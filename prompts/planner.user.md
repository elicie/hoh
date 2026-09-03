# Iteration {{loop_index}} planning input

## Workspace
- Working directory: `{{cwd}}`
- Artifact directory: `{{artifact_dir}}`
- Base candidate: `{{base_candidate}}`
- Specification file: `{{spec_path}}`
- Runtime records (read-only for you): `.hoh/`

## Public specification (source of truth)

{{spec}}

## Previous-iteration evidence

{{evidence_section}}

## Issue ledger (open and regressed issues)

{{ledger_section}}

## Deterministic checks on the base candidate

{{checks_section}}

## Instructions

{{evidence_instruction}}

Inspect the artifact as needed, then call `submit_development_document`.
