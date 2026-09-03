/**
 * Builds the inner harness (and, for pi, the model runtime) from a HohConfig.
 * Used by the CLI and by tests so both take the same path.
 */
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { HohConfig } from "../runtime/config.js";
import { assertPiResourceManifestCurrent, buildPiResourceManifest } from "../runtime/pi-resources.js";
import { materializePiModels, type PiModelsJson } from "../runtime/providers.js";
import { RunPaths } from "../runtime/state.js";
import type { Role } from "../types.js";
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
}

export async function createModelRuntime(config: HohConfig, workspace: string, opts: FactoryOptions = {}): Promise<RuntimeBuild> {
  const paths = new RunPaths(workspace);
  const models = await materializePiModels(config, paths.piModels, { log: opts.log, fetchImpl: opts.fetchImpl });
  const modelsPath = models ? paths.piModels : null;
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
  const resourceManifest = await buildPiResourceManifest(config, workspace);
  const { modelRuntime } = await createModelRuntime(config, workspace, opts);
  return new PiHarness({
    agentDir: config.pi.agent_dir,
    modelRuntime,
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
    },
  });
}
