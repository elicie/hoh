/**
 * Structured-output tool schemas. The Planner and the QA Tester deliver their
 * deliverable by calling a tool; the runtime validates the payload against
 * these schemas (pi validates tool arguments before `execute`).
 */
import { Type } from "typebox";
import type { StructuredTool } from "../harness/types.js";
import { EVIDENCE_TYPES, EXECUTION_EVIDENCE_TYPES } from "../types.js";

export const SUBMIT_PLAN_TOOL = "submit_development_document";
export const SUBMIT_EVIDENCE_TOOL = "submit_evidence";
export const SUBMIT_CLAIMS_TOOL = "submit_claims";

const Severity = Type.Union([Type.Literal("minor"), Type.Literal("major"), Type.Literal("blocker")]);
const ExecutionEvidenceTypeSchema = Type.Union(EXECUTION_EVIDENCE_TYPES.map((value) => Type.Literal(value)));

export const ExecutionRecordSchema = Type.Object({
  type: Type.Union(EVIDENCE_TYPES.map((value) => Type.Literal(value)), {
    description:
      "Evidence type. Execution evidence: run | test | check | screenshot | replay | runtime_trace | log | storage. Static evidence: source | config | manifest.",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "File, command, or artifact the observation came from. For screenshots, replay data, storage snapshots, and logs saved in HOH_EVIDENCE_DIR, use a path relative to that directory; the runtime adds sha256.",
    }),
  ),
  observation: Type.String({ description: "What was observed, concretely" }),
});

export const ClaimRecordSchema = Type.Object({
  claim_id: Type.String({
    description:
      "Stable snake_case id for one behavior (e.g. player_control, result_state). Reuse the exact id only for the same independently observable behavior.",
  }),
  claim: Type.String({
    description: "Checkable statement about exactly one independently observable behavior; split parts that could pass or fail separately",
  }),
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

export const SubmitClaimsSchema = Type.Object({
  claims: Type.Array(
    Type.Object({
      id: Type.String({ pattern: "^[a-z0-9]+(?:_[a-z0-9]+)*$", description: "Stable snake_case claim id" }),
      criterion: Type.String({ minLength: 1, description: "One independently observable acceptance criterion from the specification" }),
      requires: Type.Array(ExecutionEvidenceTypeSchema, {
        uniqueItems: true,
        description: "Execution evidence types required before this claim may be verified",
      }),
      weight: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    }),
    { minItems: 1 },
  ),
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
      "Deliver the evidence bundle for the frozen candidate: verified claims, gaps, and the handoff for the next planner. Each claim covers exactly one independently observable behavior. A verified claim must cite at least one execution record (run, test, check, screenshot, replay, runtime_trace, log, or storage); source/config/manifest-only claims are gaps, and visual claims also require screenshot evidence. Call exactly once when the assessment is complete.",
    parameters: SubmitEvidenceSchema,
  },
];

export const claimsTools: StructuredTool[] = [
  {
    name: SUBMIT_CLAIMS_TOOL,
    description:
      "Deliver the fixed PRD claim catalog. Use one stable snake_case id per independently observable criterion and list every execution evidence type required to verify it. Call exactly once.",
    parameters: SubmitClaimsSchema,
  },
];
