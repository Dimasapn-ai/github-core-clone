// gitserver.ts: git smart HTTP — ref advertisement, upload-pack (protocol v0 and v2, with
// shallow/deepen semantics) and receive-pack (push with report-status). The wire formats here
// follow gitprotocol-http / gitprotocol-v2 as the suite's own client parses them: v2 fetch
// section names carry a trailing newline, report-status lines are newline-terminated
// pkt-lines inside side-band-64k band 1, and receive-pack always speaks v0.

import {
  PKT_FLUSH,
  ZERO_OID,
  hashObject,
  ingestPack,
  parseTree,
  pktLine,
  parsePktStream,
  readPktLines,
  writePack,
  type GitObject,
  type PktLine,
} from './git.ts';
import type { Repo } from './store.ts';

export const AGENT = 'forge/1.0.0';

const UPLOAD_CAPS_V0 = (defaultBranch: string): string =>
  `multi_ack thin-pack side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${defaultBranch} agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

export interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs to advertise, HEAD first, the rest in refname order, tags peeled to commits. */
function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
  const refs: AdvertisedRef[] = [{ name: 'HEAD', oid: headOid }];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: AdvertisedRef = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.object(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = repo.peelToCommit(oid);
        if (peeled !== null && peeled !== oid) entry.peeled = peeled;
      }
    }
    refs.push(entry);
  }
  return refs;
}

/** The info/refs body for one service. `version2` is the client's Git-Protocol header. */
export function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): Buffer {
  if (service === 'git-upload-pack' && version2) {
    const lines = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow wait-for-done',
      'object-format=sha1',
    ];
    return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0(repo.defaultBranch) : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 1 && refs[0]!.oid === ZERO_OID) {
    // An empty repository advertises a single capabilities^{} pseudo-ref.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefs(lines: readonly PktLine[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid === undefined) {
      parts.push(pktLine(args.symrefs ? `unborn HEAD symref-target:${headTarget}` : 'unborn HEAD'));
    } else {
      parts.push(pktLine(args.symrefs ? `${headOid} HEAD symref-target:${headTarget}` : `${headOid} HEAD`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (ref.name === 'HEAD' || !matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(line));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen: number | null;
}

function parseFetch(lines: readonly PktLine[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], deepen: null };
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.clientShallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const parsed = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(parsed)) args.deepen = parsed;
    }
  }
  return args;
}

interface FetchPlan {
  /** Objects for the packfile section; empty means "nothing new" (acknowledgments only). */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  /** Haves that are commits on the server (acknowledged). */
  commonHaves: string[];
  hasPack: boolean;
}

/**
 * Work out what a fetch sends. The model: the client holds the closure of its haves plus,
 * for each shallow commit it names, that commit and everything between it and the wants.
 * The server sends the wants' history down to the depth limit (the requested depth, or a
 * deepen past the client's current boundary), minus what the client holds, and reports the
 * new shallow boundary.
 */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  // Resolve wants to commits (an annotated tag want peels to its commit; the tag object
  // itself rides along in the pack).
  const extraObjects: GitObject[] = [];
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    const object = repo.object(want);
    if (object === undefined) throw new Error(`want ${want} not found`);
    if (object.type === 'tag') {
      extraObjects.push(object);
      const commit = repo.peelToCommit(want);
      if (commit === null) throw new Error(`want ${want} does not peel to a commit`);
      wantCommits.push(commit);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      throw new Error(`want ${want} is not a commit`);
    }
  }

  // Generations of every commit reachable from the wants (0 = a want itself).
  const generations = new Map<string, number>();
  {
    let frontier = [...new Set(wantCommits)];
    let generation = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (generations.has(oid)) continue;
        const info = repo.commitInfo(oid);
        if (info === null) continue;
        generations.set(oid, generation);
        next.push(...info.parents);
      }
      frontier = next;
      generation += 1;
    }
  }

  // What the client already holds: the closure of its haves, but never past a shallow
  // boundary — a shallow commit is held, its parents are not — plus the shallow commits
  // themselves. (The suite's client speaks of depth absolutely: `deepen N` in a fetch asks
  // for the wants' history down to generation N-1, whether or not the client is shallow.)
  const held = new Set<string>();
  const commonHaves: string[] = [];
  const shallowSet = new Set(args.clientShallow);
  for (const have of args.haves) {
    const object = repo.object(have);
    if (object === undefined || object.type !== 'commit') continue;
    commonHaves.push(have);
    const queue = [have];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      held.add(oid);
      if (shallowSet.has(oid)) continue; // the boundary: held, but its history is not
      const info = repo.commitInfo(oid);
      if (info !== null) queue.push(...info.parents);
    }
  }
  const clientShallow = args.clientShallow.filter((oid) => generations.has(oid));
  for (const oid of clientShallow) held.add(oid);

  // The depth limit, in generations from the wants (an absolute depth, per above).
  let limit = Number.POSITIVE_INFINITY;
  if (args.deepen !== null) limit = args.deepen - 1;

  const sendCommits: string[] = [];
  for (const [oid, generation] of generations) {
    if (generation <= limit && !held.has(oid)) sendCommits.push(oid);
  }
  sendCommits.sort((a, b) => generations.get(a)! - generations.get(b)!);

  const finalHeld = new Set<string>([...held, ...sendCommits]);
  const boundary = new Set<string>();
  for (const oid of [...sendCommits, ...clientShallow]) {
    const info = repo.commitInfo(oid);
    if (info === null) continue;
    if (info.parents.some((parent) => repo.object(parent) !== undefined && !finalHeld.has(parent))) boundary.add(oid);
  }
  const shallow = [...boundary].filter((oid) => sendCommits.includes(oid) || clientShallow.includes(oid)).sort();
  const unshallow = clientShallow.filter((oid) => {
    const info = repo.commitInfo(oid);
    return info !== null && info.parents.length > 0 && info.parents.every((parent) => finalHeld.has(parent));
  });

  if (sendCommits.length === 0 && extraObjects.length === 0) {
    return { objects: [], shallow: [], unshallow: [], commonHaves, hasPack: false };
  }

  // Trees and blobs: the closure of the sent commits' trees, minus what held commits hold.
  const heldObjects = new Set<string>();
  for (const oid of held) {
    const info = repo.commitInfo(oid);
    if (info === null) continue;
    collectTreeObjects(repo, info.tree, heldObjects);
  }
  const objects: GitObject[] = [...extraObjects];
  const seen = new Set<string>(extraObjects.map((object) => hashObject(object.type, object.data)));
  for (const oid of sendCommits) {
    const object = repo.object(oid)!;
    if (!seen.has(oid)) {
      objects.push(object);
      seen.add(oid);
    }
    const info = repo.commitInfo(oid)!;
    const treeObjects = new Set<string>();
    collectTreeObjects(repo, info.tree, treeObjects);
    for (const treeOid of treeObjects) {
      if (heldObjects.has(treeOid) || seen.has(treeOid)) continue;
      const treeObject = repo.object(treeOid);
      if (treeObject !== undefined) {
        objects.push(treeObject);
        seen.add(treeOid);
      }
    }
  }
  return { objects, shallow, unshallow, commonHaves, hasPack: true };
}

/** Add a tree and everything under it (subtrees and blobs) to `out`. */
function collectTreeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  const object = repo.object(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  out.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000' || entry.mode === '040000') collectTreeObjects(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/** Wrap a pack in side-band-64k band-1 pkt-lines (each payload at most 65515 pack bytes). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

function section(name: string, lines: readonly string[]): Buffer {
  return Buffer.concat([pktLine(`${name}\n`), ...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

/** A protocol v2 upload-pack POST: an ls-refs or a fetch command. */
export async function uploadPackV2(repo: Repo, body: Buffer): Promise<Buffer> {
  const lines = parsePktStream(body);
  const first = lines.find((line) => line.kind === 'data');
  const command = first !== undefined && first.kind === 'data' ? first.data.toString('utf8').replace(/\n$/, '') : '';
  if (command === 'command=ls-refs') return lsRefs(repo, parseLsRefs(lines));
  if (command === 'command=fetch') {
    const plan = planFetch(repo, parseFetch(lines));
    const parts: Buffer[] = [];
    const ackLines = plan.commonHaves.length > 0 ? plan.commonHaves.map((oid) => `ACK ${oid}`) : ['NAK'];
    if (plan.hasPack) ackLines.push('ready');
    parts.push(section('acknowledgments', ackLines));
    const shallowLines = [
      ...plan.shallow.map((oid) => `shallow ${oid}`),
      ...plan.unshallow.map((oid) => `unshallow ${oid}`),
    ];
    if (shallowLines.length > 0) parts.push(section('shallow-info', shallowLines));
    if (plan.hasPack) {
      parts.push(Buffer.concat([pktLine('packfile\n'), sidebandPack(writePack(plan.objects)), PKT_FLUSH]));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

/** A protocol v0 upload-pack POST (want/have/done, then shallow lines, an ACK or NAK, and the pack). */
export async function uploadPackV0(repo: Repo, body: Buffer): Promise<Buffer> {
  const first = readPktLines(body);
  const wants: string[] = [];
  for (const line of first.lines) {
    if (line.kind !== 'data') continue;
    let text = line.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
  }
  const second = readPktLines(first.rest);
  const haves: string[] = [];
  let deepen: number | null = null;
  for (const line of second.lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('deepen ')) {
      const parsed = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(parsed)) deepen = parsed;
    }
  }
  const plan = planFetch(repo, { wants, haves, clientShallow: [], deepen });
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.commonHaves.length > 0) parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  if (plan.hasPack) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: readonly PktLine[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    let text = line.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match === null) throw new Error(`malformed ref update ${JSON.stringify(text.slice(0, 60))}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  return commands;
}

function reportStatus(unpackLine: string, results: readonly { ref: string; ok: boolean; reason?: string }[]): Buffer {
  const inner: Buffer[] = [pktLine(`${unpackLine}\n`)];
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  inner.push(PKT_FLUSH);
  const demuxed = Buffer.concat(inner);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < demuxed.length; offset += CHUNK) {
    const payload = Buffer.concat([Buffer.from([1]), demuxed.subarray(offset, offset + CHUNK)]);
    parts.push(pktLine(payload));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * A receive-pack POST: ingest the pack (if any), validate each ref update against the
 * current refs (fast-forward only for branches), apply the ones that pass, and answer the
 * report-status. Never throws: a malformed body is an unpack error, not a dead server.
 */
export async function receivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  let commands: PushCommand[];
  let pack = Buffer.alloc(0);
  try {
    const parsed = readPktLines(body);
    if (!parsed.ok && parsed.lines.length === 0) throw new Error('the command list is not pkt-lines');
    commands = parsePushCommands(parsed.lines);
    pack = parsed.rest;
  } catch (error) {
    return reportStatus(`unpack ${error instanceof Error ? error.message : 'error'}`, []);
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = ingestPack(pack, (oid) => repo.object(oid));
      for (const object of objects) repo.put(object.type, object.data);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  if (!unpackOk) {
    return reportStatus(`unpack ${unpackDetail}`, commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })));
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    results.push(applyPushCommand(repo, command));
  }
  return reportStatus('unpack ok', results);
}

function applyPushCommand(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const { ref, oldOid, newOid } = command;
  const fail = (reason: string): { ref: string; ok: boolean; reason: string } => ({ ref, ok: false, reason });
  if (!/^refs\/(heads|tags)\/[^\s]+$/.test(ref) || ref.includes('..') || ref.includes('//')) return fail('invalid ref name');
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) {
    return fail(oldOid === ZERO_OID ? 'reference already exists' : 'reference has moved');
  }
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return fail('reference does not exist');
    if (ref === `refs/heads/${repo.defaultBranch}`) return fail('deletion of the current branch prohibited');
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  const object = repo.object(newOid);
  if (object === undefined) return fail('invalid object');
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return fail('not a commit');
    if (oldOid !== ZERO_OID && !repo.isAncestor(oldOid, newOid)) return fail('non-fast-forward');
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}
