# Iteration {{loop_index}} planning input

## Workspace
- Working directory: `{{cwd}}`
- Artifact directory: `{{artifact_dir}}`
- Base candidate: `{{base_candidate}}`
- Specification file: `{{spec_path}}`
- Runtime records (read-only for you): `.hoh/`

## Issue ledger (open and regressed issues)

{{ledger_section}}

Items under **Mandatory next-loop issues** are runtime escalations. Put them before discretionary work and carry their observable verification into the Acceptance Gate.

## Public specification (source of truth)

{{spec_section}}

## Fixed PRD claim coverage

{{coverage_section}}

## Previous-iteration evidence

{{evidence_section}}

## Deterministic checks on the base candidate

{{checks_section}}

## Instructions

{{evidence_instruction}}

Use the fixed claim ids above when selecting validation targets. Prioritize untested claims and claims whose last verification is old unless an open blocker or regression is more urgent.

Inspect the artifact as needed, then call `submit_development_document`.
