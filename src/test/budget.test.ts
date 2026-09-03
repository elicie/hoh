import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Harness, RoleInvocation, RoleResult } from "../harness/types.js";
import { createDemoMockHarness } from "../harness/mock.js";
import { mergeConfig, DEFAULT_CONFIG, validateConfig } from "../runtime/config.js";
import { runHoh } from "../runtime/loop.js";
import { loadBudgetLedger, RunPaths } from "../runtime/state.js";
import type { Role, UsageTotals } from "../types.js";
import { makeWorkspace } from "./helpers.js";

type MeteredHarness = Harness & { calls: Array<{ role: Role; loopIndex: number }> };
const CLI = path.resolve("dist/cli.js");

function readCliStatus(workspace: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "status", "--workspace", workspace], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function usage(totalTokens: number, cost: number): UsageTotals {
  return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost };
}

function meteredHarness(
  byRole: Partial<Record<Role, UsageTotals>>,
  options: { delayMs?: number; retryCount?: number; failRole?: Role; onInvoke?: (inv: RoleInvocation) => Promise<void> } = {},
): MeteredHarness {
  const demo = createDemoMockHarness();
  const calls: Array<{ role: Role; loopIndex: number }> = [];
  return {
    name: demo.name,
    version: demo.version,
    resolveModel: (pattern) => demo.resolveModel(pattern),
    calls,
    async invoke(inv): Promise<RoleResult> {
      calls.push({ role: inv.role, loopIndex: inv.loopIndex });
      await options.onInvoke?.(inv);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.failRole === inv.role) throw new Error(`simulated ${inv.role} transport failure`);
      const result = await demo.invoke(inv);
      return {
        ...result,
        usage: byRole[inv.role] ?? usage(0, 0),
        retryCount: options.retryCount,
      };
    },
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test("budget config accepts fractional cost and validates positive duration and integer tokens", () => {
  const valid = mergeConfig(DEFAULT_CONFIG, {
    harness: "mock",
    budgets: {
      role: { elapsed_ms: 1, total_tokens: 2, cost: 0.125 },
      loop: { total_tokens: 10 },
      run: { cost: 1.75 },
    },
  });
  assert.deepEqual(validateConfig(valid), []);
  assert.equal(valid.budgets?.role?.cost, 0.125);

  const invalid = mergeConfig(DEFAULT_CONFIG, {
    harness: "mock",
    budgets: {
      role: { elapsed_ms: 0 },
      loop: { total_tokens: 1.5 },
      run: { cost: -0.01 },
    },
  });
  const errors = validateConfig(invalid).join("\n");
  assert.match(errors, /budgets\.role\.elapsed_ms must be a positive integer/);
  assert.match(errors, /budgets\.loop\.total_tokens must be a positive integer/);
  assert.match(errors, /budgets\.run\.cost must be a positive finite number/);
  assert.ok(
    validateConfig(mergeConfig(DEFAULT_CONFIG, { harness: "mock", budgets: { run: { cost: null } } } as any)).some((error) =>
      /budgets\.run\.cost must be a positive finite number/.test(error),
    ),
    "an explicit null is invalid rather than silently treated as an omitted ceiling",
  );
});

test("budget exhaustion blocks the next role, creates no error record, and is stable on resume", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    let activeRoleObserved = false;
    const firstHarness = meteredHarness(
      { planner: usage(7, 0.25) },
      {
        retryCount: 2,
        onInvoke: async (inv) => {
          const active = await loadBudgetLedger(paths);
          assert.equal(active?.current_role?.role, inv.role);
          assert.equal(active?.current_role?.loop_index, inv.loopIndex);
          assert.deepEqual(active?.limits.role, { total_tokens: 7 });
          const status = await readCliStatus(ws);
          assert.equal(status.code, 0, status.stderr);
          assert.match(status.stdout, /Resource budget: RUNNING/);
          assert.match(status.stdout, /Budget role: loop 1 \/ planner, active .*ceilings role=7 tokens, loop=unlimited, run=unlimited/);
          activeRoleObserved = true;
        },
      },
    );
    const first = await runHoh({
      workspace: ws,
      specPath: spec,
      harness: firstHarness,
      config: { harness: "mock", loops: 1, budgets: { role: { total_tokens: 7 } } },
    });

    assert.equal(first.status, "budget_exhausted");
    assert.equal(activeRoleObserved, true, "the canonical state exposes the currently running role and its limits");
    assert.deepEqual(firstHarness.calls.map((call) => call.role), ["planner"]);
    assert.equal(first.budget.totals.total_tokens, 7);
    assert.equal(first.budget.totals.cost, 0.25);
    assert.equal(first.budget.attempts[0].usage?.retry_count, 2, "same-session retry usage is charged as one returned RoleUsage");
    assert.deepEqual(first.budget.exhaustion, {
      scope: "role",
      metric: "total_tokens",
      used: 7,
      limit: 7,
      loop_index: 1,
      role: "planner",
      before_role: "developer",
      detected_at: first.budget.exhaustion?.detected_at,
    });
    assert.equal(await exists(paths.errorJson(1)), false, "budget control flow is not a runtime error");

    const resumedHarness = meteredHarness({ planner: usage(100, 100), developer: usage(100, 100), tester: usage(100, 100) });
    const resumed = await runHoh({ workspace: ws, harness: resumedHarness });
    assert.equal(resumed.status, "budget_exhausted");
    assert.deepEqual(resumedHarness.calls, [], "resume does not rerun or start a role past the stored boundary");
    assert.equal(resumed.budget.totals.total_tokens, 7);
    assert.equal(resumed.budget.attempts.length, 1);
    assert.equal(await exists(paths.errorJson(1)), false);
  } finally {
    await cleanup();
  }
});

test("loop ledger accumulates completed role tokens and fractional costs before Tester", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = meteredHarness({ planner: usage(5, 0.125), developer: usage(7, 0.625), tester: usage(100, 100) });
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: {
        harness: "mock",
        loops: 1,
        budgets: { loop: { total_tokens: 12 }, run: { cost: 10.5 } },
      },
    });

    assert.equal(result.status, "budget_exhausted");
    assert.deepEqual(harness.calls.map((call) => call.role), ["planner", "developer"]);
    assert.equal(result.budget.exhaustion?.scope, "loop");
    assert.equal(result.budget.exhaustion?.before_role, "tester");
    assert.equal(result.budget.loops["1"].totals.total_tokens, 12);
    assert.equal(result.budget.loops["1"].totals.cost, 0.75);
    assert.equal(result.budget.totals.total_tokens, 12);
    assert.equal(result.budget.totals.cost, 0.75);
  } finally {
    await cleanup();
  }
});

test("active elapsed time is accumulated and blocks the next role at a run boundary", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = meteredHarness({ planner: usage(1, 0.01) }, { delayMs: 250 });
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: { harness: "mock", loops: 1, budgets: { run: { elapsed_ms: 200 } } },
    });

    assert.equal(result.status, "budget_exhausted");
    assert.deepEqual(harness.calls.map((call) => call.role), ["planner"]);
    assert.equal(result.budget.exhaustion?.scope, "run");
    assert.equal(result.budget.exhaustion?.metric, "elapsed_ms");
    assert.ok(result.budget.totals.elapsed_ms >= 200, `recorded ${result.budget.totals.elapsed_ms}ms`);
  } finally {
    await cleanup();
  }
});

test("failed harness usage remains unavailable instead of being guessed as zero", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = meteredHarness({}, { failRole: "planner" });
    await assert.rejects(
      runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1, budgets: { run: { total_tokens: 10 } } } }),
      /simulated planner transport failure/,
    );

    const budget = await loadBudgetLedger(new RunPaths(ws));
    assert.ok(budget);
    assert.equal(budget.attempts.length, 1);
    assert.equal(budget.attempts[0].outcome, "failed");
    assert.equal(budget.attempts[0].usage, null);
    assert.equal(budget.accounting.failed_invocation_usage, "unavailable_not_estimated");
  } finally {
    await cleanup();
  }
});

test("an exact run limit completes when no additional role needs to start", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const harness = meteredHarness({ planner: usage(3, 0.1), developer: usage(4, 0.2), tester: usage(5, 0.3) });
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: { harness: "mock", loops: 1, budgets: { run: { total_tokens: 12, cost: 0.6 } } },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.budget.status, "completed");
    assert.equal(result.budget.totals.total_tokens, 12);
    assert.ok(Math.abs(result.budget.totals.cost - 0.6) < Number.EPSILON * 4);
    assert.equal(result.budget.exhaustion, null);
    assert.deepEqual(harness.calls.map((call) => call.role), ["planner", "developer", "tester"]);
  } finally {
    await cleanup();
  }
});

test("paper resume cannot raise a stored resource ceiling or rewrite its records", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: { protocol: "paper", harness: "mock", loops: 1, budgets: { run: { total_tokens: 1000, cost: 5.25 } } },
    });
    const before = {
      config: await readFile(paths.config, "utf8"),
      run: await readFile(paths.runJson, "utf8"),
      budget: await readFile(paths.budget, "utf8"),
    };

    await assert.rejects(
      runHoh({ workspace: ws, harness: createDemoMockHarness(), config: { budgets: { run: { total_tokens: 2000 } } } }),
      /cannot resume paper run .*protocol contract changed/,
    );
    assert.equal(await readFile(paths.config, "utf8"), before.config);
    assert.equal(await readFile(paths.runJson, "utf8"), before.run);
    assert.equal(await readFile(paths.budget, "utf8"), before.budget);
  } finally {
    await cleanup();
  }
});
