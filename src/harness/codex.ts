/** Codex CLI adapter using the documented non-interactive `codex exec` surface. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Role } from "../types.js";
import type { Harness, HarnessRolePolicy, RoleInvocation, RoleResult } from "./types.js";
import { CODING_TOOLS, emptyUsage, INSPECT_TOOLS, READ_ONLY_TOOLS } from "./types.js";
import { ExecutionEvidenceCapture } from "../runtime/execution-evidence.js";

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const CODEX_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["uniqueItems"]);
const MAX_ERROR_TEXT = 8_000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface CodexHarnessOptions {
  executable?: string;
  executableArgs?: string[];
  version?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
}

interface ParsedModel {
  model: string;
  reasoning?: string;
  identity: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

export class CodexHarness implements Harness {
  readonly name = "codex";
  readonly modelReporting = "unavailable" as const;
  readonly version: string;

  constructor(private readonly opts: CodexHarnessOptions = {}) {
    this.version = opts.version ?? "unknown";
  }

  async resolveModel(pattern?: string): Promise<string | null> {
    if (!pattern && !this.opts.model) return null;
    return parseModel(pattern ?? this.opts.model!).identity;
  }

  rolePolicy(role: Role): HarnessRolePolicy {
    if (role === "planner") return { workspace: "active-read-only", builtinTools: ["codex-exec:read-only"] };
    if (role === "developer") return { workspace: "active-writer", builtinTools: ["codex-exec:workspace-write"] };
    return { workspace: "isolated-read-only", builtinTools: ["codex-exec:workspace-write-on-frozen-copy"] };
  }

  preparePrompts(inv: RoleInvocation): { systemPrompt: string; prompt: string } {
    const adapt = (text: string): string => inv.structuredTools.length
      ? text
        .replace(/Output contract:[^\n]*/g, "Output contract: return the final JSON object matching the supplied output schema. No submit tool is available.")
        .replace(/(?:call|calling)\s+`submit_[a-z_]+`(?:\s+exactly once)?/gi, "return the final JSON object matching the output schema")
        .replace("The runtime only accepts output delivered through that tool.", "The runtime requires the final JSON object matching the output schema.")
      : text;
    return { systemPrompt: adapt(inv.systemPrompt), prompt: adapt(inv.prompt) };
  }

  async invoke(inv: RoleInvocation): Promise<RoleResult> {
    inv.signal?.throwIfAborted();
    const selected = inv.model ?? this.opts.model;
    if (!selected) throw new Error(`codex: ${inv.role} requires an explicit model`);
    const model = parseModel(selected);
    assertExpectedTools(inv);
    if (inv.structuredTools.length > 1) {
      throw new Error(`codex: ${inv.role} exposes ${inv.structuredTools.length} structured tools; output-schema mode supports exactly one`);
    }

    const temporary = await mkdtemp(path.join(os.tmpdir(), "hoh-codex-"));
    const outputPath = path.join(temporary, "last-message.txt");
    const schemaPath = path.join(temporary, "output-schema.json");
    const structured = inv.structuredTools[0];
    const executionCapture = new ExecutionEvidenceCapture(inv.evidenceDir);
    const prompts = this.preparePrompts(inv);
    try {
      if (structured) await writeFile(schemaPath, `${JSON.stringify(toCodexOutputSchema(structured.parameters), null, 2)}\n`);
      const args = [
        ...(this.opts.executableArgs ?? []),
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "--color",
        "never",
        "--sandbox",
        sandboxForRole(inv.role),
        "--cd",
        inv.cwd,
        ...(inv.role === "tester" && inv.evidenceDir ? ["--add-dir", inv.evidenceDir] : []),
        "--model",
        model.model,
        "-c",
        'approval_policy="never"',
        "-c",
        'web_search="disabled"',
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        `developer_instructions=${JSON.stringify(prompts.systemPrompt)}`,
        ...(model.reasoning ? ["-c", `model_reasoning_effort=${JSON.stringify(model.reasoning)}`] : []),
        ...(structured ? ["--output-schema", schemaPath] : []),
        "--output-last-message",
        outputPath,
        "-",
      ];
      inv.onTranscript?.(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          type: "hoh_invocation",
          adapter: "codex",
          adapter_version: this.version,
          role: inv.role,
          loop: inv.loopIndex,
          cwd: inv.cwd,
          requested_model: model.identity,
          reported_model: null,
          sandbox: sandboxForRole(inv.role),
          structured_output: structured?.name ?? null,
        })}\n`,
      );
      const result = await runCodexProcess({
        executable: this.opts.executable ?? "codex",
        args,
        cwd: inv.cwd,
        env: this.opts.env,
        stdin: prompts.prompt,
        timeoutMs: inv.timeoutMs,
        signal: inv.signal,
        onStdout: (line) => {
          inv.onTranscript?.(`${line}\n`);
          let event: any;
          try { event = JSON.parse(line); } catch { return; }
          const item = event.item;
          if (item?.type !== "command_execution" || typeof item.id !== "string") return;
          if (event.type === "item.started") executionCapture.start(`qa:${item.id}`, String(item.command ?? ""));
          if (event.type === "item.completed") executionCapture.end(`qa:${item.id}`, item.status === "completed" && item.exit_code === 0 ? 0 : 1);
        },
        onStderr: (line) =>
          inv.onTranscript?.(`${JSON.stringify({ ts: new Date().toISOString(), type: "codex_stderr", text: line.slice(0, MAX_ERROR_TEXT) })}\n`),
        role: inv.role,
      });
      const events = parseJsonLines(result.stdout);
      const usage = emptyUsage();
      let turns = 0;
      for (const event of events) {
        if (event.type !== "turn.completed") continue;
        turns += 1;
        const value = isRecord(event.usage) ? event.usage : {};
        usage.input += number(value.input_tokens);
        usage.cacheRead += number(value.cached_input_tokens);
        usage.output += number(value.output_tokens);
        usage.totalTokens += number(value.input_tokens) + number(value.output_tokens);
      }
      const finalText = await readFile(outputPath, "utf8").catch(() => lastAgentMessage(events));
      const submissions: Record<string, unknown[]> = {};
      if (structured) {
        try {
          submissions[structured.name] = [normalizeCodexSubmission(JSON.parse(finalText), structured.parameters)];
        } catch {
          // The runtime's existing structured-output recovery owns a missing submission.
        }
      }
      return { finalText, submissions, usage, turns, executions: executionCapture.executions };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

/**
 * Codex uses OpenAI strict Structured Outputs for --output-schema. Every
 * object must reject extra keys and list every property as required. Preserve
 * the runtime's optional-field contract by making those fields nullable only
 * at the Codex boundary; normalize null back to omission after parsing.
 */
function toCodexOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCodexOutputSchema);
  if (!isRecord(value)) return value;

  const converted = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CODEX_UNSUPPORTED_SCHEMA_KEYWORDS.has(key))
      .map(([key, child]) => [key, toCodexOutputSchema(child)]),
  ) as Record<string, unknown>;
  if (converted.type !== "object" && !isRecord(converted.properties)) return converted;

  const sourceProperties = isRecord(value.properties) ? value.properties : {};
  const sourceRequired = new Set(
    Array.isArray(value.required) ? value.required.filter((key): key is string => typeof key === "string") : [],
  );
  const properties = Object.fromEntries(
    Object.entries(sourceProperties).map(([key, schema]) => {
      const strict = toCodexOutputSchema(schema);
      return [key, sourceRequired.has(key) ? strict : nullableSchema(strict)];
    }),
  );
  converted.properties = properties;
  converted.required = Object.keys(properties);
  converted.additionalProperties = false;
  return converted;
}

function nullableSchema(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.anyOf)) {
    if (value.anyOf.some((candidate) => isRecord(candidate) && candidate.type === "null")) return value;
    return { ...value, anyOf: [...value.anyOf, { type: "null" }] };
  }
  return { anyOf: [value, { type: "null" }] };
}

function normalizeCodexSubmission(value: unknown, schema: unknown): unknown {
  const selectedSchema = selectSchemaBranch(schema, value);
  if (Array.isArray(value)) {
    const items = isRecord(selectedSchema) ? selectedSchema.items : undefined;
    return value.map((item) => normalizeCodexSubmission(item, items));
  }
  if (!isRecord(value) || !isRecord(selectedSchema) || !isRecord(selectedSchema.properties)) return value;

  const required = new Set(
    Array.isArray(selectedSchema.required)
      ? selectedSchema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = selectedSchema.properties[key];
    if (child === null && childSchema !== undefined && !required.has(key)) continue;
    normalized[key] = normalizeCodexSubmission(child, childSchema);
  }
  return normalized;
}

function selectSchemaBranch(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema) || !Array.isArray(schema.anyOf)) return schema;
  return schema.anyOf.find((candidate) => schemaAcceptsType(candidate, value)) ?? schema;
}

function schemaAcceptsType(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (value === null) return schema.type === "null";
  if (Array.isArray(value)) return schema.type === "array";
  if (typeof value === "object") return schema.type === "object" || isRecord(schema.properties);
  return schema.type === typeof value || Object.prototype.hasOwnProperty.call(schema, "const");
}

export async function detectCodexVersion(options: Pick<CodexHarnessOptions, "executable" | "executableArgs" | "env"> = {}): Promise<string> {
  const result = await runCodexProcess({
    executable: options.executable ?? "codex",
    args: [...(options.executableArgs ?? []), "--version"],
    cwd: process.cwd(),
    env: options.env,
    stdin: "",
    timeoutMs: 10_000,
    role: "planner",
  });
  const version = result.stdout.trim();
  if (!version) throw new Error("codex: --version returned no version");
  return version;
}

function parseModel(pattern: string): ParsedModel {
  const raw = pattern.trim();
  if (!raw) throw new Error("codex: model must be a non-empty string");
  const withoutProvider = raw.startsWith("codex/") ? raw.slice("codex/".length) : raw;
  const colon = withoutProvider.lastIndexOf(":");
  const suffix = colon >= 0 ? withoutProvider.slice(colon + 1) : "";
  const reasoning = THINKING_LEVELS.has(suffix) ? suffix : undefined;
  const model = reasoning ? withoutProvider.slice(0, colon) : withoutProvider;
  if (!model || /[\0\r\n]/.test(model)) throw new Error(`codex: invalid model pattern ${JSON.stringify(pattern)}`);
  return { model, reasoning, identity: `codex/${model}${reasoning ? `:${reasoning}` : ""}` };
}

function sandboxForRole(role: Role): "read-only" | "workspace-write" {
  return role === "planner" ? "read-only" : "workspace-write";
}

async function runCodexProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  role: Role;
}): Promise<ProcessResult> {
  input.signal?.throwIfAborted();
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let cancelled: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stdoutRemainder = "";
    let stderrRemainder = "";
    const flushLines = (value: string, stream: "stdout" | "stderr") => {
      const combined = (stream === "stdout" ? stdoutRemainder : stderrRemainder) + value;
      const lines = combined.split(/\r?\n/);
      const remainder = lines.pop() ?? "";
      if (stream === "stdout") stdoutRemainder = remainder;
      else stderrRemainder = remainder;
      for (const line of lines) (stream === "stdout" ? input.onStdout : input.onStderr)?.(line);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const cancel = (error: Error) => {
      if (settled || cancelled) return;
      cancelled = error;
      killProcessGroup(child);
    };
    const onAbort = () => cancel(abortFailure(input.signal));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.timeoutMs && input.timeoutMs > 0) {
      timer = setTimeout(
        () => cancel(new Error(`codex: ${input.role} invocation exceeded ${Math.round(input.timeoutMs! / 60_000)} min and was aborted`)),
        input.timeoutMs,
      );
    }
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        cancel(new Error(`codex: ${input.role} process output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`));
        return;
      }
      const text = chunk.toString("utf8");
      stdout += text;
      flushLines(text, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        cancel(new Error(`codex: ${input.role} process output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`));
        return;
      }
      const text = chunk.toString("utf8");
      stderr += text;
      flushLines(text, "stderr");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelled ?? error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stdoutRemainder) input.onStdout?.(stdoutRemainder);
      if (stderrRemainder) input.onStderr?.(stderrRemainder);
      if (cancelled) reject(cancelled);
      else if (code !== 0) reject(new Error(`codex: ${input.role} exited ${code ?? "without a status"}: ${stderr.trim().slice(-MAX_ERROR_TEXT) || stdout.trim().slice(-MAX_ERROR_TEXT)}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.stdin);
    if (input.signal?.aborted) onAbort();
  });
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

function assertExpectedTools(invocation: RoleInvocation): void {
  const expected = invocation.role === "planner" ? READ_ONLY_TOOLS : invocation.role === "developer" ? CODING_TOOLS : INSPECT_TOOLS;
  const actual = new Set(invocation.tools);
  if (actual.size !== expected.length || expected.some((tool) => !actual.has(tool))) {
    throw new Error(
      `codex: ${invocation.role} received an unsupported outer tool policy (${invocation.tools.join(", ") || "none"}); expected ${expected.join(", ")}`,
    );
  }
}

function abortFailure(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "operation aborted" : String(reason));
  error.name = "AbortError";
  return error;
}

function parseJsonLines(value: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // Non-JSON stdout is retained in the transcript and final error context.
    }
  }
  return out;
}

function lastAgentMessage(events: Record<string, unknown>[]): string {
  for (const event of [...events].reverse()) {
    if (event.type !== "item.completed" || !isRecord(event.item) || event.item.type !== "agent_message") continue;
    return typeof event.item.text === "string" ? event.item.text : "";
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
