import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ensureRepo, git } from "../runtime/git.js";
import {
  lifecycleIsActive,
  processIdentityMatches,
  processIsAlive,
  readLifecycleState,
  resolveLifecyclePaths,
  RunLifecycle,
} from "../runtime/lifecycle.js";
import { makeWorkspace } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function followLogs(workspace: string): { result: Promise<CliResult> } {
  const child = spawn(process.execPath, [CLI, "logs", "--workspace", workspace, "-f"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const result = new Promise<CliResult>((resolve, reject) => {
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  return { result };
}

async function waitForStatus(workspace: string, pattern: RegExp, timeoutMs = 12_000): Promise<CliResult> {
  const deadline = Date.now() + timeoutMs;
  let last: CliResult = { code: -1, stdout: "", stderr: "" };
  while (Date.now() < deadline) {
    last = await runCli(["status", "--workspace", workspace]);
    if (pattern.test(last.stdout)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`status never matched ${pattern}:\nstdout:\n${last.stdout}\nstderr:\n${last.stderr}`);
}

function detachedPid(result: CliResult): number {
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const match = /pid (\d+)/.exec(result.stdout);
  assert.ok(match, result.stdout);
  return Number(match[1]);
}

test("a stale Linux process token cannot make a reused PID own the lifecycle lock", { skip: process.platform !== "linux" }, async () => {
  const { ws, cleanup } = await makeWorkspace();
  let lifecycle: RunLifecycle | null = null;
  try {
    await ensureRepo(ws);
    const paths = await resolveLifecyclePaths(ws);
    await mkdir(paths.lock, { recursive: true });
    const staleToken = "linux:stale-boot:1";
    const now = new Date().toISOString();
    await writeFile(
      paths.state,
      `${JSON.stringify({
        schema_version: 1,
        instance_id: "stale-instance",
        workspace: ws,
        pid: process.pid,
        process_token: staleToken,
        status: "running",
        phase: "check",
        loop_index: 1,
        started_at: now,
        phase_started_at: now,
        updated_at: now,
        log_path: paths.log,
      })}\n`,
    );
    await writeFile(
      paths.lockOwner,
      `${JSON.stringify({
        schema_version: 1,
        instance_id: "stale-instance",
        pid: process.pid,
        process_token: staleToken,
        acquired_at: now,
      })}\n`,
    );

    assert.equal(processIdentityMatches(process.pid, staleToken), false);
    assert.equal(processIsAlive(0), false);
    assert.equal(processIsAlive(-1), false);
    assert.equal(processIsAlive(1.5), false);

    lifecycle = await RunLifecycle.start(ws);
    const current = await readLifecycleState(ws);
    assert.ok(current);
    assert.notEqual(current.instance_id, "stale-instance");
    assert.equal(processIdentityMatches(current.pid, current.process_token), true);
    await lifecycle.finish("completed", 0);
  } finally {
    await lifecycle?.close();
    await cleanup();
  }
});

test("compiled CLI controls a detached long check and SIGTERM leaves no QA worktree", { timeout: 40_000 }, async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  const config = path.join(path.dirname(ws), "detached.config.json");
  await writeFile(
    config,
    `${JSON.stringify(
      {
        protocol: "extended",
        harness: "mock",
        loops: 1,
        checks: [
          {
            name: "hold",
            command: 'printf started > "$HOH_EVIDENCE_DIR/check-started.txt"; while :; do sleep 1; done',
          },
        ],
        timeouts: { role_min: 1, check_min: 1 },
      },
      null,
      2,
    )}\n`,
  );
  let activePid: number | null = null;

  try {
    const started = await runCli([
      "run",
      "--workspace",
      ws,
      "--spec",
      spec,
      "--config",
      config,
      "--detach",
    ]);
    activePid = detachedPid(started);

    const checking = await waitForStatus(ws, /Lifecycle: RUNNING .*loop 1, role check,/);
    assert.match(checking.stdout, /elapsed \d+\.\d+s/);

    const paths = await resolveLifecyclePaths(ws);
    const gitDir = (await git(["rev-parse", "--absolute-git-dir"], ws)).stdout.trim();
    assert.equal(paths.root, path.join(gitDir, "hoh"));
    assert.notEqual(paths.root, path.join(ws, ".hoh"), "process control must not be stored with runtime records");

    const logs = await runCli(["logs", "--workspace", ws]);
    assert.equal(logs.code, 0, logs.stderr);
    assert.match(logs.stdout, /deterministic check\(s\) on frozen candidate/);

    const following = followLogs(ws);
    const stopped = await runCli(["stop", "--workspace", ws]);
    assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
    assert.match(stopped.stdout, /waiting for runtime cleanup/);
    assert.match(stopped.stdout, /stopped \(stopped\)/);
    const followed = await following.result;
    assert.equal(followed.code, 0, followed.stderr);
    assert.match(followed.stdout, /CANCELLED operator requested stop/);

    await waitForStatus(ws, /Lifecycle: STOPPED .*loop 1, role check,/);
    activePid = null;
    let worktrees = await git(["worktree", "list", "--porcelain"], ws);
    assert.equal((worktrees.stdout.match(/^worktree /gm) ?? []).length, 1, worktrees.stdout);

    const restarted = await runCli(["run", "--workspace", ws, "--detach"]);
    activePid = detachedPid(restarted);
    await waitForStatus(ws, /Lifecycle: RUNNING .*loop 1, role check,/);
    process.kill(activePid, "SIGTERM");
    await waitForStatus(ws, /Lifecycle: STOPPED .*loop 1, role check,/);
    activePid = null;

    worktrees = await git(["worktree", "list", "--porcelain"], ws);
    assert.equal((worktrees.stdout.match(/^worktree /gm) ?? []).length, 1, worktrees.stdout);
    const finalLog = await runCli(["logs", "--workspace", ws]);
    assert.match(finalLog.stdout, /CANCELLED received SIGTERM/);
  } finally {
    if (activePid !== null && processIsAlive(activePid)) {
      const state = await readLifecycleState(ws).catch(() => null);
      if (lifecycleIsActive(state)) await runCli(["stop", "--workspace", ws]).catch(() => ({ code: -1, stdout: "", stderr: "" }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (processIsAlive(activePid)) process.kill(activePid, "SIGKILL");
    }
    await cleanup();
  }
});
