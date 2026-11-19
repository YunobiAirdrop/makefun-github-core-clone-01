# Forge — a GitHub-compatible git forge in one process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/YunobiAirdrop/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/YunobiAirdrop/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

A standalone forge for the github-core-clone-01 contest. One Node 22 process,
standard library only, serves four surfaces from a single in-memory store:

- **git smart HTTP** at `/<owner>/<repo>.git` — upload-pack protocol v2
  (capability advertisement, `ls-refs`, `fetch` with shallow/deepen support)
  and receive-pack v0 with report-status and side-band-64k.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests (including squash merges with
  three-way conflict detection).
- **GraphQL v4** at `/api/graphql` — the viewer/repository/issue/pull-request
  documents `gh` and `github-mcp-server` send, introspection, Relay global
  ids, cursor pagination and operation batching.
- **MCP** at `/mcp` — streamable-HTTP JSON-RPC speaking revision 2026-07-28
  (`server/discover`) with a legacy `initialize` handshake; six tools that act
  on the same store as REST.

## Run

```sh
MAKEFUN_ENV_URL=http://store:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` and exits 0
when the env says the trial is over.

## Performance shape

- Issue and repository reads answer from pre-serialised JSON cached at write
  time, so the 2,000-read workload never re-stringifies.
- Receive-pack ingests each pack in a single pass; fetch packs are memoised
  per want/have/depth set, so concurrent shallow clones share one pack build.
- Commit ancestry and tree flattening are memoised per object id.
