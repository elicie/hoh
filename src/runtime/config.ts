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
import { PI_BUILTIN_TOOL_NAMES } from "../harness/types.js";
import { ROLES, type CheckSpec, type Role } from "../types.js";

export type HarnessName = "pi" | "codex" | "mock";
export type ExecutionProtocol = "paper" | "extended";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ProviderModelConfig {
  id: string;
  name?: string;
  api?: ProviderApi;
  /** the endpoint accepts reasoning_effort / extended thinking for this model */
  reasoning?: boolean;
  /** Map pi thinking levels to provider efforts; xhigh/max must be declared explicitly. */
  thinking_level_map?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
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
  /** Adapter model pattern, e.g. "anthropic/claude-opus-5:high" or "codex/gpt-5.6:high". */
  default?: string;
  planner?: string;
  developer?: string;
  tester?: string;
}

export interface PiCompactionConfig {
  enabled: boolean;
  reserve_tokens: number;
  keep_recent_tokens: number;
}

export const DEFAULT_PI_COMPACTION: Readonly<PiCompactionConfig> = Object.freeze({
  enabled: true,
  reserve_tokens: 16_384,
  keep_recent_tokens: 20_000,
});

export interface PiRoleResourcesConfig {
  /** Explicit workspace-relative extension files/directories added for this role. */
  extensions?: string[];
  /** Explicit workspace-relative skill files/directories added for this role. */
  skills?: string[];
  /** Exact extension-registered tool names this role may invoke. */
  extension_tools?: string[];
  /** Role-specific override of the deterministic pi compaction policy. */
  compaction?: Partial<PiCompactionConfig>;
}

export interface PiConfig {
  /** pi agent directory holding auth.json / models.json / settings.json (default ~/.pi/agent) */
  agent_dir?: string;
  /** Explicit workspace-relative extension files/directories shared by all roles. */
  extensions?: string[];
  /** Explicit workspace-relative skill files/directories shared by all roles. */
  skills?: string[];
  /** Default compaction policy for all roles; role overrides merge on top. */
  compaction?: PiCompactionConfig;
  /** Role additions are merged with the shared paths when the manifest is built. */
  roles?: Partial<Record<Role, PiRoleResourcesConfig>>;
}

export interface RetryConfig {
  /** Agent-level retries for transient transport failures, rate limits, and 5xx responses. */
  enabled: boolean;
  /** Number of retries after the initial request. */
  max_retries: number;
  /** Initial exponential-backoff delay. */
  base_delay_ms: number;
  /** Maximum provider-requested retry delay accepted by the adapter. */
  max_delay_ms: number;
}

export interface BudgetLimitConfig {
  /** Active runtime wall time at this boundary. */
  elapsed_ms?: number;
  /** Completed role usage only. */
  total_tokens?: number;
  /** Completed role usage cost; fractional values are supported. */
  cost?: number;
}

export interface BudgetConfig {
  /** Maximum usage for each role slot in a loop, including successful structured-output attempts. */
  role?: BudgetLimitConfig;
  /** Maximum aggregate usage for one Planner -> Developer -> Tester loop. */
  loop?: BudgetLimitConfig;
  /** Maximum aggregate usage for the whole run. */
  run?: BudgetLimitConfig;
}

export interface HohConfig {
  /** paper = fixed harness-model/runtime contract; extended = product-specific overrides */
  protocol: ExecutionProtocol;
  /** Fixed catalog extension: use an existing catalog, explicitly generate it, or disable it. */
  claim_catalog?: "off" | "existing" | "generate";
  /** Optional human approval of each development plan; extended runs only. */
  human_checkpoint?: boolean;
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
    /** per-provider-request ceiling */
    provider_ms: number;
    /** maximum silence between provider stream events */
    output_idle_ms: number;
    /** maximum WebSocket connect/open handshake wait */
    websocket_connect_ms: number;
  };
  retry: RetryConfig;
  /** Optional role/loop/run usage ceilings. Omitted limits preserve the unbounded legacy behavior. */
  budgets?: BudgetConfig;
  pi: PiConfig;
}

export const DEFAULT_CONFIG: HohConfig = {
  // Missing protocol fields deliberately resolve to extended for legacy compatibility.
  protocol: "extended",
  claim_catalog: undefined,
  human_checkpoint: undefined,
  harness: "pi",
  providers: {},
  models: {},
  loops: 3,
  artifact_dir: ".",
  worktree_setup: undefined,
  checks: [],
  timeouts: {
    role_min: 60,
    check_min: 10,
    provider_ms: 60 * 60_000,
    output_idle_ms: 5 * 60_000,
    websocket_connect_ms: 15_000,
  },
  retry: { enabled: true, max_retries: 3, base_delay_ms: 2_000, max_delay_ms: 60_000 },
  budgets: undefined,
  pi: { compaction: { ...DEFAULT_PI_COMPACTION } },
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
    claim_catalog: patch.claim_catalog ?? base.claim_catalog,
    human_checkpoint: patch.human_checkpoint ?? base.human_checkpoint,
    providers: structuredClone({ ...base.providers, ...stripUndefined(patch.providers ?? {}) }) as Record<string, ProviderConfig>,
    models: { ...base.models, ...stripUndefined(patch.models ?? {}) },
    loops: patch.loops ?? base.loops,
    artifact_dir: patch.artifact_dir ?? base.artifact_dir,
    worktree_setup: patch.worktree_setup ?? base.worktree_setup,
    checks: patch.checks ? patch.checks.map((c) => ({ ...c })) : base.checks.map((c) => ({ ...c })),
    timeouts: { ...base.timeouts, ...stripUndefined(patch.timeouts ?? {}) },
    retry: { ...base.retry, ...stripUndefined(patch.retry ?? {}) },
    budgets: mergeBudgetConfig(base.budgets, patch.budgets),
    pi: mergePiConfig(base.pi, patch.pi),
  };
  if (merged.pi?.agent_dir) merged.pi.agent_dir = expandHome(merged.pi.agent_dir);
  return merged;
}

export function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
}

function mergeBudgetConfig(base: BudgetConfig | undefined, patch: Partial<BudgetConfig> | null | undefined): BudgetConfig | undefined {
  if (patch === null) return patch as unknown as BudgetConfig;
  if (patch === undefined) return base ? structuredClone(base) : undefined;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch as BudgetConfig;
  const merged: BudgetConfig = {};
  for (const scope of ["role", "loop", "run"] as const) {
    const patchHasScope = Object.prototype.hasOwnProperty.call(patch, scope);
    const patchLimit = patch[scope];
    if (!patchHasScope) {
      if (base?.[scope]) merged[scope] = structuredClone(base[scope]);
    } else if (patchLimit === null || typeof patchLimit !== "object" || Array.isArray(patchLimit)) {
      merged[scope] = patchLimit as BudgetLimitConfig;
    } else {
      const definedLimit = Object.fromEntries(Object.entries(patchLimit).filter(([, value]) => value !== undefined));
      merged[scope] = { ...(base?.[scope] ?? {}), ...definedLimit };
    }
  }
  return merged;
}

function mergePiConfig(base: PiConfig, patch: Partial<PiConfig> | null | undefined): PiConfig {
  if (patch === null) return patch as unknown as PiConfig;
  if (!patch) return structuredClone(base);
  const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<PiConfig>;
  const merged = { ...structuredClone(base), ...definedPatch };
  if (Object.prototype.hasOwnProperty.call(patch, "compaction")) {
    merged.compaction =
      patch.compaction && typeof patch.compaction === "object" && !Array.isArray(patch.compaction)
        ? { ...(base.compaction ?? DEFAULT_PI_COMPACTION), ...stripUndefined(patch.compaction) }
        : (patch.compaction as PiConfig["compaction"]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "roles")) {
    if (!patch.roles || typeof patch.roles !== "object" || Array.isArray(patch.roles)) {
      merged.roles = patch.roles as PiConfig["roles"];
    } else {
      const roles: Partial<Record<Role, PiRoleResourcesConfig>> = structuredClone(base.roles ?? {});
      for (const [role, rolePatch] of Object.entries(patch.roles)) {
        const current = roles[role as Role] ?? {};
        if (rolePatch && typeof rolePatch === "object" && !Array.isArray(rolePatch)) {
          const next = { ...current, ...Object.fromEntries(Object.entries(rolePatch).filter(([, value]) => value !== undefined)) };
          if (Object.prototype.hasOwnProperty.call(rolePatch, "compaction")) {
            next.compaction =
              rolePatch.compaction && typeof rolePatch.compaction === "object" && !Array.isArray(rolePatch.compaction)
                ? { ...(current.compaction ?? {}), ...stripUndefined(rolePatch.compaction) }
                : rolePatch.compaction;
          }
          roles[role as Role] = next;
        } else {
          roles[role as Role] = rolePatch as PiRoleResourcesConfig;
        }
      }
      merged.roles = roles;
    }
  }
  return merged;
}

export function validateConfig(c: HohConfig): string[] {
  const errors: string[] = [];
  if (c.claim_catalog !== undefined && !["off", "existing", "generate"].includes(c.claim_catalog)) errors.push('claim_catalog must be off, existing, or generate');
  if (c.human_checkpoint !== undefined && typeof c.human_checkpoint !== "boolean") errors.push("human_checkpoint must be a boolean");
  if (c.human_checkpoint && c.protocol !== "extended") errors.push("human_checkpoint is available only in extended runs");
  if (c.protocol !== "paper" && c.protocol !== "extended") {
    errors.push(`protocol must be "paper" or "extended", got ${JSON.stringify(c.protocol)}`);
  }
  if (c.harness !== "pi" && c.harness !== "codex" && c.harness !== "mock") {
    errors.push(`harness must be "pi", "codex", or "mock", got ${JSON.stringify(c.harness)}`);
  }
  if (!Number.isInteger(c.loops) || c.loops < 1) errors.push(`loops must be a positive integer, got ${JSON.stringify(c.loops)}`);
  if (
    typeof c.artifact_dir !== "string" ||
    !c.artifact_dir ||
    path.isAbsolute(c.artifact_dir) ||
    path.posix.isAbsolute(c.artifact_dir) ||
    path.win32.isAbsolute(c.artifact_dir) ||
    /[\\\0\r\n]/.test(c.artifact_dir)
  ) {
    errors.push(`artifact_dir must be a canonical POSIX-style relative path inside the workspace, got ${JSON.stringify(c.artifact_dir)}`);
  } else {
    const normalizedArtifact = path.posix.normalize(c.artifact_dir);
    if (
      normalizedArtifact !== c.artifact_dir ||
      (c.artifact_dir !== "." && c.artifact_dir.endsWith("/")) ||
      normalizedArtifact === ".." ||
      normalizedArtifact.startsWith("../") ||
      normalizedArtifact === ".hoh" ||
      normalizedArtifact.startsWith(".hoh/")
    ) {
      errors.push(`artifact_dir must stay inside the workspace and outside runtime-owned .hoh, got ${JSON.stringify(c.artifact_dir)}`);
    }
  }
  for (const [k, v] of Object.entries(c.models)) {
    if (v !== undefined && (typeof v !== "string" || !v.trim())) errors.push(`models.${k} must be a non-empty string`);
    if (!["default", "planner", "developer", "tester"].includes(k)) errors.push(`models.${k} is not a role (use default, planner, developer, tester)`);
  }
  if ((c.harness === "pi" || c.harness === "codex") && !c.models.default && !(c.models.planner && c.models.developer && c.models.tester)) {
    errors.push(`models.default (or planner+developer+tester) must be set for the ${c.harness} harness`);
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
  else {
    const criteria = new Map<string, string>();
    c.checks.forEach((chk, i) => {
      if (!chk || typeof chk.name !== "string" || !chk.name.trim()) errors.push(`checks[${i}].name is required`);
      if (!chk || typeof chk.command !== "string" || !chk.command.trim()) errors.push(`checks[${i}].command is required`);
      if (chk?.timeout_min !== undefined && !(chk.timeout_min > 0)) errors.push(`checks[${i}].timeout_min must be > 0`);
      if (chk?.claims !== undefined) {
        if (!chk.claims || typeof chk.claims !== "object" || Array.isArray(chk.claims)) errors.push(`checks[${i}].claims must map claim IDs to non-empty criteria`);
        else for (const [id, criterion] of Object.entries(chk.claims)) {
          if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id) || typeof criterion !== "string" || !criterion.trim()) {
            errors.push(`checks[${i}].claims must map snake_case claim IDs to non-empty criteria`);
            continue;
          }
          if (criteria.has(id) && criteria.get(id) !== criterion.trim()) errors.push(`checks[${i}].claims.${id} conflicts with another check's criterion`);
          criteria.set(id, criterion.trim());
        }
      }
    });
  }
  if (!(c.timeouts.role_min > 0)) errors.push("timeouts.role_min must be > 0");
  if (!(c.timeouts.check_min > 0)) errors.push("timeouts.check_min must be > 0");
  if (!Number.isFinite(c.timeouts.provider_ms) || c.timeouts.provider_ms <= 0) errors.push("timeouts.provider_ms must be > 0");
  if (!Number.isFinite(c.timeouts.output_idle_ms) || c.timeouts.output_idle_ms <= 0) errors.push("timeouts.output_idle_ms must be > 0");
  if (!Number.isFinite(c.timeouts.websocket_connect_ms) || c.timeouts.websocket_connect_ms <= 0) {
    errors.push("timeouts.websocket_connect_ms must be > 0");
  }
  if (!c.retry || typeof c.retry !== "object" || Array.isArray(c.retry)) errors.push("retry must be an object");
  else {
    if (typeof c.retry.enabled !== "boolean") errors.push("retry.enabled must be a boolean");
    if (!Number.isInteger(c.retry.max_retries) || c.retry.max_retries < 0) errors.push("retry.max_retries must be a non-negative integer");
    if (!Number.isFinite(c.retry.base_delay_ms) || c.retry.base_delay_ms < 0) errors.push("retry.base_delay_ms must be >= 0");
    if (!Number.isFinite(c.retry.max_delay_ms) || c.retry.max_delay_ms < 0) errors.push("retry.max_delay_ms must be >= 0");
  }
  validateBudgetConfig(c.budgets, errors);
  if (c.harness === "codex") {
    for (const scope of ["role", "loop", "run"] as const) {
      if (c.budgets?.[scope]?.cost !== undefined) {
        errors.push(`budgets.${scope}.cost is unavailable for the codex harness because codex exec does not report monetary cost`);
      }
    }
  }
  validatePiConfig(c.pi, errors);
  return errors;
}

const BUDGET_SCOPES = new Set(["role", "loop", "run"]);
const BUDGET_METRICS = new Set(["elapsed_ms", "total_tokens", "cost"]);

function validateBudgetConfig(budgets: BudgetConfig | undefined, errors: string[]): void {
  if (budgets === undefined) return;
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    errors.push("budgets must be an object");
    return;
  }
  for (const scope of Object.keys(budgets)) {
    if (!BUDGET_SCOPES.has(scope)) errors.push(`budgets.${scope} is not supported (use role, loop, or run)`);
  }
  for (const scope of ["role", "loop", "run"] as const) {
    const limit = budgets[scope];
    if (limit === undefined) continue;
    const at = `budgets.${scope}`;
    if (!limit || typeof limit !== "object" || Array.isArray(limit)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    for (const metric of Object.keys(limit)) {
      if (!BUDGET_METRICS.has(metric)) errors.push(`${at}.${metric} is not supported (use elapsed_ms, total_tokens, or cost)`);
    }
    if (limit.elapsed_ms !== undefined && (!Number.isInteger(limit.elapsed_ms) || limit.elapsed_ms <= 0)) {
      errors.push(`${at}.elapsed_ms must be a positive integer`);
    }
    if (limit.total_tokens !== undefined && (!Number.isInteger(limit.total_tokens) || limit.total_tokens <= 0)) {
      errors.push(`${at}.total_tokens must be a positive integer`);
    }
    if (limit.cost !== undefined && (!Number.isFinite(limit.cost) || limit.cost <= 0)) {
      errors.push(`${at}.cost must be a positive finite number`);
    }
  }
}

const RESERVED_EXTENSION_TOOLS = new Set<string>(PI_BUILTIN_TOOL_NAMES);
const PI_KEYS = new Set(["agent_dir", "extensions", "skills", "compaction", "roles"]);
const PI_ROLE_KEYS = new Set(["extensions", "skills", "extension_tools", "compaction"]);

function validatePiConfig(pi: PiConfig, errors: string[]): void {
  if (!pi || typeof pi !== "object" || Array.isArray(pi)) {
    errors.push("pi must be an object");
    return;
  }
  for (const key of Object.keys(pi)) {
    if (!PI_KEYS.has(key)) errors.push(`pi.${key} is not supported`);
  }
  if (pi.agent_dir !== undefined && (typeof pi.agent_dir !== "string" || !pi.agent_dir.trim())) {
    errors.push("pi.agent_dir must be a non-empty string");
  }
  validateResourcePathList(pi.extensions, "pi.extensions", errors);
  validateResourcePathList(pi.skills, "pi.skills", errors);
  validatePiCompaction(pi.compaction, "pi.compaction", errors, false);
  if (pi.roles === undefined) return;
  if (!pi.roles || typeof pi.roles !== "object" || Array.isArray(pi.roles)) {
    errors.push("pi.roles must be an object keyed by planner, developer, or tester");
    return;
  }
  for (const [role, value] of Object.entries(pi.roles)) {
    const at = `pi.roles.${role}`;
    if (!ROLES.includes(role as Role)) {
      errors.push(`${at} is not a role (use planner, developer, or tester)`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!PI_ROLE_KEYS.has(key)) errors.push(`${at}.${key} is not supported`);
    }
    validateResourcePathList(value.extensions, `${at}.extensions`, errors);
    validateResourcePathList(value.skills, `${at}.skills`, errors);
    validateExtensionToolList(value.extension_tools, `${at}.extension_tools`, errors);
    validatePiCompaction(value.compaction, `${at}.compaction`, errors, true);
  }
}

function validatePiCompaction(value: unknown, at: string, errors: string[], partial: boolean): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${at} must be an object`);
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = new Set(["enabled", "reserve_tokens", "keep_recent_tokens"]);
  for (const key of Object.keys(record)) if (!keys.has(key)) errors.push(`${at}.${key} is not supported`);
  if (!partial) {
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(record, key)) errors.push(`${at}.${key} is required`);
  }
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") errors.push(`${at}.enabled must be a boolean`);
  for (const key of ["reserve_tokens", "keep_recent_tokens"] as const) {
    if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || (record[key] as number) <= 0)) {
      errors.push(`${at}.${key} must be a positive safe integer`);
    }
  }
}

function validateResourcePathList(value: unknown, at: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${at} must be an array of workspace-relative paths`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemAt = `${at}[${index}]`;
    if (typeof item !== "string" || !item.trim() || /[\0\r\n]/.test(item)) {
      errors.push(`${itemAt} must be a non-empty workspace-relative path`);
      return;
    }
    if (path.isAbsolute(item)) {
      errors.push(`${itemAt} must be relative to the workspace`);
      return;
    }
    const normalized = path.normalize(item);
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`) ||
      normalized === ".hoh" ||
      normalized.startsWith(`.hoh${path.sep}`)
    ) {
      errors.push(`${itemAt} must stay inside the workspace and outside runtime-owned .hoh`);
      return;
    }
    if (seen.has(normalized)) errors.push(`${itemAt} duplicates ${JSON.stringify(item)}`);
    seen.add(normalized);
  });
}

function validateExtensionToolList(value: unknown, at: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${at} must be an array of exact tool names`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemAt = `${at}[${index}]`;
    if (typeof item !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(item)) {
      errors.push(`${itemAt} must be a valid exact tool name`);
      return;
    }
    if (RESERVED_EXTENSION_TOOLS.has(item) || item.startsWith("submit_")) {
      errors.push(`${itemAt} conflicts with reserved built-in/runtime tool ${JSON.stringify(item)}`);
    }
    if (seen.has(item)) errors.push(`${itemAt} duplicates ${JSON.stringify(item)}`);
    seen.add(item);
  });
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

export function piCompactionForRole(c: HohConfig, role: Role): PiCompactionConfig {
  const base = c.pi.compaction ?? DEFAULT_PI_COMPACTION;
  return { ...base, ...(c.pi.roles?.[role]?.compaction ?? {}) };
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
