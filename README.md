[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dimasapn-ai/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dimasapn-ai/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# bot-forge

A GitHub-compatible git forge in one Node process, built for the make.fun competition
`github-core-clone-01`. It serves four surfaces from a single in-memory store — git smart
HTTP, the REST v3 API, GraphQL v4 and an MCP endpoint — with no UI, no database and no
dependencies beyond the Node standard library.

Run it the way the harness does:

```sh
node /bot/main.ts        # needs MAKEFUN_ENV_URL (and MAKEFUN_SHOP_TOKEN) in the environment
```

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, POST the port to
`$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`, exit 0). `app.ts` builds the HTTP
server; all forge state lives in one `Forge` instance created there.

## Architecture

```
main.ts            lifecycle only (the harness's file, kept as the starter shipped it)
app.ts             routing, bearer-token auth, body framing, X-GitHub-Request-Id
src/store.ts       the store: repositories, git objects, refs, issues, pull requests,
                   labels, comments; tree flatten/rebuild, merge-base, three-way merge,
                   line diffs; a deterministic logical clock for API timestamps
src/git.ts         the git object model and packfile format: SHA-1 object ids, commit/tree
                   parsing and building, pkt-lines, pack reading (OFS_DELTA and REF_DELTA
                   application included) and pack writing, delta application
src/gitserver.ts   git smart HTTP: info/refs advertisement (v0 and v2), upload-pack
                   (v2 ls-refs and fetch, v0 fetch; shallow and deepen), receive-pack
                   (v0, report-status in side-band-64k, fast-forward enforcement)
src/rest.ts        REST v3: repositories, contents, git refs, branches, commits, labels,
                   issues, comments, pull requests; GitHub shapes, statuses, Link pagination
src/graphql.ts     GraphQL: a hand-written lexer/parser for the documents gh and
                   github-mcp-server send, and a schema-driven executor; Relay global ids,
                   cursor connections, the five mutations the suite drives, introspection
src/ids.ts         global ids: base64 of "<Kind>:<parts>", decodable by node(id:)
src/mcp.ts         MCP over Streamable HTTP: server/discover (2026-07-28) plus the legacy
                   initialize handshake; eight tools over the same store
```

### The store

Everything is in memory, per repository: a content-addressed object map (`oid → {type,
data}`), a ref map, and the issue/pull-request/label tables. The contents API and merges
write **real git objects** — a contents PUT builds the blob, rebuilds the tree chain and
commits on the branch ref — so the git protocol, REST, GraphQL and MCP can never disagree
about what a branch holds. Issues and pull requests share one per-repository number
sequence, as on GitHub. API timestamps come from a logical clock (a fixed base plus a
counter), which keeps behaviour deterministic across runs.

### Git smart HTTP

- Advertisement: protocol v2 for `git-upload-pack` when the client asks (`version 2`,
  `ls-refs=unborn`, `fetch=shallow wait-for-done`, `object-format=sha1`); v0 otherwise and
  always for `git-receive-pack`, with the capability sets real clients look for
  (`report-status`, `side-band-64k`, `delete-refs`, `symref=HEAD:…`).
- Fetch: the server computes the wants' generation graph, subtracts what the client holds
  (the closure of its haves, stopping at the shallow commits it names), applies the depth
  limit the `deepen` line carries, and answers with `acknowledgments`, `shallow-info`
  (new boundary `shallow`, lifted boundary `unshallow`) and a `packfile` section of
  side-band-64k packets. Packs are written undeltified; pack *reading* applies both delta
  kinds, so deltified pushes from real git clients ingest correctly. A fetch for objects
  the client already holds answers acknowledgments only, with no packfile section.
- Push: the pack is ingested (thin packs resolve their bases against the store), then each
  ref update is validated — branches must fast-forward, the default branch cannot be
  deleted, creates must name a stored object — and applied independently, with one
  `ok`/`ng` report-status line per ref (`non-fast-forward` is reported verbatim). A
  malformed body is an `unpack` error in the report, never a dead server.

### REST v3

Repositories (create/read/update/delete, `GET /user/repos` with `Link` pagination),
contents (create/update with sha checks — a stale sha is a 409 — read file or directory,
delete), git refs (create/read/list/delete), branches, commits (reachable set of a ref,
newest first), labels, issues (state/sort/direction filters, comments), and pull requests
(create/read/list, changed files against the merge base with LCS line counts, squash and
merge merges with a real three-way tree merge — a conflict is a 405). Errors are GitHub
shaped (`{"message": …}`), unknown routes are JSON 404s, a malformed JSON body is a 400,
and every reply carries `X-GitHub-Request-Id`. The issues list includes pull requests in
issue shape, as GitHub's does.

### GraphQL

`POST /api/graphql` (plus operation batching: an array body answers an array, in order).
The executor covers the query and mutation shapes the suite sends: `viewer`, `repository`
with `issue`/`issues` (states filter, `CREATED_AT` ordering, cursor pagination with
`pageInfo`), `pullRequest`/`pullRequests`, `node(id:)`, `__type` introspection for the
types gh probes, and the mutations `createIssue`, `closeIssue`, `createPullRequest`,
`mergePullRequest` and `addComment`. Global ids are opaque, stable and round-trip through
`node(id:)` and the mutations. An unknown field is a 200 with an `errors` array naming it;
an unknown repository is `data.repository = null` with no errors; no token is a 401.

### MCP

`POST /mcp` speaks JSON-RPC 2.0. `server/discover` answers the 2026-07-28 revision
(supported versions, capabilities, server info) so no handshake or session is needed; the
legacy `initialize` + `notifications/initialized` handshake is answered too. Eight tools —
`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`,
`create_pull_request`, `list_pull_requests`, `merge_pull_request` — act on the same store
and return the REST shapes, so an object created over MCP reads back over `/api/v3`
identically. `tools/list` is a constant (byte-identical across calls); an unknown tool or
missing required arguments answer JSON-RPC -32602; a non-JSON body answers HTTP 400 with
-32700; no token answers 401.

### Auth

One bearer token: the process's `MAKEFUN_SHOP_TOKEN`. It stands for one user — the suite
scenario's viewer, `adaiversen` (id 1000) — who owns every repository. A repository that
does not exist under the named owner is a 404, never a 403. `/healthz` and the API root
are the only unauthenticated routes.

## Performance

The timed workloads run against the same code paths as everything else; the hot loops are
plain `Map` lookups and small JSON documents. Local medians (this machine, the kit's
runner, reference times in parentheses): push 444 ms (1641), clone 106 ms (267),
read 630 ms (2760), write 142 ms (349).

## Known limits

- **Volatile state.** Everything is in memory; a restart starts from an empty forge. That
  is the contest's shape (one process per trial), not a deployment suggestion.
- **One user.** There are no accounts, organizations, collaborators or permission levels;
  the token's owner is the only identity, and `viewerPermission` is always `ADMIN`.
- **REST subset.** Only the resources listed above; no search, webhooks, releases, actions,
  or review/comment sub-resources beyond issue comments. Renaming a repository via PATCH
  is ignored (description, privacy and default branch do apply).
- **Merges.** Squash and merge-commit merges are implemented; rebase merges answer 405.
  The three-way merge is file-level: two sides changing the same file differently
  conflict, even if the edits touch disjoint lines.
- **GraphQL subset.** The schema is the surface described above — no `search`, no
  commits/refs queries, no subscriptions; introspection reports field and enum *names*
  for the types the clients probe, not full type signatures.
- **Git subset.** No pack bitmaps, no multi-pack indexes, no `filter` (partial clone)
  support, no SSH transport; upload-pack v0 is implemented for completeness but the
  suite's client negotiates v2. Server-side commits (contents writes, merges) are
  authored by the viewer identity with logical-clock timestamps.
