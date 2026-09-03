import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDemoMockHarness } from "../harness/mock.js";
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from "../runtime/config.js";
import { runHoh } from "../runtime/loop.js";
import { assertPiResourceManifestCurrent, buildPiResourceManifest } from "../runtime/pi-resources.js";
import { buildProtocolReceipt } from "../runtime/protocol.js";
import { readJson, RunPaths } from "../runtime/state.js";
import type { HarnessResourceManifest } from "../types.js";
import { makeWorkspace } from "./helpers.js";

test("pi resources: config deep-merges role fields and rejects unsafe paths or reserved tools", () => {
  const base = mergeConfig(DEFAULT_CONFIG, {
    harness: "mock",
    pi: {
      extensions: ["resources/shared-extension.ts"],
      skills: ["resources/shared-skill"],
      roles: {
        planner: { extensions: ["resources/planner-extension.ts"], skills: ["resources/planner-skill"] },
      },
    },
  });
  const merged = mergeConfig(base, {
    pi: {
      roles: {
        planner: { extension_tools: ["inspect_scene"] },
        tester: { skills: ["resources/tester-skill"] },
      },
    },
  });
  assert.deepEqual(merged.pi.extensions, ["resources/shared-extension.ts"]);
  assert.deepEqual(merged.pi.roles?.planner, {
    extensions: ["resources/planner-extension.ts"],
    skills: ["resources/planner-skill"],
    extension_tools: ["inspect_scene"],
  });
  assert.deepEqual(merged.pi.roles?.tester?.skills, ["resources/tester-skill"]);
  assert.deepEqual(validateConfig(merged), []);

  const invalid = mergeConfig(merged, {
    pi: {
      roles: {
        planner: { extension_tools: ["read", "powershell", "submit_development_document", "bad tool"] },
        intruder: { skills: ["../outside"] },
      } as any,
      extensions: ["/absolute/extension.ts", ".hoh/private-extension.ts", "../outside-extension.ts"],
      unsupported: true,
    },
  } as any);
  const errors = validateConfig(invalid).join("\n");
  assert.match(errors, /pi\.extensions\[0\] must be relative to the workspace/);
  assert.match(errors, /runtime-owned \.hoh/);
  assert.match(errors, /pi\.extensions\[2\] must stay inside the workspace/);
  assert.match(errors, /pi\.unsupported is not supported/);
  assert.match(errors, /pi\.roles\.intruder is not a role/);
  assert.match(errors, /reserved built-in\/runtime tool "read"/);
  assert.match(errors, /reserved built-in\/runtime tool "powershell"/);
  assert.match(errors, /reserved built-in\/runtime tool "submit_development_document"/);
  assert.match(errors, /valid exact tool name/);
});

test("pi resources: paper resume rejects changed resource bytes before replacing the recorded manifest", async () => {
  const { ws, spec, cleanup } = await makeWorkspace();
  try {
    const extension = path.join(ws, "resources", "paper-extension.ts");
    await mkdir(path.dirname(extension), { recursive: true });
    await writeFile(extension, "export const version = 1;\n");
    const config = mergeConfig(DEFAULT_CONFIG, {
      protocol: "paper",
      harness: "mock",
      loops: 1,
      models: { default: "m/shared:high" },
      pi: { extensions: ["resources/paper-extension.ts"] },
    });
    const firstManifest = await buildPiResourceManifest(config, ws);
    const firstHarness = createDemoMockHarness();
    Object.defineProperty(firstHarness, "resourceManifest", { value: firstManifest });
    await assert.rejects(
      buildProtocolReceipt(config, firstHarness, {
        legacyDefault: false,
        origin: "run_start",
        includeResourceContracts: false,
      }),
      /cannot resume a legacy paper run with harness resources/,
    );
    const started = await runHoh({ workspace: ws, specPath: spec, harness: firstHarness, config, configSource: "resource-test" });

    const paths = new RunPaths(ws);
    assert.equal(
      started.run.protocol_receipt?.role_contracts.planner.resources?.manifest_sha256,
      firstManifest.roles.planner.manifest_sha256,
      "the paper role contract fixes resource identity, content hashes, and extension tool allowlist",
    );
    assert.deepEqual(await readJson<HarnessResourceManifest>(paths.piResources), firstManifest);
    await writeFile(extension, "export const version = 2;\n");
    const secondManifest = await buildPiResourceManifest(config, ws);
    const secondHarness = createDemoMockHarness();
    Object.defineProperty(secondHarness, "resourceManifest", { value: secondManifest });
    await assert.rejects(runHoh({ workspace: ws, harness: secondHarness }), /cannot resume paper run .*protocol contract changed/);
    assert.deepEqual(
      await readJson<HarnessResourceManifest>(paths.piResources),
      firstManifest,
      "a rejected paper resume must not replace the approved detailed manifest",
    );
  } finally {
    await cleanup();
  }
});

test("pi resources: deterministic manifests inherit shared paths and detect content or identity changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-pi-resources-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(path.join(workspace, "resources", "shared-skill", "nested"), { recursive: true });
    await writeFile(path.join(workspace, "resources", "shared-extension.ts"), "export const shared = 1;\n");
    await writeFile(path.join(workspace, "resources", "planner-extension.ts"), "export const planner = 1;\n");
    await writeFile(path.join(workspace, "resources", "shared-skill", "SKILL.md"), "# Shared\n");
    await writeFile(path.join(workspace, "resources", "shared-skill", "nested", "guide.md"), "stable\n");

    const config = mergeConfig(DEFAULT_CONFIG, {
      harness: "mock",
      pi: {
        extensions: ["resources/shared-extension.ts"],
        skills: ["resources/shared-skill"],
        roles: {
          planner: { extensions: ["resources/planner-extension.ts"], extension_tools: ["inspect_scene"] },
        },
      },
    });
    const first = await buildPiResourceManifest(config, workspace);
    const repeated = await buildPiResourceManifest(config, workspace);
    assert.deepEqual(repeated, first, "unchanged file trees produce byte-stable manifest data");
    assert.equal(first.roles.planner.extensions.length, 2, "planner inherits the shared extension");
    assert.equal(first.roles.tester.extensions.length, 1);
    assert.equal(first.roles.developer.skills.length, 1, "all roles inherit shared skills");
    assert.deepEqual(first.roles.planner.extension_tools, ["inspect_scene"]);
    assert.ok(first.roles.planner.extensions.every((entry) => path.isAbsolute(entry.resolved_path)));

    await writeFile(path.join(workspace, "resources", "shared-skill", "nested", "guide.md"), "changed\n");
    await assert.rejects(assertPiResourceManifestCurrent(first, "tester"), /pi resources changed for tester/);
    const changed = await buildPiResourceManifest(config, workspace);
    assert.notEqual(changed.roles.tester.manifest_sha256, first.roles.tester.manifest_sha256);
    assert.notEqual(changed.manifest_sha256, first.manifest_sha256);

    const outside = path.join(root, "outside-extension.ts");
    await writeFile(outside, "export const outside = true;\n");
    await symlink(outside, path.join(workspace, "resources", "escape.ts"));
    const escaped = mergeConfig(config, { pi: { roles: { tester: { extensions: ["resources/escape.ts"] } } } });
    await assert.rejects(buildPiResourceManifest(escaped, workspace), /resolves outside the workspace/);

    await mkdir(path.join(workspace, ".hoh"), { recursive: true });
    await writeFile(path.join(workspace, ".hoh", "hidden-extension.ts"), "export const hidden = true;\n");
    await symlink(path.join(workspace, ".hoh", "hidden-extension.ts"), path.join(workspace, "resources", "runtime-link.ts"));
    const runtimeOwned = mergeConfig(config, {
      pi: { roles: { tester: { extensions: ["resources/runtime-link.ts"] } } },
    });
    await assert.rejects(buildPiResourceManifest(runtimeOwned, workspace), /resolves inside runtime-owned \.hoh/);

    const escapePackage = path.join(workspace, "resources", "escape-package");
    await mkdir(path.join(escapePackage, "inside"), { recursive: true });
    await mkdir(path.join(workspace, "resources", "outside-extensions"), { recursive: true });
    await writeFile(path.join(escapePackage, "inside", "safe.ts"), "export const safe = true;\n");
    await writeFile(path.join(workspace, "resources", "outside-extensions", "outside.ts"), "export const outside = true;\n");
    await writeFile(
      path.join(escapePackage, "package.json"),
      `${JSON.stringify({ pi: { extensions: ["../shared-extension.ts"] } }, null, 2)}\n`,
    );
    const escapedEntrypoint = mergeConfig(config, {
      pi: { roles: { tester: { extensions: ["resources/escape-package"] } } },
    });
    await assert.rejects(buildPiResourceManifest(escapedEntrypoint, workspace), /entrypoint outside the configured directory/);

    await writeFile(
      path.join(escapePackage, "package.json"),
      `${JSON.stringify({ pi: { extensions: ["{../outside-extensions,inside}/*.ts"] } }, null, 2)}\n`,
    );
    await assert.rejects(buildPiResourceManifest(escapedEntrypoint, workspace), /unsupported traversal-capable glob syntax/);

    await writeFile(
      path.join(escapePackage, "package.json"),
      `${JSON.stringify({ pi: { extensions: ["inside/*.ts"] } }, null, 2)}\n`,
    );
    const safePackage = await buildPiResourceManifest(escapedEntrypoint, workspace);
    assert.equal(safePackage.roles.tester.extensions.at(-1)?.configured_path, "resources/escape-package");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
