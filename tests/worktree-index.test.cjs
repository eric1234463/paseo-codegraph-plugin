const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);

const {
  parseWorktreeList,
  hasSqliteMagic,
  isValidWorkspaceId,
  codegraphDbPath,
  cloneIndex,
  resolveWorktreeLayout,
  ensureWorktreeIndex,
} = require("../.test-build/server/worktree-index.js");

test("parseWorktreeList extracts worktree roots in order", () => {
  const output = [
    "worktree /Users/eric/dash/backend-functions",
    "HEAD 09bbf00e7581a0d52cd52b5df267bb6d1eed2c58",
    "branch refs/heads/main",
    "",
    "worktree /Users/eric/.paseo/worktrees/31awz0l2/fierce-crocodile",
    "HEAD 27d9179c42d10aeac4607bea7a9df307040ca624",
    "branch refs/heads/bugfix/x",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(output), [
    "/Users/eric/dash/backend-functions",
    "/Users/eric/.paseo/worktrees/31awz0l2/fierce-crocodile",
  ]);
  assert.deepEqual(parseWorktreeList(""), []);
});

test("hasSqliteMagic accepts SQLite headers only", () => {
  const header = Buffer.concat([Buffer.from("SQLite format 3\0", "utf8"), Buffer.alloc(100)]);
  assert.equal(hasSqliteMagic(header), true);
  assert.equal(hasSqliteMagic(Buffer.from("not a database at all.......")), false);
  assert.equal(hasSqliteMagic(Buffer.alloc(0)), false);
});

test("isValidWorkspaceId rejects path traversal", () => {
  assert.equal(isValidWorkspaceId("31awz0l2"), true);
  assert.equal(isValidWorkspaceId("ws-1_agent.x"), true);
  assert.equal(isValidWorkspaceId("../evil"), false);
  assert.equal(isValidWorkspaceId(""), false);
});

test("cloneIndex hot-copies a live db via VACUUM INTO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codegraph-clone-"));
  try {
    const sourceDb = join(directory, "source", "codegraph.db");
    const destDb = join(directory, "worktree", ".codegraph", "codegraph.db");
    await mkdir(join(directory, "source"), { recursive: true });
    await runFile("sqlite3", [sourceDb, "CREATE TABLE nodes(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO nodes(name) VALUES('alpha'),('beta');"]);
    await cloneIndex(sourceDb, destDb);
    const { stdout } = await runFile("sqlite3", [destDb, "SELECT COUNT(*) FROM nodes;"]);
    assert.equal(stdout.trim(), "2");
    await assert.rejects(readFile(`${destDb}-wal`), "no WAL sidecar should survive the clone");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeGitRepo() {
  const directory = await mkdtemp(join(tmpdir(), "codegraph-git-"));
  const git = (args) => runFile("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd: directory });
  await git(["init"]);
  await writeFile(join(directory, "README.md"), "hello\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
  return directory;
}

test("resolveWorktreeLayout finds the main checkout from a linked worktree", async () => {
  const directory = await makeGitRepo();
  try {
    const linked = join(directory, "linked");
    await runFile("git", ["-c", "user.email=test@example.com", "-c", "user.name=test",
      "worktree", "add", linked], { cwd: directory });
    const { realpath } = require("node:fs/promises");
    const canonical = await realpath(directory);
    const fromMain = await resolveWorktreeLayout(directory);
    assert.equal(fromMain.mainRoot, canonical);
    assert.equal(fromMain.isLinked, false);
    const fromLinked = await resolveWorktreeLayout(linked);
    assert.equal(fromLinked.mainRoot, canonical);
    assert.equal(fromLinked.isLinked, true);
    const plain = await mkdtemp(join(tmpdir(), "codegraph-plain-"));
    try {
      assert.equal(await resolveWorktreeLayout(plain), null);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensureWorktreeIndex reports missing directories and non-git checkouts", async () => {
  const updates = [];
  await ensureWorktreeIndex({ id: "gone", cwd: "/definitely/not/here", name: null },
    { onUpdate: (update) => updates.push(update) });
  assert.equal(updates.at(-1).state, "error");

  const plain = await mkdtemp(join(tmpdir(), "codegraph-plain-"));
  try {
    await ensureWorktreeIndex({ id: "plain", cwd: plain, name: "plain" },
      { onUpdate: (update) => updates.push(update) });
    assert.equal(updates.at(-1).state, "skipped");
  } finally {
    await rm(plain, { recursive: true, force: true });
  }

  // Invalid ids are ignored silently.
  const before = updates.length;
  await ensureWorktreeIndex({ id: "../evil", cwd: plain, name: null },
    { onUpdate: (update) => updates.push(update) });
  assert.equal(updates.length, before);
});

test("ensureWorktreeIndex syncs an existing index without cloning", async () => {
  const directory = await makeGitRepo();
  try {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "codegraph") return { stdout: JSON.stringify({ initialized: true, fileCount: 42 }), stderr: "" };
      throw new Error(`unexpected: ${command}`);
    };
    // Seed a plausible db file and resolve git via the real binary.
    const { defaultRun } = require("../.test-build/server/worktree-index.js");
    const gitRun = async (command, args, options) =>
      command === "git" ? defaultRun(command, args, options) : run(command, args, options);
    const destDb = codegraphDbPath(directory);
    await mkdir(join(directory, ".codegraph"), { recursive: true });
    await writeFile(destDb, Buffer.alloc(2048));
    const updates = [];
    await ensureWorktreeIndex({ id: "main-ws", cwd: directory, name: null },
      { run: gitRun, onUpdate: (update) => updates.push(update) });
    assert.equal(updates.at(-1).state, "ready");
    assert.equal(updates.at(-1).fileCount, 42);
    assert.ok(calls.some((call) => call.includes("sync")), `expected a sync call, got: ${calls}`);
    assert.ok(!calls.some((call) => call.includes("index ")), "must not run a full index");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensureWorktreeIndex full-indexes a linked worktree with no source db", async () => {
  const directory = await makeGitRepo();
  try {
    const linked = join(directory, "linked");
    await runFile("git", ["-c", "user.email=test@example.com", "-c", "user.name=test",
      "worktree", "add", linked], { cwd: directory });
    const calls = [];
    const { defaultRun } = require("../.test-build/server/worktree-index.js");
    const run = async (command, args, options) => {
      if (command === "git") return defaultRun(command, args, options);
      calls.push([command, ...args].join(" "));
      return { stdout: JSON.stringify({ initialized: true, fileCount: 7 }), stderr: "" };
    };
    const updates = [];
    await ensureWorktreeIndex({ id: "linked-ws", cwd: linked, name: null },
      { run, onUpdate: (update) => updates.push(update) });
    assert.equal(updates.at(-1).state, "ready");
    assert.ok(calls.some((call) => call.startsWith("codegraph index")), `expected a full index, got: ${calls}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
