import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createDemoMockHarness, MockHarness } from "../harness/mock.js";
import { runHoh } from "../runtime/loop.js";
import { verifyCurrentRunReceipt } from "../runtime/run-receipt.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { RunReceipt } from "../runtime/receipt.js";
import { makeWorkspace } from "./helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli.js");

test("a completed run receipt binds every durable input, role contract, and historical candidate", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const result = await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: { harness: "mock", loops: 1 },
    });
    const paths = new RunPaths(ws);
    const verification = await verifyCurrentRunReceipt(ws);
    assert.equal(verification.ok, true, JSON.stringify(verification.issues));

    const receipt = (await readJson<RunReceipt>(paths.receipt))!;
    assert.equal(receipt.receipt_sha256, verification.receipt?.receipt_sha256);
    const artifactPaths = new Set(receipt.artifacts.map((artifact) => artifact.path));
    for (const expected of [
      ".hoh/spec.md",
      ".hoh/config.json",
      ".hoh/run.json",
      ".hoh/claims.json",
      ".hoh/coverage.json",
      ".hoh/ledger.json",
      ".hoh/budget.json",
      ".hoh/iterations/loop-01/development_document.md",
      ".hoh/iterations/loop-01/developer.json",
      ".hoh/iterations/loop-01/evidence.json",
      ".hoh/iterations/loop-01/prompts/planner.json",
      ".hoh/iterations/loop-01/prompts/developer.json",
      ".hoh/iterations/loop-01/prompts/tester.json",
      ".hoh/iterations/loop-01/transcripts/planner.jsonl",
      ".hoh/iterations/loop-01/transcripts/developer.jsonl",
      ".hoh/iterations/loop-01/transcripts/tester.jsonl",
    ]) {
      assert.ok(artifactPaths.has(expected), `receipt is missing ${expected}`);
    }
    assert.equal(artifactPaths.has(".hoh/receipt.json"), false, "the receipt must not hash itself");
    assert.equal(artifactPaths.has(".hoh/README.md"), false, "the generated report is a view, not a canonical run record");

    const protocol = result.run.protocol_receipt!;
    assert.deepEqual(receipt.identities.harness, {
      config_sha256: protocol.config_sha256,
      name: "mock",
      protocol: "extended",
      protocol_sha256: protocol.protocol_sha256,
      runtime_version: protocol.runtime_version,
      version: "builtin-1",
    });
    for (const role of ["planner", "developer", "tester"] as const) {
      assert.deepEqual(receipt.identities.roles[role], {
        contract: protocol.role_contracts[role],
        last_reported_model: role === "planner" ? result.results[0].planner.usage.model : role === "developer" ? result.results[0].developer.usage.model : result.results[0].evidence.usage.model,
        resolved_model: protocol.models[role],
      });
    }
    assert.deepEqual(receipt.candidate, {
      commit_oid: result.results[0].developer.candidate_commit_sha,
      tree_oid: result.results[0].developer.candidate_tree_sha,
      subdir: ".",
    });

    const outsideReport = path.join(path.dirname(ws), "outside-report.md");
    await writeFile(outsideReport, "outside sentinel\n");
    await rm(paths.readme);
    await symlink(outsideReport, paths.readme);
    const withLinkedReport = await verifyCurrentRunReceipt(ws);
    assert.equal(withLinkedReport.ok, false);
    assert.ok(withLinkedReport.issues.some((issue) => issue.code === "artifact_unexpected" && /symlink.*README\.md/i.test(issue.message)));
    await assert.rejects(runHoh({ workspace: ws, harness: createDemoMockHarness() }), /cannot receipt runtime symlink .*README\.md/);
    assert.equal(await readFile(outsideReport, "utf8"), "outside sentinel\n", "the generated view must not follow a symlink");
    await rm(paths.readme);

    await writeFile(path.join(ws, "main.txt"), "uncommitted product mutation\n");
    assert.equal((await verifyCurrentRunReceipt(ws)).ok, true, "verification must use the recorded historical candidate");

    const unexpected = path.join(paths.root, "unexpected.json");
    await writeFile(unexpected, "{}\n");
    const withUnexpected = await verifyCurrentRunReceipt(ws);
    assert.equal(withUnexpected.ok, false);
    assert.ok(withUnexpected.issues.some((issue) => issue.code === "artifact_unexpected" && issue.path === ".hoh/unexpected.json"));
    await rm(unexpected);

    const linked = path.join(paths.root, "linked-record.json");
    await symlink(paths.spec, linked);
    const withSymlink = await verifyCurrentRunReceipt(ws);
    assert.equal(withSymlink.ok, false);
    assert.ok(withSymlink.issues.some((issue) => issue.code === "artifact_unexpected" && /symlink/i.test(issue.message)));
    await rm(linked);

    await writeFile(paths.spec, `${await readFile(paths.spec, "utf8")}tampered\n`);
    const tampered = await verifyCurrentRunReceipt(ws);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.issues.some((issue) => issue.code === "artifact_hash_mismatch" && issue.path === ".hoh/spec.md"));
  } finally {
    await cleanup();
  }
});

test("hoh verify is offline and does not parse config, load env files, or create a harness", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    await runHoh({
      workspace: ws,
      specPath: spec,
      harness: createDemoMockHarness(),
      config: { harness: "mock", loops: 1 },
    });
    const clean = await execFileAsync(process.execPath, [CLI, "verify", "--workspace", ws]);
    assert.match(clean.stdout, /Run receipt VERIFIED:/);
    assert.match(clean.stdout, /Artifacts: \d+/);

    await writeFile(path.join(ws, ".env"), "this is not an env assignment\n");
    await writeFile(new RunPaths(ws).config, "{ malformed config\n");
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "verify", "--workspace", ws]),
      (error: unknown) => {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        assert.equal(failure.code, 1);
        assert.equal(failure.stdout, "");
        assert.match(failure.stderr ?? "", /Run receipt verification FAILED/);
        assert.match(failure.stderr ?? "", /artifact_hash_mismatch.*\.hoh\/config\.json/);
        assert.doesNotMatch(failure.stderr ?? "", /loaded .*\.env|could not load|configured harness|valid JSON/i);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("an extended resume updates the receipt to the current resolved and reported model identity", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const firstHarness = createDemoMockHarness();
    await runHoh({
      workspace: ws,
      specPath: spec,
      harness: firstHarness,
      config: { harness: "mock", loops: 1, models: { default: "model-a" } },
    });
    const secondHarness = createDemoMockHarness();
    const resumed = await runHoh({
      workspace: ws,
      harness: secondHarness,
      config: { loops: 2, models: { default: "model-b" } },
    });
    assert.equal(resumed.results.length, 1);
    const receipt = (await verifyCurrentRunReceipt(ws)).receipt!;
    assert.equal(receipt.identities.harness && (receipt.identities.harness as { config_sha256: string }).config_sha256, resumed.run.protocol_receipt?.config_sha256);
    for (const role of ["planner", "developer", "tester"] as const) {
      assert.deepEqual(receipt.identities.roles[role], {
        contract: resumed.run.protocol_receipt?.role_contracts[role],
        last_reported_model: "mock:model-b",
        resolved_model: "mock:model-b",
      });
    }
  } finally {
    await cleanup();
  }
});

test("a claim-drafting initialization failure leaves a verifiable base-record checkpoint", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const paths = new RunPaths(ws);
    await rm(paths.claims);
    const harness = new MockHarness({ planner: () => { throw new Error("claim drafting failed"); } });
    await assert.rejects(
      runHoh({ workspace: ws, specPath: spec, harness, config: { harness: "mock", loops: 1 } }),
      /claim drafting failed/,
    );
    const verification = await verifyCurrentRunReceipt(ws);
    assert.equal(verification.ok, true, JSON.stringify(verification.issues));
    assert.equal(verification.receipt?.candidate, null);
    const pathsInReceipt = new Set(verification.receipt?.artifacts.map((artifact) => artifact.path));
    for (const expected of [".hoh/run.json", ".hoh/config.json", ".hoh/spec.md", ".hoh/ledger.json"]) {
      assert.ok(pathsInReceipt.has(expected), expected);
    }
  } finally {
    await cleanup();
  }
});
