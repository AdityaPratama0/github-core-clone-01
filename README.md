# Standalone GitHub-compatible forge

A single-process Node 22 implementation for the [make.fun GitHub forge bounty](https://make.fun/bounty/github-core-clone-01). Git smart HTTP, REST v3, GraphQL and MCP share an in-memory repository and object store. No install step, git executable, database or external service is needed at runtime.

## Run

Use Node 22 with native TypeScript stripping (tested on v22.23.5). Provide `MAKEFUN_SHOP_TOKEN` through the environment; do not save credentials in this repository.

```sh
node main.ts
```

Without `MAKEFUN_ENV_URL`, the server prints its loopback URL and stays up. It binds `0.0.0.0` on an ephemeral port. Set `FORGE_LOGIN` to configure the single owner's login. When omitted, the first authenticated owner-qualified repository request establishes the login; before that, owner fields return `owner`. This bootstrap supports the kit's opaque token contract, which supplies no separate owner login.

With `MAKEFUN_ENV_URL` set, the entry starts its listener, registers `{port}` at `/register`, polls `/done`, and exits 0 after the suite finishes. Port 8080 is reserved for the suite. SIGINT and SIGTERM shut down the listener.

Every API request requires `Authorization: Bearer` with the configured token. `GET /healthz` is public.

## Implemented surface

- Git: `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, and `git-receive-pack`. Protocol v2 advertisement, ls-refs, shallow clone and deepen, incremental fetch, v0 receive-pack, per-ref fast-forward refusal, branch/tag creation and deletion, sideband framing, pack checksums, and inbound OFS_DELTA/REF_DELTA resolution. Outbound packs contain plain compressed objects.
- REST: `/api/v3` repositories, pagination, branches, refs, commits, base64 contents with optimistic SHA checks, labels, issues, comments, pull requests, changed files and squash merges.
- GraphQL: `/api/graphql`, with a vendored GraphQL parser, validator and executor. Includes introspection, Relay node IDs, issue cursors, query batching and issue/PR mutations.
- MCP: `/mcp`, JSON-RPC over HTTP JSON, discovery and initialization, plus `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and `merge_pull_request`.

The store is intentionally ephemeral: restarting loses repositories and API data. It has one bearer token and one owner. Merge conflict detection compares complete file objects; it does not merge independent edits within the same file. Changed-file addition/deletion counts count whole versions rather than computing a minimal line diff. This implements the bounty's required API subset, not the entire GitHub API.

## Verification

Download and unpack the [official kit](https://make.fun/c/github-core-clone-01/kit) outside this repository. The following commands need only Node 22 and that kit:

```sh
node tests/smoke.mjs
node --experimental-strip-types tests/conformance.mjs /absolute/path/to/github-core-clone-01-kit reports/conformance.json
node --experimental-strip-types tests/lifecycle.mjs /absolute/path/to/github-core-clone-01-kit reports/lifecycle.json
```

`conformance.mjs` drives the official `sdk/run.ts` with all checks and four benchmarks. It also inspects every check result, since the official runner's exit code alone does not indicate conformance success. Credentials are generated in memory and excluded from saved reports.

`lifecycle.mjs` starts the official environment and scorer and launches the actual `main.ts` as a child process twice. It requires successful registration, boot, all 120 checks, clean exit and byte-identical `state.json` exports. Temporary environment exports are removed afterward.

Saved local results:

- `reports/conformance.json`: 120/120 checks, including 15/15 MCP; feature 600, agent 200, performance 171, score 971/1000.
- `reports/lifecycle.json`: two fresh entrypoint runs, each 120/120 and exit 0; local scores 970 and 972. Their 3,390-byte state exports share SHA-256 `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`.

These are local, unisolated measurements using the published suite and its fixed SDK scenario. The Docker grading driver, all generated practice instances and the sealed final instances have not been verified. Performance varies with the machine and load.

## Source map and licensing

`main.ts` owns registration and shutdown. `src/app.ts` handles HTTP and authentication; `src/git.ts` implements objects and the wire protocol; `src/store.ts` owns shared domain operations; `src/rest.ts`, `src/graphql.ts` and `src/mcp.ts` expose them.

Project source is MIT licensed. `vendor/graphql.mjs` bundles GraphQL.js 16.15.0 from its `index.mjs` with esbuild (`--bundle --platform=node --format=esm`); its MIT license is preserved in `vendor/graphql.LICENSE`. Build tools are not needed to run the committed bundle.

The task ends at a local commit when no git remote exists. Publication and bounty submission are separate: the venue requires an entrant-owned public repository and authentic harness-recorded session transcripts. No submission or upload has been made here.
