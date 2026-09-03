import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../runtime/config.js";
import {
  applyCoverage,
  claimCatalogSha256,
  emptyCoverage,
  makeClaimCatalog,
} from "../runtime/coverage.js";
import { renderRunReadme } from "../runtime/report.js";
import { RunPaths, writeJson } from "../runtime/state.js";
import type {
  BudgetLedger,
  ClaimRecord,
  DeveloperRecord,
  EvidenceBundle,
  Ledger,
  PlannerRecord,
  RoleUsage,
  RunConfig,
} from "../types.js";
import { DEMO_CLAIMS, DEMO_SPEC, makeWorkspace } from "./helpers.js";

const AT = "2026-01-02T03:04:05.000Z";

function usage(
  totalTokens: number,
  cost: number,
  durationMs: number,
  extra: Partial<RoleUsage> = {},
): RoleUsage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost,
    turns: 1,
    duration_ms: durationMs,
    model: "mock/model",
    ...extra,
  };
}

function claim(claimId: string, status: ClaimRecord["status"]): ClaimRecord {
  return {
    claim_id: claimId,
    claim: DEMO_CLAIMS.find((item) => item.id === claimId)?.criterion ?? `${claimId} fixture claim`,
    execution_records: [{ type: "check", path: "checks/result.txt", observation: "fixture observation" }],
    status,
  };
}

function evidence(
  loopIndex: number,
  catalogSha256: string,
  verified: string[],
  gaps: string[],
): EvidenceBundle {
  return {
    schema_version: 1,
    loop_index: loopIndex,
    candidate_id: `candidate-${loopIndex}`,
    claim_catalog_sha256: catalogSha256,
    qa_status: gaps.length ? "partial" : "pass",
    summary: `loop ${loopIndex} fixture evidence`,
    verified_records: verified.map((id) => claim(id, "verified")),
    gap_records: gaps.map((id) => claim(id, "gap")),
    planner_handoff: { preservation_constraints: [], update_targets: [], validation_requirements: [] },
    checks: [
      {
        name: "fixture-check",
        command: "fixture-check",
        status: "pass",
        exit_code: 0,
        duration_ms: 10,
        stdout_tail: "ok",
        stderr_tail: "",
      },
    ],
    candidate_source_sha256_before: "a".repeat(64),
    candidate_source_sha256_after: "a".repeat(64),
    frozen: true,
    runtime_notes: [],
    usage: usage(30, 0.03, 300),
    created_at: AT,
  };
}

function planner(loopIndex: number): PlannerRecord {
  return {
    schema_version: 1,
    loop_index: loopIndex,
    base_candidate_id: loopIndex === 1 ? null : `candidate-${loopIndex - 1}`,
    objective: `objective ${loopIndex}`,
    priorities: [{ name: `priority ${loopIndex}`, action: "act", observable_outcome: "observed" }],
    preservation_gate: [],
    acceptance_gate: [],
    attempts: 1,
    usage: usage(100, 0.1, 1000, {
      turns: 2,
      retry_count: 2,
      compaction_count: 1,
      compaction_tokens_before: 500,
      compaction_estimated_tokens_after: 200,
    }),
    created_at: AT,
  };
}

function developer(loopIndex: number): DeveloperRecord {
  return {
    schema_version: 1,
    loop_index: loopIndex,
    base_candidate_id: loopIndex === 1 ? null : `candidate-${loopIndex - 1}`,
    candidate_id: `candidate-${loopIndex}`,
    candidate_tree_sha: String(loopIndex).repeat(64),
    commit: String(loopIndex).repeat(40),
    changed_paths: ["src/example.ts"],
    summary: "fixture change",
    violations: [],
    usage: usage(20, 0.02, 200),
    created_at: AT,
  };
}

test("run report renders coverage and ledger trends, role accounting, links, and receipt state", async () => {
  const { ws, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    const catalog = makeClaimCatalog(DEMO_SPEC, DEMO_CLAIMS);
    const catalogHash = claimCatalogSha256(catalog);
    const evidenceByLoop = [
      evidence(1, catalogHash, ["main_entry"], ["player_control"]),
      evidence(2, catalogHash, ["player_control"], []),
      evidence(3, catalogHash, ["main_entry"], ["player_control"]),
    ];
    await writeFile(paths.spec, DEMO_SPEC);
    let coverage = emptyCoverage(catalog);
    for (const bundle of evidenceByLoop) {
      await mkdir(paths.loopDir(bundle.loop_index), { recursive: true });
      await writeJson(paths.plannerJson(bundle.loop_index), planner(bundle.loop_index));
      await writeJson(paths.developerJson(bundle.loop_index), developer(bundle.loop_index));
      await writeJson(paths.evidenceJson(bundle.loop_index), bundle);
      await writeFile(paths.testerReport(bundle.loop_index), `# fixture QA ${bundle.loop_index}\n`);
      coverage = applyCoverage(catalog, coverage, bundle);
    }
    await writeJson(paths.coverage, coverage);

    const failedPlannerUsage = usage(20, 0.02, 200, { retry_count: 1 });
    const attempts: BudgetLedger["attempts"] = [
      {
        id: "role-attempt-000001",
        loop_index: 1,
        role: "planner",
        outcome: "failed",
        usage: failedPlannerUsage,
        started_at: AT,
        finished_at: AT,
        source: "runtime",
      },
    ];
    for (const loopIndex of [1, 2, 3]) {
      const roleUsages = [
        ["planner", planner(loopIndex).usage],
        ["developer", developer(loopIndex).usage],
        ["tester", evidenceByLoop[loopIndex - 1].usage],
      ] as const;
      for (const [role, roleUsage] of roleUsages) {
        attempts.push({
          id: `role-attempt-${String(attempts.length + 1).padStart(6, "0")}`,
          loop_index: loopIndex,
          role,
          outcome: "completed",
          usage: roleUsage,
          started_at: AT,
          finished_at: AT,
          source: "runtime",
        });
      }
    }
    const budget: BudgetLedger = {
      schema_version: 1,
      status: "completed",
      limits: {},
      totals: { elapsed_ms: 4700, total_tokens: 470, cost: 0.47 },
      loops: {
        "1": {
          loop_index: 1,
          totals: { elapsed_ms: 1700, total_tokens: 170, cost: 0.17 },
          roles: {
            planner: { elapsed_ms: 1200, total_tokens: 120, cost: 0.12, attempts: 2 },
            developer: { elapsed_ms: 200, total_tokens: 20, cost: 0.02, attempts: 1 },
            tester: { elapsed_ms: 300, total_tokens: 30, cost: 0.03, attempts: 1 },
          },
        },
        "2": {
          loop_index: 2,
          totals: { elapsed_ms: 1500, total_tokens: 150, cost: 0.15 },
          roles: {
            planner: { elapsed_ms: 1000, total_tokens: 100, cost: 0.1, attempts: 1 },
            developer: { elapsed_ms: 200, total_tokens: 20, cost: 0.02, attempts: 1 },
            tester: { elapsed_ms: 300, total_tokens: 30, cost: 0.03, attempts: 1 },
          },
        },
        "3": {
          loop_index: 3,
          totals: { elapsed_ms: 1500, total_tokens: 150, cost: 0.15 },
          roles: {
            planner: { elapsed_ms: 1000, total_tokens: 100, cost: 0.1, attempts: 1 },
            developer: { elapsed_ms: 200, total_tokens: 20, cost: 0.02, attempts: 1 },
            tester: { elapsed_ms: 300, total_tokens: 30, cost: 0.03, attempts: 1 },
          },
        },
      },
      attempts,
      current_role: null,
      exhaustion: null,
      accounting: {
        completed_role_usage: "charged_from_role_usage",
        failed_invocation_usage: "unavailable_not_estimated",
      },
      created_at: AT,
      updated_at: AT,
    };
    await writeJson(paths.budget, budget);

    const ledger: Ledger = {
      schema_version: 1,
      issues: {
        player_control: {
          id: "player_control",
          claim: "player_control.txt describes left/right input handling.",
          status: "regressed",
          first_seen_loop: 1,
          last_seen_loop: 3,
          consecutive_gap_loops: 1,
          reopen_count: 1,
          history: [
            { loop: 1, status: "open" },
            { loop: 2, status: "closed" },
            { loop: 3, status: "regressed" },
          ],
        },
      },
    };
    const run: RunConfig = {
      schema_version: 1,
      run_id: "run-report-fixture",
      spec_path: ".hoh/spec.md",
      created_at: AT,
      config: {
        ...structuredClone(DEFAULT_CONFIG),
        protocol: "paper",
        harness: "mock",
        loops: 3,
        models: { planner: "mock/planner", developer: "mock/developer", tester: "mock/tester" },
      },
      config_source: "fixture",
    };

    const markdown = await renderRunReadme(paths, run, ledger, { receiptVerification: { ok: true, issues: [] } });
    assert.match(markdown, /\*\*Protocol:\*\* PAPER \(protocol receipt unavailable\)/);
    assert.match(markdown, /\*\*Configured models:\*\* planner=mock\/planner, developer=mock\/developer, tester=mock\/tester/);
    assert.match(markdown, /\*\*Run receipt verification at report generation:\*\* VERIFIED/);
    assert.match(markdown, /\| Resolved model \| mock\/model \|/);
    assert.match(
      markdown,
      /\| 01 \| 1 \| 1 \| 1 \| player_control \| - \| - \| \[evidence\]\(iterations\/loop-01\/evidence\.json\) \/ \[QA report\]\(iterations\/loop-01\/tester_report\.md\) \|/,
    );
    assert.match(markdown, /\| 02 \| 1 \| 0 \| 2 \| - \| - \| player_control \|/);
    assert.match(markdown, /\| 03 \| 1 \| 1 \| 1 \| - \| player_control \| - \|/);
    assert.match(markdown, /\| Duration \| 1\.2s \|/);
    assert.match(markdown, /\| Tokens \| 120 \(3 turns\) \|/);
    assert.match(markdown, /\| Cost \| \$0\.120000 \|/);
    assert.match(markdown, /\| Role attempts \| 2 \|/);
    assert.match(markdown, /\| Transport retries \| 3 \|/);
    assert.match(markdown, /\| Compactions \| 1 \(500 before → 200 estimated after\) \|/);
    assert.match(
      markdown,
      /\| Records \| \[evidence\]\(iterations\/loop-01\/evidence\.json\) \/ \[QA report\]\(iterations\/loop-01\/tester_report\.md\) \|/,
    );

    const unchecked = await renderRunReadme(paths, run, ledger);
    assert.match(unchecked, /\*\*Run receipt verification at report generation:\*\* NOT CHECKED/);
    const failed = await renderRunReadme(paths, run, ledger, {
      receiptVerification: {
        ok: false,
        issues: [{ code: "receipt_integrity_mismatch" }, { code: "artifact_hash_mismatch" }],
      },
    });
    assert.match(
      failed,
      /\*\*Run receipt verification at report generation:\*\* FAILED \(2 issues: artifact_hash_mismatch, receipt_integrity_mismatch\)/,
    );
  } finally {
    await cleanup();
  }
});
