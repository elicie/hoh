/**
 * Scripted harness for tests and dry runs. No model is involved: each role is
 * a function that may read/write its working directory and submit structured
 * output, exactly the way a real harness would through tools.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Role } from "../types.js";
import type { Harness, RoleInvocation, RoleResult } from "./types.js";
import { emptyUsage } from "./types.js";
import { runCheck } from "../runtime/checks.js";
import type { CheckResult, EvidenceExecution } from "../types.js";

export interface MockApi {
  submit(tool: string, payload: unknown): void;
  write(relPath: string, content: string): Promise<void>;
  read(relPath: string): Promise<string | null>;
  exists(relPath: string): Promise<boolean>;
  run(command: string): Promise<CheckResult>;
}

export type MockScript = (inv: RoleInvocation, api: MockApi) => Promise<string | void> | string | void;

export class MockHarness implements Harness {
  readonly name = "mock";
  readonly version = "builtin-1";
  readonly calls: { role: Role; loopIndex: number; prompt: string; model?: string }[] = [];

  constructor(private readonly scripts: Partial<Record<Role, MockScript>>) {}

  async resolveModel(pattern?: string): Promise<string | null> {
    return pattern ? `mock:${pattern}` : "mock";
  }

  async invoke(inv: RoleInvocation): Promise<RoleResult> {
    inv.signal?.throwIfAborted();
    this.calls.push({ role: inv.role, loopIndex: inv.loopIndex, prompt: inv.prompt, model: inv.model });
    const submissions: Record<string, unknown[]> = {};
    const executions: EvidenceExecution[] = [];
    const api: MockApi = {
      run: async (command) => {
        if (!inv.evidenceDir) throw new Error("mock QA execution requires an evidence directory");
        const result = await runCheck({ name: `mock-${executions.length + 1}`, command }, inv.cwd, inv.timeoutMs ?? 10_000, {},
          { directory: inv.evidenceDir, category: "qa", basename: `mock-${executions.length + 1}` }, inv.signal);
        if (result.execution) executions.push(result.execution);
        return result;
      },
      submit: (tool, payload) => {
        inv.signal?.throwIfAborted();
        (submissions[tool] ??= []).push(payload);
      },
      write: async (rel, content) => {
        inv.signal?.throwIfAborted();
        const file = path.resolve(inv.cwd, rel);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
      },
      read: async (rel) => {
        inv.signal?.throwIfAborted();
        try {
          return await readFile(path.resolve(inv.cwd, rel), "utf8");
        } catch {
          return null;
        }
      },
      exists: async (rel) => {
        inv.signal?.throwIfAborted();
        try {
          await readFile(path.resolve(inv.cwd, rel));
          return true;
        } catch {
          return false;
        }
      },
    };
    const text = (await this.scripts[inv.role]?.(inv, api)) ?? "";
    inv.signal?.throwIfAborted();
    inv.onTranscript?.(
      `${JSON.stringify({ ts: new Date().toISOString(), type: "mock_invocation", role: inv.role, loop: inv.loopIndex, systemPrompt: inv.systemPrompt, prompt: inv.prompt, finalText: text, submissions })}\n`,
    );
    return { finalText: text, submissions, usage: emptyUsage(), turns: 1, executions, model: inv.model ? `mock:${inv.model}` : "mock" };
  }
}

/**
 * A deterministic demo: a tiny "artifact" (text files) that takes two loops to
 * reach QA PASS. Loop 1 leaves a gap (`result_state`), loop 2 closes it.
 */
export function createDemoMockHarness(): MockHarness {
  return new MockHarness({
    planner: (inv, api) => {
      if (inv.structuredTools.some((tool) => tool.name === "submit_claims")) {
        api.submit("submit_claims", {
          claims: [
            { id: "main_entry", criterion: "main.txt names the entry scene.", requires: ["check"] },
            { id: "player_control", criterion: "player_control.txt describes left/right input handling.", requires: ["check"] },
            { id: "result_state", criterion: "result_state.txt describes the visible completion screen.", requires: ["check"] },
          ],
        });
        return "Claim catalog submitted.";
      }
      const t = inv.loopIndex;
      api.submit("submit_development_document", {
        objective: t === 1 ? "Bootstrap a launchable artifact with a visible player control loop" : "Repair the missing result state and preserve player control",
        priorities:
          t === 1
            ? [
                { name: "Launchable entry", action: "Create main.txt describing the entry point", observable_outcome: "main.txt exists and names the entry scene" },
                { name: "Player control", action: "Create player_control.txt", observable_outcome: "player_control.txt lists left/right handling" },
              ]
            : [{ name: "Result state", action: "Create result_state.txt", observable_outcome: "result_state.txt describes the visible completion screen" }],
        preservation_gate: t === 1 ? [] : ["player_control remains present"],
        acceptance_gate: ["All files named in the priorities exist with non-empty content"],
      });
      return "Plan submitted.";
    },
    developer: async (inv, api) => {
      const t = inv.loopIndex;
      await api.write("main.txt", `entry scene: Main (loop ${t})\n`);
      await api.write("player_control.txt", "left/right input moves the avatar\n");
      if (t >= 2) await api.write("result_state.txt", "completing the objective shows a result screen\n");
      return `Loop ${t}: wrote main.txt, player_control.txt${t >= 2 ? ", result_state.txt" : ""}.`;
    },
    tester: async (inv, api) => {
      const hasMain = await api.exists("main.txt");
      const hasPlayerControl = await api.exists("player_control.txt");
      const hasResult = await api.exists("result_state.txt");
      const mainCheck = hasMain ? await api.run("test -s main.txt") : null;
      const playerCheck = hasPlayerControl ? await api.run("test -s player_control.txt") : null;
      const resultCheck = hasResult ? await api.run("test -s result_state.txt") : null;
      const verified: Array<{ claim_id: string; claim: string; execution_records: Array<{ type: string; path: string; observation: string }> }> = [];
      if (hasMain) {
        verified.push({
          claim_id: "main_entry",
          claim: "The main-entry contract passes its scripted check.",
          execution_records: [{ type: "check", path: mainCheck!.stdout_path!, observation: "scripted file check passed" }],
        });
      }
      if (hasPlayerControl) {
        verified.push({
          claim_id: "player_control",
          claim: "The player-control contract passes its scripted check.",
          execution_records: [{ type: "check", path: playerCheck!.stdout_path!, observation: "scripted file check passed" }],
        });
      }
      const gaps = hasResult
        ? []
        : [
            {
              claim_id: "result_state",
              claim: "Completing the objective produces a visible result.",
              execution_records: [{ type: "source", path: "result_state.txt", observation: "file is missing" }],
              severity: "major",
              player_impact: "Completion is not visible to the player.",
              recommended_update: "Add a result state.",
            },
          ];
      if (hasResult) {
        verified.push({
          claim_id: "result_state",
          claim: "The result-state contract passes its scripted check.",
          execution_records: [{ type: "check", path: resultCheck!.stdout_path!, observation: "scripted file check passed" }],
        });
      }
      api.submit("submit_evidence", {
        qa_status: gaps.length ? "partial" : "pass",
        summary: gaps.length ? "Player control verified; result state missing." : "Player control and result state verified.",
        verified_records: verified,
        gap_records: gaps,
        planner_handoff: {
          preservation_constraints: ["Preserve verified player movement."],
          update_targets: gaps.length ? ["Implement a visible completion state."] : [],
          validation_requirements: ["Check that every priority file exists."],
        },
      });
      return "Evidence submitted.";
    },
  });
}
