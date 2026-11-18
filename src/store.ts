// store.ts: the forge's single in-memory store. Every surface (git smart HTTP, REST, GraphQL,
// MCP) reads and writes through here, so an object created on one surface is the same object on
// all the others. Git objects are real: contents writes and merges build blobs, trees and
// commits in the object store, and refs point at them, so the git protocol and the APIs can
// never disagree about what a branch holds.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  isDirMode,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './git.ts';

/** The one authenticated identity the suite's token stands for (wire.ts's scenario viewer). */
export const VIEWER = { login: 'adaiversen', id: 1000 } as const;

/** Deterministic logical clock: every timestamp the forge mints comes from this counter. */
const CLOCK_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
let clockTick = 0;
export function tickIso(): string {
  clockTick += 1;
  return new Date(CLOCK_BASE_MS + clockTick * 1000).toISOString();
}
export function tickEpochSeconds(): number {
  clockTick += 1;
  return Math.floor(CLOCK_BASE_MS / 1000) + clockTick;
}

/** The identity server-side commits (contents writes, merges) are authored with. */
function serverIdentity(): string {
  const ts = tickEpochSeconds();
  return `${VIEWER.login} <${VIEWER.login}@forge.local> ${ts} +0000`;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  /** Globally unique, stable across reads and surfaces. */
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Creation order within the repository (issues and pull requests share one sequence). */
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Ref tips captured at creation, used when a ref has since been deleted. */
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdAt: string;
  updatedAt: string;
  /** oid -> object. Content-addressed and immutable. */
  readonly objects = new Map<string, GitObject>();
  /** Full ref name (refs/heads/main) -> oid. HEAD is implicit: refs/heads/<defaultBranch>. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  /** Shared issue/PR number counter (GitHub numbers both from one sequence). */
  nextNumber = 1;
  nextSeq = 1;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string | null) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    const now = tickIso();
    this.createdAt = now;
    this.updatedAt = now;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  object(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object and return its oid. */
  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  commitInfo(oid: string): { tree: string; parents: string[]; author: string; committer: string; message: string } | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** The commit oid a branch/tag name or a raw oid resolves to, or null. */
  resolveRef(ref: string): string | null {
    if (ref === 'HEAD') {
      const tip = this.refs.get(`refs/heads/${this.defaultBranch}`);
      return tip ?? null;
    }
    const full = this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`);
    if (full !== undefined) return full;
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) return ref;
    return null;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Follow a tag object chain to the commit it points at (annotated tags), or null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
    }
    return null;
  }

  /** Every commit reachable from `tip`, newest first (breadth by generation). */
  ancestorsOf(tip: string): Map<string, number> {
    const generations = new Map<string, number>();
    if (!this.objects.has(tip)) return generations;
    let frontier = [tip];
    let generation = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (generations.has(oid)) continue;
        const info = this.commitInfo(oid);
        if (info === null) continue;
        generations.set(oid, generation);
        next.push(...info.parents);
      }
      frontier = next;
      generation += 1;
    }
    return generations;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestorsOf(descendant).has(ancestor);
  }

  /** The best common ancestor of two commits (the merge base), or null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    const fromA = this.ancestorsOf(a);
    const fromB = this.ancestorsOf(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, genA] of fromA) {
      const genB = fromB.get(oid);
      if (genB === undefined) continue;
      const score = genA + genB;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  // -------------------------------------------------------------- trees

  /** Flatten a tree (by oid) into path -> blob entry. Empty map for the empty tree. */
  flattenTree(treeOid: string | null, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    if (treeOid === null) return out;
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** The flat file map of a commit (empty when the commit is unknown). */
  filesOfCommit(commitOid: string | null): Map<string, { mode: string; oid: string }> {
    if (commitOid === null) return new Map();
    const info = this.commitInfo(commitOid);
    if (info === null) return new Map();
    return this.flattenTree(info.tree);
  }

  /** Rebuild nested trees from a flat file map; returns the root tree oid. */
  buildTreeFromFiles(files: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Node {
      dirs: Map<string, Node>;
      files: { name: string; mode: string; oid: string }[];
    }
    const root: Node = { dirs: new Map(), files: [] };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { dirs: new Map(), files: [] };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.push({ name: parts[parts.length - 1]!, mode: entry.mode, oid: entry.oid });
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid of a commit, or null. */
  treeOfCommit(commitOid: string): string | null {
    const info = this.commitInfo(commitOid);
    return info === null ? null : info.tree;
  }

  /** Make a commit on top of `parent` (null = root) with the given tree; returns its oid. */
  makeCommit(treeOid: string, parent: string | null, message: string): string {
    const identity = serverIdentity();
    const data = buildCommit(treeOid, parent === null ? [] : [parent], identity, identity, message.endsWith('\n') ? message : `${message}\n`);
    return this.put('commit', data);
  }

  // -------------------------------------------------------------- contents

  /**
   * Write `content` at `path` on `branch`, GitHub contents-API style. Returns the new commit
   * oid and blob oid, or a refusal reason. A branch that does not exist yet is created from
   * the default branch's tip (the suite's branch-creation fallback relies on this).
   */
  writeFile(
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha: string | undefined,
  ): { ok: true; commit: string; blob: string; created: boolean } | { ok: false; status: number; reason: string } {
    let tip = this.branchTip(branch);
    if (tip === null && !this.refs.has(`refs/heads/${branch}`)) {
      // Create the branch from the default branch tip (or leave it unborn on an empty repo).
      tip = this.branchTip(this.defaultBranch);
    }
    const files = this.filesOfCommit(tip);
    const existing = files.get(path);
    if (expectedSha !== undefined) {
      if (existing === undefined) return { ok: false, status: 404, reason: `no file at ${path} to update` };
      if (existing.oid !== expectedSha) return { ok: false, status: 409, reason: 'the provided sha does not match the file on the server' };
    } else if (existing !== undefined) {
      return { ok: false, status: 422, reason: 'sha is required to overwrite an existing file' };
    }
    const blob = this.put('blob', content);
    files.set(path, { mode: existing?.mode ?? '100644', oid: blob });
    const tree = this.buildTreeFromFiles(files);
    const commit = this.makeCommit(tree, tip, message);
    this.refs.set(`refs/heads/${branch}`, commit);
    this.updatedAt = tickIso();
    return { ok: true, commit, blob, created: existing === undefined };
  }

  /** Delete `path` on `branch`; the caller has already verified the blob sha. */
  deleteFile(branch: string, path: string, message: string): { ok: true; commit: string } | { ok: false; status: number; reason: string } {
    const tip = this.branchTip(branch);
    if (tip === null) return { ok: false, status: 404, reason: 'the branch has no commits' };
    const files = this.filesOfCommit(tip);
    if (!files.has(path)) return { ok: false, status: 404, reason: `no file at ${path}` };
    files.delete(path);
    const tree = this.buildTreeFromFiles(files);
    const commit = this.makeCommit(tree, tip, message);
    this.refs.set(`refs/heads/${branch}`, commit);
    this.updatedAt = tickIso();
    return { ok: true, commit };
  }

  /** Read a path at a ref: a file's blob, a directory's entries, or null when absent. */
  readPath(
    ref: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: { name: string; path: string; type: 'file' | 'dir'; oid: string }[] } | null {
    const commitOid = this.resolveRef(ref);
    if (commitOid === null) return null;
    const commit = this.peelToCommit(commitOid);
    if (commit === null) return null;
    const info = this.commitInfo(commit);
    if (info === null) return null;
    if (path === '') {
      return { kind: 'dir', entries: this.dirEntries(info.tree, '') };
    }
    const parts = path.split('/');
    let treeOid = info.tree;
    for (let index = 0; index < parts.length; index += 1) {
      const object = this.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === parts[index]);
      if (entry === undefined) return null;
      if (index === parts.length - 1) {
        if (isDirMode(entry.mode)) return { kind: 'dir', entries: this.dirEntries(entry.oid, path) };
        const blob = this.objects.get(entry.oid);
        if (blob === undefined || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (!isDirMode(entry.mode)) return null;
      treeOid = entry.oid;
    }
    return null;
  }

  private dirEntries(treeOid: string, prefix: string): { name: string; path: string; type: 'file' | 'dir'; oid: string }[] {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      type: isDirMode(entry.mode) ? ('dir' as const) : ('file' as const),
      oid: entry.oid,
    }));
  }
}

// ------------------------------------------------------------------ merges and diffs

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** Line counts of a one-file change, by longest common subsequence of lines. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // LCS over lines with a rolling row; the files this forge diffs are small.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    const row = new Array<number>(newLines.length + 1).fill(0);
    for (let j = 1; j <= newLines.length; j += 1) {
      row[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    prev = row;
  }
  const common = prev[newLines.length]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function blobText(repo: Repo, oid: string | undefined): string {
  if (oid === undefined) return '';
  const object = repo.object(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** The changed files of `head` relative to `base` (both flat file maps), with line counts. */
export function diffFiles(
  repo: Repo,
  baseFiles: ReadonlyMap<string, { mode: string; oid: string }>,
  headFiles: ReadonlyMap<string, { mode: string; oid: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid && before.mode === after.mode) continue;
    const { additions, deletions } = lineDiff(blobText(repo, before?.oid), blobText(repo, after?.oid));
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
    });
  }
  return changes;
}

/**
 * Three-way merge of flat file maps: `ours` and `theirs` both descend from `base`.
 * Returns the merged map, or the list of conflicting paths.
 */
export function mergeFileMaps(
  base: ReadonlyMap<string, { mode: string; oid: string }>,
  ours: ReadonlyMap<string, { mode: string; oid: string }>,
  theirs: ReadonlyMap<string, { mode: string; oid: string }>,
): { merged: Map<string, { mode: string; oid: string }> } | { conflicts: string[] } {
  const same = (a: { mode: string; oid: string } | undefined, b: { mode: string; oid: string } | undefined): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return conflicts.length > 0 ? { conflicts } : { merged };
}

/** Whether merging `pull` into its base branch right now would conflict. */
export function pullRequestConflicts(repo: Repo, pull: PullRequest): boolean {
  const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  const base = repo.mergeBase(headTip, baseTip);
  if (base === null) return true;
  const result = mergeFileMaps(repo.filesOfCommit(base), repo.filesOfCommit(baseTip), repo.filesOfCommit(headTip));
  return 'conflicts' in result;
}

/**
 * Merge a pull request. 'squash' lands one commit with the head's merged tree on the base
 * branch; 'merge' lands a two-parent merge commit. On conflict nothing moves and the caller
 * answers 405. Returns the merge commit oid.
 */
export function mergePullRequest(
  repo: Repo,
  pull: PullRequest,
  method: 'squash' | 'merge',
): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'the pull request is not open' };
  const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  const base = repo.mergeBase(headTip, baseTip);
  if (base === null) return { ok: false, reason: 'the branches have no common history' };
  const result = mergeFileMaps(repo.filesOfCommit(base), repo.filesOfCommit(baseTip), repo.filesOfCommit(headTip));
  if ('conflicts' in result) return { ok: false, reason: `the merge conflicts on ${result.conflicts.join(', ')}` };
  const tree = repo.buildTreeFromFiles(result.merged);
  const identity = serverIdentity();
  let sha: string;
  if (method === 'squash') {
    const message = `${pull.title}\n\n${pull.body ?? ''}`.trimEnd() + '\n';
    sha = repo.put('commit', buildCommit(tree, [baseTip], identity, identity, message));
  } else {
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    sha = repo.put('commit', buildCommit(tree, [baseTip, headTip], identity, identity, message));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = tickIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = tickIso();
  repo.updatedAt = tickIso();
  return { ok: true, sha };
}

// ------------------------------------------------------------------ the forge

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextLabelId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string | null): Repo | 'exists' {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return 'exists';
    const repo = new Repo(this.nextRepoId, owner, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  allocLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  allocIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

export { ZERO_OID };
