/** Optional extended-run checkpoint bound to the exact development plan. */
import { readFile } from "node:fs/promises";
import { canonicalSha256 } from "./protocol.js";
import { readJson, writeJson } from "./state.js";

export interface PlanCheckpoint {
  loopIndex: number;
  documentPath: string;
  document: string;
  signal?: AbortSignal;
}
export type ApprovePlan = (checkpoint: PlanCheckpoint) => Promise<boolean>;

export async function requirePlanApproval(
  checkpoint: PlanCheckpoint,
  filename: string,
  protocolHash: string,
  approve: ApprovePlan,
): Promise<void> {
  checkpoint.signal?.throwIfAborted();
  if (await readFile(checkpoint.documentPath, "utf8") !== checkpoint.document) {
    throw new Error("development document changed before human review; review the new plan");
  }
  const binding = canonicalSha256({ document: checkpoint.document, protocol: protocolHash });
  const prior = await readJson<{ approved: boolean; binding_sha256: string }>(filename);
  if (prior?.approved === true && prior.binding_sha256 === binding) return;
  const approved = await approve(checkpoint);
  checkpoint.signal?.throwIfAborted();
  if (await readFile(checkpoint.documentPath, "utf8") !== checkpoint.document) {
    throw new Error("development document changed during human review; review the new plan");
  }
  await writeJson(filename, { approved, binding_sha256: binding, reviewed_at: new Date().toISOString() });
  if (!approved) throw new Error("development plan was declined at the human checkpoint");
}
