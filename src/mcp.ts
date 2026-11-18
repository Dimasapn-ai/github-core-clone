// mcp.ts: the Model Context Protocol endpoint at POST /mcp — JSON-RPC 2.0 over Streamable
// HTTP, speaking the 2026-07-28 revision (server/discover, no handshake, no session) and
// answering the legacy initialize handshake too. The tools act on the same store as the REST
// surface and answer with the REST shapes, so an object made over MCP is the same object over
// /api/v3. tools/list is a constant: two calls are byte-identical by construction.

import {
  VIEWER,
  mergePullRequest,
  tickIso,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const prop = (type: string, description: string): { type: string; description: string } => ({ type, description });

/** The tool list: fixed content, fixed key order, no state — identical on every call. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('string', 'The repository name.'),
        description: prop('string', 'A short description of the repository.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The issue title.'),
        body: prop('string', 'The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        state: prop('string', 'Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        issue_number: prop('number', 'The issue number.'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The pull request title.'),
        body: prop('string', 'The pull request body.'),
        head: prop('string', 'The head branch name.'),
        base: prop('string', 'The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        state: prop('string', 'Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        pull_number: prop('number', 'The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ------------------------------------------------------------------ helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function argNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

interface ToolOutcome {
  result?: Record<string, unknown>;
  rpcError?: { code: number; message: string };
}

function toolOk(value: unknown): ToolOutcome {
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
      isError: false,
    },
  };
}

function toolFail(message: string): ToolOutcome {
  return { result: { content: [{ type: 'text', text: message }], isError: true } };
}

function repoArg(forge: Forge, args: Record<string, unknown>): Repo | null {
  return forge.repo(argString(args, 'owner'), argString(args, 'repo')) ?? null;
}

// ------------------------------------------------------------------ tool calls

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `unknown tool '${name}'` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { rpcError: { code: -32602, message: `missing required argument '${required}'` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === '.' || repoName === '..') {
        return toolFail(`repository name '${repoName}' is invalid`);
      }
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const description = typeof args.description === 'string' ? args.description : null;
      const created = forge.createRepo(VIEWER.login, repoName, isPrivate, description);
      if (created === 'exists') return toolFail('Repository creation failed: name already exists on this account');
      return toolOk(repoJson(created));
    }
    case 'get_repo': {
      const repo = repoArg(forge, args);
      if (repo === null) return toolFail(`repository ${argString(args, 'owner')}/${argString(args, 'repo')} not found`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoArg(forge, args);
      if (repo === null) return toolFail('repository not found');
      const now = tickIso();
      const issue: Issue = {
        id: forge.allocIssueId(),
        number: repo.nextNumber,
        title: argString(args, 'title'),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        seq: repo.nextSeq,
      };
      repo.nextNumber += 1;
      repo.nextSeq += 1;
      repo.issues.set(issue.number, issue);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoArg(forge, args);
      if (repo === null) return toolFail('repository not found');
      const state = argString(args, 'state') || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.seq - b.seq)
        .map((issue) => issueJson(repo, issue));
      return toolOk(issues);
    }
    case 'get_issue': {
      const repo = repoArg(forge, args);
      if (repo === null) return toolFail('repository not found');
      const issue = repo.issues.get(argNumber(args, 'issue_number'));
      if (issue === undefined) return toolFail('issue not found');
      return toolOk(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoArg(forge, args);
      if (repo === null) return toolFail('repository not found');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (baseSha === null) return toolFail(`base branch '${base}' does not exist`);
      if (headSha === null) return toolFail(`head branch '${head}' does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return toolFail('a pull request already exists for this head and base');
        }
      }
      const now = tickIso();
      const pull: PullRequest = {
        id: forge.allocIssueId(),
        number: repo.nextNumber,
        title: argString(args, 'title'),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        headRef: head,
        baseRef: base,
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdAt: now,
        updatedAt: now,
        seq: repo.nextSeq,
      };
      repo.nextNumber += 1;
      repo.nextSeq += 1;
      repo.pulls.set(pull.number, pull);
      return toolOk(pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const repo = repoArg(forge, args);
      if (repo === null) return toolFail('repository not found');
      const state = argString(args, 'state') || 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => a.seq - b.seq)
        .map((pull) => pullJson(repo, pull));
      return toolOk(pulls);
    }
    case 'merge_pull_request': {
      const repo = repoArg(forge, args);
      if (repo === null) return toolFail('repository not found');
      const pull = repo.pulls.get(argNumber(args, 'pull_number'));
      if (pull === undefined) return toolFail('pull request not found');
      const result = mergePullRequest(repo, pull, 'squash');
      if (!result.ok) return toolFail(`the pull request is not mergeable: ${result.reason}`);
      return toolOk(pullJson(repo, pull));
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool '${name}'` } };
  }
}

// ------------------------------------------------------------------ the endpoint

export interface McpReply {
  status: number;
  /** The JSON-RPC response body; undefined answers with no body (notifications). */
  body?: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function handleOne(forge: Forge, request: unknown): McpReply {
  if (!isRecord(request) || typeof request.method !== 'string') {
    return rpcError(isRecord(request) ? request.id : null, -32600, 'invalid request');
  }
  const id = request.id;
  const params = isRecord(request.params) ? request.params : {};
  switch (request.method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(forge, toolName, args);
      if (outcome.rpcError !== undefined) return rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
      return rpcResult(id, outcome.result);
    }
    default:
      if (id === undefined) return { status: 202 }; // a notification we do not act on
      return rpcError(id, -32601, `method '${request.method}' not found`);
  }
}

/**
 * Answer one POST /mcp body. Authentication happens in app.ts before this runs. A body that
 * is not JSON is the JSON-RPC parse error: HTTP 400 with code -32700.
 */
export function handleMcp(forge: Forge, rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'parse error: the body is not JSON', 400);
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.map((entry) => handleOne(forge, entry)).filter((reply) => reply.body !== undefined);
    return { status: 200, body: replies.map((reply) => reply.body) };
  }
  return handleOne(forge, parsed);
}
