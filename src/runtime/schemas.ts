/**
 * Structured-output tool schemas. The Planner and the QA Tester deliver their
 * deliverable by calling a tool; the runtime validates the payload against
 * these schemas (pi validates tool arguments before `execute`).
 */
import { Type } from "typebox";
import type { StructuredTool } from "../harness/types.js";

export const SUBMIT_PLAN_TOOL = "submit_development_document";
export const SUBMIT_EVIDENCE_TOOL = "submit_evidence";

const Severity = Type.Union([Type.Literal("minor"), Type.Literal("major"), Type.Literal("blocker")]);

export const ExecutionRecordSchema = Type.Object({
  type: Type.Union(
    [
      Type.Literal("run"),
      Type.Literal("test"),
      Type.Literal("check"),
      Type.Literal("screenshot"),
      Type.Literal("replay"),
      Type.Literal("runtime_trace"),
      Type.Literal("log"),
      Type.Literal("storage"),
      Type.Literal("source"),
      Type.Literal("config"),
      Type.Literal("manifest"),
    ],
    {
      description:
        "Evidence type. Execution evidence: run | test | check | screenshot | replay | runtime_trace | log | storage. Static evidence: source | config | manifest.",
    },
  ),
  path: Type.Optional(Type.String({ description: "File, command, or artifact the observation came from" })),
  observation: Type.String({ description: "What was observed, concretely" }),
});

export const ClaimRecordSchema = Type.Object({
  claim_id: Type.String({
    description:
      "Stable snake_case id for the behavior (e.g. player_control, result_state). Reuse ids from prior evidence for the same behavior.",
  }),
  claim: Type.String({ description: "Checkable statement about observable behavior" }),
  execution_records: Type.Array(ExecutionRecordSchema, {
    description: "Records that were actually collected for this claim",
  }),
  severity: Type.Optional(Severity),
  player_impact: Type.Optional(Type.String()),
  recommended_update: Type.Optional(Type.String()),
});

export const SubmitEvidenceSchema = Type.Object({
  qa_status: Type.Union([Type.Literal("pass"), Type.Literal("partial"), Type.Literal("fail")], {
    description: "pass: every acceptance-gate claim verified and no regressions; partial: some verified, some gaps; fail: blockers or nothing verifiable",
  }),
  summary: Type.String({ description: "Two to five sentences for the next planner" }),
  verified_records: Type.Array(ClaimRecordSchema, {
    description: "Claims whose cited records visibly support the behavior",
  }),
  gap_records: Type.Array(ClaimRecordSchema, {
    description: "Observed failures, regressions, unmet requirements, and claims with insufficient evidence",
  }),
  planner_handoff: Type.Object({
    preservation_constraints: Type.Array(Type.String(), {
      description: "Verified behaviors the next loop must not regress",
    }),
    update_targets: Type.Array(Type.String(), { description: "Concrete repairs or extensions for the next loop" }),
    validation_requirements: Type.Array(Type.String(), {
      description: "How the next candidate should be validated end to end",
    }),
  }),
});

export const SubmitPlanSchema = Type.Object({
  objective: Type.String({ description: "One sentence: the bounded, locally complete increment for this loop" }),
  priorities: Type.Array(
    Type.Object({
      name: Type.String(),
      action: Type.String({ description: "Concrete implementation target" }),
      observable_outcome: Type.String({ description: "What QA should be able to observe when this is done" }),
    }),
    { minItems: 1, maxItems: 3, description: "At most three, ordered: blockers and regressions first" },
  ),
  preservation_gate: Type.Array(Type.String(), {
    description: "Working functionality and evidence that must not regress",
  }),
  acceptance_gate: Type.Array(Type.String(), {
    description: "Smallest end-to-end validation for the selected priorities",
  }),
});

export const plannerTools: StructuredTool[] = [
  {
    name: SUBMIT_PLAN_TOOL,
    description:
      "Deliver the prioritization overlay for this iteration's development document. Call exactly once when planning is complete.",
    parameters: SubmitPlanSchema,
  },
];

export const testerTools: StructuredTool[] = [
  {
    name: SUBMIT_EVIDENCE_TOOL,
    description:
      "Deliver the evidence bundle for the frozen candidate: verified claims, gaps, and the handoff for the next planner. A verified claim must cite at least one execution record (run, test, check, screenshot, replay, runtime_trace, log, or storage); source/config/manifest-only claims are gaps, and visual claims also require screenshot evidence. Call exactly once when the assessment is complete.",
    parameters: SubmitEvidenceSchema,
  },
];
