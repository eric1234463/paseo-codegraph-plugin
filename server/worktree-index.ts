import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

export const CREATE_INDEX_TIMEOUT_MS = 25_000;

export type IndexResult =
  | { state: "ready"; detail: null; fileCount: number | null }
  | { state: "error"; detail: string; fileCount: null };

interface CodegraphStatusJson {
  initialized?: boolean;
  fileCount?: number;
  index?: { state?: string };
}

type RunFn = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<string>;

export const defaultRun: RunFn = (command, args, { timeoutMs, env, signal }) => {
  if (signal?.aborted) return Promise.reject(new Error("Indexing cancelled."));
  return new Promise((resolve, reject) => {
    // CodeGraph runs indexing in a child worker. Stop both processes on timeout.
    const processGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      detached: processGroup,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (!child.pid) return;
      if (!processGroup) {
        child.kill("SIGKILL");
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const abort = () => stop(new Error("Indexing cancelled."));
    const timer = setTimeout(() => stop(new Error("CodeGraph command timed out.")), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout = (stdout + data).slice(-1_000_000);
    });
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
      stderr = (stderr + data).slice(-500);
    });
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim().slice(-500) || `CodeGraph exited with code ${code}.`));
    });
  });
};

export function codegraphDbPath(root: string): string {
  return join(root, ".codegraph", "codegraph.db");
}

export async function hasLocalIndex(root: string): Promise<boolean> {
  try {
    return (await stat(codegraphDbPath(root))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

let cachedCodegraphBin: string | null = null;

/** Pure: return the first candidate that exists, else fall back to PATH lookup. */
export function findCodegraphBin(candidates: readonly string[], exists: (path: string) => boolean): string {
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return "codegraph";
}

/** Likely install locations: newest nvm version first, then system paths. */
export function codegraphBinCandidates(): string[] {
  const home = process.env.HOME ?? "";
  const candidates: string[] = [];
  try {
    if (home) {
      const nvmDir = join(home, ".nvm", "versions", "node");
      for (const version of readdirSync(nvmDir).sort().reverse()) {
        candidates.push(join(nvmDir, version, "bin", "codegraph"));
      }
    }
  } catch {
    // No nvm directory; fall through to system locations.
  }
  if (home) candidates.push(join(home, ".local", "bin", "codegraph"));
  candidates.push("/opt/homebrew/bin/codegraph", "/usr/local/bin/codegraph");
  return candidates;
}

/**
 * Resolve the codegraph binary to an absolute path when possible. Paseo is
 * Finder-launched with a minimal PATH (no nvm shims), so a bare `codegraph`
 * fails with ENOENT there. CODEGRAPH_BIN overrides everything.
 */
export function resolveCodegraphBin(exists: (path: string) => boolean = existsSync): string {
  if (cachedCodegraphBin) return cachedCodegraphBin;
  const override = (process.env.CODEGRAPH_BIN ?? "").trim();
  if (override) {
    cachedCodegraphBin = override;
  } else {
    cachedCodegraphBin = findCodegraphBin(codegraphBinCandidates(), exists);
  }
  return cachedCodegraphBin;
}

/**
 * Pure: a copy of base env with the binary's directory prepended to PATH.
 * codegraph is a `#!/usr/bin/env node` launcher, so under Paseo's minimal
 * PATH the kernel cannot even resolve `node` for it. Undefined for bare
 * command names (nothing to prepend).
 */
export function pathEnvWith(binary: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (!binary.includes("/")) return undefined;
  const dir = dirname(binary);
  return { ...base, PATH: base.PATH ? `${dir}${delimiter}${base.PATH}` : dir };
}

/** Test-only: clear the resolver cache. */
export function _resetCodegraphBinCache(): void {
  cachedCodegraphBin = null;
}

export async function ensureWorktreeIndex(
  cwd: string,
  options: { timeoutMs: number; signal?: AbortSignal; run?: RunFn; codegraphBin?: string },
): Promise<IndexResult> {
  const deadline = performance.now() + options.timeoutMs;
  try {
    const run = options.run ?? defaultRun;
    const binary = options.codegraphBin ?? resolveCodegraphBin();
    const env = pathEnvWith(binary);
    const execute = (args: string[]) => {
      const timeoutMs = deadline - performance.now();
      if (timeoutMs <= 0) throw new Error("CodeGraph command timed out.");
      return run(binary, [...args, cwd], { timeoutMs, env, signal: options.signal });
    };
    const status = async (): Promise<CodegraphStatusJson> =>
      JSON.parse(await execute(["status", "--json"])) as CodegraphStatusJson;

    const existing = await hasLocalIndex(cwd) ? await status() : null;
    if (existing?.initialized && existing.index?.state === "complete") {
      return { state: "ready", detail: null, fileCount: existing.fileCount ?? null };
    }

    await execute(existing?.initialized ? ["index"] : ["init", "--yes"]);
    const after = await hasLocalIndex(cwd) ? await status() : null;
    if (!after?.initialized || after.index?.state !== "complete") {
      throw new Error("CodeGraph did not produce a complete local index.");
    }
    return { state: "ready", detail: null, fileCount: after.fileCount ?? null };
  } catch (error) {
    return {
      state: "error",
      detail: error instanceof Error ? error.message : String(error),
      fileCount: null,
    };
  }
}
