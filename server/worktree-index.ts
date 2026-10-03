import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import type { WorktreeIndexState } from "../shared/worktree-index";

const runFile = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type RunFn = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBufferBytes: number },
) => Promise<RunResult>;

export const defaultRun: RunFn = async (command, args, { timeoutMs, maxBufferBytes }) => {
  const { stdout, stderr } = await runFile(command, [...args], {
    timeout: timeoutMs,
    maxBuffer: maxBufferBytes,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

export interface WorkspaceRef {
  id: string;
  cwd: string;
  name: string | null;
}

export interface StatusUpdate {
  workspaceId: string;
  cwd: string;
  name: string | null;
  state: WorktreeIndexState;
  detail: string | null;
  fileCount: number | null;
}

export interface CodegraphStatusJson {
  initialized?: boolean;
  fileCount?: number;
  index?: { state?: string };
}

/** Parse `git worktree list --porcelain` into worktree root paths. Pure. */
export function parseWorktreeList(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (path) paths.push(path);
  }
  return paths;
}

/** SQLite file magic: "SQLite format 3\0". Pure. */
export function hasSqliteMagic(header: Uint8Array): boolean {
  const magic = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];
  if (header.length < magic.length) return false;
  return magic.every((byte, i) => header[i] === byte);
}

export function codegraphDbPath(root: string): string {
  return join(root, ".codegraph", "codegraph.db");
}

export function isValidWorkspaceId(id: string): boolean {
  return /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/.test(id);
}

function tail(text: string, maxChars = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function dbSizeBytes(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export interface WorktreeLayout {
  /** Main checkout root (first entry of `git worktree list`). */
  mainRoot: string;
  /** True when cwd is a linked worktree rather than the main checkout. */
  isLinked: boolean;
}

/** Resolve the main checkout for a workspace cwd. Null when cwd is not a git checkout. */
export async function resolveWorktreeLayout(cwd: string, run: RunFn = defaultRun): Promise<WorktreeLayout | null> {
  let output: string;
  try {
    ({ stdout: output } = await run("git", ["-C", cwd, "worktree", "list", "--porcelain"],
      { timeoutMs: 30_000, maxBufferBytes: 1_000_000 }));
  } catch {
    return null;
  }
  const paths = parseWorktreeList(output);
  if (!paths.length) return null;
  // Canonicalize: macOS temp dirs (e.g. /var -> /private/var) would otherwise
  // make the main checkout look like a linked worktree.
  const [realCwd, mainRoot] = await Promise.all([
    realpath(cwd).catch(() => cwd),
    realpath(paths[0]).catch(() => paths[0]),
  ]);
  return { mainRoot, isLinked: realCwd !== mainRoot };
}

/**
 * Hot-copy a live SQLite db into place: VACUUM INTO writes a clean,
 * fully-checkpointed snapshot, so the source daemon's WAL never leaks in.
 * Never copies daemon sockets/pids. Atomic via temp file + rename.
 */
export async function cloneIndex(sourceDb: string, destDb: string, run: RunFn = defaultRun): Promise<void> {
  await mkdir(join(destDb, ".."), { recursive: true });
  const tmpDb = `${destDb}.clone-tmp`;
  await rm(tmpDb, { force: true });
  await run("sqlite3", [sourceDb, `VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`],
    { timeoutMs: 15 * 60_000, maxBufferBytes: 1_000_000 });
  const size = await dbSizeBytes(tmpDb);
  if (size === null || size < 1024) {
    await rm(tmpDb, { force: true });
    throw new Error("Clone produced an empty database file.");
  }
  await rename(tmpDb, destDb);
  // Drop stale lock/daemon artifacts; the worktree starts its own daemon on next command.
  await Promise.all(["-shm", "-wal"].map((suffix) => rm(`${destDb}${suffix}`, { force: true })));
}

export interface EnsureDeps {
  run?: RunFn;
  onUpdate: (update: StatusUpdate) => void;
  signal?: AbortSignal;
}

function update(deps: EnsureDeps, ref: WorkspaceRef, state: WorktreeIndexState, detail: string | null, fileCount: number | null = null) {
  deps.onUpdate({ workspaceId: ref.id, cwd: ref.cwd, name: ref.name, state, detail, fileCount });
}

/**
 * Bring a workspace's CodeGraph index to ready:
 * missing/corrupt db -> clone from main checkout (VACUUM INTO) + `codegraph sync`,
 * no source db -> full `codegraph index`, existing db -> `codegraph sync` repair.
 */
export async function ensureWorktreeIndex(ref: WorkspaceRef, deps: EnsureDeps): Promise<void> {
  const run = deps.run ?? defaultRun;
  if (!isValidWorkspaceId(ref.id)) return;
  if (deps.signal?.aborted) return;
  if (!(await exists(ref.cwd))) {
    update(deps, ref, "error", "Workspace directory does not exist.");
    return;
  }

  const layout = await resolveWorktreeLayout(ref.cwd, run);
  if (!layout) {
    update(deps, ref, "skipped", "Not a git checkout; nothing to clone from.");
    return;
  }

  const destDb = codegraphDbPath(ref.cwd);
  const destSize = await dbSizeBytes(destDb);
  const destPresent = destSize !== null && destSize >= 1024;

  const checkStatus = async (cwd: string): Promise<CodegraphStatusJson | null> => {
    try {
      const { stdout } = await run("codegraph", ["status", "-j", cwd],
        { timeoutMs: 60_000, maxBufferBytes: 1_000_000 });
      return JSON.parse(stdout) as CodegraphStatusJson;
    } catch {
      return null;
    }
  };

  if (destPresent) {
    const status = await checkStatus(ref.cwd);
    if (status?.initialized) {
      update(deps, ref, "syncing", "Verifying existing index…", status.fileCount ?? null);
      try {
        await run("codegraph", ["sync", "-q", ref.cwd], { timeoutMs: 30 * 60_000, maxBufferBytes: 10_000_000 });
      } catch (error) {
        update(deps, ref, "error", `Sync failed: ${tail(errorMessage(error))}`);
        return;
      }
      const after = await checkStatus(ref.cwd);
      update(deps, ref, "ready", null, after?.fileCount ?? status.fileCount ?? null);
      return;
    }
    // Present but unreadable -> fall through to clone path.
  }

  const sourceDb = codegraphDbPath(layout.mainRoot);
  const sourceSize = await dbSizeBytes(sourceDb);
  if (sourceSize !== null && sourceSize >= 1024) {
    update(deps, ref, "cloning", `Cloning index from ${layout.mainRoot}…`);
    try {
      await cloneIndex(sourceDb, destDb, run);
    } catch (error) {
      update(deps, ref, "error", `Clone failed: ${tail(errorMessage(error))}`);
      return;
    }
  } else if (!layout.isLinked) {
    update(deps, ref, "indexing", "No source index; building from scratch…");
    try {
      await run("codegraph", ["index", ref.cwd], { timeoutMs: 30 * 60_000, maxBufferBytes: 10_000_000 });
    } catch (error) {
      update(deps, ref, "error", `Index failed: ${tail(errorMessage(error))}`);
      return;
    }
    const after = await checkStatus(ref.cwd);
    update(deps, ref, "ready", null, after?.fileCount ?? null);
    return;
  } else {
    update(deps, ref, "indexing", "Source checkout has no index; building from scratch…");
    try {
      await run("codegraph", ["index", ref.cwd], { timeoutMs: 30 * 60_000, maxBufferBytes: 10_000_000 });
    } catch (error) {
      update(deps, ref, "error", `Index failed: ${tail(errorMessage(error))}`);
      return;
    }
    const after = await checkStatus(ref.cwd);
    update(deps, ref, "ready", null, after?.fileCount ?? null);
    return;
  }

  update(deps, ref, "syncing", "Syncing cloned index to this worktree…");
  try {
    await run("codegraph", ["sync", "-q", ref.cwd], { timeoutMs: 30 * 60_000, maxBufferBytes: 10_000_000 });
  } catch (error) {
    update(deps, ref, "error", `Sync after clone failed: ${tail(errorMessage(error))}`);
    return;
  }
  const after = await checkStatus(ref.cwd);
  update(deps, ref, "ready", null, after?.fileCount ?? null);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const output = [error.message];
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) output.push(stderr.trim());
    return output.join(" ");
  }
  return String(error);
}
