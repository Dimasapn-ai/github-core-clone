// ids.ts: Relay-style global ids for the GraphQL surface (and REST node_id fields). An id is
// the base64 of "<Kind>:<part>:<part>..." — opaque to clients, stable across reads, and
// decodable by node(id:) and the mutations that take one.

export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2 || parts[0] === '') return null;
  // Round-trip guard: the decoded text must re-encode to the id (modulo padding), so random
  // base64-looking strings do not decode into forged kinds.
  if (Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '') !== id.replace(/=+$/, '')) return null;
  return { kind: parts[0]!, parts: parts.slice(1) };
}
