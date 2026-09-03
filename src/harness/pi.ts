/**
 * pi coding agent adapter (in-process SDK).
 *
 * Each role invocation is a fresh in-memory pi session with:
 *   - the role's system prompt replacing pi's default prompt
 *   - a tool allowlist (read-only for Planner, inspect-only for Tester, full for Developer)
 *   - structured-output tools (`submit_development_document`, `submit_evidence`)
 *   - no project extensions/skills/context files (the runtime owns the contract)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Harness, RoleInvocation, RoleResult } from "./types.js";
import { emptyUsage } from "./types.js";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface PiHarnessOptions {
  /** pi model pattern, e.g. "anthropic/claude-opus-4-5", "sonnet:high", "minimax/MiniMax-M3" */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** pi agent directory (auth.json, models.json, settings.json). Default: ~/.pi/agent */
  agentDir?: string;
  /** injected model runtime (tests, custom providers) */
  modelRuntime?: ModelRuntime;
  /** create-time options when no runtime is injected */
  modelRuntimeOptions?: Parameters<typeof ModelRuntime.create>[0];
}

const MAX_STRING = 20_000;

function piPackageVersion(): string {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

export class PiHarness implements Harness {
  readonly name = "pi";
  readonly version = piPackageVersion();
  private runtime?: Promise<ModelRuntime>;

  constructor(private readonly opts: PiHarnessOptions = {}) {}

  private getRuntime(): Promise<ModelRuntime> {
    if (!this.runtime) {
      this.runtime = this.opts.modelRuntime ? Promise.resolve(this.opts.modelRuntime) : ModelRuntime.create(this.opts.modelRuntimeOptions);
    }
    return this.runtime;
  }

  async resolveModel(pattern?: string): Promise<string | null> {
    if (!pattern) return null;
    const resolved = resolveCliModel({ cliModel: pattern, modelRuntime: await this.getRuntime() });
    if (resolved.error || !resolved.model) throw new Error(`pi: cannot resolve model "${pattern}": ${resolved.error ?? "not found"}`);
    return `${resolved.model.provider}/${resolved.model.id}${resolved.thinkingLevel && resolved.thinkingLevel !== "off" ? `:${resolved.thinkingLevel}` : ""}`;
  }

  async invoke(inv: RoleInvocation): Promise<RoleResult> {
    const modelRuntime = await this.getRuntime();
    const agentDir = this.opts.agentDir ?? getAgentDir();

    let model;
    let thinkingLevel = this.opts.thinkingLevel;
    const pattern = inv.model ?? this.opts.model;
    if (pattern) {
      const resolved = resolveCliModel({ cliModel: pattern, modelRuntime });
      if (resolved.error || !resolved.model) {
        throw new Error(`pi: cannot resolve model "${pattern}" for ${inv.role}: ${resolved.error ?? "not found"}`);
      }
      model = resolved.model;
      thinkingLevel = resolved.thinkingLevel ?? thinkingLevel;
    }

    const loader = new DefaultResourceLoader({
      cwd: inv.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => inv.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const submissions: Record<string, unknown[]> = {};
    const customTools = inv.structuredTools.map((t) =>
      defineTool({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: t.parameters,
        async execute(_toolCallId, params) {
          (submissions[t.name] ??= []).push(params);
          return {
            content: [{ type: "text", text: `${t.name} recorded by the runtime. Do not call it again; reply with a one-line confirmation and stop.` }],
            details: {},
          };
        },
      }),
    );

    const { session } = await createAgentSession({
      cwd: inv.cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel,
      tools: [...inv.tools, ...inv.structuredTools.map((t) => t.name)],
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(inv.cwd),
      settingsManager: SettingsManager.create(inv.cwd, agentDir),
    });

    const usedModel = session.model
      ? `${session.model.provider}/${session.model.id}${session.thinkingLevel && session.thinkingLevel !== "off" ? `:${session.thinkingLevel}` : ""}`
      : undefined;
    const usage = emptyUsage();
    let turns = 0;
    let finalText = "";
    let lastError: string | undefined;
    let lastStop: string | undefined;
    let out: fs.WriteStream | undefined;
    if (inv.transcriptPath) {
      fs.mkdirSync(path.dirname(inv.transcriptPath), { recursive: true });
      out = fs.createWriteStream(inv.transcriptPath, { flags: "a" });
      out.on("error", (err) => process.stderr.write(`hoh: transcript write failed: ${err.message}\n`));
    }
    out?.write(
      `${JSON.stringify({ ts: new Date().toISOString(), type: "hoh_invocation", role: inv.role, loop: inv.loopIndex, cwd: inv.cwd, tools: [...inv.tools, ...inv.structuredTools.map((t) => t.name)], model: usedModel })}\n`,
    );

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_update") return;
      out?.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event }, truncate)}\n`);
      if (event.type === "turn_end") turns += 1;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const m = event.message;
        if (m.usage) {
          usage.input += m.usage.input ?? 0;
          usage.output += m.usage.output ?? 0;
          usage.cacheRead += m.usage.cacheRead ?? 0;
          usage.cacheWrite += m.usage.cacheWrite ?? 0;
          usage.totalTokens += m.usage.totalTokens ?? 0;
          usage.cost += m.usage.cost?.total ?? 0;
        }
        const text = (m.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        if (text) finalText = text;
        lastStop = m.stopReason;
        lastError = m.errorMessage;
      }
    });

    try {
      await withTimeout(session.prompt(inv.prompt), inv.timeoutMs, async () => {
        await session.abort();
      });
    } finally {
      unsubscribe();
      session.dispose();
      out?.end();
    }

    if (lastStop === "error") {
      throw new Error(`pi: model error during ${inv.role}: ${lastError ?? "unknown error"}`);
    }
    return { finalText, submissions, usage, turns, model: usedModel };
  }
}

function truncate(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_STRING) {
    return `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)`;
  }
  return value;
}

async function withTimeout<T>(p: Promise<T>, ms: number | undefined, onTimeout: () => Promise<void>): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      try {
        await onTimeout();
      } finally {
        reject(new Error(`pi: role invocation exceeded ${Math.round(ms / 60000)} min and was aborted`));
      }
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
