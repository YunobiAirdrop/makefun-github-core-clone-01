# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/YunobiAirdrop/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/YunobiAirdrop/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process using only the standard library — no npm dependencies. It serves git smart HTTP (protocol v0 and v2, with its own object store, packfile generation/parsing including deltas, shallow fetch and fast-forward-only push), the REST v3 API (repos, contents, branches, commits, labels, issues, comments, pull requests with squash/merge), a GraphQL v4 endpoint with introspection, Relay global ids, cursor pagination and mutations, and an MCP streamable-HTTP endpoint (server/discover plus the legacy initialize handshake) — all over one shared in-memory store, fully deterministic.

## Run it

```sh
node --experimental-strip-types main.ts
```
(dengan MAKEFUN_ENV_URL dan MAKEFUN_SHOP_TOKEN diatur oleh harness make.fun; program mengikat port ephemeral, mendaftar ke env, melayani sampai env menyatakan selesai)

---
<sub>Entered on [make.fun](https://make.fun/?ref=zqdg0kc1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
