/**
 * Run configuration. Models, harness, budget, checks and timeouts are managed
 * in a config file instead of CLI flags.
 *
 * Resolution order (first wins):
 *   1. --config <file>                       explicit file
 *   2. <workspace>/.hoh/config.json          the run's own config (editable between invocations)
 *   3. <cwd>/hoh.config.json                 tool-level default (this repository ships one)
 *   4. built-in defaults
 *
 * The effective config is written to `<workspace>/.hoh/config.json` and
 * committed with the run record, so every loop is reproducible.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROLES, type CheckSpec, type Role } from "../types.js";

export type HarnessName = "pi" | "mock";
export type ExecutionProtocol = "paper" | "extended";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ProviderModelConfig {
  id: string;
  name?: string;
  api?: ProviderApi;
  /** the endpoint accepts reasoning_effort / extended thinking for this model */
  reasoning?: boolean;
  input?: ("text" | "image")[];
  context_window?: number;
  max_tokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** pi compat flags, snake_case accepted (supports_developer_role, supports_reasoning_effort, supports_usage_in_streaming, supports_store) */
  compat?: Record<string, unknown>;
}

/** An OpenAI-compatible (or Anthropic-compatible) endpoint. */
export interface ProviderConfig {
  /** e.g. "https://gateway.example.com/v1" or "http://localhost:11434/v1"; may reference $ENV */
  base_url: string;
  /** "$ENV_VAR" or "!command" (literal values only for loopback hosts) */
  api_key?: string;
  /** default "openai-completions" */
  api?: ProviderApi;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  /** "discover" = GET {base_url}/models at run start; or an explicit list */
  models: "discover" | (string | ProviderModelConfig)[];
  discover?: { exclude?: string[]; include?: string[] };
  model_defaults?: Partial<Omit<ProviderModelConfig, "id">>;
  model_overrides?: Record<string, Partial<Omit<ProviderModelConfig, "id">>>;
}

export interface ModelsConfig {
  /** pi model pattern, e.g. "anthropic/claude-opus-5:high", "minimax/MiniMax-M3", "openai-codex/gpt-5.5:high" */
  default?: string;
  planner?: string;
  developer?: string;
  tester?: string;
}

export interface HohConfig {
  /** paper = fixed harness-model/runtime contract; extended = product-specific overrides */
  protocol: ExecutionProtocol;
  harness: HarnessName;
  /** custom endpoints, referenced from `models` as "<provider>/<model id>" */
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  /** iteration budget T */
  loops: number;
  /** artifact directory relative to the workspace; "." = whole workspace minus .hoh/ */
  artifact_dir: string;
  /**
   * Optional command run in the root of the isolated candidate worktree before the checks
   * (e.g. "cd tools && npm ci"). Recorded as check "setup"; a failure blocks like any check.
   */
  worktree_setup?: string;
  /** deterministic checks run on the frozen candidate before QA */
  checks: CheckSpec[];
  timeouts: {
    /** per-role wall-clock limit */
    role_min: number;
    /** default per-check limit */
    check_min: number;
  };
  pi: {
    /** pi agent directory holding auth.json / models.json / settings.json (default ~/.pi/agent) */
    agent_dir?: string;
  };
}

export const DEFAULT_CONFIG: HohConfig = {
  // Missing protocol fields deliberately resolve to extended for legacy compatibility.
  protocol: "extended",
  harness: "pi",
  providers: {},
  models: {},
  loops: 3,
  artifact_dir: ".",
  worktree_setup: undefined,
  checks: [],
  timeouts: { role_min: 60, check_min: 10 },
  pi: {},
};

export type ConfigPatch = {
  [K in keyof HohConfig]?: HohConfig[K] extends object ? (HohConfig[K] extends unknown[] ? HohConfig[K] : Partial<HohConfig[K]>) : HohConfig[K];
};

export const CONFIG_FILE_NAME = "hoh.config.json";

export function mergeConfig(base: HohConfig, patch: ConfigPatch | null | undefined): HohConfig {
  if (!patch) return structuredClone(base);
  const merged: HohConfig = {
    // Preserve an explicitly invalid value so validation reports it instead of
    // silently treating `null`/`undefined` from raw JSON as an omitted field.
    protocol: (Object.prototype.hasOwnProperty.call(patch, "protocol") ? patch.protocol : base.protocol) as ExecutionProtocol,
    harness: patch.harness ?? base.harness,
    providers: structuredClone({ ...base.providers, ...stripUndefined(patch.providers ?? {}) }) as Record<string, ProviderConfig>,
    models: { ...base.models, ...stripUndefined(patch.models ?? {}) },
    loops: patch.loops ?? base.loops,
    artifact_dir: patch.artifact_dir ?? base.artifact_dir,
    worktree_setup: patch.worktree_setup ?? base.worktree_setup,
    checks: patch.checks ? patch.checks.map((c) => ({ ...c })) : base.checks.map((c) => ({ ...c })),
    timeouts: { ...base.timeouts, ...stripUndefined(patch.timeouts ?? {}) },
    pi: { ...base.pi, ...stripUndefined(patch.pi ?? {}) },
  };
  if (merged.pi.agent_dir) merged.pi.agent_dir = expandHome(merged.pi.agent_dir);
  return merged;
}

export function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
}

export function validateConfig(c: HohConfig): string[] {
  const errors: string[] = [];
  if (c.protocol !== "paper" && c.protocol !== "extended") {
    errors.push(`protocol must be "paper" or "extended", got ${JSON.stringify(c.protocol)}`);
  }
  if (c.harness !== "pi" && c.harness !== "mock") errors.push(`harness must be "pi" or "mock", got ${JSON.stringify(c.harness)}`);
  if (!Number.isInteger(c.loops) || c.loops < 1) errors.push(`loops must be a positive integer, got ${JSON.stringify(c.loops)}`);
  if (typeof c.artifact_dir !== "string" || !c.artifact_dir || path.isAbsolute(c.artifact_dir) || /[\0\r\n]/.test(c.artifact_dir)) {
    errors.push(`artifact_dir must be a relative path inside the workspace, got ${JSON.stringify(c.artifact_dir)}`);
  } else {
    const normalizedArtifact = path.normalize(c.artifact_dir);
    if (
      normalizedArtifact === ".." ||
      normalizedArtifact.startsWith(`..${path.sep}`) ||
      normalizedArtifact === ".hoh" ||
      normalizedArtifact.startsWith(`.hoh${path.sep}`)
    ) {
      errors.push(`artifact_dir must stay inside the workspace and outside runtime-owned .hoh, got ${JSON.stringify(c.artifact_dir)}`);
    }
  }
  for (const [k, v] of Object.entries(c.models)) {
    if (v !== undefined && (typeof v !== "string" || !v.trim())) errors.push(`models.${k} must be a non-empty string`);
    if (!["default", "planner", "developer", "tester"].includes(k)) errors.push(`models.${k} is not a role (use default, planner, developer, tester)`);
  }
  if (c.harness === "pi" && !c.models.default && !(c.models.planner && c.models.developer && c.models.tester)) {
    errors.push("models.default (or planner+developer+tester) must be set for the pi harness");
  }
  if (c.protocol === "paper") {
    const patterns = ROLES.map((role) => modelForRole(c, role) ?? null);
    if (new Set(patterns).size !== 1) {
      errors.push(
        `paper protocol requires one identical model pattern for planner, developer, and tester (configured: ${ROLES.map((role, i) => `${role}=${patterns[i] ?? "(harness default)"}`).join(", ")})`,
      );
    }
  }
  if (!c.providers || typeof c.providers !== "object" || Array.isArray(c.providers)) errors.push("providers must be an object keyed by provider name");
  else
    for (const [name, p] of Object.entries(c.providers)) {
      const at = `providers.${name}`;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) errors.push(`${at}: provider names must be lowercase letters, digits, "-" or "_"`);
      if (!p || typeof p !== "object") {
        errors.push(`${at} must be an object`);
        continue;
      }
      if (typeof p.base_url !== "string" || !/^(https?:\/\/|\$)/.test(p.base_url)) errors.push(`${at}.base_url must be an http(s) URL (or $ENV reference)`);
      if (p.api !== undefined && !["openai-completions", "openai-responses", "anthropic-messages"].includes(p.api))
        errors.push(`${at}.api must be openai-completions, openai-responses, or anthropic-messages`);
      if (p.api_key !== undefined) {
        if (typeof p.api_key !== "string" || !p.api_key) errors.push(`${at}.api_key must be a non-empty string`);
        else if (!p.api_key.startsWith("$") && !p.api_key.startsWith("!") && !isLoopbackHost(p.base_url))
          errors.push(`${at}.api_key must be "$ENV_VAR" or "!command" (a literal key would be committed with the run record; literals are allowed only for localhost endpoints)`);
      }
      if (p.models !== "discover" && !Array.isArray(p.models)) errors.push(`${at}.models must be "discover" or an array of model ids/objects`);
      if (Array.isArray(p.models))
        p.models.forEach((m, i) => {
          if (typeof m === "string" ? !m.trim() : !m || typeof m.id !== "string" || !m.id.trim()) errors.push(`${at}.models[${i}] needs an id`);
        });
      if (p.models === "discover" && p.api === "anthropic-messages") errors.push(`${at}: model discovery is only supported for OpenAI-compatible endpoints`);
    }
  // every referenced "<provider>/<model>" with a custom provider must exist there when the list is explicit
  for (const [role, pattern] of Object.entries(c.models)) {
    if (!pattern) continue;
    const slash = pattern.indexOf("/");
    if (slash <= 0) continue;
    const prov = c.providers?.[pattern.slice(0, slash)];
    if (!prov || prov.models === "discover" || !Array.isArray(prov.models)) continue;
    const id = pattern.slice(slash + 1).replace(/:[a-z]+$/, "");
    const ids = prov.models.map((m) => (typeof m === "string" ? m : m.id));
    if (!ids.includes(id)) errors.push(`models.${role} references ${pattern}, but providers.${pattern.slice(0, slash)}.models does not list "${id}"`);
  }
  if (c.worktree_setup !== undefined && (typeof c.worktree_setup !== "string" || !c.worktree_setup.trim())) errors.push("worktree_setup must be a non-empty command string");
  if (!Array.isArray(c.checks)) errors.push("checks must be an array");
  else
    c.checks.forEach((chk, i) => {
      if (!chk || typeof chk.name !== "string" || !chk.name.trim()) errors.push(`checks[${i}].name is required`);
      if (!chk || typeof chk.command !== "string" || !chk.command.trim()) errors.push(`checks[${i}].command is required`);
      if (chk?.timeout_min !== undefined && !(chk.timeout_min > 0)) errors.push(`checks[${i}].timeout_min must be > 0`);
    });
  if (!(c.timeouts.role_min > 0)) errors.push("timeouts.role_min must be > 0");
  if (!(c.timeouts.check_min > 0)) errors.push("timeouts.check_min must be > 0");
  return errors;
}

function isLoopbackHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "0.0.0.0" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function assertValidConfig(c: HohConfig, source: string): void {
  const errors = validateConfig(c);
  if (errors.length) throw new Error(`invalid configuration (${source}):\n  - ${errors.join("\n  - ")}`);
}

export function modelForRole(c: HohConfig, role: Role): string | undefined {
  return c.models[role] ?? c.models.default;
}

export async function readConfigFile(file: string): Promise<ConfigPatch> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err: any) {
    throw new Error(`cannot read config ${file}: ${err?.message ?? err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`config ${file} is not valid JSON: ${err?.message ?? err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`config ${file} must contain a JSON object`);
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const k of Object.keys(parsed as object)) {
    if (!known.has(k)) throw new Error(`config ${file}: unknown key "${k}" (known: ${[...known].join(", ")})`);
  }
  return parsed as ConfigPatch;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedConfig {
  config: HohConfig;
  /** where the base configuration came from */
  source: string;
  /** patch to apply on top of the run's stored config (explicit file or tool default), if any */
  patch: ConfigPatch | null;
}

/**
 * Decide which config file seeds/overrides a run. The run's own
 * `.hoh/config.json` is loaded by the runtime itself; this only picks the
 * external file (explicit or tool-level) and reports what was chosen.
 */
export async function pickConfigFile(opts: { explicit?: string; workspace: string; cwd: string }): Promise<{ file: string | null; source: string }> {
  if (opts.explicit) return { file: path.resolve(opts.explicit), source: `--config ${opts.explicit}` };
  const runConfig = path.join(opts.workspace, ".hoh", "config.json");
  if (await fileExists(runConfig)) return { file: null, source: runConfig };
  const toolConfig = path.join(opts.cwd, CONFIG_FILE_NAME);
  if (await fileExists(toolConfig)) return { file: toolConfig, source: toolConfig };
  return { file: null, source: "built-in defaults" };
}
