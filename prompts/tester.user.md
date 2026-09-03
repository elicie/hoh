# Iteration {{loop_index}} QA input

## Candidate
- Candidate id: `{{candidate_id}}`
- Isolated candidate directory (your working directory): `{{cwd}}`
- Artifact directory: `{{artifact_dir}}`
- Evidence directory: `$HOH_EVIDENCE_DIR` (save durable QA artifacts here)
- Base candidate: `{{base_candidate}}`
- Developer's own summary (a claim, not evidence):

{{developer_summary}}

## Deterministic checks (already executed on this exact candidate)

{{checks_section}}

## Development document (this iteration's brief)

{{development_document}}

## Fixed PRD claim coverage

{{coverage_section}}

Assess every fixed claim that this iteration can reach. Reuse its exact id and satisfy all evidence types listed in `Requires`. Claims outside this catalog are allowed when they identify a new observable behavior.

## Issue ledger (open and regressed issues)

{{ledger_section}}

## Public specification

{{spec}}

Inspect and execute the candidate, then call `submit_evidence`.
