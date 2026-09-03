/**
 * Drives the real pi SDK (session, tool loop, built-in tools, custom
 * structured tools, tool allowlists) against a fake OpenAI-compatible server,
 * so the adapter is verified end to end without credentials or network.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createHarness } from "../harness/factory.js";
import { DEFAULT_CONFIG, mergeConfig } from "../runtime/config.js";
import { runHoh } from "../runtime/loop.js";
import { readPiModelsJson } from "../runtime/providers.js";
import { RunPaths } from "../runtime/state.js";
import { startFakeOpenAI, type FakeStep } from "./fake-openai.js";
import { makeWorkspace } from "./helpers.js";

test("pi adapter: full loop through the real pi tool loop against a fake provider", async (t) => {
  const { ws, spec, cleanup } = await makeWorkspace();
  const server = await startFakeOpenAI(
    (view): FakeStep => {
    switch (view.role) {
      case "planner":
        if (view.step === 0) {
          // Read-only role: a write must be rejected by the allowlist before the plan is submitted.
          return { tool: { name: "write", arguments: { path: "planner-should-not-write.txt", content: "x" } } };
        }
        if (view.step === 1) {
          return {
            tool: {
              name: "submit_development_document",
              arguments: {
                objective: "Bootstrap a launchable artifact",
                priorities: [{ name: "Entry", action: "Create hello.txt", observable_outcome: "hello.txt exists" }],
                preservation_gate: [],
                acceptance_gate: ["hello.txt exists with content"],
              },
            },
          };
        }
        return { text: "Plan submitted." };
      case "developer":
        if (view.step === 0) return { tool: { name: "write", arguments: { path: "hello.txt", content: "hello from the fake developer\n" } } };
        if (view.step === 1) {
          return {
            tool: {
              name: "bash",
              arguments: {
                command:
                  "cat hello.txt; for f in \"${TMPDIR:-/tmp}\"/hoh-transcript-*/developer.jsonl; do test ! -e \"$f\" || printf 'PI_DEVELOPER_TRANSCRIPT_SENTINEL\\n' >> \"$f\"; done",
              },
            },
          };
        }
        return { text: "Wrote hello.txt and verified it with cat." };
      case "tester":
        if (view.step === 0) return { tool: { name: "edit", arguments: { path: "hello.txt", oldText: "hello", newText: "bye" } } };
        if (view.step === 1) {
          return {
            tool: {
              name: "bash",
              arguments: {
                command:
                  "cat hello.txt && ls; for f in \"${TMPDIR:-/tmp}\"/hoh-transcript-*/tester.jsonl; do test ! -e \"$f\" || printf 'PI_TESTER_TRANSCRIPT_SENTINEL\\n' >> \"$f\"; done",
              },
            },
          };
        }
        if (view.step === 2) {
          return {
            tool: {
              name: "submit_evidence",
              arguments: {
                qa_status: "pass",
                summary: "hello.txt exists and prints.",
                verified_records: [
                  {
                    claim_id: "entry_file",
                    claim: "hello.txt exists with content",
                    execution_records: [{ type: "run", path: "cat hello.txt", observation: view.lastToolResult?.slice(0, 200) ?? "" }],
                  },
                ],
                gap_records: [],
                planner_handoff: { preservation_constraints: ["keep hello.txt"], update_targets: [], validation_requirements: ["cat hello.txt"] },
              },
            },
          };
        }
        return { text: "Evidence submitted." };
      default:
        return { text: "unknown role" };
    }
    },
    { models: ["fake-model", "fake-tester", "fake-image-gen"], apiKey: "fake-key" },
  );

  // Providers come from the hoh config (OpenAI-compatible endpoint + discovery), not from pi's models.json.
  const agentDir = path.join(path.dirname(ws), "pi-agent");
  const roleTmpDir = path.join(path.dirname(ws), "role-visible-tmp");
  await mkdir(agentDir, { recursive: true });
  await mkdir(roleTmpDir, { recursive: true });
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = roleTmpDir;
  process.env.FAKE_GATEWAY_KEY = "fake-key";
  const config = mergeConfig(DEFAULT_CONFIG, {
    harness: "pi",
    loops: 1,
    pi: { agent_dir: agentDir },
    providers: {
      fake: {
        base_url: server.baseUrl,
        api_key: "$FAKE_GATEWAY_KEY",
        models: "discover",
        model_defaults: { context_window: 64000, max_tokens: 4096 },
        model_overrides: { "fake-tester": { reasoning: true } },
      },
    },
    models: { default: "fake/fake-model", tester: "fake/fake-tester" },
  });
  const harness = await createHarness(config, ws, { runtimeOptions: { refreshOnCreate: false } });

  try {
    const logs: string[] = [];
    const result = await runHoh({ workspace: ws, specPath: spec, harness, config, log: (m) => logs.push(m) });
    const paths = new RunPaths(ws);
    const { planner, developer, evidence } = result.results[0];

    assert.equal(planner.objective, "Bootstrap a launchable artifact");
    assert.equal(planner.attempts, 1);
    assert.equal(await readFile(path.join(ws, "hello.txt"), "utf8"), "hello from the fake developer\n");
    assert.ok(developer.changed_paths.includes("hello.txt"));
    assert.match(developer.summary, /Wrote hello.txt/);
    assert.equal(evidence.qa_status, "pass");
    assert.equal(evidence.frozen, true, `tester edit must have been blocked: ${JSON.stringify(evidence.runtime_notes)}`);
    assert.equal(evidence.verified_records[0].claim_id, "entry_file");
    assert.match(evidence.verified_records[0].execution_records[0].observation, /hello from the fake developer/);
    assert.ok(evidence.usage.totalTokens > 0, "usage accumulated from assistant messages");

    // Discovery filtered non-chat models and materialized a pi models.json inside the run record.
    const generated = (await readPiModelsJson(paths.piModels))!;
    assert.deepEqual(generated.hoh!.discovered.fake, ["fake-model", "fake-tester"]);
    assert.equal(generated.providers.fake.apiKey, "$FAKE_GATEWAY_KEY", "secrets stay as env references");
    assert.equal(generated.providers.fake.api, "openai-completions");
    assert.deepEqual(generated.providers.fake.models.find((m) => m.id === "fake-tester"), { id: "fake-tester", reasoning: true, contextWindow: 64000, maxTokens: 4096 });

    // Per-role models from config reached the provider and the record.
    assert.equal(server.requests.find((r) => r.role === "planner")!.model, "fake-model");
    assert.equal(server.requests.find((r) => r.role === "tester")!.model, "fake-tester");
    assert.equal(planner.usage.model, "fake/fake-model");
    assert.equal(evidence.usage.model, "fake/fake-tester:medium", "reasoning model gets pi's default thinking level");

    // Tool allowlists as seen by the model.
    const plannerReq = server.requests.find((r) => r.role === "planner")!;
    assert.deepEqual([...plannerReq.toolNames].sort(), ["find", "grep", "ls", "read", "submit_development_document"]);
    const devReq = server.requests.find((r) => r.role === "developer")!;
    assert.deepEqual([...devReq.toolNames].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
    const testerReq = server.requests.find((r) => r.role === "tester")!;
    assert.deepEqual([...testerReq.toolNames].sort(), ["bash", "find", "grep", "ls", "read", "submit_evidence"]);

    // The disallowed calls were answered with tool errors, not executed.
    const plannerWriteResult = server.requests.find((r) => r.role === "planner" && r.step === 1)!.lastToolResult ?? "";
    assert.match(plannerWriteResult, /not found|not available|unknown/i);
    const testerEditResult = server.requests.find((r) => r.role === "tester" && r.step === 1)!.lastToolResult ?? "";
    assert.match(testerEditResult, /not found|not available|unknown/i);

    // Transcripts were written by the adapter.
    const transcript = await readFile(paths.transcript(1, "developer"), "utf8");
    assert.match(transcript, /"type":"hoh_invocation"/);
    assert.match(transcript, /"type":"tool_execution_end"/);
    assert.equal(transcript.split("\n").includes("PI_DEVELOPER_TRANSCRIPT_SENTINEL"), false);
    const testerTranscript = await readFile(paths.transcript(1, "tester"), "utf8");
    assert.equal(testerTranscript.split("\n").includes("PI_TESTER_TRANSCRIPT_SENTINEL"), false);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    await server.close();
    await cleanup();
  }
});
