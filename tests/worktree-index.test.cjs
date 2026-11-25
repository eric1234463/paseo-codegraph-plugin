const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");

const {
  codegraphDbPath,
  defaultRun,
  ensureWorktreeIndex,
  findCodegraphBin,
  resolveCodegraphBin,
  pathEnvWith,
  _resetCodegraphBinCache,
} = require("../.test-build/server/worktree-index.js");

test("findCodegraphBin picks the first existing candidate", () => {
  assert.equal(findCodegraphBin(["/nope/cg", "/yes/cg"], (path) => path === "/yes/cg"), "/yes/cg");
  assert.equal(findCodegraphBin(["", "/nope/cg"], () => false), "codegraph");
  assert.equal(findCodegraphBin([], () => true), "codegraph");
});

test("resolveCodegraphBin honors CODEGRAPH_BIN and falls back to PATH", () => {
  const previous = process.env.CODEGRAPH_BIN;
  try {
    _resetCodegraphBinCache();
    process.env.CODEGRAPH_BIN = "  /custom/cg  ";
    assert.equal(resolveCodegraphBin(() => true), "/custom/cg");
    _resetCodegraphBinCache();
    delete process.env.CODEGRAPH_BIN;
    assert.equal(resolveCodegraphBin(() => false), "codegraph");
    _resetCodegraphBinCache();
    const picked = resolveCodegraphBin((path) => path.endsWith("bin/codegraph"));
    assert.ok(picked.endsWith("bin/codegraph"), `expected a candidate path, got: ${picked}`);
  } finally {
    if (previous === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = previous;
    _resetCodegraphBinCache();
  }
});

test("pathEnvWith prepends the binary dir to PATH", () => {
  assert.equal(pathEnvWith("codegraph"), undefined);
  const env = pathEnvWith("/x/bin/codegraph", { PATH: "/usr/bin:/bin", OTHER: "keep" });
  assert.equal(env.PATH, "/x/bin:/usr/bin:/bin");
  assert.equal(env.OTHER, "keep");
  assert.equal(pathEnvWith("/x/bin/codegraph", {}).PATH, "/x/bin");
});

async function withWorktree(check) {
  const cwd = await mkdtemp(join(tmpdir(), "codegraph-worktree-"));
  const db = codegraphDbPath(cwd);
  const writeDb = async () => {
    await mkdir(dirname(db), { recursive: true });
    await writeFile(db, "");
  };
  try {
    await check(cwd, writeDb);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const completeStatus = JSON.stringify({
  initialized: true,
  index: { state: "complete" },
  fileCount: 7,
});

test("creates a missing local index and verifies it before reporting ready", async () => {
  await withWorktree(async (cwd, writeDb) => {
    const calls = [];
    const run = async (command, args, options) => {
      calls.push(args);
      assert.equal(command, "/x/bin/codegraph");
      assert.equal(options.env.PATH.split(":")[0], "/x/bin");
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 25_000);
      if (args[0] === "init") await writeDb();
      return completeStatus;
    };
    const result = await ensureWorktreeIndex(cwd, { run, codegraphBin: "/x/bin/codegraph", timeoutMs: 25_000 });
    assert.deepEqual(calls, [["init", "--yes", cwd], ["status", "--json", cwd]]);
    assert.deepEqual(result, { state: "ready", detail: null, fileCount: 7 });
  });
});

test("reuses a complete index without starting a writer", async () => {
  await withWorktree(async (cwd, writeDb) => {
    await writeDb();
    const calls = [];
    const run = async (_command, args) => {
      calls.push(args[0]);
      return completeStatus;
    };
    const result = await ensureWorktreeIndex(cwd, { run, timeoutMs: 25_000 });
    assert.equal(result.state, "ready");
    assert.deepEqual(calls, ["status"]);
  });
});

test("rebuilds an incomplete index and reports an error if it is still incomplete", async () => {
  await withWorktree(async (cwd, writeDb) => {
    await writeDb();
    const calls = [];
    const run = async (_command, args) => {
      calls.push(args[0]);
      return JSON.stringify({ initialized: true, index: { state: "incomplete" } });
    };
    const result = await ensureWorktreeIndex(cwd, { run, timeoutMs: 25_000 });
    assert.equal(result.state, "error");
    assert.match(result.detail, /complete local index/);
    assert.deepEqual(calls, ["status", "index", "status"]);
  });
});

test("an init failure returns an actionable status without throwing", async () => {
  await withWorktree(async (cwd) => {
    const run = async () => { throw new Error("database is locked"); };
    const result = await ensureWorktreeIndex(cwd, { run, timeoutMs: 25_000 });
    assert.deepEqual(result, { state: "error", detail: "database is locked", fileCount: null });
  });
});

test("a timed-out CodeGraph command exits even when an indexing worker inherits its pipes", {
  skip: process.platform === "win32",
  timeout: 3_000,
}, async () => {
  const worker = 'setInterval(() => {}, 1000)';
  const command = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], {
    stdio: "inherit",
  });`;
  await assert.rejects(defaultRun(process.execPath, ["-e", command], { timeoutMs: 500 }), /timed out/);
});

test("the creation hook finishes indexing before workspace registration and keeps failures retryable", async () => {
  const worktreeIndex = require("../.test-build/server/worktree-index.js");
  const contribute = require("../.test-build/index.server.js").default;
  const { listRpc, retryRpc } = require("../.test-build/shared/worktree-index.js");
  const hooks = new Map();
  const rpcs = new Map();
  const release = contribute({
    addHook(name, handler) {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
    handle(contract, handler) {
      rpcs.set(contract, handler);
    },
  });
  try {
    await withWorktree(async (sourceCheckout, writeSourceDb) => {
      await withWorktree(async (cwd) => {
        const workspace = { id: "worktree-id", cwd, name: "Worktree", archivedAt: null };
        const create = () => hooks.get("worktree.create.after")({ worktree: { path: cwd, sourceCheckout } });
        const register = () => hooks.get("workspace.create.after")({ workspace });
        const list = () => rpcs.get(listRpc)().workspaces;
        const retry = () => rpcs.get(retryRpc)({ workspaceId: workspace.id });
        let finish;
        let entered;
        const started = new Promise((resolve) => { entered = resolve; });
        const result = new Promise((resolve) => { finish = resolve; });
        const impl = require("node:test").mock.method(worktreeIndex, "ensureWorktreeIndex", () => {
          entered();
          return result;
        });
        try {
          await create();
          await register();
          assert.equal(impl.mock.callCount(), 0);
          assert.deepEqual(list(), []);
          await writeSourceDb();

          let completed = false;
          const creating = create().then(() => { completed = true; });
          await started;
          assert.equal(completed, false);
          finish({ state: "error", detail: "test index failure", fileCount: null });
          await creating;
          await register();
          assert.equal(list()[0].state, "error");
          assert.deepEqual(retry(), { accepted: true });
          assert.deepEqual(retry(), { accepted: false });

          assert.equal(impl.mock.callCount(), 2);
          assert.equal(impl.mock.calls[0].arguments[1].timeoutMs, 25_000);
          await hooks.get("workspace.archive.after")({ workspace });
          assert.deepEqual(list(), []);
        } finally {
          impl.mock.restore();
        }
      });
    });
  } finally {
    release();
  }
});
