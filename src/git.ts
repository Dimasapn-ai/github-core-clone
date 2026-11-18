// git.ts: the git object model and packfile format, implemented from the protocol's own
// documentation with node:crypto and node:zlib only. Objects are content-addressed buffers;
// a pack is parsed into (and generated from) the same {type, data} shape the store keeps.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of a typed payload: sha1("<type> <length>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function oidToBytes(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

export function bytesToOid(bytes: Buffer): string {
  return bytes.toString('hex');
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's payload. Header continuation lines (gpgsig) are folded away. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  let lastKey = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // a continuation of the previous header
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    lastKey = key;
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  void lastKey;
  return { tree, parents, author, committer, message };
}

/** Build a commit payload. `author`/`committer` are full "Name <email> ts tz" lines. */
export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

/** Split an identity line "Name <email> 1700000000 +0000" into its parts (best effort). */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', timestamp: 0 };
  return { name: match[1]!, email: match[2]!, timestamp: Number(match[3]) };
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  /** Octal mode as written in the tree object: '40000' for a directory, '100644'/'100755'/'120000' for a leaf. */
  mode: string;
  name: string;
  oid: string;
}

export function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Parse a tree object's payload into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = bytesToOid(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: entries compare by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

/** Build a tree payload from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(oidToBytes(entry.oid));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ pkt-line

/** One decoded pkt-line: a payload, or the framing packets git interleaves. */
export type PktLine =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one payload as a pkt-line (4 hex digits of total length, then the payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error(`pkt-line payload too large: ${body.length}`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/**
 * Decode the pkt-lines at the front of `buffer`. Stops at the first framing packet or at a
 * truncated/invalid line; `rest` is whatever followed (a packfile, in receive-pack).
 */
export function readPktLines(buffer: Buffer, start = 0): { lines: PktLine[]; rest: Buffer; ok: boolean } {
  const lines: PktLine[] = [];
  let pos = start;
  while (pos + 4 <= buffer.length) {
    const header = buffer.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { lines, rest: buffer.subarray(pos), ok: false };
    const length = parseInt(header, 16);
    if (length === 0) {
      lines.push({ kind: 'flush' });
      return { lines, rest: buffer.subarray(pos + 4), ok: true };
    }
    if (length === 1) {
      lines.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buffer.length) return { lines, rest: buffer.subarray(pos), ok: false };
    lines.push({ kind: 'data', data: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { lines, rest: buffer.subarray(pos), ok: pos === buffer.length };
}

/** Decode a whole buffer of pkt-lines (protocol requests). Throws on malformed framing. */
export function parsePktStream(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let pos = 0;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end' });
      pos += 4;
    } else {
      if (length < 4 || pos + length > buffer.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', data: buffer.subarray(pos + 4, pos + length) });
      pos += length;
    }
  }
  return out;
}

// ------------------------------------------------------------------ packfiles

/**
 * Inflate the zlib stream starting at `pos`; returns the data and the offset just past it.
 * `inflateSync` with `info: true` reports exactly how many compressed bytes the stream
 * consumed (engine.bytesWritten), which is the only reliable way to find the next entry.
 */
function inflateAt(buffer: Buffer, pos: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(pos), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${pos} consumed no bytes`);
  return { data: result.buffer, next: pos + written };
}

/** Apply a git delta (copy/insert instructions) to its base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: delta expects ${sourceSize}, base is ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const opcode = delta[pos]!;
    pos += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          offset |= delta[pos]! << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          size |= delta[pos]! << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(pos, pos + opcode));
      produced += opcode;
      pos += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface PackEntry {
  type: ObjType;
  /** For full objects: the payload. For deltas: the delta payload. */
  data: Buffer;
  deltaBase?: { kind: 'oid'; oid: string } | { kind: 'offset'; entryIndex: number };
}

/**
 * Parse a packfile into its entries, verifying the trailer checksum. Delta bases are left as
 * references (by oid, or by entry index for OFS_DELTA); resolvePackEntries applies them.
 */
export function parsePack(buffer: Buffer): PackEntry[] {
  if (buffer.length < 12 + 20) throw new Error('pack is too short');
  if (buffer.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20);
  const digest = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  const entryOffsets: number[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    entryOffsets.push(pos);
    let byte = buffer[pos]!;
    pos += 1;
    const typeCode = (byte >> 4) & 7;
    // The size varint's low bits are informational here; the inflated length is authoritative.
    while (byte & 0x80) {
      byte = buffer[pos]!;
      pos += 1;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, in git's offset encoding.
      let back = buffer[pos]! & 0x7f;
      let b = buffer[pos]!;
      pos += 1;
      while (b & 0x80) {
        b = buffer[pos]!;
        pos += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = entryOffsets[index]! - back;
      const baseIndex = entryOffsets.indexOf(baseOffset);
      if (baseIndex === -1) throw new Error('OFS_DELTA base offset does not land on an entry');
      const inflated = inflateAt(buffer, pos);
      entries.push({ type: 'blob', data: inflated.data, deltaBase: { kind: 'offset', entryIndex: baseIndex } });
      pos = inflated.next;
    } else if (typeCode === 7) {
      const baseOid = bytesToOid(buffer.subarray(pos, pos + 20));
      pos += 20;
      const inflated = inflateAt(buffer, pos);
      entries.push({ type: 'blob', data: inflated.data, deltaBase: { kind: 'oid', oid: baseOid } });
      pos = inflated.next;
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(buffer, pos);
      entries.push({ type, data: inflated.data });
      pos = inflated.next;
    }
  }
  return entries;
}

/**
 * Resolve parsed pack entries into whole objects. `lookup` finds objects the pack itself does
 * not carry (thin packs: the base already lives in the receiving repository).
 */
export function resolvePackEntries(
  entries: readonly PackEntry[],
  lookup: (oid: string) => GitObject | undefined,
): GitObject[] {
  const resolved: (GitObject | undefined)[] = new Array(entries.length);
  const resolving = new Set<number>();
  const resolveIndex = (index: number): GitObject => {
    const done = resolved[index];
    if (done !== undefined) return done;
    if (resolving.has(index)) throw new Error('delta cycle in pack');
    resolving.add(index);
    const entry = entries[index]!;
    let object: GitObject;
    if (entry.deltaBase === undefined) {
      object = { type: entry.type, data: entry.data };
    } else {
      let base: GitObject;
      if (entry.deltaBase.kind === 'oid') {
        // The base may be another pack entry (by content) or an object the store already holds.
        base = resolveByOid(entry.deltaBase.oid) ?? lookup(entry.deltaBase.oid) ?? (() => {
          throw new Error(`delta base ${entry.deltaBase.oid} is not available`);
        })();
      } else {
        base = resolveIndex(entry.deltaBase.entryIndex);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolving.delete(index);
    resolved[index] = object;
    return object;
  };
  const byOid = new Map<string, number>();
  const resolveByOid = (oid: string): GitObject | undefined => {
    const known = byOid.get(oid);
    if (known !== undefined) return resolveIndex(known);
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index]!.deltaBase === undefined && hashObject(entries[index]!.type, entries[index]!.data) === oid) {
        byOid.set(oid, index);
        return resolveIndex(index);
      }
    }
    return undefined;
  };
  return entries.map((_, index) => resolveIndex(index));
}

/** Parse and resolve a packfile in one call (receive-pack's ingest). */
export function ingestPack(
  buffer: Buffer,
  lookup: (oid: string) => GitObject | undefined,
): GitObject[] {
  const entries = parsePack(buffer);
  return resolvePackEntries(entries, lookup);
}

/** Write a packfile of whole objects (no deltas): header, deflated entries, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const typeCode = TYPE_TO_CODE[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const headerBytes: number[] = [];
    let byte = (typeCode << 4) | first;
    while (size > 0) {
      headerBytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    headerBytes.push(byte);
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
