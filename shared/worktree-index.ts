import { defineRpc } from "@getpaseo/plugin";
import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const worktreeIndexState = z.enum([
  "pending",
  "cloning",
  "syncing",
  "indexing",
  "ready",
  "error",
  "skipped",
]);
export type WorktreeIndexState = z.infer<typeof worktreeIndexState>;

export function stateLabel(state: WorktreeIndexState): string {
  switch (state) {
    case "pending": return "Pending";
    case "cloning": return "Cloning index…";
    case "syncing": return "Syncing…";
    case "indexing": return "Indexing…";
    case "ready": return "Ready";
    case "error": return "Error";
    case "skipped": return "Skipped";
    default: return state satisfies never;
  }
}

const workspaceSchema = z.object({
  workspaceId: z.string(),
  cwd: z.string(),
  name: z.string().nullable(),
  state: worktreeIndexState,
  detail: z.string().nullable(),
  fileCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.string(),
});
export type WorkspaceIndexStatus = z.infer<typeof workspaceSchema>;

export const listRpc = defineRpc({
  name: "worktree-index.list",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceSchema) }),
});
export type ListOutput = RpcOutput<typeof listRpc>;

export const retryRpc = defineRpc({
  name: "worktree-index.retry",
  input: z.object({ workspaceId: z.string().min(1).max(200) }),
  output: z.object({ accepted: z.boolean() }),
});
