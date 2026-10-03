import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { listRpc, retryRpc, stateLabel } from "../shared/worktree-index";

export function WorktreeIndexSurface({ theme, layout }: PluginSurfaceProps) {
  const list = useRpc(listRpc);
  const retry = useRpc(retryRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["worktree-index"],
    queryFn: () => list({}),
    refetchInterval: 5000,
  });
  const retryMutation = useMutation({
    mutationFn: (workspaceId: string) => retry({ workspaceId }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["worktree-index"] }),
  });
  const styles = useMemo(
    () => ({
      screen: { flex: 1, padding: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const, marginBottom: 12 },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      rowHeader: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
      button: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: theme.colors.accent, borderRadius: 6 },
      buttonText: { color: theme.colors.accentForeground },
    }),
    [theme, layout.compact],
  );
  const workspaces = query.data?.workspaces ?? [];
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Worktree CodeGraph indexes</Text>
      {query.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
      {query.isError ? <Text style={styles.muted}>Could not load index status.</Text> : null}
      {!query.isPending && !query.isError && workspaces.length === 0 ? (
        <Text style={styles.muted}>No workspaces seen yet. New worktree workspaces are indexed automatically.</Text>
      ) : null}
      {workspaces.map((workspace) => (
        <View key={workspace.workspaceId} style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={styles.text}>{workspace.name ?? workspace.cwd}</Text>
            <Text style={styles.muted}>{stateLabel(workspace.state)}</Text>
          </View>
          <Text style={styles.muted}>{workspace.cwd}</Text>
          {workspace.fileCount !== null ? <Text style={styles.muted}>{workspace.fileCount.toLocaleString()} files indexed</Text> : null}
          {workspace.detail ? <Text style={styles.muted}>{workspace.detail}</Text> : null}
          {workspace.state === "error" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Retry indexing ${workspace.name ?? workspace.cwd}`}
              style={styles.button}
              onPress={() => retryMutation.mutate(workspace.workspaceId)}
            >
              <Text style={styles.buttonText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
