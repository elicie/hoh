/**
 * pi coding agent adapter (in-process SDK).
 *
 * Each role invocation is a fresh in-memory pi session with:
 *   - the role's system prompt replacing pi's default prompt
 *   - a tool allowlist (read-only for Planner, inspect-only for Tester, full for Developer)
 *   - structured-output tools (`submit_development_document`, `submit_evidence`)
 *   - ambient resources disabled; only runtime-attested role extensions and skills loaded
 *   - no project prompt templates, themes, or context files (the runtime owns the contract)
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
  type InlineExtension,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { HarnessResourceManifest, ResourceManifestEntry, Role, RoleResourceManifest } from "../types.js";
import type { Harness, RoleInvocation, RoleResult } from "./types.js";
import { emptyUsage, PI_BUILTIN_TOOL_NAMES } from "./types.js";

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
  /** Exact role resources resolved and hashed by the runtime before the run starts. */
  resourceManifest?: HarnessResourceManifest;
  /** Re-hash one role's resources immediately before and after loading them. */
  verifyResourceManifest?: (role: Role) => Promise<void>;
  /** Runtime-owned transport policy. These overrides take precedence over ambient pi settings. */
  sessionPolicy?: PiSessionPolicy;
}

export interface PiSessionPolicy {
  retry: {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxRetryDelayMs: number;
  };
  providerTimeoutMs: number;
  outputIdleTimeoutMs: number;
  websocketConnectTimeoutMs: number;
  compaction: Record<Role, { enabled: boolean; reserveTokens: number; keepRecentTokens: number }>;
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
  readonly resourceManifest?: HarnessResourceManifest;
  private runtime?: Promise<ModelRuntime>;

  constructor(private readonly opts: PiHarnessOptions = {}) {
    this.resourceManifest = opts.resourceManifest;
  }

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
    inv.signal?.throwIfAborted();
    await this.opts.verifyResourceManifest?.(inv.role);
    const modelRuntime = await this.getRuntime();
    const agentDir = this.opts.agentDir ?? getAgentDir();
    const roleResources = this.resourceManifest?.roles[inv.role];
    const extensionTools = roleResources?.extension_tools ?? [];
    const allowedTools = [...inv.tools, ...inv.structuredTools.map((tool) => tool.name), ...extensionTools];
    const allowedToolNames = new Set<string>(allowedTools);

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
      additionalExtensionPaths: roleResources?.extensions.map((entry) => entry.resolved_path),
      additionalSkillPaths: roleResources?.skills.map((entry) => entry.resolved_path),
      extensionFactories: [roleToolGuard(allowedToolNames)],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => inv.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    inv.signal?.throwIfAborted();
    await loader.reload();
    inv.signal?.throwIfAborted();
    await this.opts.verifyResourceManifest?.(inv.role);
    assertLoadedRoleResources(loader, inv.role, roleResources);

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

    const settingsManager = SettingsManager.create(inv.cwd, agentDir);
    if (this.opts.sessionPolicy) {
      const policy = this.opts.sessionPolicy;
      settingsManager.applyOverrides({
        retry: {
          enabled: policy.retry.enabled,
          maxRetries: policy.retry.maxRetries,
          baseDelayMs: policy.retry.baseDelayMs,
          // Keep SDK retries disabled so pi owns classification, backoff,
          // transcript events, and same-session continuation.
          provider: {
            timeoutMs: policy.providerTimeoutMs,
            maxRetries: 0,
            maxRetryDelayMs: policy.retry.maxRetryDelayMs,
          },
        },
        httpIdleTimeoutMs: policy.outputIdleTimeoutMs,
        websocketConnectTimeoutMs: policy.websocketConnectTimeoutMs,
        compaction: policy.compaction[inv.role],
      });
    }

    const { session } = await createAgentSession({
      cwd: inv.cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel,
      tools: allowedTools,
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(inv.cwd),
      settingsManager,
    });

    const usedModel = session.model
      ? `${session.model.provider}/${session.model.id}${session.thinkingLevel && session.thinkingLevel !== "off" ? `:${session.thinkingLevel}` : ""}`
      : undefined;
    const usage = emptyUsage();
    let turns = 0;
    let finalText = "";
    let lastError: string | undefined;
    let lastStop: string | undefined;
    let retryCount = 0;
    let compactionCount = 0;
    let compactionTokensBefore = 0;
    let compactionEstimatedTokensAfter: number | undefined;
    inv.onTranscript?.(
      `${JSON.stringify({ ts: new Date().toISOString(), type: "hoh_invocation", role: inv.role, loop: inv.loopIndex, cwd: inv.cwd, tools: allowedTools, model: usedModel, transport_policy: this.opts.sessionPolicy })}\n`,
    );

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_update") return;
      inv.onTranscript?.(`${JSON.stringify({ ts: new Date().toISOString(), ...event }, truncate)}\n`);
      if (event.type === "auto_retry_start") retryCount += 1;
      if (event.type === "compaction_end" && !event.aborted && event.result) {
        compactionCount += 1;
        compactionTokensBefore += finiteNumber(event.result.tokensBefore);
        if (Number.isFinite(event.result.estimatedTokensAfter)) compactionEstimatedTokensAfter = event.result.estimatedTokensAfter;
        addPiUsage(usage, event.result.usage);
      }
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
      await withInvocationDeadline(() => session.prompt(inv.prompt), inv.timeoutMs, inv.signal, async () => {
        await session.abort();
      });
    } finally {
      unsubscribe();
      session.dispose();
    }

    if (lastStop === "error") {
      throw new Error(`pi: model error during ${inv.role}: ${lastError ?? "unknown error"}`);
    }
    return {
      finalText,
      submissions,
      usage,
      turns,
      model: usedModel,
      ...(retryCount > 0 ? { retryCount } : {}),
      ...(compactionCount > 0 ? { compactionCount, compactionTokensBefore, compactionEstimatedTokensAfter } : {}),
    };
  }
}

function addPiUsage(target: ReturnType<typeof emptyUsage>, value: any): void {
  if (!value || typeof value !== "object") return;
  target.input += finiteNumber(value.input);
  target.output += finiteNumber(value.output);
  target.cacheRead += finiteNumber(value.cacheRead);
  target.cacheWrite += finiteNumber(value.cacheWrite);
  target.totalTokens += finiteNumber(value.totalTokens);
  target.cost += finiteNumber(value.cost?.total ?? value.cost);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function roleToolGuard(allowedTools: ReadonlySet<string>): InlineExtension {
  return {
    name: "hoh-role-tool-guard",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", (event) => {
        if (allowedTools.has(event.toolName)) return undefined;
        return {
          block: true,
          reason: `HoH role policy does not allow tool ${JSON.stringify(event.toolName)}`,
        };
      });
    },
  };
}

function assertLoadedRoleResources(loader: DefaultResourceLoader, role: Role, resources: RoleResourceManifest | undefined): void {
  const extensions = loader.getExtensions();
  if (extensions.errors.length > 0) {
    throw new Error(
      `pi: failed to load ${role} extensions: ${extensions.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
    );
  }

  const registeredExtensionTools = new Set<string>();
  const loadedExtensions = extensions.extensions.filter((extension) => extension.path !== "<inline:hoh-role-tool-guard>");
  for (const extension of loadedExtensions) {
    if (!resources?.extensions.some((entry) => containsResolvedPath(entry, extension.resolvedPath))) {
      throw new Error(`pi: ${role} loaded extension outside its recorded resource manifest: ${extension.resolvedPath}`);
    }
    for (const name of extension.tools.keys()) {
      if (PI_BUILTIN_TOOL_NAMES.includes(name) || name.startsWith("submit_")) {
        throw new Error(`pi: ${role} extension ${extension.path} conflicts with reserved tool ${JSON.stringify(name)}`);
      }
      registeredExtensionTools.add(name);
    }
  }
  const unloadedExtensions = (resources?.extensions ?? []).filter(
    (entry) => !loadedExtensions.some((extension) => containsResolvedPath(entry, extension.resolvedPath)),
  );
  if (unloadedExtensions.length > 0) {
    throw new Error(`pi: ${role} extension resources loaded no entrypoint: ${unloadedExtensions.map((entry) => entry.configured_path).join(", ")}`);
  }

  const missingTools = (resources?.extension_tools ?? []).filter((name) => !registeredExtensionTools.has(name));
  if (missingTools.length > 0) {
    throw new Error(`pi: ${role} extension tool allowlist names tools that were not registered: ${missingTools.join(", ")}`);
  }

  const skills = loader.getSkills();
  if (skills.diagnostics.length > 0) {
    throw new Error(
      `pi: failed to load ${role} skills: ${skills.diagnostics.map((diagnostic) => `${diagnostic.path ?? "(unknown path)"}: ${diagnostic.message}`).join("; ")}`,
    );
  }
  const hashedSkillSources = [...(resources?.skills ?? []), ...(resources?.extensions ?? [])];
  for (const skill of skills.skills) {
    if (!hashedSkillSources.some((entry) => containsResolvedPath(entry, skill.filePath))) {
      throw new Error(`pi: ${role} loaded skill outside its recorded resource manifest: ${skill.filePath}`);
    }
  }
  const unloadedSkills = (resources?.skills ?? []).filter(
    (entry) => !skills.skills.some((skill) => containsResolvedPath(entry, skill.filePath)),
  );
  if (unloadedSkills.length > 0) {
    throw new Error(`pi: ${role} skill resources loaded no valid skill: ${unloadedSkills.map((entry) => entry.configured_path).join(", ")}`);
  }
}

function containsResolvedPath(resource: ResourceManifestEntry, loadedPath: string): boolean {
  const resolved = path.resolve(loadedPath);
  if (resource.kind === "file") return resolved === resource.resolved_path;
  const relative = path.relative(resource.resolved_path, resolved);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function truncate(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_STRING) {
    return `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)`;
  }
  return value;
}

/** @internal Exported so the cancellation ordering contract can be regression-tested. */
export async function withInvocationDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  onCancel: () => Promise<void>,
): Promise<T> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let cancelling = false;
      const cancel = (failure: Error) => {
        if (settled || cancelling) return;
        cancelling = true;
        void Promise.resolve()
          .then(onCancel)
          .then(
            () => {
              settled = true;
              reject(failure);
            },
            () => {
              // Cancellation owns the outcome once it starts. Preserve the
              // timeout/operator reason even if the SDK's abort cleanup fails.
              settled = true;
              reject(failure);
            },
          );
      };
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          cancel(new Error(`pi: role invocation exceeded ${Math.round(timeoutMs / 60000)} min and was aborted`));
        }, timeoutMs);
      }
      if (signal) {
        onAbort = () => cancel(abortFailure(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      if (cancelling) return;
      let pending: Promise<T>;
      try {
        pending = operation();
      } catch (error) {
        settled = true;
        reject(error);
        return;
      }
      pending.then(
        (value) => {
          if (settled || cancelling) return;
          settled = true;
          resolve(value);
        },
        (error) => {
          if (settled || cancelling) return;
          settled = true;
          reject(error);
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortFailure(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(signal.reason === undefined ? "operation aborted" : String(signal.reason));
  error.name = "AbortError";
  return error;
}
