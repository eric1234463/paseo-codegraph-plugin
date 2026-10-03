# paseo-codegraph-worktree

Paseo plugin (pinned to Paseo **0.10.0** SDK) that keeps CodeGraph working inside
git worktrees.

## Problem

`.codegraph/*` is gitignored, so `git worktree add` produces a worktree whose
`.codegraph/` holds only `.gitignore` — no index. Agents in that worktree get no
(or stale) code intelligence until someone runs a slow full `codegraph index`.

## What it does

On `workspace.created`, the server hook brings the workspace index to `ready`:

1. **Missing/corrupt db** → hot-clone `codegraph.db` from the main checkout
   (`sqlite3 … "VACUUM INTO …"`, atomic temp-file + rename, never copies daemon
   sockets/pids), then `codegraph sync` to reconcile the worktree's HEAD.
   File paths in the db are relative, so the clone is valid across worktrees.
2. **No source db** → full `codegraph index` in the worktree.
3. **Existing index** → `codegraph sync` verify + repair only, never overwritten.

The sidebar surface ("Worktree index", Database icon) lists per-workspace state
(`pending → cloning → syncing → ready`, or `indexing` / `error` / `skipped`),
file counts, and a Retry button. It polls `worktree-index.list` every 5s.

## Develop

```sh
npm install
npm run typecheck
npm test
```

Install into Paseo from this directory:

```sh
paseo plugin install /Users/eric/personal-project/paseo-codegraph-plugin
```
