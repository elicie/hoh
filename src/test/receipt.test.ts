import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { artifactTreeHash, commitAll, ensureRepo, git, headCommit, RUNTIME_IDENTITY } from "../runtime/git.js";
import {
  captureRunReceiptArtifact,
  createRunReceipt,
  historicalCandidateTreeOid,
  MAX_RUN_RECEIPT_BYTES,
  parseRunReceipt,
  serializeRunReceipt,
  verifyRunReceipt,
  verifyRunReceiptFile,
  type RunReceiptInput,
} from "../runtime/receipt.js";

const A_SHA = "a".repeat(64);
const B_SHA = "b".repeat(64);

function identities() {
  return {
    harness: { version: "1.2.3", name: "test-harness" },
    roles: {
      tester: { model: "same:model", policy: ["read"] },
      developer: { policy: ["write"], model: "same:model" },
      planner: { model: "same:model", policy: ["read"] },
    },
  };
}

function input(overrides: Partial<RunReceiptInput> = {}): RunReceiptInput {
  return {
    run_id: "run-001",
    artifacts: [
      { name: "spec", path: ".hoh/spec.md", sha256: A_SHA },
      { name: "config", path: ".hoh/config.json", sha256: B_SHA },
    ],
    identities: identities(),
    candidate: null,
    ...overrides,
  };
}

test("run receipt canonicalizes equivalent input and detects a stale self-checksum", async () => {
  const first = createRunReceipt(input());
  const second = createRunReceipt({
    candidate: null,
    identities: {
      roles: {
        planner: { policy: ["read"], model: "same:model" },
        developer: { model: "same:model", policy: ["write"] },
        tester: { policy: ["read"], model: "same:model" },
      },
      harness: { name: "test-harness", version: "1.2.3" },
    },
    artifacts: [...input().artifacts].reverse(),
    run_id: "run-001",
  });

  assert.deepEqual(second, first);
  assert.equal(first.artifacts[0].name, "config");
  assert.match(first.receipt_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.identities.roles));
  assert.deepEqual(parseRunReceipt(JSON.parse(serializeRunReceipt(first))), first);

  const tampered = JSON.parse(serializeRunReceipt(first));
  tampered.artifacts[0].sha256 = "c".repeat(64);
  const result = await verifyRunReceipt(".", tampered);
  assert.equal(result.ok, false);
  assert.equal(result.receipt, null);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["receipt_integrity_mismatch"]);

  assert.throws(
    () => parseRunReceipt({ ...first, unexpected: true }),
    /must contain exactly/,
    "unknown receipt fields are rejected instead of ignored",
  );
});

test("run receipt rejects duplicate and unsafe artifact identities before storage", () => {
  assert.throws(
    () => createRunReceipt(input({ artifacts: [{ name: "escape", path: "../secret", sha256: A_SHA }] })),
    /stay inside the workspace/,
  );
  assert.throws(
    () => createRunReceipt(input({ artifacts: [{ name: "escape", path: "/tmp/secret", sha256: A_SHA }] })),
    /relative to the workspace/,
  );
  assert.throws(
    () =>
      createRunReceipt(
        input({
          artifacts: [
            { name: "same", path: "first", sha256: A_SHA },
            { name: "same", path: "second", sha256: B_SHA },
          ],
        }),
      ),
    /duplicates artifact name/,
  );
  assert.throws(
    () =>
      createRunReceipt(
        input({
          artifacts: [
            { name: "first", path: "same", sha256: A_SHA },
            { name: "second", path: "same", sha256: B_SHA },
          ],
        }),
      ),
    /duplicates artifact path/,
  );
  assert.throws(
    () => createRunReceipt(input({ identities: { harness: { invalid: Number.NaN }, roles: {} } })),
    /finite JSON number/,
  );
  const sparseArtifacts = new Array(1) as RunReceiptInput["artifacts"];
  assert.throws(() => createRunReceipt(input({ artifacts: sparseArtifacts })), /sparse array holes/);
  const sparseIdentity: unknown[] = [];
  sparseIdentity.length = 1;
  assert.throws(
    () => createRunReceipt(input({ identities: { harness: { sparse: sparseIdentity as any }, roles: {} } })),
    /sparse array holes/,
  );
});

test("offline receipt verification reports changed, missing, malformed, and symlinked files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-receipt-files-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(path.join(workspace, ".hoh"), { recursive: true });
    await writeFile(path.join(workspace, ".hoh", "spec.md"), "stable spec\n");
    await writeFile(path.join(workspace, ".hoh", "config.json"), "{}\n");
    const artifacts = await Promise.all([
      captureRunReceiptArtifact(workspace, "spec", ".hoh/spec.md"),
      captureRunReceiptArtifact(workspace, "config", ".hoh/config.json"),
    ]);
    const receipt = createRunReceipt(input({ artifacts }));
    assert.equal((await verifyRunReceipt(workspace, receipt)).ok, true);

    await writeFile(path.join(workspace, ".hoh", "spec.md"), "changed spec\n");
    await unlink(path.join(workspace, ".hoh", "config.json"));
    const changed = await verifyRunReceipt(workspace, receipt);
    assert.equal(changed.ok, false);
    assert.deepEqual(
      changed.issues.map((issue) => issue.code),
      ["artifact_missing", "artifact_hash_mismatch"],
      "artifact diagnostics remain deterministically ordered by canonical artifact name",
    );

    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(workspace, "linked.txt"));
    const linkedReceipt = createRunReceipt(
      input({
        artifacts: [
          {
            name: "linked",
            path: "linked.txt",
            sha256: createHash("sha256").update("outside\n").digest("hex"),
          },
        ],
      }),
    );
    const linked = await verifyRunReceipt(workspace, linkedReceipt);
    assert.deepEqual(linked.issues.map((issue) => issue.code), ["artifact_symlink"]);
    await assert.rejects(captureRunReceiptArtifact(workspace, "linked", "linked.txt"), /symlink paths are not allowed/);

    const outsideDirectory = path.join(root, "outside-directory");
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "secret.txt"), "ancestor escape\n");
    await symlink(outsideDirectory, path.join(workspace, "linked-directory"));
    const ancestorLinked = createRunReceipt(
      input({
        artifacts: [
          {
            name: "ancestor-linked",
            path: "linked-directory/secret.txt",
            sha256: createHash("sha256").update("ancestor escape\n").digest("hex"),
          },
        ],
      }),
    );
    assert.deepEqual(
      (await verifyRunReceipt(workspace, ancestorLinked)).issues.map((issue) => issue.code),
      ["artifact_symlink"],
    );

    await writeFile(path.join(workspace, ".hoh", "receipt.json"), "{ definitely not json\n");
    assert.deepEqual(
      (await verifyRunReceiptFile(workspace)).issues.map((issue) => issue.code),
      ["receipt_invalid_json"],
    );
    await writeFile(path.join(workspace, ".hoh", "receipt.json"), JSON.stringify({ ...receipt, extra: true }));
    assert.deepEqual(
      (await verifyRunReceiptFile(workspace)).issues.map((issue) => issue.code),
      ["receipt_malformed"],
    );
    await writeFile(path.join(workspace, ".hoh", "receipt.json"), Buffer.alloc(MAX_RUN_RECEIPT_BYTES + 1));
    assert.deepEqual(
      (await verifyRunReceiptFile(workspace)).issues.map((issue) => issue.code),
      ["receipt_too_large"],
    );
    await writeFile(path.join(workspace, ".hoh", "receipt.json"), serializeRunReceipt(receipt));
    const stored = await verifyRunReceiptFile(workspace);
    assert.deepEqual(
      stored.issues.map((issue) => issue.code),
      ["artifact_missing", "artifact_hash_mismatch"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical candidate verification ignores later worktree and HEAD changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-receipt-candidate-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(path.join(workspace, ".hoh"), { recursive: true });
    await mkdir(path.join(workspace, "game"), { recursive: true });
    await ensureRepo(workspace);
    await writeFile(path.join(workspace, "game", "main.txt"), "candidate one\n");
    await writeFile(path.join(workspace, ".hoh", "run.json"), "{\"run\":1}\n");
    await writeFile(path.join(workspace, ".hoh", "runtime-only.log"), "ignored one\n");
    await commitAll(workspace, "candidate one", RUNTIME_IDENTITY);
    const commitOid = await headCommit(workspace);
    assert.ok(commitOid);
    const objectStateBefore = (await git(["count-objects", "-v"], workspace)).stdout;
    const realObjectDirectory = path.join(workspace, ".git", "objects");
    await chmod(realObjectDirectory, 0o555);
    let treeOid: string;
    try {
      treeOid = await historicalCandidateTreeOid(workspace, {
        commit_oid: commitOid,
        tree_oid: "0".repeat(commitOid.length),
        subdir: ".",
      });
    } finally {
      await chmod(realObjectDirectory, 0o755);
    }
    assert.equal(
      (await git(["count-objects", "-v"], workspace)).stdout,
      objectStateBefore,
      "historical reconstruction writes derived trees only to its temporary object database",
    );
    assert.equal(await artifactTreeHash(workspace), treeOid, "historical reconstruction preserves artifactTreeHash semantics");
    const artifact = await captureRunReceiptArtifact(workspace, "run", ".hoh/run.json");
    const receipt = createRunReceipt(
      input({
        artifacts: [artifact],
        candidate: { commit_oid: commitOid, tree_oid: treeOid, subdir: "." },
      }),
    );
    const statusBeforeVerification = (await git(["status", "--porcelain=v1"], workspace)).stdout;
    assert.equal(await historicalCandidateTreeOid(workspace, receipt.candidate), treeOid);
    const emptyTreeOid = await artifactTreeHash(workspace, { subdir: "empty-directory" });
    assert.equal(
      await historicalCandidateTreeOid(workspace, {
        commit_oid: commitOid,
        tree_oid: emptyTreeOid,
        subdir: "empty-directory",
      }),
      emptyTreeOid,
      "an absent Git subdir uses this repository's object-format-specific empty tree",
    );
    await assert.rejects(
      historicalCandidateTreeOid(workspace, {
        commit_oid: commitOid,
        tree_oid: treeOid,
        subdir: "game/main.txt",
      }),
      /is not a Git tree/,
      "a non-tree or Git plumbing failure cannot be mistaken for an empty candidate",
    );
    assert.equal((await verifyRunReceipt(workspace, receipt)).ok, true);
    assert.equal(
      (await git(["status", "--porcelain=v1"], workspace)).stdout,
      statusBeforeVerification,
      "historical verification does not touch the live index or worktree",
    );

    await writeFile(path.join(workspace, "game", "main.txt"), "uncommitted tampering\n");
    await writeFile(path.join(workspace, ".hoh", "runtime-only.log"), "ignored two\n");
    assert.equal(
      (await verifyRunReceipt(workspace, receipt)).ok,
      true,
      "neither the live source tree nor excluded runtime state replaces the recorded commit",
    );

    await commitAll(workspace, "candidate two", RUNTIME_IDENTITY);
    await writeFile(path.join(workspace, "game", "main.txt"), "candidate three in worktree\n");
    assert.equal((await verifyRunReceipt(workspace, receipt)).ok, true, "verification still resolves the original commit after HEAD moves");

    const wrongTree = createRunReceipt(
      input({
        artifacts: [artifact],
        candidate: { commit_oid: commitOid, tree_oid: treeOid === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40), subdir: "." },
      }),
    );
    assert.deepEqual(
      (await verifyRunReceipt(workspace, wrongTree)).issues.map((issue) => issue.code),
      ["candidate_tree_mismatch"],
    );

    const missingCommit = createRunReceipt(
      input({
        artifacts: [artifact],
        candidate: { commit_oid: "f".repeat(40), tree_oid: treeOid, subdir: "." },
      }),
    );
    assert.deepEqual(
      (await verifyRunReceipt(workspace, missingCommit)).issues.map((issue) => issue.code),
      ["candidate_commit_missing"],
    );

    await git(["tag", "-a", "candidate-tag", "-m", "annotated candidate tag"], workspace, {
      env: {
        GIT_COMMITTER_NAME: RUNTIME_IDENTITY.name,
        GIT_COMMITTER_EMAIL: RUNTIME_IDENTITY.email,
      },
    });
    const tagOid = (await git(["rev-parse", "candidate-tag"], workspace)).stdout.trim();
    const tagReceipt = createRunReceipt(
      input({
        artifacts: [artifact],
        candidate: { commit_oid: tagOid, tree_oid: treeOid, subdir: "." },
      }),
    );
    assert.deepEqual(
      (await verifyRunReceipt(workspace, tagReceipt)).issues.map((issue) => issue.code),
      ["candidate_commit_invalid"],
      "an annotated tag that peels to a commit is not accepted as the recorded commit itself",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical candidate verification derives SHA-256 repository object IDs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-receipt-sha256-"));
  const workspace = path.join(root, "workspace");
  try {
    const initialized = await git(["init", "-q", "--object-format=sha256", workspace], root, { allowFail: true });
    if (initialized.code !== 0) {
      t.skip("installed Git does not support SHA-256 repositories");
      return;
    }
    await mkdir(path.join(workspace, ".hoh"), { recursive: true });
    await mkdir(path.join(workspace, "game"), { recursive: true });
    await writeFile(path.join(workspace, "game", "main.txt"), "sha256 candidate\n");
    await writeFile(path.join(workspace, ".hoh", "run.json"), "{}\n");
    await commitAll(workspace, "sha256 candidate", RUNTIME_IDENTITY);
    const commitOid = await headCommit(workspace);
    assert.ok(commitOid);
    assert.equal(commitOid.length, 64);

    const reconstructed = await historicalCandidateTreeOid(workspace, {
      commit_oid: commitOid,
      tree_oid: "0".repeat(64),
      subdir: ".",
    });
    assert.equal(reconstructed.length, 64);
    assert.equal(reconstructed, await artifactTreeHash(workspace));

    const emptyExpected = (await git(["hash-object", "-t", "tree", "--stdin"], workspace)).stdout.trim();
    assert.equal(
      await historicalCandidateTreeOid(workspace, {
        commit_oid: commitOid,
        tree_oid: emptyExpected,
        subdir: "absent",
      }),
      emptyExpected,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
