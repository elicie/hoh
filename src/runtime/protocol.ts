/** Protocol contract receipt construction and validation. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Harness } from "../harness/types.js";
import { CODING_TOOLS, INSPECT_TOOLS, READ_ONLY_TOOLS } from "../harness/types.js";
import { ROLES, type ProtocolReceipt, type Role, type RoleContractReceipt } from "../types.js";
import type { HohConfig } from "./config.js";
import { modelForRole } from "./config.js";
import { rolePromptTemplateHashes } from "./prompts.js";
import { plannerTools, testerTools } from "./schemas.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalize(item)));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertProtocolReceiptIntegrity(value: unknown): asserts value is ProtocolReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored protocol receipt is malformed");
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.schema_version !== 1 ||
    (receipt.origin !== "run_start" && receipt.origin !== "legacy_reconstruction") ||
    (receipt.mode !== "paper" && receipt.mode !== "extended") ||
    typeof receipt.protocol_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.protocol_sha256)
  ) {
    throw new Error("stored protocol receipt is malformed");
  }
  const payload = { ...receipt };
  delete payload.protocol_sha256;
  const actual = canonicalSha256(payload);
  if (actual !== receipt.protocol_sha256) {
    throw new Error(`stored protocol receipt failed its integrity check (${receipt.protocol_sha256.slice(0, 12)} != ${actual.slice(0, 12)})`);
  }
}

export function hasExplicitProtocol(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "protocol"));
}

let runtimeVersion: Promise<string> | undefined;
function loadRuntimeVersion(): Promise<string> {
  runtimeVersion ??= readFile(new URL("../../package.json", import.meta.url), "utf8")
    .then((text) => {
      const value = (JSON.parse(text) as { version?: unknown }).version;
      return typeof value === "string" && value ? value : "unknown";
    })
    .catch(() => "unknown");
  return runtimeVersion;
}

export async function buildProtocolReceipt(
  config: HohConfig,
  harness: Harness,
  options: { legacyDefault: boolean; origin: ProtocolReceipt["origin"] },
): Promise<ProtocolReceipt> {
  const harnessVersion = harness.version?.trim() || "unversioned";
  if (config.protocol === "paper" && (harnessVersion === "unversioned" || harnessVersion === "unknown")) {
    throw new Error(`paper protocol requires a versioned harness adapter; ${harness.name} reported ${harnessVersion}`);
  }
  if (config.protocol === "paper" && !harness.resolveModel) {
    throw new Error(`paper protocol requires ${harness.name} to resolve its configured model to a concrete identity`);
  }

  const promptHashes = await rolePromptTemplateHashes();
  const toolsByRole = {
    planner: { workspace: "active-read-only", builtin: READ_ONLY_TOOLS, structured: plannerTools },
    developer: { workspace: "active-writer", builtin: CODING_TOOLS, structured: [] },
    tester: { workspace: "isolated-read-only", builtin: INSPECT_TOOLS, structured: testerTools },
  } as const;
  const roleContracts = Object.fromEntries(
    ROLES.map((role) => {
      const contract = toolsByRole[role];
      const receipt: RoleContractReceipt = {
        workspace: contract.workspace,
        builtin_tools: [...contract.builtin],
        structured_tools: contract.structured.map((tool) => tool.name),
        system_prompt_sha256: promptHashes[role].system,
        user_prompt_sha256: promptHashes[role].user,
        output_contract_sha256: canonicalSha256(contract.structured),
      };
      return [role, receipt];
    }),
  ) as Record<Role, RoleContractReceipt>;
  const modelEntries = await Promise.all(
    ROLES.map(async (role) => {
      const pattern = modelForRole(config, role);
      const resolved = harness.resolveModel ? await harness.resolveModel(pattern) : (pattern ?? null);
      return [role, resolved] as const;
    }),
  );
  const models = Object.fromEntries(modelEntries) as Record<Role, string | null>;
  if (config.protocol === "paper") {
    const resolved = ROLES.map((role) => models[role]);
    if (resolved.some((model) => !model) || new Set(resolved).size !== 1) {
      throw new Error(
        `paper protocol requires one identical resolved model/reasoning identity (resolved: ${ROLES.map((role) => `${role}=${models[role] ?? "(none)"}`).join(", ")})`,
      );
    }
  }

  const runtimeVersionValue = await loadRuntimeVersion();
  if (config.protocol === "paper" && runtimeVersionValue === "unknown") {
    throw new Error("paper protocol requires a versioned HoH runtime");
  }

  const payload = {
    schema_version: 1 as const,
    origin: options.origin,
    mode: config.protocol,
    legacy_default: options.legacyDefault,
    initial_loops: config.loops,
    runtime_version: runtimeVersionValue,
    harness: { name: harness.name, version: harnessVersion },
    models,
    config_sha256: canonicalSha256(config),
    role_contracts: roleContracts,
  };
  return { ...payload, protocol_sha256: canonicalSha256(payload) };
}
