/**
 * Deterministic checks (`Runtime.check(A_t)` in Algorithm 1): build and smoke
 * commands run against the frozen candidate before the QA Tester starts.
 */
import { spawn } from "node:child_process";
import type { CheckResult, CheckSpec } from "../types.js";

const TAIL = 4000;

function tail(s: string): string {
  return s.length > TAIL ? `…(${s.length - TAIL} chars omitted)…\n${s.slice(-TAIL)}` : s;
}

export function runCheck(spec: CheckSpec, cwd: string, defaultTimeoutMs: number, env: Record<string, string> = {}): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = spec.timeout_ms ?? (spec.timeout_min ? spec.timeout_min * 60_000 : defaultTimeoutMs);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (status: CheckResult["status"], exit_code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({
        name: spec.name,
        command: spec.command,
        status,
        exit_code,
        duration_ms: Date.now() - started,
        stdout_tail: tail(stdout),
        stderr_tail: tail(stderr),
      });
    };
    let child;
    try {
      child = spawn("sh", ["-c", spec.command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...env } });
    } catch (err) {
      stderr = String(err);
      finish("error", null);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      finish("error", null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) finish("timeout", code);
      else finish(code === 0 ? "pass" : "fail", code);
    });
  });
}

export async function runChecks(specs: CheckSpec[], cwd: string, defaultTimeoutMs = 10 * 60_000, env: Record<string, string> = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const spec of specs) results.push(await runCheck(spec, cwd, defaultTimeoutMs, env));
  return results;
}

export function renderChecks(results: CheckResult[]): string {
  if (results.length === 0) return "_No deterministic checks are configured._";
  const lines = ["| Check | Status | Exit | Duration |", "| --- | --- | --- | --- |"];
  for (const r of results) {
    lines.push(`| \`${r.name}\` | ${r.status.toUpperCase()} | ${r.exit_code ?? "-"} | ${(r.duration_ms / 1000).toFixed(1)}s |`);
  }
  for (const r of results) {
    if (r.status === "pass") continue;
    lines.push("", `### ${r.name} (${r.status})`, "```", `$ ${r.command}`, r.stdout_tail.trim(), r.stderr_tail.trim(), "```");
  }
  return lines.join("\n");
}
