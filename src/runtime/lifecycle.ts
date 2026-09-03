import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

export const DETACHED_CHILD_ENV = "HOH_DETACHED_CHILD";
export const DEFAULT_STOP_WAIT_MS = 20_000;
const DEFAULT_READY_WAIT_MS = 10_000;
const ACTIVE_STATUSES = ["starting", "running", "stopping"] as const;

type ActiveLifecycleStatus = (typeof ACTIVE_STATUSES)[number];
export type LifecycleStatus = ActiveLifecycleStatus | "completed" | "budget_exhausted" | "failed" | "stopped";
export type LifecyclePhase = "initializing" | "planner" | "developer" | "check" | "tester";

export interface LifecycleState {
  schema_version: 1;
  instance_id: string;
  workspace: string;
  pid: number;
  process_token?: string;
  status: LifecycleStatus;
  phase: LifecyclePhase;
  loop_index: number | null;
  started_at: string;
  phase_started_at: string;
  updated_at: string;
  log_path: string;
  exit_code?: number;
  message?: string;
}

export type ActiveLifecycleState = LifecycleState & { status: ActiveLifecycleStatus };

export interface LifecyclePaths {
  gitDir: string;
  root: string;
  state: string;
  stopRequest: string;
  log: string;
  lock: string;
  lockOwner: string;
}

interface StopRequest {
  schema_version: 1;
  instance_id: string;
  requested_at: string;
}

interface LockOwner {
  schema_version: 1;
  instance_id: string;
  pid: number;
  process_token?: string;
  acquired_at: string;
}

export interface StopRequestResult {
  requested: boolean;
  state: LifecycleState | null;
  reason?: "not-running" | "process-missing";
}

export interface DetachedRun {
  pid: number;
  logPath: string;
  state: LifecycleState;
}

export function lifecycleIsActive(state: LifecycleState | null): state is ActiveLifecycleState {
  return state !== null && ACTIVE_STATUSES.some((status) => status === state.status);
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/** Match a PID to the process that originally published it, not a later process that reused the number. */
export function processIdentityMatches(pid: number, expectedToken?: string): boolean {
  if (!processIsAlive(pid)) return false;
  if (process.platform !== "linux") return true;
  return expectedToken !== undefined && linuxProcessToken(pid) === expectedToken;
}

export function lifecycleProcessIsCurrent(state: LifecycleState): boolean {
  return processIdentityMatches(state.pid, state.process_token);
}

export async function resolveLifecyclePaths(workspace: string): Promise<LifecyclePaths> {
  const absoluteWorkspace = path.resolve(workspace);
  const result = await git(["rev-parse", "--absolute-git-dir"], absoluteWorkspace, { allowFail: true });
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`No Git repository in ${absoluteWorkspace}`);
  }
  const gitDir = path.resolve(absoluteWorkspace, result.stdout.trim());
  const root = path.join(gitDir, "hoh");
  const lock = path.join(root, "active.lock");
  return {
    gitDir,
    root,
    state: path.join(root, "process.json"),
    stopRequest: path.join(root, "stop-request.json"),
    log: path.join(root, "run.log"),
    lock,
    lockOwner: path.join(lock, "owner.json"),
  };
}

export async function readLifecycleState(workspace: string): Promise<LifecycleState | null> {
  return readJson<LifecycleState>((await resolveLifecyclePaths(workspace)).state);
}

export async function requestLifecycleStop(workspace: string): Promise<StopRequestResult> {
  const paths = await resolveLifecyclePaths(workspace);
  const state = await readJson<LifecycleState>(paths.state);
  if (!lifecycleIsActive(state)) return { requested: false, state, reason: "not-running" };
  if (!lifecycleProcessIsCurrent(state)) return { requested: false, state, reason: "process-missing" };
  const request: StopRequest = {
    schema_version: 1,
    instance_id: state.instance_id,
    requested_at: new Date().toISOString(),
  };
  await writeJsonAtomic(paths.stopRequest, request);
  return { requested: true, state };
}

export async function waitForLifecycleTerminal(
  workspace: string,
  instanceId: string,
  timeoutMs = DEFAULT_STOP_WAIT_MS,
): Promise<LifecycleState | null> {
  const paths = await resolveLifecyclePaths(workspace);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readJson<LifecycleState>(paths.state);
    if (!state || state.instance_id !== instanceId || !lifecycleIsActive(state)) return state;
    await delay(100);
  }
  return readJson<LifecycleState>(paths.state);
}

export async function readLifecycleLog(workspace: string): Promise<Buffer> {
  const paths = await resolveLifecyclePaths(workspace);
  try {
    return await readFile(paths.log);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`No HoH lifecycle log in ${workspace}`);
    throw error;
  }
}

export async function followLifecycleLog(
  workspace: string,
  write: (chunk: Uint8Array) => void,
  signal?: AbortSignal,
): Promise<void> {
  const paths = await resolveLifecyclePaths(workspace);
  let offset = 0;
  let sawLog = false;
  while (true) {
    signal?.throwIfAborted();
    let file: Awaited<ReturnType<typeof open>> | null = null;
    try {
      file = await open(paths.log, "r");
      sawLog = true;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (file) {
      try {
        const size = (await file.stat()).size;
        if (size < offset) offset = 0;
        while (offset < size) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, offset);
          if (bytesRead === 0) break;
          write(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } finally {
        await file.close();
      }
    }
    const state = await readJson<LifecycleState>(paths.state);
    if (!lifecycleIsActive(state)) {
      if (!sawLog) throw new Error(`No HoH lifecycle log in ${workspace}`);
      return;
    }
    await delay(125);
  }
}

export async function launchDetachedRun(options: {
  workspace: string;
  cliPath: string;
  args: string[];
  readyTimeoutMs?: number;
}): Promise<DetachedRun> {
  const paths = await resolveLifecyclePaths(options.workspace);
  const current = await readJson<LifecycleState>(paths.state);
  if (lifecycleIsActive(current) && lifecycleProcessIsCurrent(current)) {
    throw new Error(`HoH run already active in ${current.workspace} (pid ${current.pid}, ${current.status})`);
  }
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const log = await open(paths.log, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  const outcome: {
    error?: Error;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
  } = {};
  const launchedAt = Date.now();
  try {
    child = spawn(process.execPath, [path.resolve(options.cliPath), ...options.args], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, [DETACHED_CHILD_ENV]: "1" },
    });
    child.once("error", (error) => {
      outcome.error = error;
    });
    child.once("exit", (code, signal) => {
      outcome.exit = { code, signal };
    });
  } finally {
    await log.close();
  }
  const childProcessToken = child.pid ? linuxProcessToken(child.pid) ?? undefined : undefined;

  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_WAIT_MS;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const state = await readJson<LifecycleState>(paths.state);
    const belongsToChild = lifecycleBelongsToChild(state, child.pid, childProcessToken, launchedAt);
    if (state && belongsToChild) {
      if (state.status === "failed") {
        const tail = (await readLifecycleLog(options.workspace)).toString("utf8").slice(-2_000).trim();
        throw new Error(state.message || tail || `detached HoH process ${child.pid} exited before becoming ready`);
      }
      child.unref();
      return { pid: child.pid!, logPath: paths.log, state };
    }
    if (outcome.error) throw outcome.error;
    if (outcome.exit) {
      const tail = (await readLifecycleLog(options.workspace)).toString("utf8").slice(-2_000).trim();
      throw new Error(
        tail || `detached HoH process ${child.pid} exited before becoming ready (${outcome.exit.code ?? outcome.exit.signal ?? "unknown"})`,
      );
    }
    await delay(50);
  }

  terminateDetachedChild(child);
  const terminationDeadline = Date.now() + 1_000;
  while (Date.now() < terminationDeadline) {
    const state = await readJson<LifecycleState>(paths.state);
    if (outcome.exit || (lifecycleBelongsToChild(state, child.pid, childProcessToken, launchedAt) && !lifecycleIsActive(state))) break;
    await delay(50);
  }
  child.unref();
  throw new Error(`detached HoH process ${child.pid} did not publish lifecycle state within ${readyTimeoutMs}ms`);
}

export class RunLifecycle {
  readonly signal: AbortSignal;
  readonly paths: LifecyclePaths;
  readonly instanceId: string;

  private readonly controller = new AbortController();
  private state: LifecycleState;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private pollTask: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private stopSource: "request" | "SIGTERM" | "SIGINT" | "control-error" | null = null;

  private constructor(paths: LifecyclePaths, state: LifecycleState) {
    this.paths = paths;
    this.state = state;
    this.instanceId = state.instance_id;
    this.signal = this.controller.signal;
  }

  static async start(workspace: string): Promise<RunLifecycle> {
    const paths = await resolveLifecyclePaths(workspace);
    const instanceId = randomBytes(12).toString("hex");
    const processToken = linuxProcessToken(process.pid) ?? undefined;
    if (process.platform === "linux" && !processToken) throw new Error(`cannot establish process identity for pid ${process.pid}`);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await acquireLock(paths, instanceId, processToken);
    try {
      await rm(paths.stopRequest, { force: true });
      await writeFile(paths.log, "", { mode: 0o600 });
      const now = new Date().toISOString();
      const state: LifecycleState = {
        schema_version: 1,
        instance_id: instanceId,
        workspace: path.resolve(workspace),
        pid: process.pid,
        ...(processToken ? { process_token: processToken } : {}),
        status: "starting",
        phase: "initializing",
        loop_index: null,
        started_at: now,
        phase_started_at: now,
        updated_at: now,
        log_path: paths.log,
      };
      await writeJsonAtomic(paths.state, state);
      const lifecycle = new RunLifecycle(paths, state);
      lifecycle.install();
      return lifecycle;
    } catch (error) {
      await releaseLock(paths, instanceId);
      throw error;
    }
  }

  get cancellationSource(): "request" | "SIGTERM" | "SIGINT" | "control-error" | null {
    return this.stopSource;
  }

  observe(message: string): void {
    if (!lifecycleIsActive(this.state)) return;
    const role = /^\[loop\s+0*(\d+)\]\s+(planner|developer|tester):\s+(?:start|reusing)\b/.exec(message);
    const check = /^\[loop\s+0*(\d+)\]\s+runtime:\s+\d+ deterministic check\(s\)/.exec(message);
    if (role) this.setPhase(role[2] as LifecyclePhase, Number(role[1]));
    else if (check) this.setPhase("check", Number(check[1]));
    else if (this.state.status === "starting") this.update({ status: "running" });
  }

  appendLog(line: string): void {
    appendFileSync(this.paths.log, line, { encoding: "utf8", mode: 0o600 });
  }

  async finish(status: "completed" | "budget_exhausted" | "failed" | "stopped", exitCode: number, message?: string): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const next: Partial<LifecycleState> = {
      status,
      exit_code: exitCode,
      ...(message ? { message } : {}),
    };
    this.update(next);
    if (this.pollTask) await this.pollTask;
    await this.writes;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    process.removeListener("SIGTERM", this.onSigterm);
    process.removeListener("SIGINT", this.onSigint);
    if (this.pollTask) await this.pollTask;
    await this.writes;
    const request = await readJson<StopRequest>(this.paths.stopRequest);
    if (request?.instance_id === this.instanceId) await rm(this.paths.stopRequest, { force: true });
    await releaseLock(this.paths, this.instanceId);
  }

  private install(): void {
    process.once("SIGTERM", this.onSigterm);
    process.once("SIGINT", this.onSigint);
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.pollTask = this.poll()
        .catch((error) => this.failControl(error))
        .finally(() => {
          this.polling = false;
        });
    }, 250);
  }

  private readonly onSigterm = (): void => this.cancel("SIGTERM");
  private readonly onSigint = (): void => this.cancel("SIGINT");

  private async poll(): Promise<void> {
    const request = await readJson<StopRequest>(this.paths.stopRequest);
    if (request?.instance_id === this.instanceId) this.cancel("request");
  }

  private cancel(source: "request" | "SIGTERM" | "SIGINT"): void {
    if (this.controller.signal.aborted || !lifecycleIsActive(this.state)) return;
    this.stopSource = source;
    const message = source === "request" ? "operator requested stop" : `received ${source}`;
    const error = new Error(message);
    error.name = "AbortError";
    this.update({ status: "stopping", message });
    this.controller.abort(error);
  }

  private failControl(cause: unknown): void {
    if (this.controller.signal.aborted || !lifecycleIsActive(this.state)) return;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`lifecycle control failed: ${detail}`);
    this.stopSource = "control-error";
    this.update({ status: "stopping", message: error.message });
    this.controller.abort(error);
  }

  private setPhase(phase: LifecyclePhase, loopIndex: number): void {
    if (this.state.phase === phase && this.state.loop_index === loopIndex && this.state.status === "running") return;
    this.update({
      status: "running",
      phase,
      loop_index: loopIndex,
      phase_started_at: new Date().toISOString(),
    });
  }

  private update(patch: Partial<LifecycleState>): void {
    this.state = { ...this.state, ...patch, updated_at: new Date().toISOString() };
    const snapshot = { ...this.state };
    this.writes = this.writes.then(() => writeJsonAtomic(this.paths.state, snapshot));
  }
}

async function acquireLock(paths: LifecyclePaths, instanceId: string, processToken?: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(paths.lock);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const [state, owner, lockStat] = await Promise.all([
        readJson<LifecycleState>(paths.state),
        readJson<LockOwner>(paths.lockOwner),
        stat(paths.lock).catch(() => null),
      ]);
      if (lifecycleIsActive(state) && lifecycleProcessIsCurrent(state)) {
        throw new Error(`HoH run already active in ${state.workspace} (pid ${state.pid}, ${state.status})`);
      }
      if (owner && processIdentityMatches(owner.pid, owner.process_token)) {
        throw new Error(`HoH run is already starting (pid ${owner.pid})`);
      }
      if (!owner && lockStat && Date.now() - lockStat.mtimeMs < 5_000) {
        throw new Error("HoH run is already starting");
      }
      await rm(paths.lock, { recursive: true, force: true });
      continue;
    }
    const existing = await readJson<LifecycleState>(paths.state);
    if (lifecycleIsActive(existing) && lifecycleProcessIsCurrent(existing)) {
      await rm(paths.lock, { recursive: true, force: true });
      throw new Error(`HoH run already active in ${existing.workspace} (pid ${existing.pid}, ${existing.status})`);
    }
    const owner: LockOwner = {
      schema_version: 1,
      instance_id: instanceId,
      pid: process.pid,
      ...(processToken ? { process_token: processToken } : {}),
      acquired_at: new Date().toISOString(),
    };
    try {
      await writeJsonAtomic(paths.lockOwner, owner);
      return;
    } catch (error) {
      await rm(paths.lock, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error("could not acquire HoH lifecycle lock");
}

async function releaseLock(paths: LifecyclePaths, instanceId: string): Promise<void> {
  const owner = await readJson<LockOwner>(paths.lockOwner);
  if (owner?.instance_id === instanceId) await rm(paths.lock, { recursive: true, force: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function linuxProcessToken(pid: number): string | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const processStat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = processStat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = processStat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19]; // proc(5) field 22; this slice begins at field 3.
    if (!/^\d+$/.test(startTime ?? "")) return null;
    let bootId = "unknown-boot";
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || bootId;
    } catch {
      // starttime still distinguishes PID reuse within the current boot.
    }
    return `linux:${bootId}:${startTime}`;
  } catch {
    return null;
  }
}

function terminateDetachedChild(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return;
  try {
    process.kill(-pid!, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function lifecycleBelongsToChild(
  state: LifecycleState | null,
  pid: number | undefined,
  processToken: string | undefined,
  launchedAt: number,
): state is LifecycleState {
  if (!state || !Number.isInteger(pid) || (pid ?? 0) <= 0 || state.pid !== pid || Date.parse(state.started_at) < launchedAt - 1_000) {
    return false;
  }
  return process.platform !== "linux" || (processToken !== undefined && state.process_token === processToken);
}
