import { realpath } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CREATE_INDEX_TIMEOUT_MS, ensureWorktreeIndex, hasLocalIndex } from "./server/worktree-index";
import type { IndexResult } from "./server/worktree-index";
import { listRpc, retryRpc } from "./shared/worktree-index";
import type { WorkspaceIndexStatus } from "./shared/worktree-index";

export default function contribute(server: PluginServerContext) {
  const lifetime = new AbortController();
  const prepared = new Map<string, IndexResult>();
  const statuses = new Map<string, WorkspaceIndexStatus>();
  const running = new Set<string>();

  const remember = (workspace: { id: string; cwd: string; name: string | null }, result: IndexResult) => {
    statuses.set(workspace.id, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      name: workspace.name,
      ...result,
      updatedAt: new Date().toISOString(),
    });
    if (result.state === "error") {
      console.warn(`[worktree-index] ${workspace.cwd}: ${result.detail}`);
    }
  };

  const releasePrepare = server.addHook("worktree.create.after", async ({ worktree }) => {
    const cwd = await realpath(worktree.path).catch(() => worktree.path);
    try {
      if (!(await hasLocalIndex(cwd)) && !(await hasLocalIndex(worktree.sourceCheckout))) return;

      const result = await ensureWorktreeIndex(cwd, {
        timeoutMs: CREATE_INDEX_TIMEOUT_MS,
        signal: lifetime.signal,
      });
      prepared.set(cwd, result);
    } catch (error) {
      prepared.set(cwd, { state: "error", detail: String(error), fileCount: null });
    }
  });

  const releaseWorkspace = server.addHook("workspace.create.after", async ({ workspace }) => {
    const cwd = await realpath(workspace.cwd).catch(() => workspace.cwd);
    const result = prepared.get(cwd);
    if (!result) return;
    prepared.delete(cwd);
    if (!workspace.archivedAt) remember(workspace, result);
  });

  const releaseArchive = server.addHook("workspace.archive.after", async ({ workspace }) => {
    statuses.delete(workspace.id);
  });

  server.handle(listRpc, () => ({
    workspaces: [...statuses.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));

  server.handle(retryRpc, ({ workspaceId }) => {
    const current = statuses.get(workspaceId);
    if (current?.state !== "error" || running.has(current.cwd) || lifetime.signal.aborted) {
      return { accepted: false };
    }
    running.add(current.cwd);
    statuses.set(workspaceId, { ...current, state: "indexing", detail: null, updatedAt: new Date().toISOString() });
    void ensureWorktreeIndex(current.cwd, { timeoutMs: 30 * 60_000, signal: lifetime.signal })
      .then((result) => {
        if (!statuses.has(workspaceId)) return;
        remember({ id: workspaceId, cwd: current.cwd, name: current.name }, result);
      })
      .finally(() => running.delete(current.cwd));
    return { accepted: true };
  });

  return () => {
    lifetime.abort();
    releasePrepare();
    releaseWorkspace();
    releaseArchive();
  };
}
