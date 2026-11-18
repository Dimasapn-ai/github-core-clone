// app.ts: the forge's HTTP server — routing, authentication and framing for the four
// surfaces. All state lives in one Forge (src/store.ts); each surface is its own module:
// git smart HTTP (src/gitserver.ts), REST v3 (src/rest.ts), GraphQL (src/graphql.ts) and
// MCP (src/mcp.ts). main.ts owns the entry <-> env lifecycle and just serves this app.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest, type RestRequest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { advertisement, receivePack, uploadPackV0, uploadPackV2 } from './src/gitserver.ts';
import { pktLine, PKT_FLUSH } from './src/git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** The token the suite presents; the entry process receives it as MAKEFUN_SHOP_TOKEN. */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Whether the request carries the suite's bearer token. */
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  // With no token configured (a local run), any bearer token is accepted; in a trial the
  // env always sets MAKEFUN_SHOP_TOKEN and the match is exact.
  return TOKEN === '' || match[1] === TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'content-type': JSON_TYPE }),
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

/** Read a whole request body (bounded); rejects past the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(forge, req, res).catch(() => {
      // A handler bug must never take the process down: the suite's next request decides.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });
  return server;
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The env's boot check: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---------------------------------------------------------------- MCP
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const reply = handleMcp(forge, await readBody(req));
    if (reply.body === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body);
    return;
  }

  // ---------------------------------------------------------------- GraphQL
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'the request body is not JSON' }] });
      return;
    }
    const reply = handleGraphQL(forge, body);
    sendJson(res, reply.status, reply.body);
    return;
  }

  // ---------------------------------------------------------------- REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path.slice('/api/v3'.length) || '/';
    const segments = restPath.split('/').filter((segment) => segment !== '').map(decodeSegment);
    const isRoot = segments.length === 0;
    if (!isRoot && !authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const host = req.headers.host ?? 'localhost';
    const restReq: RestRequest = {
      method,
      segments,
      query: url.searchParams,
      body,
      origin: `http://${host}`,
      path: restPath,
    };
    const reply = handleRest(forge, restReq);
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  // ---------------------------------------------------------------- git smart HTTP
  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const repoName = decodeSegment(gitMatch[2]!);
    const route = gitMatch[3]!;
    if (!authed(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
      res.end('authentication required\n');
      return;
    }
    const repo = forge.repo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (route === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const version2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
      sendBuffer(res, 200, advertisement(repo, service, version2), `application/x-${service}-advertisement`);
      return;
    }
    if (route === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2') || body.subarray(0, 64).includes('command=');
      try {
        const reply = version2 ? await uploadPackV2(repo, body) : await uploadPackV0(repo, body);
        sendBuffer(res, 200, reply, 'application/x-git-upload-pack-result');
      } catch (error) {
        if (version2) {
          const message = error instanceof Error ? error.message : 'upload-pack failed';
          sendBuffer(res, 200, Buffer.concat([pktLine(`ERR ${message}\n`), PKT_FLUSH]), 'application/x-git-upload-pack-result');
        } else {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
          res.end('upload-pack failed\n');
        }
      }
      return;
    }
    if (route === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const reply = await receivePack(repo, body);
      sendBuffer(res, 200, reply, 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---------------------------------------------------------------- everything else
  sendJson(res, 404, { message: 'Not Found' });
}
