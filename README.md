# paseo-codegraph-worktree

Paseo plugin that initializes a local CodeGraph index before the first agent starts in a new worktree. Requires Paseo 0.17.4 or later and CodeGraph on the daemon host.

The plugin uses `worktree.create.after`. A local index in the source checkout enables indexing for new worktrees. A new worktree gets one `codegraph init --yes` run unless it already has a complete local index. CodeGraph MCP handles subsequent changes.

The worktree can open if indexing fails or exceeds the 25-second command budget. The **Worktree index** sidebar shows the result and offers **Retry** on errors. Paseo skips the creation hook when restoring a missing worktree. From a restored worktree without an index, run `codegraph init --yes .`.

Set `CODEGRAPH_BIN` on the daemon to select a specific executable. Otherwise the plugin checks the installed nvm Node versions and common binary locations before falling back to `PATH`.

## Develop

```sh
npm ci
npm run typecheck
npm test
```

Install the local plugin source with `paseo plugin install /absolute/path/to/paseo-codegraph-plugin`.
