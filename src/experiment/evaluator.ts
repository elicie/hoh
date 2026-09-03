/** A process-separated input-blinding boundary for pre-registered evaluators. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExperimentEvaluator } from "./manifest.js";

export const EVALUATOR_LIMITS = Object.freeze({
  artifact_bytes: 8 * 1024 * 1024,
  executable_bytes: 512 * 1024 * 1024,
  task_bytes: 1024 * 1024,
  sample_bytes: 1024 * 1024,
  serialized_input_bytes: 16 * 1024 * 1024,
  stdout_bytes: 256 * 1024,
  stderr_bytes: 256 * 1024,
  timeout_ms: 24 * 60 * 60 * 1000,
  argv_entries: 64,
  argv_bytes: 16 * 1024,
  public_env_entries: 32,
  public_env_bytes: 16 * 1024,
  private_value_entries: 128,
  private_value_min_code_points: 8,
});

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const NEUTRAL_ARTIFACT_FILENAME = "artifact.bin";
const NEUTRAL_TEMPORARY_PREFIX = "external-evaluator-";
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const ENV_NAME = /^PUBLIC_[A-Z0-9_]{1,56}$/;
const PRIVATE_ENV_SEGMENT =
  /(?:^|_)(?:HOH|EXPERIMENT|CONDITION|CELL|ABLATION|VARIANT|RUN_ID|RUN_LABEL|API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|COOKIE|SESSION|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)(?:_|$)/;
const COMMON_PRIVATE_VALUES = new Set([
  "access_token",
  "api_key",
  "apikey",
  "artifact",
  "changeme",
  "client_secret",
  "default",
  "example",
  "example.com",
  "localhost",
  "password",
  "placeholder",
  "refresh_token",
  "testing",
  "undefined",
  "username",
]);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Evaluator identity fields frozen in the experiment plan before any run. */
export type BlindEvaluatorDefinition = ExperimentEvaluator;

export interface BlindEvaluatorRequest {
  /**
   * The exact, label-free executable and arguments, executable hash, version,
   * and rubric hash frozen in ExperimentPlan. The evaluator is trusted code;
   * this process boundary is not an OS filesystem or network sandbox.
   */
  evaluator: BlindEvaluatorDefinition;
  /** Absolute path to one final artifact file. The original path is never disclosed to the evaluator. */
  artifactPath: string;
  /** Task text disclosed to every experimental condition. */
  task: string;
  /** Sample input disclosed to every experimental condition. */
  sample: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Explicit public values only. Parent-process environment variables are never inherited. */
  publicEnv?: Readonly<Record<string, string>>;
  /**
   * Values used only to reject a leaky launch. Qualifying values are never
   * serialized, hashed, retained in receipts, or sent to the evaluator.
   */
  private_values?: readonly string[];
}

export type EvaluatorFailureCode =
  | "cancelled"
  | "timed_out"
  | "output_too_large"
  | "spawn_error"
  | "nonzero_exit"
  | "invalid_json"
  | "evaluator_identity_mismatch";

export interface EvaluatorStreamReceipt {
  readonly raw: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface EvaluatorReceipt {
  readonly schema_version: 1;
  readonly evaluator: {
    readonly argv: readonly string[];
    readonly version: string;
    readonly rubric_sha256: string;
    readonly executable_sha256: string;
    readonly observed_executable_sha256_before: string;
    readonly observed_executable_sha256_after: string | null;
  };
  readonly boundary: {
    readonly threat_model: "trusted_cooperative_evaluator";
    readonly process_separated: true;
    readonly serialized_input_blinded: true;
    readonly filesystem_isolated: false;
    readonly network_isolated: false;
    readonly descendant_termination: "same_posix_process_group" | "immediate_child_only";
  };
  readonly input: {
    readonly serialized_bytes: number;
    readonly serialized_sha256: string;
    readonly artifact_filename: typeof NEUTRAL_ARTIFACT_FILENAME;
    readonly artifact_bytes: number;
    readonly artifact_sha256: string;
    readonly task_bytes: number;
    readonly task_sha256: string;
    readonly sample_bytes: number;
    readonly sample_sha256: string;
  };
  readonly process: {
    readonly started_at: string;
    readonly finished_at: string;
    readonly duration_ms: number;
    readonly exit_code: number | null;
    readonly signal: NodeJS.Signals | null;
  };
  readonly stdout: EvaluatorStreamReceipt;
  readonly stderr: EvaluatorStreamReceipt;
  readonly result: JsonValue | null;
  readonly failure: { readonly code: EvaluatorFailureCode; readonly message: string } | null;
}

export class EvaluatorRunError extends Error {
  override readonly name = "EvaluatorRunError";

  constructor(
    readonly code: EvaluatorFailureCode,
    message: string,
    readonly receipt?: EvaluatorReceipt,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface MaterialInput {
  readonly schema_version: 1;
  readonly task: { readonly content: string };
  readonly sample: { readonly content: string };
  readonly artifact: {
    readonly filename: typeof NEUTRAL_ARTIFACT_FILENAME;
    readonly encoding: "base64";
    readonly bytes: number;
    readonly sha256: string;
    readonly content: string;
  };
}

interface ProcessOutcome {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: EvaluatorStreamReceipt;
  readonly stderr: EvaluatorStreamReceipt;
  readonly forcedFailure?: { code: EvaluatorFailureCode; message: string; cause?: unknown };
}

/**
 * Execute one pre-registered evaluator without adding experimental labels,
 * workspace paths, parent environment, or development-loop records to its
 * view. This boundary does not by itself prove that the registered evaluator
 * or rubric supplies independent ground truth. Cancellation reaches the same
 * process group on POSIX; on Windows it can guarantee only the immediate child,
 * which is recorded in the receipt.
 */
export async function runBlindEvaluator(request: BlindEvaluatorRequest): Promise<EvaluatorReceipt> {
  const privateValues = normalizePrivateValues(request.private_values);
  assertPrivateValuesAbsent(privateValues, requestDisclosureSurfaces(request));
  const evaluator = await validateEvaluator(request.evaluator);
  const timeoutMs = validateTimeout(request.timeoutMs);
  const publicEnv = validatePublicEnv(request.publicEnv);
  const taskBytes = boundedText(request.task, "task", EVALUATOR_LIMITS.task_bytes);
  const sampleBytes = boundedText(request.sample, "sample", EVALUATOR_LIMITS.sample_bytes);
  request.signal?.throwIfAborted();

  const artifact = await readArtifact(request.artifactPath);
  assertPrivateBytesAbsent(privateValues, "artifact material", artifact);
  const artifactSha256 = sha256(artifact);
  const material: MaterialInput = {
    schema_version: 1,
    task: { content: request.task },
    sample: { content: request.sample },
    artifact: {
      filename: NEUTRAL_ARTIFACT_FILENAME,
      encoding: "base64",
      bytes: artifact.byteLength,
      sha256: artifactSha256,
      content: artifact.toString("base64"),
    },
  };
  const serialized = Buffer.from(`${JSON.stringify(material)}\n`, "utf8");
  if (serialized.byteLength > EVALUATOR_LIMITS.serialized_input_bytes) {
    throw new Error(`evaluator serialized input exceeds ${EVALUATOR_LIMITS.serialized_input_bytes} bytes`);
  }

  request.signal?.throwIfAborted();
  const temporary = await mkdtemp(path.join(neutralTemporaryRoot(), NEUTRAL_TEMPORARY_PREFIX));
  let hasPrimaryOutcome = false;
  try {
    assertPrivateValuesAbsent(privateValues, [{ name: "neutral temporary directory", value: temporary }]);
    await writeFile(path.join(temporary, NEUTRAL_ARTIFACT_FILENAME), artifact, { mode: 0o600 });
    request.signal?.throwIfAborted();
    const executableSha256Before = await hashExecutable(evaluator.argv[0]);
    if (executableSha256Before !== evaluator.executable_sha256) {
      throw new EvaluatorRunError(
        "evaluator_identity_mismatch",
        "external evaluator executable SHA-256 did not match its pre-registered value before launch",
      );
    }
    const outcome = await runEvaluatorProcess({
      evaluator,
      cwd: temporary,
      input: serialized,
      timeoutMs,
      signal: request.signal,
      publicEnv,
    });
    assertPrivateValuesAbsent(privateValues, [
      { name: "evaluator stdout", value: outcome.stdout.raw },
      { name: "evaluator stderr", value: outcome.stderr.raw },
    ]);
    let executableSha256After: string | null = null;
    let executableHashFailure: unknown;
    try {
      executableSha256After = await hashExecutable(evaluator.argv[0]);
    } catch (cause) {
      executableHashFailure = cause;
    }
    const base = {
      schema_version: 1 as const,
      evaluator: {
        argv: evaluator.argv,
        version: evaluator.version,
        rubric_sha256: evaluator.rubric_sha256,
        executable_sha256: evaluator.executable_sha256,
        observed_executable_sha256_before: executableSha256Before,
        observed_executable_sha256_after: executableSha256After,
      },
      boundary: {
        threat_model: "trusted_cooperative_evaluator" as const,
        process_separated: true as const,
        serialized_input_blinded: true as const,
        filesystem_isolated: false as const,
        network_isolated: false as const,
        descendant_termination: process.platform === "win32" ? ("immediate_child_only" as const) : ("same_posix_process_group" as const),
      },
      input: {
        serialized_bytes: serialized.byteLength,
        serialized_sha256: sha256(serialized),
        artifact_filename: NEUTRAL_ARTIFACT_FILENAME,
        artifact_bytes: artifact.byteLength,
        artifact_sha256: artifactSha256,
        task_bytes: taskBytes.byteLength,
        task_sha256: sha256(taskBytes),
        sample_bytes: sampleBytes.byteLength,
        sample_sha256: sha256(sampleBytes),
      },
      process: {
        started_at: outcome.startedAt,
        finished_at: outcome.finishedAt,
        duration_ms: outcome.durationMs,
        exit_code: outcome.exitCode,
        signal: outcome.signal,
      },
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    } as const;

    if (executableSha256After !== evaluator.executable_sha256 || executableSha256After !== executableSha256Before) {
      const message = "external evaluator executable SHA-256 changed or became unreadable during execution";
      const receipt: EvaluatorReceipt = {
        ...base,
        result: null,
        failure: { code: "evaluator_identity_mismatch", message },
      };
      throw new EvaluatorRunError("evaluator_identity_mismatch", message, receipt, { cause: executableHashFailure });
    }
    if (outcome.forcedFailure) {
      const receipt: EvaluatorReceipt = {
        ...base,
        result: null,
        failure: { code: outcome.forcedFailure.code, message: outcome.forcedFailure.message },
      };
      throw new EvaluatorRunError(outcome.forcedFailure.code, outcome.forcedFailure.message, receipt, {
        cause: outcome.forcedFailure.cause,
      });
    }
    if (outcome.exitCode !== 0) {
      const message = `external evaluator exited with code ${outcome.exitCode ?? "null"}${outcome.signal ? ` (${outcome.signal})` : ""}`;
      const receipt: EvaluatorReceipt = {
        ...base,
        result: null,
        failure: { code: "nonzero_exit", message },
      };
      throw new EvaluatorRunError("nonzero_exit", message, receipt);
    }

    let result: JsonValue;
    try {
      result = parseSingleJson(outcome.stdout.raw);
    } catch (cause) {
      const message = `external evaluator stdout must contain exactly one JSON value: ${errorMessage(cause)}`;
      const receipt: EvaluatorReceipt = {
        ...base,
        result: null,
        failure: { code: "invalid_json", message },
      };
      throw new EvaluatorRunError("invalid_json", message, receipt, { cause });
    }
    const receipt: EvaluatorReceipt = { ...base, result, failure: null };
    hasPrimaryOutcome = true;
    return receipt;
  } catch (error) {
    hasPrimaryOutcome = true;
    throw error;
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (cause) {
      if (!hasPrimaryOutcome) throw new Error("external evaluator temporary directory cleanup failed", { cause });
      // Cleanup is best-effort and cannot replace a completed receipt or evaluator failure.
    }
  }
}

async function validateEvaluator(value: BlindEvaluatorDefinition): Promise<{
  argv: readonly string[];
  version: string;
  rubric_sha256: string;
  executable_sha256: string;
}> {
  if (!value || typeof value !== "object") throw new Error("evaluator definition is required");
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > EVALUATOR_LIMITS.argv_entries) {
    throw new Error(`evaluator argv must contain 1-${EVALUATOR_LIMITS.argv_entries} entries`);
  }
  const argv = value.argv.map((argument, index) => {
    if (typeof argument !== "string" || argument.length === 0 || argument.includes("\0")) {
      throw new Error(`evaluator argv[${index}] must be a non-empty string without NUL`);
    }
    return argument;
  });
  const version = value.version;
  const rubricSha256 = value.rubric_sha256;
  const executableSha256 = value.executable_sha256;
  if (!path.isAbsolute(argv[0])) throw new Error("evaluator argv[0] must be an absolute executable path");
  const argvBytes = argv.reduce((total, argument) => total + Buffer.byteLength(argument), 0);
  if (argvBytes > EVALUATOR_LIMITS.argv_bytes) throw new Error(`evaluator argv exceeds ${EVALUATOR_LIMITS.argv_bytes} bytes`);
  const executable = await stat(argv[0]).catch(() => null);
  if (!executable?.isFile()) throw new Error("evaluator argv[0] must identify an existing file");
  await access(argv[0], fsConstants.X_OK).catch(() => {
    throw new Error("evaluator argv[0] must be executable");
  });
  if (typeof version !== "string" || version.trim().length === 0 || Buffer.byteLength(version) > 256) {
    throw new Error("evaluator version must be a non-empty string of at most 256 bytes");
  }
  if (!HEX_SHA256.test(rubricSha256)) throw new Error("evaluator rubric_sha256 must be a lowercase SHA-256 hash");
  if (!HEX_SHA256.test(executableSha256)) throw new Error("evaluator executable_sha256 must be a lowercase SHA-256 hash");
  return Object.freeze({
    argv: Object.freeze([...argv]),
    version,
    rubric_sha256: rubricSha256,
    executable_sha256: executableSha256,
  });
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > EVALUATOR_LIMITS.timeout_ms) {
    throw new Error(`evaluator timeoutMs must be a positive safe integer no greater than ${EVALUATOR_LIMITS.timeout_ms}`);
  }
  return timeout;
}

function validatePublicEnv(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evaluator publicEnv must be an object");
  const entries = Object.entries(value);
  if (entries.length > EVALUATOR_LIMITS.public_env_entries) {
    throw new Error(`evaluator publicEnv exceeds ${EVALUATOR_LIMITS.public_env_entries} entries`);
  }
  let bytes = 0;
  const result: Record<string, string> = {};
  for (const [name, envValue] of entries) {
    if (!ENV_NAME.test(name) || PRIVATE_ENV_SEGMENT.test(name)) {
      throw new Error("evaluator publicEnv contains a name that is not permitted");
    }
    if (typeof envValue !== "string" || envValue.includes("\0")) {
      throw new Error(`evaluator publicEnv ${name} must be a string without NUL`);
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(envValue);
    result[name] = envValue;
  }
  if (bytes > EVALUATOR_LIMITS.public_env_bytes) {
    throw new Error(`evaluator publicEnv exceeds ${EVALUATOR_LIMITS.public_env_bytes} bytes`);
  }
  return Object.freeze(result);
}

function normalizePrivateValues(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("evaluator private_values must be an array");
  if (value.length > EVALUATOR_LIMITS.private_value_entries) {
    throw new Error(`evaluator private_values exceeds ${EVALUATOR_LIMITS.private_value_entries} entries`);
  }
  const normalized = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const privateValue = value[index];
    if (typeof privateValue !== "string") throw new Error(`evaluator private_values[${index}] must be a string`);
    const commonForm = privateValue.trim().toLowerCase();
    if (Array.from(privateValue).length < EVALUATOR_LIMITS.private_value_min_code_points) continue;
    if (!commonForm || COMMON_PRIVATE_VALUES.has(commonForm)) continue;
    normalized.add(privateValue);
  }
  return Object.freeze(
    [...normalized].sort((left, right) => {
      const lengthDifference = Array.from(right).length - Array.from(left).length;
      if (lengthDifference !== 0) return lengthDifference;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  );
}

function requestDisclosureSurfaces(request: BlindEvaluatorRequest): Array<{ name: string; value: string }> {
  const surfaces: Array<{ name: string; value: string }> = [
    { name: "neutral artifact filename", value: NEUTRAL_ARTIFACT_FILENAME },
    { name: "neutral temporary prefix", value: NEUTRAL_TEMPORARY_PREFIX },
  ];
  if (typeof request.task === "string") surfaces.push({ name: "task material", value: request.task });
  if (typeof request.sample === "string") surfaces.push({ name: "sample material", value: request.sample });
  if (request.evaluator && typeof request.evaluator === "object") {
    if (Array.isArray(request.evaluator.argv)) {
      for (const argument of request.evaluator.argv) {
        if (typeof argument === "string") surfaces.push({ name: "evaluator argv", value: argument });
      }
    }
    if (typeof request.evaluator.version === "string") {
      surfaces.push({ name: "evaluator version", value: request.evaluator.version });
    }
  }
  if (request.publicEnv && typeof request.publicEnv === "object" && !Array.isArray(request.publicEnv)) {
    for (const [name, value] of Object.entries(request.publicEnv)) {
      surfaces.push({ name: "public environment name", value: name });
      if (typeof value === "string") surfaces.push({ name: "public environment value", value });
    }
  }
  return surfaces;
}

function assertPrivateValuesAbsent(privateValues: readonly string[], surfaces: readonly { name: string; value: string }[]): void {
  for (const surface of surfaces) {
    for (const privateValue of privateValues) {
      if (surface.value.includes(privateValue)) {
        throw new Error(`evaluator rejected a qualifying private value in ${surface.name}`);
      }
    }
  }
}

function assertPrivateBytesAbsent(privateValues: readonly string[], name: string, value: Buffer): void {
  for (const privateValue of privateValues) {
    if (value.indexOf(Buffer.from(privateValue, "utf8")) >= 0) {
      throw new Error(`evaluator rejected a qualifying private value in ${name}`);
    }
  }
}

function boundedText(value: string, name: string, limit: number): Buffer {
  if (typeof value !== "string") throw new Error(`evaluator ${name} must be a string`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > limit) throw new Error(`evaluator ${name} exceeds ${limit} bytes`);
  return bytes;
}

async function readArtifact(artifactPath: string): Promise<Buffer> {
  if (typeof artifactPath !== "string" || !path.isAbsolute(artifactPath) || artifactPath.includes("\0")) {
    throw new Error("evaluator artifactPath must be an absolute path without NUL");
  }
  const handle = await open(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((cause) => {
    throw new Error("evaluator artifactPath must identify a readable non-symlink file", { cause });
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("evaluator artifactPath must identify a regular file");
    if (info.size > EVALUATOR_LIMITS.artifact_bytes) {
      throw new Error(`evaluator artifact exceeds ${EVALUATOR_LIMITS.artifact_bytes} bytes`);
    }
    const bounded = Buffer.allocUnsafe(EVALUATOR_LIMITS.artifact_bytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const next = await handle.read(bounded, bytesRead, bounded.byteLength - bytesRead, bytesRead);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > EVALUATOR_LIMITS.artifact_bytes) {
      throw new Error(`evaluator artifact exceeds ${EVALUATOR_LIMITS.artifact_bytes} bytes`);
    }
    return Buffer.from(bounded.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function hashExecutable(filename: string): Promise<string> {
  const handle = await open(filename, fsConstants.O_RDONLY).catch((cause) => {
    throw new Error("evaluator executable became unreadable", { cause });
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("evaluator executable must remain a regular file");
    if (info.size > EVALUATOR_LIMITS.executable_bytes) {
      throw new Error(`evaluator executable exceeds ${EVALUATOR_LIMITS.executable_bytes} bytes`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < info.size) {
      const length = Math.min(buffer.byteLength, info.size - position);
      const next = await handle.read(buffer, 0, length, position);
      if (next.bytesRead === 0) break;
      hash.update(buffer.subarray(0, next.bytesRead));
      position += next.bytesRead;
    }
    if (position !== info.size) throw new Error("evaluator executable changed size while hashing");
    const extra = await handle.read(buffer, 0, 1, position);
    if (extra.bytesRead !== 0) throw new Error("evaluator executable changed size while hashing");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function runEvaluatorProcess(options: {
  evaluator: { argv: readonly string[]; version: string; rubric_sha256: string; executable_sha256: string };
  cwd: string;
  input: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
  publicEnv: Readonly<Record<string, string>>;
}): Promise<ProcessOutcome> {
  options.signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const stdout = new BoundedCapture(EVALUATOR_LIMITS.stdout_bytes);
  const stderr = new BoundedCapture(EVALUATOR_LIMITS.stderr_bytes);
  const [executable, ...args] = options.evaluator.argv;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        HOME: options.cwd,
        TMPDIR: options.cwd,
        TMP: options.cwd,
        TEMP: options.cwd,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        ...options.publicEnv,
      },
    });
  } catch (cause) {
    const now = new Date().toISOString();
    return {
      startedAt,
      finishedAt: now,
      durationMs: elapsedMilliseconds(startedNs),
      exitCode: null,
      signal: null,
      stdout: stdout.finish(),
      stderr: stderr.finish(),
      forcedFailure: { code: "spawn_error", message: `failed to spawn external evaluator: ${errorMessage(cause)}`, cause },
    };
  }

  return await new Promise<ProcessOutcome>((resolve) => {
    let forcedFailure: ProcessOutcome["forcedFailure"];
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const force = (failure: NonNullable<ProcessOutcome["forcedFailure"]>) => {
      if (forcedFailure) return;
      forcedFailure = failure;
      signalProcessGroup(child, "SIGTERM");
      escalation = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 150);
    };
    const onAbort = () => {
      const cause = options.signal?.reason;
      force({ code: "cancelled", message: "external evaluator was cancelled", cause });
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", onAbort);
      if (forcedFailure) signalProcessGroup(child, "SIGKILL");
      resolve({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: elapsedMilliseconds(startedNs),
        exitCode,
        signal,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        ...(forcedFailure ? { forcedFailure } : {}),
      });
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    timeout = setTimeout(
      () => force({ code: "timed_out", message: `external evaluator exceeded ${options.timeoutMs} ms` }),
      options.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stdout.add(chunk)) {
        force({ code: "output_too_large", message: `external evaluator stdout exceeded ${EVALUATOR_LIMITS.stdout_bytes} bytes` });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!stderr.add(chunk)) {
        force({ code: "output_too_large", message: `external evaluator stderr exceeded ${EVALUATOR_LIMITS.stderr_bytes} bytes` });
      }
    });
    child.stdin.on("error", () => {
      // A process may reject input and exit; its exit code and captured stderr are authoritative.
    });
    child.on("error", (cause) => {
      force({ code: "spawn_error", message: `external evaluator process error: ${errorMessage(cause)}`, cause });
    });
    child.on("close", finish);
    child.stdin.end(options.input);
  });
}

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private storedBytes = 0;
  private didTruncate = false;

  constructor(private readonly limit: number) {}

  add(value: Buffer): boolean {
    if (this.didTruncate) return false;
    const remaining = this.limit - this.storedBytes;
    if (value.byteLength <= remaining) {
      this.chunks.push(Buffer.from(value));
      this.storedBytes += value.byteLength;
      return true;
    }
    if (remaining > 0) {
      this.chunks.push(Buffer.from(value.subarray(0, remaining)));
      this.storedBytes += remaining;
    }
    this.didTruncate = true;
    return false;
  }

  finish(): EvaluatorStreamReceipt {
    const captured = Buffer.concat(this.chunks);
    // Receipts persist a JavaScript string, not the original byte buffer. Make
    // the stored UTF-8 representation the one and only material covered by
    // bytes/sha256, including when a process emitted malformed UTF-8.
    const raw = captured.toString("utf8");
    const stored = Buffer.from(raw, "utf8");
    return {
      raw,
      bytes: stored.byteLength,
      sha256: sha256(stored),
      truncated: this.didTruncate,
    };
  }
}

function parseSingleJson(raw: string): JsonValue {
  if (raw.trim().length === 0) throw new Error("stdout was empty");
  const value: unknown = JSON.parse(raw);
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("JSON numbers must be finite");
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (typeof current === "object") {
      pending.push(...Object.values(current));
      continue;
    }
    throw new Error(`unsupported JSON value type ${typeof current}`);
  }
  return value as JsonValue;
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The evaluator may have exited between observation and termination.
    }
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function elapsedMilliseconds(startedNs: bigint): number {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function neutralTemporaryRoot(): string {
  // On POSIX, os.tmpdir() is derived from TMPDIR/TMP/TEMP and could therefore
  // carry a run label supplied through the parent environment.
  return process.platform === "win32" ? path.join(path.parse(process.execPath).root, "Windows", "Temp") : "/tmp";
}
