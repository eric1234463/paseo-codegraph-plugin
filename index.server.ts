import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ensureWorktreeIndex, isValidWorkspaceId } from "./server/worktree-index";
import type { StatusUpdate, WorkspaceRef } from "./server/worktree-index";
import { listRpc, retryRpc } from "./shared/worktree-index";
import type { WorkspaceIndexStatus } from "./shared/worktree-index";

export default function contribute(server: PluginServerContext) {
  const lifetime = new AbortController();
  const statuses = new Map<string, WorkspaceIndexStatus>();
  const running = new Set<string>();

  const now = () => new Date().toISOString();
  const remember = (update: StatusUpdate) => {
    statuses.set(update.workspaceId, {
      workspaceId: update.workspaceId,
      cwd: update.cwd,
      name: update.name,
      state: update.state,
      detail: update.detail,
      fileCount: update.fileCount,
      updatedAt: now(),
    });
  };

  const kickoff = async (ref: WorkspaceRef) => {
    if (!isValidWorkspaceId(ref.id) || running.has(ref.id) || lifetime.signal.aborted) return;
    running.add(ref.id);
    console.log(`[worktree-index] workspace.created: ${ref.id} (${ref.cwd})`);
    remember({ workspaceId: ref.id, cwd: ref.cwd, name: ref.name, state: "pending", detail: null, fileCount: null });
    try {
      await ensureWorktreeIndex(ref, { onUpdate: remember, signal: lifetime.signal });
      const final = statuses.get(ref.id);
      console.log(`[worktree-index] done: ${ref.id} -> ${final?.state}${final?.detail ? ` (${final.detail})` : ""}`);
    } catch (error) {
      console.error(`[worktree-index] failed: ${ref.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running.delete(ref.id);
    }
  };

  const releaseWorkspace = server.on("workspace.created", ({ workspace }) => {
    if (workspace.archivedAt) return;
    void kickoff({ id: workspace.id, cwd: workspace.cwd, name: workspace.name });
  });

  server.handle(listRpc, () => ({
    workspaces: [...statuses.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
  }));

  server.handle(retryRpc, ({ workspaceId }) => {
    const current = statuses.get(workspaceId);
    if (!current || running.has(workspaceId)) return { accepted: false };
    void kickoff({ id: current.workspaceId, cwd: current.cwd, name: current.name });
    return { accepted: true };
  });

  return () => {
    lifetime.abort();
    releaseWorkspace();
  };
}
