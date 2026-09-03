import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  EVALUATOR_LIMITS,
  EvaluatorRunError,
  runBlindEvaluator,
  type BlindEvaluatorDefinition,
  type BlindEvaluatorRequest,
} from "../experiment/evaluator.js";

const RUBRIC_SHA = "a".repeat(64);
const EXECUTABLE_SHA = await sha256File(process.execPath);

function evaluator(script: string, ...args: string[]): BlindEvaluatorDefinition {
  return {
    argv: [process.execPath, "-e", script, ...args],
    version: "fixture@1.0.0",
    rubric_sha256: RUBRIC_SHA,
    executable_sha256: EXECUTABLE_SHA,
  };
}

async function workspace(label = "external-evaluator-test-"): Promise<{ directory: string; artifact: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), label));
  const artifact = path.join(directory, "private-workspace-name.bin");
  await writeFile(artifact, Buffer.from("POST_ARTIFACT_BYTES", "utf8"));
  return { directory, artifact };
}

function request(artifactPath: string, definition: BlindEvaluatorDefinition): BlindEvaluatorRequest {
  return {
    evaluator: definition,
    artifactPath,
    task: "Build the requested artifact.",
    sample: "Public sample input.",
  };
}

test("blind evaluator serialized input and launch context omit a private sentinel", async () => {
  const sentinel = `PRIVATE_CONDITION_SENTINEL_${Date.now()}`;
  const { directory, artifact } = await workspace(`external-${sentinel}-`);
  const previous = {
    HOH_EXPERIMENT_CONDITION: process.env.HOH_EXPERIMENT_CONDITION,
    EXPERIMENT_RUN_LABEL: process.env.EXPERIMENT_RUN_LABEL,
    API_TOKEN: process.env.API_TOKEN,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.HOH_EXPERIMENT_CONDITION = sentinel;
  process.env.EXPERIMENT_RUN_LABEL = sentinel;
  process.env.API_TOKEN = sentinel;
  process.env.TMPDIR = path.join(directory, sentinel);
  try {
    const script = [
      "const fs = require('node:fs');",
      "let body = '';",
      "process.stderr.write('public evaluator diagnostic\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => body += chunk);",
      "process.stdin.on('end', () => process.stdout.write(JSON.stringify({",
      "argv: process.argv.slice(1), cwd: process.cwd(), env: process.env,",
      "input: JSON.parse(body), artifact: fs.readFileSync('artifact.bin').toString('base64')",
      "})));",
    ].join("");
    const rawRequest = {
      ...request(artifact, evaluator(script)),
      publicEnv: { PUBLIC_EVALUATOR_MODE: "blind" },
      private_values: [sentinel, "tiny", "password"],
      condition: sentinel,
      cell_id: sentinel,
      run_label: sentinel,
      development_intermediate_scores: { sentinel },
    };
    const receipt = await runBlindEvaluator(rawRequest);
    const result = receipt.result as Record<string, any>;
    const observation = JSON.stringify(result);
    assert.doesNotMatch(observation, new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(sentinel));
    assert.equal(EVALUATOR_LIMITS.private_value_min_code_points, 8);
    assert.equal(result.env.PUBLIC_EVALUATOR_MODE, "blind");
    assert.equal(result.env.HOH_EXPERIMENT_CONDITION, undefined);
    assert.equal(result.env.EXPERIMENT_RUN_LABEL, undefined);
    assert.equal(result.env.API_TOKEN, undefined);
    assert.equal(path.basename(result.cwd), path.basename(result.cwd).replace(sentinel, ""));
    assert.equal(result.input.artifact.filename, "artifact.bin");
    assert.equal(result.input.artifact.content, Buffer.from("POST_ARTIFACT_BYTES").toString("base64"));
    assert.equal(result.artifact, Buffer.from("POST_ARTIFACT_BYTES").toString("base64"));
    assert.deepEqual(Object.keys(result.input).sort(), ["artifact", "sample", "schema_version", "task"]);
    assert.equal(receipt.input.artifact_sha256, createHash("sha256").update("POST_ARTIFACT_BYTES").digest("hex"));
    assert.equal(receipt.failure, null);
    assert.equal(receipt.evaluator.executable_sha256, EXECUTABLE_SHA);
    assert.equal(receipt.evaluator.observed_executable_sha256_before, EXECUTABLE_SHA);
    assert.equal(receipt.evaluator.observed_executable_sha256_after, EXECUTABLE_SHA);
    assert.deepEqual(receipt.boundary, {
      threat_model: "trusted_cooperative_evaluator",
      process_separated: true,
      serialized_input_blinded: true,
      filesystem_isolated: false,
      network_isolated: false,
      descendant_termination: "same_posix_process_group",
    });
    assert.equal(receipt.stdout.sha256, createHash("sha256").update(receipt.stdout.raw).digest("hex"));
    assert.equal(receipt.stderr.raw, "public evaluator diagnostic\n");
    assert.equal(receipt.stderr.sha256, createHash("sha256").update(receipt.stderr.raw).digest("hex"));
    assert.match(receipt.process.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(receipt.process.duration_ms >= 0);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("qualifying private values are rejected from every caller-controlled disclosure channel", async () => {
  const { directory, artifact } = await workspace();
  const sentinel = `PRIVATE_DISCLOSURE_SENTINEL_${Date.now()}`;
  const base = request(artifact, evaluator("process.stdout.write('{}')"));
  const leakyRequests: BlindEvaluatorRequest[] = [
    { ...base, task: `public task ${sentinel}`, private_values: [sentinel] },
    { ...base, sample: `public sample ${sentinel}`, private_values: [sentinel] },
    { ...request(artifact, evaluator("process.stdout.write('{}')", sentinel)), private_values: [sentinel] },
    { ...base, publicEnv: { PUBLIC_HINT: sentinel }, private_values: [sentinel] },
    { ...base, publicEnv: { [`PUBLIC_${sentinel}`]: "public" }, private_values: [sentinel] },
  ];
  try {
    for (const leaky of leakyRequests) {
      await assert.rejects(runBlindEvaluator(leaky), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /rejected a qualifying private value/);
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        return true;
      });
    }
    await assert.rejects(
      runBlindEvaluator({ ...base, private_values: ["artifact.bin"] }),
      /qualifying private value in neutral artifact filename/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blind evaluator uses exact argv without shell interpolation and rejects private env names", async () => {
  const { directory, artifact } = await workspace();
  const marker = path.join(directory, "shell-interpolation-must-not-run");
  const literal = `; require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); #`;
  try {
    const receipt = await runBlindEvaluator(request(artifact, evaluator("process.stdout.write(JSON.stringify(process.argv.slice(1)))", literal)));
    assert.deepEqual(receipt.result, [literal]);
    await assert.rejects(access(marker));
    await assert.rejects(
      runBlindEvaluator({ ...request(artifact, evaluator("process.stdout.write('{}')")), publicEnv: { PUBLIC_API_TOKEN: "not-public" } }),
      /publicEnv contains a name that is not permitted/,
    );
    await assert.rejects(
      runBlindEvaluator({ ...request(path.basename(artifact), evaluator("process.stdout.write('{}')")) }),
      /artifactPath must be an absolute path/,
    );
    await assert.rejects(
      runBlindEvaluator({
        ...request(artifact, { ...evaluator("process.stdout.write('{}')"), executable_sha256: "b".repeat(64) }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof EvaluatorRunError);
        assert.equal(error.code, "evaluator_identity_mismatch");
        assert.match(error.message, /did not match its pre-registered value before launch/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blind evaluator rejects multiple or oversized JSON output and retains bounded receipts", async () => {
  const { directory, artifact } = await workspace();
  try {
    await assert.rejects(
      runBlindEvaluator(request(artifact, evaluator("process.stdout.write('{}\\n{}')"))),
      (error: unknown) => {
        assert.ok(error instanceof EvaluatorRunError);
        assert.equal(error.code, "invalid_json");
        assert.equal(error.receipt?.stdout.raw, "{}\n{}");
        assert.match(error.receipt?.stdout.sha256 ?? "", /^[0-9a-f]{64}$/);
        return true;
      },
    );
    await assert.rejects(
      runBlindEvaluator(request(artifact, evaluator("process.stdout.write('1e400')"))),
      (error: unknown) => {
        assert.ok(error instanceof EvaluatorRunError);
        assert.equal(error.code, "invalid_json");
        assert.match(error.message, /numbers must be finite/);
        return true;
      },
    );
    await assert.rejects(
      runBlindEvaluator(
        request(
          artifact,
          evaluator(`process.stdout.write(JSON.stringify({value:'x'.repeat(${EVALUATOR_LIMITS.stdout_bytes})}))`),
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof EvaluatorRunError);
        assert.equal(error.code, "output_too_large");
        assert.equal(error.receipt?.stdout.bytes, EVALUATOR_LIMITS.stdout_bytes);
        assert.equal(error.receipt?.stdout.truncated, true);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stream receipts hash the exact stored UTF-8 representation", async () => {
  const { directory, artifact } = await workspace();
  try {
    const script = [
      "process.stderr.write(Buffer.from([0xff]));",
      "process.stdout.write('{}');",
    ].join("");
    const receipt = await runBlindEvaluator(request(artifact, evaluator(script)));
    assert.equal(receipt.failure, null);
    assert.equal(receipt.stderr.raw, "\uFFFD");
    assert.equal(receipt.stderr.bytes, Buffer.byteLength(receipt.stderr.raw, "utf8"));
    assert.equal(receipt.stderr.sha256, createHash("sha256").update(receipt.stderr.raw, "utf8").digest("hex"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "on Linux, cancellation and timeout terminate the evaluator process group including descendants",
  { timeout: 15_000, skip: process.platform !== "linux" ? "requires Linux process groups and /proc verification" : false },
  async () => {
    const { directory, artifact } = await workspace();
    const childPidPath = path.join(directory, "descendant.pid");
    const script = [
      "const {spawn} = require('node:child_process');",
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], {stdio:'ignore'});",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("");
    try {
      const controller = new AbortController();
      const pending = runBlindEvaluator({ ...request(artifact, evaluator(script, childPidPath)), signal: controller.signal });
      await waitForFile(childPidPath);
      const descendantPid = Number(await readFile(childPidPath, "utf8"));
      controller.abort(new Error("operator cancellation"));
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof EvaluatorRunError);
        assert.equal(error.code, "cancelled");
        assert.equal(error.receipt?.failure?.code, "cancelled");
        return true;
      });
      await waitForProcessExit(descendantPid);

      await assert.rejects(
        runBlindEvaluator({
          ...request(artifact, evaluator("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")),
          timeoutMs: 50,
        }),
        (error: unknown) => {
          assert.ok(error instanceof EvaluatorRunError);
          assert.equal(error.code, "timed_out");
          return true;
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(filename);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`file did not appear: ${filename}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2];
      if (state === "Z") return;
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`descendant process ${pid} survived evaluator cancellation`);
}

async function sha256File(filename: string): Promise<string> {
  const handle = await open(filename, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}
