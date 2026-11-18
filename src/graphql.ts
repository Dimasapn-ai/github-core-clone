// graphql.ts: the GraphQL v4 surface at POST /api/graphql — a hand-written lexer/parser for
// the document shapes gh and github-mcp-server send, and a schema-driven executor over the
// same store the REST and git surfaces use. Relay global ids come from ids.ts; unknown fields
// are GraphQL errors in a 200 body, never HTTP errors.

import {
  VIEWER,
  diffFiles,
  mergePullRequest as mergePullInStore,
  pullRequestConflicts,
  tickIso,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { globalId, decodeGlobalId } from './ids.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (pos < source.length) {
    const ch = source[pos]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (source.startsWith('...', pos)) {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', pos)) {
        const end = source.indexOf('"""', pos + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(pos + 3, end) });
        pos = end + 3;
        continue;
      }
      let value = '';
      pos += 1;
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') {
          const escape = source[pos + 1]!;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escape === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(pos + 2, pos + 6), 16));
            pos += 6;
          } else if (simple[escape] !== undefined) {
            value += simple[escape];
            pos += 2;
          } else {
            throw new Error(`invalid string escape \\${escape}`);
          }
        } else {
          value += source[pos];
          pos += 1;
        }
      }
      if (pos >= source.length) throw new Error('unterminated string');
      pos += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let end = pos + 1;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(pos));
      if (match === null) throw new Error(`invalid number at ${pos}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      pos += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${pos}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, Value>;
  selectionSet?: Selection[];
}

type Selection =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; selectionSet: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selectionSet: Selection[] }>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition?: string; selectionSet: Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error('unexpected token at the top level of the document');
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseSelectionSet(): Selection[] {
    const selections: Selection[] = [];
    this.expectPunct('{');
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: this.expectName() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : new Map<string, Value>();
    this.skipDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: Value[] = [];
          while (!this.skipPunct(']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: Value }[] = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        break;
    }
    throw new Error('unexpected token in a value');
  }
}

// ------------------------------------------------------------------ values and context

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Document['fragments'];
  errors: { message: string; path?: (string | number)[] }[];
}

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of node.args) out[name] = resolveValue(value, ctx);
  return out;
}

class GqlError extends Error {}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------ domain values

type Resolver = (parent: any, args: Record<string, unknown>, ctx: Ctx) => unknown;

function repoByDbId(forge: Forge, dbId: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function userValue(): Record<string, unknown> {
  return { __typename: 'User' };
}

function repoValue(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pull };
}

function commentValue(repo: Repo, number: number, comment: Issue['comments'][number]): Record<string, unknown> {
  return { __typename: 'IssueComment', repo, number, comment };
}

function pageInfoValue(hasNextPage: boolean, hasPreviousPage: boolean, endCursor: string | null, startCursor: string | null): Record<string, unknown> {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage, endCursor, startCursor };
}

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match === null ? -1 : Number(match[1]);
}

/** Slice a full, already-ordered list into a connection value by first/after. */
function connection(typename: string, items: readonly Record<string, unknown>[], args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const afterIndex = args.after === undefined || args.after === null ? -1 : cursorIndex(args.after);
  const start = afterIndex + 1;
  const nodes = items.slice(start, start + first);
  return {
    __typename: typename,
    nodes,
    pageInfo: pageInfoValue(start + nodes.length < items.length, start > 0, nodes.length > 0 ? cursorOf(start + nodes.length - 1) : null, nodes.length > 0 ? cursorOf(start) : null),
    totalCount: items.length,
  };
}

function addIssue(forge: Forge, repo: Repo, title: string, body: string | null): Issue {
  const now = tickIso();
  const issue: Issue = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title,
    body,
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
  return issue;
}

function addPull(forge: Forge, repo: Repo, title: string, body: string | null, headRef: string, baseRef: string): PullRequest {
  const now = tickIso();
  const pull: PullRequest = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headShaAtCreate: repo.branchTip(headRef) ?? '',
    baseShaAtCreate: repo.branchTip(baseRef) ?? '',
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
  return pull;
}

/** Decode a global id that must name a repository; throws a GraphQL error otherwise. */
function repoFromGlobalId(ctx: Ctx, id: unknown): Repo {
  const decoded = decodeGlobalId(asString(id));
  if (decoded === null || decoded.kind !== 'Repository') throw new GqlError(`'${asString(id)}' is not a repository id`);
  const repo = repoByDbId(ctx.forge, Number(decoded.parts[0]));
  if (repo === undefined) throw new GqlError('the repository does not exist');
  return repo;
}

function issueFromGlobalId(ctx: Ctx, id: unknown): { repo: Repo; issue: Issue } {
  const decoded = decodeGlobalId(asString(id));
  if (decoded === null || decoded.kind !== 'Issue') throw new GqlError(`'${asString(id)}' is not an issue id`);
  const repo = repoByDbId(ctx.forge, Number(decoded.parts[0]));
  const issue = repo?.issues.get(Number(decoded.parts[1]));
  if (repo === undefined || issue === undefined) throw new GqlError('the issue does not exist');
  return { repo, issue };
}

function pullFromGlobalId(ctx: Ctx, id: unknown): { repo: Repo; pull: PullRequest } {
  const decoded = decodeGlobalId(asString(id));
  if (decoded === null || decoded.kind !== 'PullRequest') throw new GqlError(`'${asString(id)}' is not a pull request id`);
  const repo = repoByDbId(ctx.forge, Number(decoded.parts[0]));
  const pull = repo?.pulls.get(Number(decoded.parts[1]));
  if (repo === undefined || pull === undefined) throw new GqlError('the pull request does not exist');
  return { repo, pull };
}

// ------------------------------------------------------------------ the schema

const schema: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userValue(),
    repository: (_parent, args, ctx) => {
      const repo = ctx.forge.repo(asString(args.owner), asString(args.name));
      return repo === undefined ? null : repoValue(repo);
    },
    node: (_parent, args, ctx) => {
      const decoded = decodeGlobalId(asString(args.id));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoByDbId(ctx.forge, Number(decoded.parts[0]));
        return repo === undefined ? null : repoValue(repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = repoByDbId(ctx.forge, Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo === undefined || issue === undefined ? null : issueValue(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = repoByDbId(ctx.forge, Number(decoded.parts[0]));
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        return repo === undefined || pull === undefined ? null : pullValue(repo, pull);
      }
      if (decoded.kind === 'User') return userValue();
      return null;
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const title = asString(input.title);
      if (title === '') throw new GqlError('title is required');
      const issue = addIssue(ctx.forge, repo, title, typeof input.body === 'string' ? input.body : null);
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const { repo, issue } = issueFromGlobalId(ctx, input.issueId);
      issue.state = 'closed';
      issue.closedAt = tickIso();
      issue.updatedAt = tickIso();
      return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const headRef = asString(input.headRefName);
      const baseRef = asString(input.baseRefName);
      if (repo.branchTip(baseRef) === null) throw new GqlError(`base ref '${baseRef}' does not exist`);
      if (repo.branchTip(headRef) === null) throw new GqlError(`head ref '${headRef}' does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
          throw new GqlError('a pull request already exists for this head and base');
        }
      }
      const pull = addPull(ctx.forge, repo, asString(input.title), typeof input.body === 'string' ? input.body : null, headRef, baseRef);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const { repo, pull } = pullFromGlobalId(ctx, input.pullRequestId);
      const method = asString(input.mergeMethod) === 'MERGE' ? 'merge' : 'squash';
      const result = mergePullInStore(repo, pull, method);
      if (!result.ok) throw new GqlError(`the pull request is not mergeable: ${result.reason}`);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const body = asString(input.body);
      const decoded = decodeGlobalId(asString(input.subjectId));
      if (decoded === null || (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest')) throw new GqlError('the subject is not commentable');
      const repo = repoByDbId(ctx.forge, Number(decoded.parts[0]));
      if (repo === undefined) throw new GqlError('the subject does not exist');
      const number = Number(decoded.parts[1]);
      const target = decoded.kind === 'Issue' ? repo.issues.get(number) : repo.pulls.get(number);
      if (target === undefined) throw new GqlError('the subject does not exist');
      const now = tickIso();
      const comment = { id: ctx.forge.allocCommentId(), body, createdAt: now, updatedAt: now };
      target.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentValue(repo, number, comment), cursor: null },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    id: () => globalId('User', VIEWER.id),
    login: () => VIEWER.login,
    name: () => VIEWER.login,
    avatarUrl: () => '',
    url: () => '',
  },
  Repository: {
    id: (parent) => globalId('Repository', (parent.repo as Repo).id),
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => (parent.repo as Repo).fullName,
    description: (parent) => (parent.repo as Repo).description,
    isPrivate: (parent) => (parent.repo as Repo).isPrivate,
    owner: () => userValue(),
    defaultBranchRef: (parent) => ({ __typename: 'Ref', name: (parent.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (parent) => (parent.repo as Repo).createdAt,
    updatedAt: (parent) => (parent.repo as Repo).updatedAt,
    url: () => '',
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const issue = repo.issues.get(asInt(args.number));
      return issue === undefined ? null : issueValue(repo, issue);
    },
    issues: (parent, args) => {
      const repo = parent.repo as Repo;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(asString) : null;
      if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
      const descending = orderBy !== null && asString(orderBy.direction) === 'DESC';
      list.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
      return connection('IssueConnection', list.map((issue) => issueValue(repo, issue)), args);
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = repo.pulls.get(asInt(args.number));
      return pull === undefined ? null : pullValue(repo, pull);
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as Repo;
      let list = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(asString) : ['OPEN'];
      list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      list.sort((a, b) => a.seq - b.seq);
      return connection('PullRequestConnection', list.map((pull) => pullValue(repo, pull)), args);
    },
  },
  Ref: {
    name: (parent) => parent.name as string,
  },
  Issue: {
    id: (parent) => globalId('Issue', (parent.repo as Repo).id, (parent.issue as Issue).number),
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    body: (parent) => (parent.issue as Issue).body,
    state: (parent) => (parent.issue as Issue).state.toUpperCase(),
    author: () => userValue(),
    repository: (parent) => repoValue(parent.repo as Repo),
    labels: (parent) => ({
      __typename: 'LabelConnection',
      nodes: (parent.issue as Issue).labels.map((name) => ({ __typename: 'Label', name, color: (parent.repo as Repo).labels.get(name)?.color ?? '000000' })),
    }),
    comments: (parent) => ({
      __typename: 'IssueCommentConnection',
      nodes: (parent.issue as Issue).comments.map((comment) => commentValue(parent.repo as Repo, (parent.issue as Issue).number, comment)),
      totalCount: (parent.issue as Issue).comments.length,
    }),
    createdAt: (parent) => (parent.issue as Issue).createdAt,
    updatedAt: (parent) => (parent.issue as Issue).updatedAt,
    closedAt: (parent) => (parent.issue as Issue).closedAt,
    url: () => '',
  },
  PullRequest: {
    id: (parent) => globalId('PullRequest', (parent.repo as Repo).id, (parent.pull as PullRequest).number),
    number: (parent) => (parent.pull as PullRequest).number,
    title: (parent) => (parent.pull as PullRequest).title,
    body: (parent) => (parent.pull as PullRequest).body,
    state: (parent) => {
      const pull = parent.pull as PullRequest;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (parent) => (parent.pull as PullRequest).merged,
    mergeable: (parent) => (pullRequestConflicts(parent.repo as Repo, parent.pull as PullRequest) ? 'CONFLICTING' : 'MERGEABLE'),
    headRefName: (parent) => (parent.pull as PullRequest).headRef,
    baseRefName: (parent) => (parent.pull as PullRequest).baseRef,
    headRef: (parent) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      return repo.branchTip(pull.headRef) === null ? null : { __typename: 'Ref', name: pull.headRef };
    },
    baseRef: (parent) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      return repo.branchTip(pull.baseRef) === null ? null : { __typename: 'Ref', name: pull.baseRef };
    },
    files: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
      const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
      const mergeBase = repo.mergeBase(headTip, baseTip);
      const changes = diffFiles(repo, repo.filesOfCommit(mergeBase), repo.filesOfCommit(headTip));
      const nodes = changes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path, additions: change.additions, deletions: change.deletions }));
      return connection('PullRequestChangedFileConnection', nodes, args);
    },
    author: () => userValue(),
    createdAt: (parent) => (parent.pull as PullRequest).createdAt,
    updatedAt: (parent) => (parent.pull as PullRequest).updatedAt,
    mergedAt: (parent) => (parent.pull as PullRequest).mergedAt,
    url: () => '',
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path,
    additions: (parent) => parent.additions,
    deletions: (parent) => parent.deletions,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    endCursor: (parent) => parent.endCursor,
    startCursor: (parent) => parent.startCursor,
  },
  LabelConnection: {
    nodes: (parent) => parent.nodes,
  },
  Label: {
    name: (parent) => parent.name,
    color: (parent) => parent.color,
  },
  IssueCommentConnection: {
    nodes: (parent) => parent.nodes,
    totalCount: (parent) => parent.totalCount,
  },
  IssueComment: {
    id: (parent) => globalId('IssueComment', (parent.repo as Repo).id, parent.number as number, (parent.comment as Issue['comments'][number]).id),
    body: (parent) => (parent.comment as Issue['comments'][number]).body,
    author: () => userValue(),
    createdAt: (parent) => (parent.comment as Issue['comments'][number]).createdAt,
    updatedAt: (parent) => (parent.comment as Issue['comments'][number]).updatedAt,
  },
  CommentEdge: {
    node: (parent) => parent.node,
    cursor: (parent) => parent.cursor,
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  __Type: {
    name: (parent) => parent.name,
    kind: (parent) => parent.kind,
    description: () => null,
    fields: (parent) => (parent.fieldNames === null ? null : (parent.fieldNames as string[]).map((name) => ({ __typename: '__Field', name }))),
    enumValues: (parent) => (parent.enumNames === null ? null : (parent.enumNames as string[]).map((name) => ({ __typename: '__EnumValue', name }))),
  },
  __Field: {
    name: (parent) => parent.name,
  },
  __EnumValue: {
    name: (parent) => parent.name,
  },
};

// ------------------------------------------------------------------ introspection data

const ENUM_TYPES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function typeValue(name: string): Record<string, unknown> | null {
  if (ENUM_TYPES[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'ENUM', fieldNames: null, enumNames: ENUM_TYPES[name] };
  }
  const fields = schema[name];
  if (fields !== undefined) {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: Object.keys(fields), enumNames: null };
  }
  return null;
}

// ------------------------------------------------------------------ executor

function expandSelections(selections: readonly Selection[], parentType: string, ctx: Ctx, out: FieldNode[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === parentType) {
        expandSelections(selection.selectionSet, parentType, ctx, out);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === undefined || fragment.typeCondition === parentType)) {
        expandSelections(fragment.selectionSet, parentType, ctx, out);
      }
    }
  }
}

function completeValue(value: unknown, node: FieldNode, ctx: Ctx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry, index) => completeValue(entry, node, ctx, [...path, index]));
  if (isRecord(value) && typeof value.__typename === 'string') {
    if (node.selectionSet === undefined) return null;
    return executeSelectionSet(value.__typename, value, node.selectionSet, ctx, path);
  }
  return value;
}

function executeSelectionSet(typeName: string, parent: unknown, selections: readonly Selection[], ctx: Ctx, path: (string | number)[]): Record<string, unknown> {
  const fields: FieldNode[] = [];
  expandSelections(selections, typeName, ctx, fields);
  const out: Record<string, unknown> = {};
  for (const node of fields) {
    const responseKey = node.alias ?? node.name;
    const fieldPath = [...path, responseKey];
    if (node.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    if (typeName === 'Query' && node.name === '__type') {
      const args = argsOf(node, ctx);
      out[responseKey] = completeValue(typeValue(asString(args.name)), node, ctx, fieldPath);
      continue;
    }
    const resolver = schema[typeName]?.[node.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(parent, argsOf(node, ctx), ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, node, ctx, fieldPath);
  }
  return out;
}

// ------------------------------------------------------------------ entry point

function runOperation(forge: Forge, operation: unknown): Record<string, unknown> {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { errors: [{ message: 'a GraphQL operation needs a query string' }] };
  }
  let document: Document;
  try {
    document = new Parser(operation.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: `could not parse the document: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
  const chosen = operationName === undefined ? document.operations[0] : document.operations.find((entry) => entry.name === operationName);
  if (chosen === undefined) return { errors: [{ message: 'no operation to run' }] };
  const ctx: Ctx = {
    forge,
    variables: isRecord(operation.variables) ? operation.variables : {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = chosen.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __typename: rootType }, chosen.selectionSet, ctx, []);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** Answer one POST /api/graphql body (one operation, or an array of them for batching). */
export function handleGraphQL(forge: Forge, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) return { status: 200, body: body.map((operation) => runOperation(forge, operation)) };
  return { status: 200, body: runOperation(forge, body) };
}
