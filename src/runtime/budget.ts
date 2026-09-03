import { readdir } from "node:fs/promises";
import type { BudgetConfig, BudgetLimitConfig } from "./config.js";
import type {
  BudgetExhaustion,
  BudgetLedger,
  BudgetMetric,
  BudgetRoleAttempt,
  BudgetRoleTotals,
  BudgetScope,
  BudgetTotals,
  DeveloperRecord,
  EvidenceBundle,
  PlannerRecord,
  Role,
  RoleUsage,
} from "../types.js";
import { ROLES } from "../types.js";
import { loadBudgetLedger, parseLoopDirName, readJson, RunPaths, writeJson } from "./state.js";

const METRICS: readonly BudgetMetric[] = ["elapsed_ms", "total_tokens", "cost"];

const EMPTY_TOTALS = (): BudgetTotals => ({ elapsed_ms: 0, total_tokens: 0, cost: 0 });
const EMPTY_ROLE_TOTALS = (): BudgetRoleTotals => ({ ...EMPTY_TOTALS(), attempts: 0 });

export class BudgetExhaustedError extends Error {
  readonly code = "HOH_BUDGET_EXHAUSTED";

  constructor(readonly exhaustion: BudgetExhaustion) {
    super(formatBudgetExhaustion(exhaustion));
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Persistent budget accountant. Usage returned by completed harness results is
 * charged even when the surrounding logical role later fails. Calls that
 * throw before returning usage keep `usage: null`; zero is never guessed.
 */
export class BudgetTracker {
  private activeLoop: number | null = null;
  private lastCheckpointMs: number;
  private nextAttemptSequence: number;

  private constructor(
    private readonly paths: RunPaths,
    private readonly clock: () => number,
    private ledger: BudgetLedger,
  ) {
    this.lastCheckpointMs = clock();
    this.nextAttemptSequence = nextAttemptSequence(ledger.attempts);
  }

  static async open(paths: RunPaths, limits: BudgetConfig | undefined, clock: () => number = Date.now): Promise<BudgetTracker> {
    const nowMs = clock();
    const stored = await loadBudgetLedger(paths);
    const ledger = stored ?? emptyBudgetLedger(limits, nowMs);
    assertBudgetLedger(ledger);
    ledger.limits = structuredClone(limits ?? {});

    // An attempt left running across process boundaries has no recoverable
    // RoleUsage under the current harness contract. Keep that absence explicit.
    for (const attempt of ledger.attempts) {
      if (attempt.outcome !== "running") continue;
      attempt.outcome = "failed";
      attempt.usage = null;
      attempt.finished_at = iso(nowMs);
    }
    ledger.current_role = null;

    const tracker = new BudgetTracker(paths, clock, ledger);
    await tracker.reconcileRoleRecords(stored === null);
    tracker.refreshStatus();
    await tracker.save();
    return tracker;
  }

  snapshot(): BudgetLedger {
    return structuredClone(this.ledger);
  }

  async startLoop(loopIndex: number): Promise<void> {
    this.switchLoop(loopIndex);
    this.advanceElapsed();
    this.refreshStatus();
    await this.save();
  }

  /** A cheap preflight for expensive setup that precedes the actual role call. */
  async assertCanStartRole(loopIndex: number, role: Role): Promise<void> {
    this.switchLoop(loopIndex);
    this.advanceElapsed();
    const exhaustion = findBudgetExhaustion(this.ledger, { beforeRole: role, inclusive: true });
    if (!exhaustion) {
      this.ledger.status = "running";
      this.ledger.exhaustion = null;
      await this.save();
      return;
    }
    this.ledger.status = "budget_exhausted";
    this.ledger.exhaustion = { ...exhaustion, before_role: role, detected_at: iso(this.clock()) };
    await this.save();
    throw new BudgetExhaustedError(this.ledger.exhaustion);
  }

  /** Persist a visible current-role boundary immediately before invoking the harness. */
  async beginRole(loopIndex: number, role: Role): Promise<string> {
    await this.assertCanStartRole(loopIndex, role);
    const startedAt = this.clock();
    const id = `role-attempt-${String(this.nextAttemptSequence++).padStart(6, "0")}`;
    const attempt: BudgetRoleAttempt = {
      id,
      loop_index: loopIndex,
      role,
      outcome: "running",
      usage: null,
      started_at: iso(startedAt),
      source: "runtime",
    };
    this.ledger.attempts.push(attempt);
    this.recalculate();
    this.ledger.current_role = {
      attempt_id: id,
      loop_index: loopIndex,
      role,
      started_at: attempt.started_at,
      charged_before_start: structuredClone(this.roleTotals(loopIndex, role)),
    };
    await this.save();
    return id;
  }

  async completeRole(attemptId: string, usage: RoleUsage): Promise<void> {
    this.advanceElapsed();
    const attempt = this.requireRunningAttempt(attemptId);
    attempt.outcome = "completed";
    attempt.usage = validateRoleUsage(usage);
    attempt.finished_at = iso(this.clock());
    this.ledger.current_role = null;
    this.recalculate();
    this.refreshStatus();
    await this.save();
  }

  async failRole(attemptId: string, completedUsage?: RoleUsage): Promise<void> {
    this.advanceElapsed();
    const attempt = this.ledger.attempts.find((candidate) => candidate.id === attemptId);
    if (attempt?.outcome === "running") {
      attempt.outcome = "failed";
      attempt.usage = completedUsage ? validateRoleUsage(completedUsage) : null;
      attempt.finished_at = iso(this.clock());
    }
    if (this.ledger.current_role?.attempt_id === attemptId) this.ledger.current_role = null;
    this.recalculate();
    this.refreshStatus();
    await this.save();
  }

  async endLoop(loopIndex: number): Promise<void> {
    if (this.activeLoop === loopIndex) this.advanceElapsed();
    this.activeLoop = null;
    this.lastCheckpointMs = this.clock();
    this.refreshStatus();
    await this.save();
  }

  /** Persist elapsed time when cancellation, budget control flow, or an error leaves a partial loop. */
  async pauseLoop(loopIndex: number): Promise<void> {
    if (this.activeLoop === loopIndex) this.advanceElapsed();
    this.activeLoop = null;
    this.lastCheckpointMs = this.clock();
    this.refreshStatus();
    await this.save();
  }

  async finish(completed: boolean): Promise<BudgetLedger> {
    if (this.activeLoop !== null) this.advanceElapsed();
    this.activeLoop = null;
    this.refreshStatus();
    if (this.ledger.status !== "budget_exhausted") this.ledger.status = completed ? "completed" : "running";
    await this.save();
    return this.snapshot();
  }

  /** Reinstall the in-memory canonical value after role-owned runtime paths are restored. */
  async persist(): Promise<void> {
    await this.save();
  }

  private switchLoop(loopIndex: number): void {
    const now = this.clock();
    if (this.activeLoop === loopIndex) return;
    if (this.activeLoop !== null) this.advanceElapsed(now);
    this.activeLoop = loopIndex;
    ensureLoop(this.ledger, loopIndex);
    this.lastCheckpointMs = now;
  }

  private advanceElapsed(nowMs: number = this.clock()): void {
    const delta = Math.max(0, nowMs - this.lastCheckpointMs);
    if (this.activeLoop !== null && delta > 0) {
      ensureLoop(this.ledger, this.activeLoop).totals.elapsed_ms += delta;
      this.recalculate();
    }
    this.lastCheckpointMs = nowMs;
  }

  private refreshStatus(): void {
    this.recalculate();
    const strictExhaustion = findBudgetExhaustion(this.ledger, { inclusive: false });
    const boundaryExhaustion =
      !strictExhaustion && this.ledger.exhaustion?.before_role
        ? findBudgetExhaustion(this.ledger, { beforeRole: this.ledger.exhaustion.before_role, inclusive: true })
        : null;
    const exhaustion = strictExhaustion ?? boundaryExhaustion;
    if (exhaustion) {
      this.ledger.status = "budget_exhausted";
      this.ledger.exhaustion = {
        ...exhaustion,
        before_role: this.ledger.exhaustion?.before_role,
        detected_at: this.ledger.exhaustion?.detected_at ?? iso(this.clock()),
      };
    } else {
      this.ledger.status = "running";
      this.ledger.exhaustion = null;
    }
  }

  private recalculate(): void {
    for (const loop of Object.values(this.ledger.loops)) {
      const measuredLoopElapsed = loop.totals.elapsed_ms;
      loop.roles = {};
      loop.totals = { elapsed_ms: measuredLoopElapsed, total_tokens: 0, cost: 0 };
    }
    for (const attempt of this.ledger.attempts) {
      if (!attempt.usage) continue;
      const loop = ensureLoop(this.ledger, attempt.loop_index);
      const role = (loop.roles[attempt.role] ??= EMPTY_ROLE_TOTALS());
      role.attempts += 1;
      role.elapsed_ms += attempt.usage.duration_ms;
      role.total_tokens += attempt.usage.totalTokens;
      role.cost += attempt.usage.cost;
      loop.totals.total_tokens += attempt.usage.totalTokens;
      loop.totals.cost += attempt.usage.cost;
    }
    for (const loop of Object.values(this.ledger.loops)) {
      const roleElapsed = Object.values(loop.roles).reduce((sum, role) => sum + (role?.elapsed_ms ?? 0), 0);
      loop.totals.elapsed_ms = Math.max(loop.totals.elapsed_ms, roleElapsed);
    }
    this.ledger.totals = Object.values(this.ledger.loops).reduce(
      (total, loop) => ({
        elapsed_ms: total.elapsed_ms + loop.totals.elapsed_ms,
        total_tokens: total.total_tokens + loop.totals.total_tokens,
        cost: total.cost + loop.totals.cost,
      }),
      EMPTY_TOTALS(),
    );
  }

  private roleTotals(loopIndex: number, role: Role): BudgetRoleTotals {
    return ensureLoop(this.ledger, loopIndex).roles[role] ?? EMPTY_ROLE_TOTALS();
  }

  private requireRunningAttempt(id: string): BudgetRoleAttempt {
    const attempt = this.ledger.attempts.find((candidate) => candidate.id === id);
    if (!attempt || attempt.outcome !== "running") throw new Error(`budget role attempt ${id} is not running`);
    return attempt;
  }

  private async reconcileRoleRecords(reconstructElapsed: boolean): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.paths.iterations);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const name of entries) {
      const loopIndex = parseLoopDirName(name);
      if (loopIndex === null) continue;
      const records: Array<[Role, RoleUsage | undefined]> = [
        ["planner", (await readJson<PlannerRecord>(this.paths.plannerJson(loopIndex)))?.usage],
        ["developer", (await readJson<DeveloperRecord>(this.paths.developerJson(loopIndex)))?.usage],
        ["tester", (await readJson<EvidenceBundle>(this.paths.evidenceJson(loopIndex)))?.usage],
      ];
      for (const [role, usage] of records) {
        if (!usage || this.hasCompletedCharge(loopIndex, role)) continue;
        const validated = validateRoleUsage(usage);
        const at = this.clock();
        this.ledger.attempts.push({
          id: `role-attempt-${String(this.nextAttemptSequence++).padStart(6, "0")}`,
          loop_index: loopIndex,
          role,
          outcome: "completed",
          usage: validated,
          started_at: iso(Math.max(0, at - validated.duration_ms)),
          finished_at: iso(at),
          source: "reconstructed_record",
        });
      }
    }
    this.recalculate();
    if (reconstructElapsed) {
      for (const loop of Object.values(this.ledger.loops)) {
        const roleElapsed = Object.values(loop.roles).reduce((sum, role) => sum + (role?.elapsed_ms ?? 0), 0);
        loop.totals.elapsed_ms = Math.max(loop.totals.elapsed_ms, roleElapsed);
      }
      this.recalculate();
    }
  }

  private hasCompletedCharge(loopIndex: number, role: Role): boolean {
    return this.ledger.attempts.some(
      (attempt) => attempt.loop_index === loopIndex && attempt.role === role && attempt.outcome === "completed" && attempt.usage !== null,
    );
  }

  private async save(): Promise<void> {
    this.ledger.updated_at = iso(this.clock());
    await writeJson(this.paths.budget, this.ledger);
  }
}

export function emptyBudgetLedger(limits: BudgetConfig | undefined, nowMs: number = Date.now()): BudgetLedger {
  const at = iso(nowMs);
  return {
    schema_version: 1,
    status: "running",
    limits: structuredClone(limits ?? {}),
    totals: EMPTY_TOTALS(),
    loops: {},
    attempts: [],
    current_role: null,
    exhaustion: null,
    accounting: {
      completed_role_usage: "charged_from_role_usage",
      failed_invocation_usage: "unavailable_not_estimated",
    },
    created_at: at,
    updated_at: at,
  };
}

export function formatBudgetExhaustion(exhaustion: BudgetExhaustion): string {
  const at = [exhaustion.scope, exhaustion.loop_index ? `loop ${exhaustion.loop_index}` : "", exhaustion.role ?? ""]
    .filter(Boolean)
    .join("/");
  return `budget exhausted at ${at}: ${exhaustion.metric} ${formatMetric(exhaustion.metric, exhaustion.used)} >= ${formatMetric(exhaustion.metric, exhaustion.limit)}`;
}

function findBudgetExhaustion(
  ledger: BudgetLedger,
  options: { beforeRole?: Role; inclusive: boolean },
): Omit<BudgetExhaustion, "detected_at"> | null {
  const loops = Object.values(ledger.loops).sort((a, b) => a.loop_index - b.loop_index);
  for (const loop of loops) {
    for (const role of ROLES) {
      const totals = loop.roles[role];
      if (!totals) continue;
      const hit = firstLimitHit("role", ledger.limits.role, totals, options.inclusive, loop.loop_index, role, options.beforeRole);
      if (hit) return hit;
    }
  }
  for (const loop of loops) {
    const hit = firstLimitHit("loop", ledger.limits.loop, loop.totals, options.inclusive, loop.loop_index, undefined, options.beforeRole);
    if (hit) return hit;
  }
  return firstLimitHit("run", ledger.limits.run, ledger.totals, options.inclusive, undefined, undefined, options.beforeRole);
}

function firstLimitHit(
  scope: BudgetScope,
  limit: BudgetLimitConfig | undefined,
  totals: BudgetTotals,
  inclusive: boolean,
  loopIndex?: number,
  role?: Role,
  beforeRole?: Role,
): Omit<BudgetExhaustion, "detected_at"> | null {
  if (!limit) return null;
  for (const metric of METRICS) {
    const maximum = limit[metric];
    if (maximum === undefined || !limitReached(metric, totals[metric], maximum, inclusive)) continue;
    return { scope, metric, used: totals[metric], limit: maximum, loop_index: loopIndex, role, before_role: beforeRole };
  }
  return null;
}

function limitReached(metric: BudgetMetric, used: number, maximum: number, inclusive: boolean): boolean {
  const tolerance = metric === "cost" ? Math.max(1, Math.abs(used), Math.abs(maximum)) * Number.EPSILON * 8 : 0;
  return inclusive ? used >= maximum - tolerance : used > maximum + tolerance;
}

function ensureLoop(ledger: BudgetLedger, loopIndex: number) {
  const key = String(loopIndex);
  return (ledger.loops[key] ??= { loop_index: loopIndex, totals: EMPTY_TOTALS(), roles: {} });
}

function validateRoleUsage(usage: RoleUsage): RoleUsage {
  const numericKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "turns", "duration_ms"] as const;
  for (const key of numericKeys) {
    if (!Number.isFinite(usage[key]) || usage[key] < 0) throw new Error(`cannot charge invalid role usage ${key}=${JSON.stringify(usage[key])}`);
  }
  return structuredClone(usage);
}

function nextAttemptSequence(attempts: BudgetRoleAttempt[]): number {
  let maximum = 0;
  for (const attempt of attempts) {
    const match = /^role-attempt-(\d+)$/.exec(attempt.id);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

function assertBudgetLedger(value: BudgetLedger): void {
  if (!value || value.schema_version !== 1 || !Array.isArray(value.attempts) || !value.loops || !value.totals) {
    throw new Error("stored budget ledger is malformed");
  }
}

function formatMetric(metric: BudgetMetric, value: number): string {
  if (metric === "cost") return `$${value.toFixed(6)}`;
  if (metric === "elapsed_ms") return `${value}ms`;
  return `${value} tokens`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
