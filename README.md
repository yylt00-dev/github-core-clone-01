# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yylt00-dev/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yylt00-dev/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only — no `git` binary, no dependencies. It implements the git smart-HTTP protocol from scratch (v0 and v2: ref advertisement, ls-refs, fetch with shallow/deepen negotiation, receive-pack pushes with per-ref reports, packfile reading with delta resolution and packfile writing on node:zlib/node:crypto), the REST v3 surface (repositories, branches, commits, the contents API that authors real commits, git refs, labels, issues, comments, pull requests with three-way merges), the GraphQL v4 documents gh and github-mcp-server send (viewer, repository reads, issue/pull-request connections with cursor pagination, the create/close/merge mutations, node(id:) and __type introspection), and an MCP streamable-HTTP endpoint whose six tools act on the same store as REST. Everything is held in memory; the server registers its ephemeral port with the harness env and serves until the trial ends.

## Run it

```sh
node --experimental-strip-types main.ts
```

Requires Node 22.18+ and `MAKEFUN_ENV_URL` pointing at the harness env (the entry registers its port there and polls `/done`); `MAKEFUN_SHOP_TOKEN` is the bearer token the API surfaces check.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cyjtwd3n&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
