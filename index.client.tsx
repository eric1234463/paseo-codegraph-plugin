import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorktreeIndexSurface } from "./client/worktree-index";

export default function contribute(client: PluginClientContext) {
  client.addSurface("worktree-index", WorktreeIndexSurface);
  client.addSidebarItem({
    id: "worktree-index",
    title: "Worktree index",
    icon: "Database",
    surface: "worktree-index",
  });
  return () => {};
}
