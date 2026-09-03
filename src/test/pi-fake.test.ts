/**
 * Drives the real pi SDK (session, tool loop, built-in tools, custom
 * structured tools, tool allowlists) against a fake OpenAI-compatible server,
 * so the adapter is verified end to end without credentials or network.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createHarness } from "../harness/factory.js";
import { DEFAULT_CONFIG, mergeConfig } from "../runtime/config.js";
import { runHoh } from "../runtime/loop.js";
import { readPiModelsJson } from "../runtime/providers.js";
import { RunPaths } from "../runtime/state.js";
import type { HarnessResourceManifest } from "../types.js";
import { startFakeOpenAI, type FakeStep } from "./fake-openai.js";
import { makeWorkspace } from "./helpers.js";

test("pi adapter: full loop through the real pi tool loop against a fake provider", async (t) => {
  const { ws, spec, cleanup } = await makeWorkspace();
  const resourcesDir = path.join(ws, "resources");
  await mkdir(path.join(resourcesDir, "shared-skill"), { recursive: true });
  await mkdir(path.join(resourcesDir, "developer-skill"), { recursive: true });
  await writeFile(
    path.join(resourcesDir, "role-tools.ts"),
    `import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export default function roleTools(pi) {
  pi.registerTool(defineTool({
    name: "write_role_marker",
    label: "Write role marker",
    description: "Write a test marker into the current role workspace.",
    parameters: Type.Object({ file: Type.String(), content: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      await writeFile(path.join(ctx.cwd, params.file), params.content);
      return { content: [{ type: "text", text: "marker written" }], details: {} };
    },
  }));
}
`,
  );
  await writeFile(
    path.join(resourcesDir, "shared-skill", "SKILL.md"),
    "---\nname: shared-fixture\ndescription: HOH_SHARED_SKILL_MARKER\n---\n\nShared fixture instructions.\n",
  );
  await writeFile(
    path.join(resourcesDir, "developer-skill", "SKILL.md"),
    "---\nname: developer-fixture\ndescription: HOH_DEVELOPER_SKILL_MARKER\n---\n\nDeveloper-only fixture instructions.\n",
  );
  let plannerTransientFailure = true;
  const server = await startFakeOpenAI(
    (view): FakeStep => {
    switch (view.role) {
      case "planner":
        if (plannerTransientFailure) {
          plannerTransientFailure = false;
          return { error: { status: 503, message: "temporary fixture outage" } };
        }
        if (view.step === 0) {
          // Read-only role: a write must be rejected by the allowlist before the plan is submitted.
          return { tool: { name: "write", arguments: { path: "planner-should-not-write.txt", content: "x" } } };
        }
        if (view.step === 1) {
          return { tool: { name: "write_role_marker", arguments: { file: "planner-extension-should-not-write.txt", content: "x" } } };
        }
        if (view.step === 2) {
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
        if (view.step === 0) {
          return { tool: { name: "write_role_marker", arguments: { file: "extension-marker.txt", content: "developer extension ran\n" } } };
        }
        if (view.step === 1) return { tool: { name: "write", arguments: { path: "hello.txt", content: "hello from the fake developer\n" } } };
        if (view.step === 2) {
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
          return { tool: { name: "write_role_marker", arguments: { file: "tester-extension-should-not-write.txt", content: "x" } } };
        }
        if (view.step === 2) {
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
        if (view.step === 3) {
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
    pi: {
      agent_dir: agentDir,
      extensions: ["resources/role-tools.ts"],
      skills: ["resources/shared-skill"],
      roles: {
        developer: {
          skills: ["resources/developer-skill"],
          extension_tools: ["write_role_marker"],
        },
      },
    },
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
    retry: { max_retries: 2, base_delay_ms: 1 },
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
    assert.equal(await readFile(path.join(ws, "extension-marker.txt"), "utf8"), "developer extension ran\n");
    assert.ok(developer.changed_paths.includes("hello.txt"));
    assert.ok(developer.changed_paths.includes("extension-marker.txt"));
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
    assert.equal(planner.usage.retry_count, 1, "the transient 503 is retried inside the same pi session");
    assert.equal(evidence.usage.model, "fake/fake-tester:medium", "reasoning model gets pi's default thinking level");

    // Tool allowlists as seen by the model.
    const plannerReq = server.requests.find((r) => r.role === "planner")!;
    assert.deepEqual([...plannerReq.toolNames].sort(), ["find", "grep", "ls", "read", "submit_development_document"]);
    const devReq = server.requests.find((r) => r.role === "developer")!;
    assert.deepEqual([...devReq.toolNames].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write", "write_role_marker"]);
    const testerReq = server.requests.find((r) => r.role === "tester")!;
    assert.deepEqual([...testerReq.toolNames].sort(), ["bash", "find", "grep", "ls", "read", "submit_evidence"]);

    assert.match(plannerReq.systemPrompt, /HOH_SHARED_SKILL_MARKER/);
    assert.doesNotMatch(plannerReq.systemPrompt, /HOH_DEVELOPER_SKILL_MARKER/);
    assert.match(devReq.systemPrompt, /HOH_SHARED_SKILL_MARKER/);
    assert.match(devReq.systemPrompt, /HOH_DEVELOPER_SKILL_MARKER/);
    assert.match(testerReq.systemPrompt, /HOH_SHARED_SKILL_MARKER/);
    assert.doesNotMatch(testerReq.systemPrompt, /HOH_DEVELOPER_SKILL_MARKER/);

    // The disallowed calls were answered with tool errors, not executed.
    const plannerWriteResult = server.requests.find((r) => r.role === "planner" && r.step === 1)!.lastToolResult ?? "";
    assert.match(plannerWriteResult, /not found|not available|unknown/i);
    const plannerExtensionResult = server.requests.find((r) => r.role === "planner" && r.step === 2)!.lastToolResult ?? "";
    assert.match(plannerExtensionResult, /not found|not available|unknown|does not allow/i);
    const testerEditResult = server.requests.find((r) => r.role === "tester" && r.step === 1)!.lastToolResult ?? "";
    assert.match(testerEditResult, /not found|not available|unknown/i);
    const testerExtensionResult = server.requests.find((r) => r.role === "tester" && r.step === 2)!.lastToolResult ?? "";
    assert.match(testerExtensionResult, /not found|not available|unknown|does not allow/i);

    const resourceManifest = (await readFile(paths.piResources, "utf8").then((text) => JSON.parse(text))) as HarnessResourceManifest;
    assert.equal(resourceManifest.roles.planner.extensions.length, 1);
    assert.equal(resourceManifest.roles.developer.skills.length, 2);
    assert.deepEqual(resourceManifest.roles.developer.extension_tools, ["write_role_marker"]);
    assert.match(resourceManifest.manifest_sha256, /^[0-9a-f]{64}$/);
    assert.equal(result.run.protocol_receipt?.role_contracts.developer.resources?.manifest_sha256, resourceManifest.roles.developer.manifest_sha256);

    // Transcripts were written by the adapter.
    const transcript = await readFile(paths.transcript(1, "developer"), "utf8");
    assert.match(transcript, /"type":"hoh_invocation"/);
    assert.match(transcript, /"type":"tool_execution_end"/);
    assert.equal(transcript.split("\n").includes("PI_DEVELOPER_TRANSCRIPT_SENTINEL"), false);
    const testerTranscript = await readFile(paths.transcript(1, "tester"), "utf8");
    assert.equal(testerTranscript.split("\n").includes("PI_TESTER_TRANSCRIPT_SENTINEL"), false);
    const plannerTranscript = await readFile(paths.transcript(1, "planner"), "utf8");
    assert.match(plannerTranscript, /"type":"auto_retry_start"/);
    assert.match(plannerTranscript, /"type":"auto_retry_end"/);
    assert.match(plannerTranscript, /"transport_policy":\{"retry":\{"enabled":true,"maxRetries":2,"baseDelayMs":1/);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    await server.close();
    await cleanup();
  }
});

test("pi adapter: rejects an invalid configured skill before contacting the model", async () => {
  const { ws, cleanup } = await makeWorkspace();
  const skillDir = path.join(ws, "resources", "broken-skill");
  const agentDir = path.join(path.dirname(ws), "pi-agent-invalid-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# Missing required frontmatter\n");
  const server = await startFakeOpenAI(() => ({ text: "must not be reached" }), {
    models: ["fake-model"],
    apiKey: "invalid-skill-key",
  });
  const previousKey = process.env.HOH_INVALID_SKILL_KEY;
  process.env.HOH_INVALID_SKILL_KEY = "invalid-skill-key";
  const config = mergeConfig(DEFAULT_CONFIG, {
    harness: "pi",
    pi: { agent_dir: agentDir, skills: ["resources/broken-skill"] },
    providers: {
      fake: {
        base_url: server.baseUrl,
        api_key: "$HOH_INVALID_SKILL_KEY",
        models: "discover",
      },
    },
    models: { default: "fake/fake-model" },
  });

  try {
    const harness = await createHarness(config, ws, { runtimeOptions: { refreshOnCreate: false } });
    await assert.rejects(
      harness.invoke({
        role: "planner",
        loopIndex: 1,
        cwd: ws,
        systemPrompt: "You are the Project Planner.",
        prompt: "Do not contact the model.",
        tools: ["read"],
        structuredTools: [],
        model: "fake/fake-model",
      }),
      /failed to load planner skills|planner skill resources loaded no valid skill/,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    if (previousKey === undefined) delete process.env.HOH_INVALID_SKILL_KEY;
    else process.env.HOH_INVALID_SKILL_KEY = previousKey;
    await server.close();
    await cleanup();
  }
});
