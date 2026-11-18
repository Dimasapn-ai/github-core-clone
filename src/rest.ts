// rest.ts: the REST v3 surface under /api/v3 — repositories, contents, git refs, branches,
// commits, labels, issues, comments and pull requests, in GitHub's shapes and statuses.
// app.ts owns authentication and the JSON body parse; this module routes and answers.

import { parseIdentity } from './git.ts';
import {
  VIEWER,
  diffFiles,
  mergePullRequest,
  tickIso,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { globalId } from './ids.ts';

export interface RestReply {
  status: number;
  /** JSON body; undefined answers with no body (204). */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  /** Path segments under /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when the request carried none). */
  body: unknown;
  /** The request's absolute origin, for Link headers. */
  origin: string;
  /** The raw path under /api/v3 (for building Link URLs). */
  path: string;
}

const ok = (body: unknown, status = 200): RestReply => ({ status, body });
const fail = (status: number, message: string): RestReply => ({ status, body: { message } });
const notFound = (): RestReply => fail(404, 'Not Found');
const invalid = (message: string): RestReply => fail(422, message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, name: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

// ------------------------------------------------------------------ serializers

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    name,
    color: label?.color ?? '000000',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

/** A pull request in issue shape (GitHub's issues list includes pull requests). */
export function pullAsIssueJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userJson(),
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : pull.state === 'closed' ? pull.updatedAt : null,
    pull_request: { url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}` },
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issueNumber, comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ------------------------------------------------------------------ pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice `items` to the requested page and build the Link header for the pages around it. */
function paginate<T>(req: RestRequest, items: readonly T[]): { page: T[]; headers?: Record<string, string> } {
  const { perPage, page } = pageOf(req.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (items.length <= perPage && page === 1) return { page: slice };
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<${req.origin}/api/v3${req.path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < lastPage) links.push(`${urlFor(page + 1)}; rel="next"`, `${urlFor(lastPage)}; rel="last"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`, `${urlFor(1)}; rel="first"`);
  return { page: slice, headers: links.length > 0 ? { link: links.join(', ') } : undefined };
}

// ------------------------------------------------------------------ shared lookups

function repoOr404(forge: Forge, owner: string, name: string): Repo | RestReply {
  const repo = forge.repo(owner, name);
  return repo === undefined ? notFound() : repo;
}

function isReply(value: Repo | RestReply): value is RestReply {
  return typeof (value as RestReply).status === 'number';
}

// ------------------------------------------------------------------ repositories

function createRepo(forge: Forge, req: RestRequest): RestReply {
  const name = stringField(req.body, 'name');
  if (name === undefined || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return invalid('Validation Failed: name is invalid');
  }
  const isPrivate = isRecord(req.body) && typeof req.body.private === 'boolean' ? req.body.private : false;
  const description = stringField(req.body, 'description') ?? null;
  const created = forge.createRepo(VIEWER.login, name, isPrivate, description);
  if (created === 'exists') return invalid('Repository creation failed: name already exists on this account');
  return ok(repoJson(created), 201);
}

function getRepo(repo: Repo): RestReply {
  return ok(repoJson(repo));
}

function patchRepo(repo: Repo, req: RestRequest): RestReply {
  if (isRecord(req.body)) {
    if (typeof req.body.description === 'string' || req.body.description === null) repo.description = req.body.description as string | null;
    if (typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
    if (typeof req.body.default_branch === 'string' && req.body.default_branch !== '') repo.defaultBranch = req.body.default_branch;
  }
  repo.updatedAt = tickIso();
  return ok(repoJson(repo));
}

// ------------------------------------------------------------------ contents

function contentsGet(repo: Repo, req: RestRequest, path: string): RestReply {
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  const found = repo.readPath(ref, path);
  if (found === null) return notFound();
  if (found.kind === 'file') {
    const name = path.split('/').pop() ?? path;
    return ok({
      type: 'file',
      name,
      path,
      sha: found.oid,
      size: found.data.length,
      encoding: 'base64',
      content: found.data.toString('base64'),
    });
  }
  return ok(
    found.entries.map((entry) => ({
      type: entry.type,
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
      size: entry.type === 'file' ? (repo.object(entry.oid)?.data.length ?? 0) : 0,
    })),
  );
}

function contentsPut(repo: Repo, req: RestRequest, path: string): RestReply {
  const contentBase64 = stringField(req.body, 'content');
  if (contentBase64 === undefined) return invalid('Validation Failed: content is required');
  const content = Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const branch = stringField(req.body, 'branch') ?? repo.defaultBranch;
  const message = stringField(req.body, 'message') ?? `Update ${path}`;
  const sha = stringField(req.body, 'sha');
  const result = repo.writeFile(branch, path, content, message, sha);
  if (!result.ok) return fail(result.status, result.reason);
  const name = path.split('/').pop() ?? path;
  return ok(
    {
      content: { name, path, sha: result.blob, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: result.commit, message },
    },
    result.created ? 201 : 200,
  );
}

function contentsDelete(repo: Repo, req: RestRequest, path: string): RestReply {
  const branch = stringField(req.body, 'branch') ?? repo.defaultBranch;
  const message = stringField(req.body, 'message') ?? `Delete ${path}`;
  const sha = stringField(req.body, 'sha');
  const tip = repo.branchTip(branch);
  const existing = tip === null ? undefined : repo.filesOfCommit(tip).get(path);
  if (existing === undefined) return notFound();
  if (sha !== undefined && sha !== existing.oid) return fail(409, 'the provided sha does not match the file on the server');
  const result = repo.deleteFile(branch, path, message);
  if (!result.ok) return fail(result.status, result.reason);
  return ok({ content: null, commit: { sha: result.commit, message } });
}

// ------------------------------------------------------------------ git data, branches, commits

function createRef(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  void forge;
  const ref = stringField(req.body, 'ref');
  const sha = stringField(req.body, 'sha');
  if (ref === undefined || !ref.startsWith('refs/')) return invalid('Validation Failed: ref must be a full ref name');
  if (sha === undefined || repo.object(sha) === undefined) return invalid('Validation Failed: object does not exist');
  if (ref.startsWith('refs/heads/') && repo.peelToCommit(sha) === null) return invalid('Validation Failed: object is not a commit');
  if (repo.refs.has(ref)) return invalid('Reference already exists');
  repo.refs.set(ref, sha);
  const object = repo.object(sha)!;
  return ok({ ref, object: { sha, type: object.type } }, 201);
}

function refJson(repo: Repo, ref: string): Record<string, unknown> {
  const sha = repo.refs.get(ref)!;
  return { ref, object: { sha, type: repo.object(sha)?.type ?? 'commit' } };
}

function listRefs(repo: Repo): RestReply {
  return ok([...repo.refs.keys()].sort().map((ref) => refJson(repo, ref)));
}

function getRef(repo: Repo, ref: string): RestReply {
  if (!repo.refs.has(ref)) return notFound();
  return ok(refJson(repo, ref));
}

function listBranches(repo: Repo): RestReply {
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort()
    .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false }));
  return ok(branches);
}

function getBranch(repo: Repo, branch: string): RestReply {
  const sha = repo.branchTip(branch);
  if (sha === null) return notFound();
  return ok({ name: branch, commit: { sha }, protected: false });
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const info = repo.commitInfo(oid)!;
  const author = parseIdentity(info.author);
  const committer = parseIdentity(info.committer);
  const iso = (ts: number): string => new Date(ts * 1000).toISOString();
  return {
    sha: oid,
    node_id: globalId('Commit', repo.id, oid),
    commit: {
      message: info.message.replace(/[\r\n]+$/, ''),
      tree: { sha: info.tree },
      author: { name: author.name, email: author.email, date: iso(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: iso(committer.timestamp) },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

function listCommits(repo: Repo, req: RestRequest): RestReply {
  const shaParam = req.query.get('sha');
  const start = shaParam === null || shaParam === '' ? repo.branchTip(repo.defaultBranch) : repo.resolveRef(shaParam);
  if (start === null) return ok([]);
  const commit = repo.peelToCommit(start);
  if (commit === null) return ok([]);
  const ordered = [...repo.ancestorsOf(commit).entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
  const { page, headers } = paginate(req, ordered);
  return { status: 200, body: page.map((oid) => commitJson(repo, oid)), headers };
}

// ------------------------------------------------------------------ labels

function createLabel(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const name = stringField(req.body, 'name');
  if (name === undefined || name === '') return invalid('Validation Failed: name is required');
  if (repo.labels.has(name)) return invalid('Validation Failed: a label with that name already exists');
  const color = (stringField(req.body, 'color') ?? 'ededed').replace(/^#/, '');
  const description = stringField(req.body, 'description') ?? null;
  repo.labels.set(name, { id: forge.allocLabelId(), name, color, description });
  return ok(labelJson(repo, name), 201);
}

/** Validate a create/update label list: every named label must exist in the repository. */
function labelsOf(repo: Repo, body: unknown): string[] | RestReply {
  if (!isRecord(body) || body.labels === undefined) return [];
  if (!Array.isArray(body.labels)) return invalid('Validation Failed: labels must be an array');
  const names: string[] = [];
  for (const entry of body.labels) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : null;
    if (name === null) return invalid('Validation Failed: a label entry has no name');
    if (!repo.labels.has(name)) return invalid(`Validation Failed: label '${name}' does not exist`);
    names.push(name);
  }
  return names;
}

// ------------------------------------------------------------------ issues

function findIssueOrPull(repo: Repo, number: number): { issue: Issue } | { pull: PullRequest } | null {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return { issue };
  const pull = repo.pulls.get(number);
  if (pull !== undefined) return { pull };
  return null;
}

function listIssues(repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  interface Row {
    seq: number;
    json: Record<string, unknown>;
    state: string;
  }
  const rows: Row[] = [];
  for (const issue of repo.issues.values()) rows.push({ seq: issue.seq, json: issueJson(repo, issue), state: issue.state });
  for (const pull of repo.pulls.values()) rows.push({ seq: pull.seq, json: pullAsIssueJson(repo, pull), state: pull.state });
  const filtered = rows.filter((row) => state === 'all' || row.state === state);
  filtered.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { page, headers } = paginate(req, filtered);
  return { status: 200, body: page.map((row) => row.json), headers };
}

function createIssue(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const title = stringField(req.body, 'title');
  if (title === undefined || title === '') return invalid('Validation Failed: title is required');
  const labels = labelsOf(repo, req.body);
  if (!Array.isArray(labels)) return labels;
  const now = tickIso();
  const issue: Issue = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title,
    body: stringField(req.body, 'body') ?? null,
    state: 'open',
    labels,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    seq: repo.nextSeq,
  };
  repo.nextNumber += 1;
  repo.nextSeq += 1;
  repo.issues.set(issue.number, issue);
  return ok(issueJson(repo, issue), 201);
}

function getIssue(repo: Repo, number: number): RestReply {
  const found = findIssueOrPull(repo, number);
  if (found === null) return notFound();
  return ok('issue' in found ? issueJson(repo, found.issue) : pullAsIssueJson(repo, found.pull));
}

function patchIssue(repo: Repo, req: RestRequest, number: number): RestReply {
  const found = findIssueOrPull(repo, number);
  if (found === null) return notFound();
  const labels = labelsOf(repo, req.body);
  if (!Array.isArray(labels)) return labels;
  const hasLabels = isRecord(req.body) && req.body.labels !== undefined;
  const apply = (target: { title: string; body: string | null; state: 'open' | 'closed'; updatedAt: string; closedAt?: string | null }): void => {
    const title = stringField(req.body, 'title');
    if (title !== undefined) target.title = title;
    if (isRecord(req.body) && (typeof req.body.body === 'string' || req.body.body === null)) target.body = req.body.body as string | null;
    const state = stringField(req.body, 'state');
    if (state === 'closed' || state === 'open') {
      target.state = state;
      if ('closedAt' in target) target.closedAt = state === 'closed' ? tickIso() : null;
    }
    target.updatedAt = tickIso();
  };
  if ('issue' in found) {
    apply(found.issue);
    if (hasLabels) found.issue.labels = labels;
    return ok(issueJson(repo, found.issue));
  }
  apply(found.pull);
  return ok(pullAsIssueJson(repo, found.pull));
}

function listComments(repo: Repo, number: number): RestReply {
  const found = findIssueOrPull(repo, number);
  if (found === null) return notFound();
  const comments = 'issue' in found ? found.issue.comments : found.pull.comments;
  return ok(comments.map((comment) => commentJson(repo, number, comment)));
}

function createComment(forge: Forge, repo: Repo, req: RestRequest, number: number): RestReply {
  const found = findIssueOrPull(repo, number);
  if (found === null) return notFound();
  const body = stringField(req.body, 'body');
  if (body === undefined) return invalid('Validation Failed: body is required');
  const now = tickIso();
  const comment = { id: forge.allocCommentId(), body, createdAt: now, updatedAt: now };
  ('issue' in found ? found.issue.comments : found.pull.comments).push(comment);
  return ok(commentJson(repo, number, comment), 201);
}

// ------------------------------------------------------------------ pull requests

/** A head/base argument may arrive as "branch" or "owner:branch". */
function branchNameOf(value: string): string {
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function createPull(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const title = stringField(req.body, 'title');
  const headRaw = stringField(req.body, 'head');
  const baseRaw = stringField(req.body, 'base');
  if (title === undefined || title === '') return invalid('Validation Failed: title is required');
  if (headRaw === undefined || baseRaw === undefined) return invalid('Validation Failed: head and base are required');
  const head = branchNameOf(headRaw);
  const base = branchNameOf(baseRaw);
  const headSha = repo.branchTip(head);
  const baseSha = repo.branchTip(base);
  if (baseSha === null) return invalid(`Validation Failed: base branch '${base}' does not exist`);
  if (headSha === null) return invalid(`Validation Failed: head branch '${head}' does not exist`);
  if (head === base) return invalid('Validation Failed: head and base are the same branch');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return invalid(`Validation Failed: a pull request already exists for ${head} into ${base}`);
    }
  }
  const now = tickIso();
  const pull: PullRequest = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title,
    body: stringField(req.body, 'body') ?? null,
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
  return ok(pullJson(repo, pull), 201);
}

function listPulls(repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  const all = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
  const filtered = all.filter((pull) => state === 'all' || pull.state === state);
  const { page, headers } = paginate(req, filtered);
  return { status: 200, body: page.map((pull) => pullJson(repo, pull)), headers };
}

function getPull(repo: Repo, number: number): RestReply {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  return ok(pullJson(repo, pull));
}

function pullFiles(repo: Repo, number: number): RestReply {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  const mergeBase = repo.mergeBase(headTip, baseTip);
  const changes = diffFiles(repo, repo.filesOfCommit(mergeBase), repo.filesOfCommit(headTip));
  const headFiles = repo.filesOfCommit(headTip);
  return ok(
    changes.map((change) => ({
      filename: change.path,
      sha: headFiles.get(change.path)?.oid ?? null,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })),
  );
}

function mergePull(repo: Repo, req: RestRequest, number: number): RestReply {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  if (pull.merged || pull.state !== 'open') return fail(405, 'Pull Request is not mergeable');
  const methodRaw = stringField(req.body, 'merge_method') ?? 'merge';
  if (methodRaw !== 'squash' && methodRaw !== 'merge') return fail(405, `merge method '${methodRaw}' is not supported`);
  const result = mergePullRequest(repo, pull, methodRaw);
  if (!result.ok) return fail(405, `Pull Request is not mergeable: ${result.reason}`);
  return ok({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ------------------------------------------------------------------ router

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
      headers: { 'x-oauth-scopes': 'repo, user' },
    };
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: 'forge-1.0.0', verifiable_password_authentication: false });
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(userJson());
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') return createRepo(forge, req);
    if (method === 'GET') {
      const { page, headers } = paginate(req, forge.reposOf(VIEWER.login));
      return { status: 200, body: page.map(repoJson), headers };
    }
    return notFound();
  }
  if (seg[0] !== 'repos' || seg.length < 3) return notFound();

  const owner = seg[1]!;
  const name = seg[2]!;
  const rest = seg.slice(3);
  const found = repoOr404(forge, owner, name);
  if (isReply(found)) {
    // Creating is the only route that does not need the repository to exist first, and it
    // does not live under /repos — everything here 404s for a missing repository.
    return found;
  }
  const repo = found;

  if (rest.length === 0) {
    if (method === 'GET') return getRepo(repo);
    if (method === 'PATCH') return patchRepo(repo, req);
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }

  const [head, ...tail] = rest as [string, ...string[]];

  if (head === 'contents') {
    const path = tail.join('/');
    if (method === 'GET') return contentsGet(repo, req, path);
    if (method === 'PUT') return contentsPut(repo, req, path);
    if (method === 'DELETE') return contentsDelete(repo, req, path);
    return notFound();
  }
  if (head === 'git' && tail[0] === 'refs') {
    if (tail.length === 1) {
      if (method === 'POST') return createRef(forge, repo, req);
      if (method === 'GET') return listRefs(repo);
      return notFound();
    }
    const ref = `refs/${tail.slice(1).join('/')}`;
    if (method === 'GET') return getRef(repo, ref);
    if (method === 'DELETE') {
      if (!repo.refs.has(ref)) return notFound();
      repo.refs.delete(ref);
      return { status: 204 };
    }
    return notFound();
  }
  if (head === 'branches') {
    if (tail.length === 0) return method === 'GET' ? listBranches(repo) : notFound();
    return method === 'GET' ? getBranch(repo, tail.join('/')) : notFound();
  }
  if (head === 'commits') {
    if (tail.length === 0) return method === 'GET' ? listCommits(repo, req) : notFound();
    if (method === 'GET') {
      const oid = repo.peelToCommit(tail[0]!) ?? (repo.object(tail[0]!)?.type === 'commit' ? tail[0]! : null);
      if (oid === null || repo.commitInfo(oid) === null) return notFound();
      return ok(commitJson(repo, oid));
    }
    return notFound();
  }
  if (head === 'labels') {
    if (tail.length === 0) {
      if (method === 'GET') return ok([...repo.labels.keys()].sort().map((labelName) => labelJson(repo, labelName)));
      if (method === 'POST') return createLabel(forge, repo, req);
      return notFound();
    }
    if (method === 'GET') {
      if (!repo.labels.has(tail.join('/'))) return notFound();
      return ok(labelJson(repo, tail.join('/')));
    }
    return notFound();
  }
  if (head === 'issues') {
    if (tail.length === 0) {
      if (method === 'GET') return listIssues(repo, req);
      if (method === 'POST') return createIssue(forge, repo, req);
      return notFound();
    }
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isInteger(number) || String(number) !== tail[0]) return notFound();
    if (tail.length === 1) {
      if (method === 'GET') return getIssue(repo, number);
      if (method === 'PATCH') return patchIssue(repo, req, number);
      return notFound();
    }
    if (tail[1] === 'comments' && tail.length === 2) {
      if (method === 'GET') return listComments(repo, number);
      if (method === 'POST') return createComment(forge, repo, req, number);
      return notFound();
    }
    return notFound();
  }
  if (head === 'pulls') {
    if (tail.length === 0) {
      if (method === 'GET') return listPulls(repo, req);
      if (method === 'POST') return createPull(forge, repo, req);
      return notFound();
    }
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isInteger(number) || String(number) !== tail[0]) return notFound();
    if (tail.length === 1) return method === 'GET' ? getPull(repo, number) : notFound();
    if (tail[1] === 'files' && tail.length === 2) return method === 'GET' ? pullFiles(repo, number) : notFound();
    if (tail[1] === 'merge' && tail.length === 2) return method === 'PUT' ? mergePull(repo, req, number) : notFound();
    return notFound();
  }
  return notFound();
}
