/**
 * Deterministic checks (`Runtime.check(A_t)` in Algorithm 1): build and smoke
 * commands run against the frozen candidate before the QA Tester starts.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CheckResult, CheckSpec } from "../types.js";
import { MAX_EVIDENCE_FILE_BYTES } from "./evidence-files.js";

const TAIL = 4000;

interface CapturedOutput {
  bytes: number;
  contents: Buffer | null;
  originalSha256: string;
  tail: string;
}

class OutputCapture {
  private readonly decoder = new StringDecoder("utf8");
  private readonly hash = createHash("sha256");
  private chunks: Buffer[] = [];
  private byteCount = 0;
  private characterCount = 0;
  private tailText = "";
  private oversized = false;

  add(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.hash.update(chunk);
    this.byteCount += chunk.byteLength;
    if (!this.oversized && this.byteCount <= MAX_EVIDENCE_FILE_BYTES) this.chunks.push(Buffer.from(chunk));
    else if (!this.oversized) {
      this.oversized = true;
      this.chunks = [];
    }
    this.appendText(this.decoder.write(chunk));
  }

  finish(): CapturedOutput {
    this.appendText(this.decoder.end());
    return {
      bytes: this.byteCount,
      contents: this.oversized ? null : Buffer.concat(this.chunks),
      originalSha256: this.hash.digest("hex"),
      tail:
        this.characterCount > TAIL
          ? `…(${this.characterCount - TAIL} chars omitted)…\n${this.tailText}`
          : this.tailText,
    };
  }

  private appendText(text: string): void {
    this.characterCount += text.length;
    this.tailText = `${this.tailText}${text}`.slice(-TAIL);
  }
}

export interface CheckEvidenceOutput {
  directory: string;
  basename?: string;
}

export function runCheck(
  spec: CheckSpec,
  cwd: string,
  defaultTimeoutMs: number,
  env: Record<string, string> = {},
  evidence?: CheckEvidenceOutput,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = spec.timeout_ms ?? (spec.timeout_min ? spec.timeout_min * 60_000 : defaultTimeoutMs);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortFailure(signal));
      return;
    }
    const stdout = new OutputCapture();
    const stderr = new OutputCapture();
    let timedOut = false;
    let aborted = false;
    let cancellation: Error | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (status: CheckResult["status"], exit_code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        const stdoutResult = stdout.finish();
        const stderrResult = stderr.finish();
        const files = evidence
          ? await Promise.all([
              storeCheckOutput(evidence, spec.name, "stdout", stdoutResult),
              storeCheckOutput(evidence, spec.name, "stderr", stderrResult),
            ])
          : [];
        resolve({
          name: spec.name,
          command: spec.command,
          status,
          exit_code,
          duration_ms: Date.now() - started,
          stdout_tail: stdoutResult.tail,
          stderr_tail: stderrResult.tail,
          ...(files[0] ? { stdout_path: files[0].path, stdout_sha256: files[0].sha256 } : {}),
          ...(files[1] ? { stderr_path: files[1].path, stderr_sha256: files[1].sha256 } : {}),
        });
      })().catch(reject);
    };
    const failCancellation = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancellation ?? abortFailure(signal));
    };
    function onAbort(): void {
      if (settled || timedOut || aborted) return;
      aborted = true;
      cancellation = abortFailure(signal);
      if (child) killProcessGroup(child);
    }
    try {
      child = spawn("sh", ["-c", spec.command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...env } });
    } catch (err) {
      stderr.add(String(err));
      finish("error", null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child!);
    }, timeoutMs);
    child.stdout!.on("data", (data: Buffer) => stdout.add(data));
    child.stderr!.on("data", (data: Buffer) => stderr.add(data));
    child.on("error", (err) => {
      if (aborted) {
        failCancellation();
        return;
      }
      stderr.add(String(err));
      finish("error", null);
    });
    child.on("close", (code) => {
      if (aborted) failCancellation();
      else if (timedOut) finish("timeout", code);
      else finish(code === 0 ? "pass" : "fail", code);
    });
  });
}

export async function runChecks(
  specs: CheckSpec[],
  cwd: string,
  defaultTimeoutMs = 10 * 60_000,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    signal?.throwIfAborted();
    const spec = specs[index];
    const evidenceDir = env.HOH_EVIDENCE_DIR;
    results.push(
      await runCheck(
        spec,
        cwd,
        defaultTimeoutMs,
        env,
        evidenceDir ? { directory: evidenceDir, basename: `${String(index + 1).padStart(2, "0")}-${safeName(spec.name)}` } : undefined,
        signal,
      ),
    );
  }
  return results;
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the group and direct kill attempts.
    }
  }
}

function abortFailure(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
}

export function renderChecks(results: CheckResult[]): string {
  if (results.length === 0) return "_No deterministic checks are configured._";
  const lines = ["| Check | Status | Exit | Duration |", "| --- | --- | --- | --- |"];
  for (const r of results) {
    lines.push(`| \`${r.name}\` | ${r.status.toUpperCase()} | ${r.exit_code ?? "-"} | ${(r.duration_ms / 1000).toFixed(1)}s |`);
  }
  if (results.some((result) => result.stdout_path || result.stderr_path)) {
    lines.push("", "Evidence files:");
    for (const result of results) {
      if (result.stdout_path) lines.push(`- \`${result.name}\` stdout: \`${result.stdout_path}\` (${result.stdout_sha256?.slice(0, 12) ?? "no hash"})`);
      if (result.stderr_path) lines.push(`- \`${result.name}\` stderr: \`${result.stderr_path}\` (${result.stderr_sha256?.slice(0, 12) ?? "no hash"})`);
    }
  }
  for (const r of results) {
    if (r.status === "pass") continue;
    lines.push("", `### ${r.name} (${r.status})`, "```", `$ ${r.command}`, r.stdout_tail.trim(), r.stderr_tail.trim(), "```");
  }
  return lines.join("\n");
}

async function storeCheckOutput(
  output: CheckEvidenceOutput,
  checkName: string,
  stream: "stdout" | "stderr",
  captured: CapturedOutput,
): Promise<{ path: string; sha256: string }> {
  const directory = path.join(output.directory, "checks");
  await mkdir(directory, { recursive: true });
  const basename = output.basename ?? safeName(checkName);
  let filename: string;
  let contents: Buffer;
  if (captured.contents === null) {
    filename = `${basename}.${stream}.omitted.json`;
    contents = Buffer.from(
      `${JSON.stringify(
        {
          omitted: true,
          reason: `output exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte evidence file limit`,
          original_bytes: captured.bytes,
          original_sha256: captured.originalSha256,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    filename = `${basename}.${stream}.log`;
    contents = captured.contents;
  }
  const absolute = path.join(directory, filename);
  await writeFile(absolute, contents);
  return {
    path: path.posix.join("checks", filename),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "check";
}
