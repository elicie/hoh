import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDemoMockHarness } from "../harness/mock.js";
import type { Harness, RoleInvocation } from "../harness/types.js";
import { runHoh } from "../runtime/loop.js";
import { combinedPromptInputSha256 } from "../runtime/prompt-snapshot.js";
import { REDACTION_MARKER } from "../runtime/redaction.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { Role, RolePromptSnapshot } from "../types.js";
import { DEMO_SPEC, makeWorkspace } from "./helpers.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("configured credentials stay exact in memory but are redacted from prompt and transcript storage", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  const envName = "HOH_STORAGE_REDACTION_TEST_KEY";
  const previous = process.env[envName];
  const secret = "storage-secret-value-9f31e8c2";
  const exactInputs: Array<{ role: Role; loopIndex: number; system: string; user: string }> = [];
  try {
    process.env[envName] = secret;
    await writeFile(spec, `${DEMO_SPEC}\nPrivate fixture echo: ${secret}\n`);
    await rm(path.join(ws, ".hoh", "claims.json"), { force: true });

    const inner = createDemoMockHarness();
    const harness: Harness = {
      name: inner.name,
      version: inner.version,
      resolveModel: (pattern) => inner.resolveModel(pattern),
      invoke(inv: RoleInvocation) {
        exactInputs.push({ role: inv.role, loopIndex: inv.loopIndex, system: inv.systemPrompt, user: inv.prompt });
        return inner.invoke(inv);
      },
    };

    await runHoh({
      workspace: ws,
      specPath: spec,
      harness,
      config: {
        harness: "mock",
        claim_catalog: "generate",
        loops: 1,
        providers: {
          fixture: {
            base_url: "http://localhost:11434/v1",
            api_key: `$${envName}`,
            models: ["unused"],
          },
        },
      },
    });

    assert.ok(exactInputs.some((input) => input.user.includes(secret)), "the harness must receive the exact unredacted input");
    const paths = new RunPaths(ws);
    const claimsTranscript = await readFile(paths.claimsTranscript, "utf8");
    assert.doesNotMatch(claimsTranscript, new RegExp(secret));
    assert.match(claimsTranscript, /\[REDACTED\]/);

    for (const role of ["planner", "developer", "tester"] as const) {
      const exact = exactInputs.find((input) => input.role === role && input.loopIndex === 1)!;
      const snapshot = (await readJson<RolePromptSnapshot>(paths.promptSnapshot(1, role)))!;
      const serializedSnapshot = JSON.stringify(snapshot);
      const transcript = await readFile(paths.transcript(1, role), "utf8");

      assert.ok(exact.user.includes(secret));
      assert.equal(snapshot.user_prompt_sha256, sha256(exact.user));
      assert.equal(snapshot.system_prompt_sha256, sha256(exact.system));
      assert.equal(snapshot.combined_input_sha256, combinedPromptInputSha256(exact.system, exact.user));
      assert.equal(snapshot.user_prompt_storage.redacted, true);
      assert.equal(snapshot.user_prompt_storage.stored_sha256, sha256(snapshot.user_prompt));
      assert.doesNotMatch(serializedSnapshot, new RegExp(secret));
      assert.match(snapshot.user_prompt, new RegExp(REDACTION_MARKER.replace(/[\[\]]/g, "\\$&")));
      assert.doesNotMatch(transcript, new RegExp(secret));
      assert.match(transcript, /\[REDACTED\]/);
    }
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await cleanup();
  }
});
