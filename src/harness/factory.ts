/**
 * Builds the inner harness (and, for pi, the model runtime) from a HohConfig.
 * Used by the CLI and by tests so both take the same path.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureRepo, git } from "../runtime/git.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piCompactionForRole, type HohConfig } from "../runtime/config.js";
import { assertPiResourceManifestCurrent, buildPiResourceManifest } from "../runtime/pi-resources.js";
import { buildPiModelsJson, readPiModelsJson, type PiModelsJson } from "../runtime/providers.js";
import { RunPaths, writeJson } from "../runtime/state.js";
import { ROLES, type Role } from "../types.js";
import { CodexHarness, detectCodexVersion, type CodexHarnessOptions } from "./codex.js";
import { createDemoMockHarness } from "./mock.js";
import { PiHarness } from "./pi.js";
import type { Harness } from "./types.js";

export interface RuntimeBuild {
  modelRuntime: ModelRuntime;
  /** generated pi models.json, when the config declares providers */
  modelsPath: string | null;
  models: PiModelsJson | null;
}

export interface FactoryOptions {
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
  /** extra ModelRuntime.create options (tests) */
  runtimeOptions?: Parameters<typeof ModelRuntime.create>[0];
  /** Codex executable injection for tests or non-default installations. */
  codex?: CodexHarnessOptions;
}

export async function createModelRuntime(config: HohConfig, workspace: string, opts: FactoryOptions = {}): Promise<RuntimeBuild> {
  const paths = new RunPaths(workspace);
  const models = Object.keys(config.providers).length ? await buildPiModelsJson(config, {
    log: opts.log, fetchImpl: opts.fetchImpl, previous: await readPiModelsJson(paths.piModels),
  }) : null;
  let modelsPath: string | null = null;
  if (models) {
    // Harness construction precedes resume verification. Keep prepared models
    // in Git's private cache until runHoh accepts the previous checkpoint.
    await ensureRepo(workspace);
    const digest = createHash("sha256").update(JSON.stringify(models)).digest("hex");
    const cache = await git(["rev-parse", "--git-path", `hoh-models/${digest}.json`], workspace);
    modelsPath = path.resolve(workspace, cache.stdout.trim());
    await writeJson(modelsPath, models);
  }
  const agentDir = config.pi.agent_dir;
  const modelRuntime = await ModelRuntime.create({
    ...(modelsPath ? { modelsPath } : {}),
    ...(agentDir ? { authPath: path.join(agentDir, "auth.json") } : {}),
    ...(opts.runtimeOptions ?? {}),
  });
  return { modelRuntime, modelsPath, models };
}

export async function createHarness(config: HohConfig, workspace: string, opts: FactoryOptions = {}): Promise<Harness> {
  if (config.harness === "mock") return createDemoMockHarness();
  if (config.harness === "codex") {
    const codex = opts.codex ?? {};
    const version = codex.version ?? (await detectCodexVersion(codex));
    return new CodexHarness({ ...codex, version });
  }
  const resourceManifest = await buildPiResourceManifest(config, workspace);
  const { modelRuntime, models } = await createModelRuntime(config, workspace, opts);
  return new PiHarness({
    agentDir: config.pi.agent_dir,
    modelRuntime,
    providerModels: models ?? undefined,
    resourceManifest,
    verifyResourceManifest: (role: Role) => assertPiResourceManifestCurrent(resourceManifest, role),
    sessionPolicy: {
      retry: {
        enabled: config.retry.enabled,
        maxRetries: config.retry.max_retries,
        baseDelayMs: config.retry.base_delay_ms,
        maxRetryDelayMs: config.retry.max_delay_ms,
      },
      providerTimeoutMs: config.timeouts.provider_ms,
      outputIdleTimeoutMs: config.timeouts.output_idle_ms,
      websocketConnectTimeoutMs: config.timeouts.websocket_connect_ms,
      compaction: Object.fromEntries(
        ROLES.map((role) => {
          const value = piCompactionForRole(config, role);
          return [role, { enabled: value.enabled, reserveTokens: value.reserve_tokens, keepRecentTokens: value.keep_recent_tokens }];
        }),
      ) as Record<Role, { enabled: boolean; reserveTokens: number; keepRecentTokens: number }>,
    },
  });
}
