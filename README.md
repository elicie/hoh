# hoh — Harness-of-Harness runtime

An implementation of the Harness-of-Harness (HoH) loop from
*Harness of Harness: Multi-Day Autonomous Software Development with Continual Improvement*
(arXiv 2609.01481). HoH does not replace a coding agent; it wraps one. Each
iteration invokes the same fixed harness three times with role-specific
prompts and permissions, and carries the artifact and the QA evidence into
the next iteration:

```
E_0 = ∅
for t = 1..T:
  D_t = Planner(S, E_{t-1}; read_only(A_{t-1}))       # development document
  A_t = Developer(A_{t-1}; S, D_t)                    # single writer
  E_t = Tester(read_only(A_t); S, D_t, Runtime.check(A_t))   # evidence bundle
```

The default inner harness is the [pi coding agent](https://github.com/earendil-works/pi)
through its SDK (one of the harnesses evaluated in the paper). A Codex CLI
adapter is also available for controlled comparison runs. The runtime in this
repository is the part the paper calls "the deterministic Runtime": it freezes
each role's inputs, enforces permissions, binds evidence to the exact candidate,
and records every loop in git.

## What the runtime enforces

| Role | Default pi allowlist | Working directory | Deliverable |
| --- | --- | --- | --- |
| Project Planner | `read grep find ls` + `submit_development_document` | workspace | D_t (`development_document.md`) |
| Developer | `read bash edit write grep find ls` | workspace | A_t (commit + artifact tree hash → candidate id) |
| QA Tester | `read bash grep find ls` + `submit_evidence` | isolated git worktree of the candidate | E_t (`evidence.json`) |

Codex runs preserve the same workspace boundaries and structured deliverables,
but their immutable receipt names the actual Codex sandbox capability instead
of pretending that Codex exposes pi's individual built-in tool names.

- **Run protocol.** `protocol: "paper"` fixes the base harness and version,
  one model/reasoning pattern, role prompt and tool contracts, runtime policy,
  and iteration budget for the life of the run. Their canonical SHA-256 receipt
  is stored in `.hoh/run.json`; a changed contract is rejected before resume.
  `protocol: "extended"` keeps product-specific role-model and budget overrides.
  Configs without the field are treated as legacy `extended` runs, never
  retroactively labeled paper-compatible.
- **Candidate identity.** After the Developer finishes, the runtime commits the
  workspace and hashes only the configured `artifact_dir` subtree, respecting
  Git ignore rules. `artifact_dir: "."` means the whole workspace except
  `.hoh/`. The candidate id is `loop-NN-<tree hash>`. With a narrower
  `artifact_dir`, files elsewhere can be present in the frozen commit but do not
  change the candidate id or its before/after QA hash.
- **Candidate diff for QA.** The Developer record preserves the exact full Git
  SHAs before and after development. The Tester receives an artifact-scoped
  stat, changed-file list, and patch plus a read-only inspection command. The
  inline block is capped at 32 KiB; larger patches expose metadata and hunk
  headers only. Runtime-owned `.hoh` files and paths outside `artifact_dir`
  never enter this diff, and a resumed QA attempt reuses the recorded candidate
  commit rather than a later runtime-only HEAD.
- **Frozen QA.** Deterministic checks and the Tester run in a detached git
  worktree of that commit. The tree is hashed before checks, before Tester, and
  after Tester; a mismatch fails QA with a runtime blocker.
- **Runtime records are off limits.** Developer changes under `.hoh/` are
  reverted. Tester writes are limited to the current loop's evidence directory;
  attempts to change other workspace or runtime records are reverted and fail QA.
  Active role transcript events are buffered inside the harness process and
  installed only after the corresponding mutation guard, so role-visible file
  writes cannot forge the runtime's log.
- **Structured output or nothing.** Planner and Tester deliver through tools
  with TypeBox schemas. A missing call is retried once with a runtime notice;
  a Planner that still returns nothing aborts the loop, a Tester that still
  returns nothing yields a failing evidence bundle (`tester.no_structured_output`).
- **Evidence normalization** (paper appendix A.4): verified vs gap records,
  a claim in both lists counts as a gap, failed deterministic checks become
  blocker gaps, source/config/manifest-only verification is downgraded, and
  fixed claims must satisfy every evidence type in their `requires` list.
- **Fixed PRD coverage.** `.hoh/claims.json` keeps one stable claim per public
  acceptance criterion. `.hoh/coverage.json` records each claim as `verified`,
  `gap`, or `untested`, plus its last verified loop and verification count.
  Planner and Tester receive a priority index plus canonical paths, and the
  exact table is inline only while it fits the context threshold; free claims
  remain allowed. Evidence is bound to the catalog hash, so editing a claim
  makes its old evidence ineligible until the revised claim is verified again.
- **Issue ledger.** Gaps open issues, verified records close them, a gap on a
  closed issue marks a regression. Exact claim ids identify the same gap across
  loops. A blocker is mandatory in the next loop, as is a gap observed in two
  adjacent loops; these escalations appear before discretionary Planner work
  and at the top of the Developer document. Duplicate or replayed observations
  count only once. The Planner receives the bounded ledger view; mandatory and
  open issues then travel in the development document seen by the
  Developer and Tester. Loop progress is measured by the ledger and
  deterministic checks, not only by QA PASS (the Fusepoint trajectory has 2
  PASS in 96 loops).
- **Progressive role context.** Long specification, evidence, ledger, coverage,
  check, and development-document views are represented by canonical paths,
  SHA-256, and a bounded index. Exact views up to 8 KiB remain inline; larger
  views are read on demand. Every per-loop role system+user input, including a
  retry notice, is limited to 96 KiB. Developer checks are carried once in the
  development document, while QA receives the current plan, candidate diff,
  current checks, coverage, and specification without the Developer's summary
  or a duplicate standalone ledger.
- **Environment for tools.** Every loop role invocation inherits
  `HOH_WORKSPACE` (the main workspace), `HOH_RUN_ID`, `HOH_LOOP`, and
  `HOH_ROLE` (the role name); roles that expose a shell can read them there.
  `worktree_setup` and deterministic checks additionally receive
  `HOH_CANDIDATE_DIR` (the isolated worktree), `HOH_EVIDENCE_DIR` (the main
  workspace's durable evidence directory), and `HOH_ROLE=check`; the Tester
  receives those two directories with `HOH_ROLE=tester`. `worktree_setup` runs
  from the candidate worktree root, while checks run from its `artifact_dir`.
  Untracked files (such as `tools/node_modules`) are not in the worktree; tools
  can resolve them from `$HOH_WORKSPACE` or install worktree-local dependencies
  in `worktree_setup`.
- **Durable evidence files.** Checks preserve complete stdout and stderr (within
  the file limit) under the loop's `evidence/checks/` directory while keeping
  compact tails in JSON; oversized output becomes a small omission manifest.
  Tester screenshots, logs, replay data, and storage snapshots cited by relative
  path receive a runtime-computed SHA-256. Links and special files are rejected;
  limits are 2 MiB per file and 30 MiB per loop. Because these files are committed
  to git, checks must not print secrets or personal data.
- **Resume.** Re-running `hoh run` continues after the last loop whose
  `evidence.json` is committed at `HEAD`. In an incomplete loop, a recorded plan
  and development document are reused; a recorded Developer result is reused
  only when the current `artifact_dir` hash still matches it. Checks and the
  Tester then run again against that same candidate tree. A mismatch aborts
  instead of silently testing a different artifact.
- **Git record and ownership.** `.hoh/` is runtime-managed: role attempts to
  alter records outside their allowed output are reverted. A new run snapshots
  the starting workspace and run records as `hoh-runtime`; configuration,
  start-up, error, and pre-QA check-record updates also use that identity.
  Planner, Developer, and final QA boundaries use `docs(loop-NN)`,
  `feat(loop-NN)`, and `test(loop-NN)` commits by `hoh-planner-bot`,
  `hoh-developer-bot`, and `hoh-tester-bot`. Before Tester access, a runtime
  `chore(loop-NN)` commit freezes the Developer record and deterministic check
  logs, so regenerated runtime files are not attributed to the next role.
- **Prompt snapshots.** The exact final system and user input delivered to each
  Planner, Developer, and Tester invocation in loops `1..T`, including the last
  structured-output retry notice, is stored under the loop's `prompts/`
  directory with per-input and combined SHA-256 values. The optional loop-0
  claim-drafting call keeps its existing `claims-transcript.jsonl` record.
- **Explicit pi resources.** Pi extensions and skills are disabled by default.
  Workspace-relative paths may be enabled globally or per role; extension tools
  are active only when named in that role's allowlist. Real paths and recursive
  content hashes are stored in `.hoh/pi-resources.json`, checked again before
  and after loading, and included in new protocol receipts. Extensions are
  trusted executable code, not a sandbox: use reviewed local code and scoped
  credentials even when its LLM-callable tools are restricted.
- **Cooperative cancellation.** Library callers may pass `signal` to `runHoh`.
  It propagates through claim drafting, every role invocation, setup, and
  deterministic checks. Pi aborts the active session, check process groups are
  killed, and a cancelled QA attempt removes its worktree without recording a
  QA verdict or runtime failure.
- **Persistent resource budgets.** Optional role, loop, and run ceilings for
  active elapsed time, total tokens, and cost are checked before every role.
  Completed `RoleUsage` is atomically charged to `.hoh/budget.json`; reaching a
  ceiling returns the resumable `budget_exhausted` state without creating a QA
  verdict or `error.json`.

## Layout of a run (`<workspace>/.hoh/`)

```
run.json                    run id, budget T, harness, model, checks
spec.md                     S, the public specification (copied from --spec)
pi-resources.json           resolved role extension/skill/tool manifest and hashes
budget.json                 atomic role/loop/run usage ledger and exhaustion state
ledger.json                 issue ledger
claims.json                 fixed PRD claim catalog and required evidence types
coverage.json               per-claim status, last verified loop, verification count
claims-transcript.jsonl     model events from automatic claim drafting
README.md                   generated development record
iterations/loop-NN/
  planner.json              planner overlay + usage
  development_document.md   D_t (deterministic scaffold + overlay)
  developer.json            candidate id, tree hash, commit, changed paths, violations
  checks.json               deterministic check results on the frozen candidate
  evidence.json             E_t
  evidence/                 hashed QA artifacts and retained check output
  prompts/<role>.json       exact final system/user prompt snapshot and hashes
  tester_report.md          human-readable QA report
  transcripts/<role>.jsonl  adapter session events (or mock records)
  error.json                present only when the loop aborted
```

## Configuration

Protocol, models, providers, harness, budget, checks, retry and timeouts live in a config file,
not in CLI flags. This repository ships `hoh.config.json`; edit it (or point
`--config` at another file). Providers are OpenAI-compatible endpoints; model
lists can be discovered from `GET {base_url}/models`. The root config uses
`paper`; the split-model example below is deliberately `extended`.

```json
{
  "protocol": "extended",
  "harness": "pi",
  "providers": {
    "spbros": {
      "base_url": "https://ai-api.spbros.com/v1",
      "api_key": "$SPBROS_API_KEY",
      "api": "openai-completions",
      "models": "discover",
      "discover": { "exclude": ["image", "video", "embed", "tts", "codex-auto-review"] },
      "model_defaults": { "context_window": 200000, "max_tokens": 32768, "reasoning": false },
      "model_overrides": { "gpt-5.5": { "reasoning": true, "context_window": 400000 } }
    },
    "ollama": {
      "base_url": "http://localhost:11434/v1",
      "api_key": "ollama",
      "models": ["qwen3-coder:30b"],
      "compat": { "supports_developer_role": false, "supports_reasoning_effort": false }
    }
  },
  "models": {
    "default": "spbros/gpt-5.5:high",
    "tester": "ollama/qwen3-coder:30b"
  },
  "loops": 3,
  "artifact_dir": ".",
  "checks": [{ "name": "build", "command": "godot --headless --path . --quit", "timeout_min": 5 }],
  "timeouts": {
    "role_min": 60,
    "check_min": 10,
    "provider_ms": 3600000,
    "output_idle_ms": 300000,
    "websocket_connect_ms": 15000
  },
  "retry": { "enabled": true, "max_retries": 3, "base_delay_ms": 2000, "max_delay_ms": 60000 },
  "budgets": {
    "role": { "elapsed_ms": 3600000, "total_tokens": 100000, "cost": 5.5 },
    "loop": { "elapsed_ms": 10800000, "total_tokens": 250000, "cost": 12.5 },
    "run": { "elapsed_ms": 32400000, "total_tokens": 750000, "cost": 35.0 }
  },
  "pi": {}
}
```

| Key | Meaning |
| --- | --- |
| `protocol` | `paper` fixes the initial harness/model/role/runtime contract and `T`; `extended` permits the product-specific overrides described below. Missing means legacy `extended` |
| `harness` | `pi` (in-process SDK), `codex` (non-interactive Codex CLI), or `mock` (scripted dry run) |
| `providers.<name>.base_url` | OpenAI-compatible endpoint (`…/v1`); may reference `$ENV` |
| `providers.<name>.api_key` | `"$ENV_VAR"` or `"!command"`. Literal keys are accepted only for localhost endpoints, because the config is committed with the run record |
| `providers.<name>.api` | `openai-completions` (default), `openai-responses`, or `anthropic-messages` |
| `providers.<name>.models` | `"discover"` (fetch `GET {base_url}/models`, drop image/video/embedding/audio models) or an explicit list of ids / objects |
| `providers.<name>.discover.exclude` / `include` | regex fragments applied to discovered ids |
| `providers.<name>.model_defaults` / `model_overrides` | `reasoning`, `context_window`, `max_tokens`, `input`, `cost`, `compat` per model; overrides are keyed by model id |
| `providers.<name>.headers` / `compat` | extra headers (`$ENV` allowed) and pi compat flags (snake_case accepted) |
| `models.default` | model pattern used by every role: pi uses `provider/model[:thinking]`; Codex accepts `codex/model[:minimal\|low\|medium\|high\|xhigh]` |
| `models.planner` / `developer` / `tester` | per-role override for `extended`; under `paper`, every configured pattern must be identical and the receipt records its concrete resolution |
| `loops` | iteration budget T |
| `artifact_dir` | artifact directory inside the workspace (`.` = whole workspace minus `.hoh/`) |
| `worktree_setup` | optional command run once per QA attempt in the isolated candidate worktree root before the checks (e.g. `cd tools && npm ci`), with the `HOH_*` check environment; recorded as check `setup`, whose failure blocks QA. It must not create or change non-ignored files in `artifact_dir`, or the candidate hash check invalidates QA |
| `checks[]` | deterministic commands run on the frozen candidate before QA (`name`, `command`, optional `timeout_min`) |
| `timeouts.role_min` / `check_min` | role and deterministic-check wall-clock limits |
| `timeouts.provider_ms` | per-provider-request ceiling; pi SDK retries stay disabled so the same pi session owns retry classification |
| `timeouts.output_idle_ms` / `websocket_connect_ms` | stream-silence watchdog and WebSocket handshake ceiling |
| `retry.*` | same-session transient retry policy: enablement, retry count, exponential-backoff base and maximum accepted server delay |
| `budgets.role` / `loop` / `run` | optional ceilings with `elapsed_ms` (positive integer), `total_tokens` (positive integer), and fractional `cost` (positive finite number). Omit any scope or metric to leave it unlimited. Codex CLI does not report monetary cost, so Codex configs may use elapsed/token limits but not `cost` |
| `pi.agent_dir` | pi's credential/models directory (default `~/.pi/agent`) |
| `pi.extensions` / `pi.skills` | reviewed workspace-relative resource paths loaded for every role; ambient pi discovery remains disabled |
| `pi.roles.<role>.extensions` / `skills` | additional resources loaded only for `planner`, `developer`, or `tester` |
| `pi.roles.<role>.extension_tools` | exact extension-registered tool names exposed to that role; built-in and `submit_*` names are reserved |

A minimal Codex run uses the installed `codex` executable and its own existing
authentication. The adapter fixes the CLI version, ignores ambient Codex config
and repository instructions, supplies HoH's role prompt explicitly, disables
interactive approval and web search, and maps `--json` plus `--output-schema`
back into the common role result:

```json
{
  "protocol": "paper",
  "harness": "codex",
  "models": { "default": "codex/gpt-5.6:high" },
  "loops": 3,
  "artifact_dir": ".",
  "checks": [],
  "budgets": { "run": { "elapsed_ms": 32400000, "total_tokens": 750000 } }
}
```

For example, this loads one shared skill for every role while loading a
reviewed extension and its tool only for the Developer:

```json
{
  "pi": {
    "skills": ["skills/shared"],
    "roles": {
      "developer": {
        "extensions": ["tools/project-tools.ts"],
        "skills": ["skills/implementation"],
        "extension_tools": ["inspect_project"]
      }
    }
  }
}
```

Each list accepts existing regular files or directories. A configured path must
resolve inside the workspace and outside `.hoh`, and a directory resource may
not contain symlinks. Extension package entrypoints declared by `package.json`
must also stay inside the configured, hashed directory; only exact paths and
simple `*`/`?` globs are accepted so brace, class, or extglob expansion cannot
cross that boundary. Invalid skills, unloaded extension entrypoints, and extension tools that replace any Pi built-in
(including `powershell`) or `submit_*` tool fail before a model request. A new
`paper` run fixes each role's resolved paths, bytes, and extension-tool allowlist
in its immutable role contract. Any resource drift therefore requires a fresh
run rather than a resume.

Resolution order, first wins:

1. `--config <file>`
2. `<workspace>/.hoh/config.json` — the run's own copy, committed with the record; only `extended` runs may accept material changes on resume
3. `./hoh.config.json` in the current directory (this repo's file when you run from here)
4. built-in defaults

`--loops <n>` is the only CLI run-time override. It is stored for an
`extended` run; a `paper` run rejects it when it changes the initial `T`.
The runtime creates a `paper` receipt only at run start, verifies the stored
receipt's own hash before resume, recomputes the current contract, and rejects
an invocation whose harness reports a model other than the receipt's resolved
identity. A pre-receipt run is always preserved as `extended`; its synthesized
receipt is marked `legacy_reconstruction` and does not attest to the original
run-start conditions.
Provider configuration records environment-variable references rather than
literal keys: `.env` files in the current directory and workspace are loaded
automatically (this repo's `.env` is git-ignored), and `.hoh/pi-models.json`
keeps `$ENV` references. Shell-enabled roles, setup commands, and checks still
inherit the runtime environment, so they can read or print those values. Use
scoped credentials and trusted specifications/tooling; HoH is not an
environment-variable sandbox.
`hoh config` re-runs discovery and prints the model list; when the endpoint is
unreachable, the previously discovered list is reused.
Every role record stores the model that was actually used, so `.hoh/README.md`
shows which model produced each plan, candidate, and evidence bundle.

```bash
node dist/cli.js config --workspace ../my-game   # effective config, per-role model resolution, credential check
```

## Install and run

Use a dedicated, backed-up Git branch or workspace with no concurrent human
edits. HoH creates commits and worktrees and reverts role writes that cross its
runtime-record boundaries.

```bash
npm install
npm run build

# secrets: put the gateway key in .env (git-ignored) or export it
echo 'SPBROS_API_KEY=…' > .env
# (pi's built-in providers also work: `npx pi` → /login, or ANTHROPIC_API_KEY / OPENAI_API_KEY …)

# edit hoh.config.json (providers, models, checks, artifact_dir), then:
node dist/cli.js config --workspace ../my-game                     # verify models resolve and have credentials
node dist/cli.js init-claims --workspace ../my-game --spec ./PRD.md # optional: draft and edit claims before running
node dist/cli.js run    --workspace ../my-game --spec ./PRD.md     # run the budgeted loops
node dist/cli.js status --workspace ../my-game
```

Re-running with the same workspace resumes after the last completed loop.
For an `extended` run, `--loops <n>` may extend the budget. For a `paper` run,
the initial token, cost, elapsed, and loop ceilings are part of the immutable
receipt; start a new run in another workspace instead of raising them. A
`budget_exhausted` result preserves the partial loop and starts no next role
until the stored limits permit it. The ledger charges the `RoleUsage` returned
by each completed role, including Pi's same-session retry totals. The harness
contract exposes no usage for a call that throws, so such usage is explicitly
recorded as unavailable and never estimated as zero. Accounting begins with
the loop-1 Planner; the optional loop-0 claim-drafting extension runs before
the budget ledger opens and is not included. If
`claims.json` is absent, `run` asks the
Planner model to draft it before loop 1 and commits it with the run record.
The generated catalog is a draft: review its PRD coverage and `requires` fields
before relying on the coverage total. The runtime enforces declared evidence
requirements but cannot prove that the model included every requirement.

A dry run without any model:

```bash
node dist/cli.js run --workspace /tmp/hoh-demo --spec examples/demo-PRD.md --config examples/mock.config.json
node dist/cli.js status --workspace /tmp/hoh-demo
```

## Tests

```bash
npm test
```

- `loop.test.ts`: end-to-end loops with a scripted harness, candidate freezing,
  artifact-scoped bounded QA diffs, `.hoh/` guard, retry and fallback paths,
  stable resume endpoints, and failed checks.
- `cancellation.test.ts`: check process-group termination and cancellation-safe
  QA worktree cleanup without false QA or runtime-failure records.
- `budget.test.ts`: config validation, role-boundary blocking, cumulative
  elapsed/token/cost accounting, resume stability, and error-free exhaustion.
- `codex-harness.test.ts`: exact non-interactive CLI flags, schema mapping,
  process-group cancellation, adapter versioning, native role-policy receipts,
  config validation, and a complete paper-protocol loop through a fake CLI.
- `ledger.test.ts`: exact gap identity, duplicate and replay idempotence,
  adjacent-loop escalation, and open/closed/regressed transitions.
- `config.test.ts`: config merge and validation, paper/extended protocol
  receipts and resume guards, file resolution order, per-role models reaching
  the harness and run record, provider validation, pi models.json mapping,
  model discovery.
- `coverage.test.ts`: fixed-claim initialization, cross-loop status transitions,
  required evidence types, prompt/report/status rendering, and `init-claims`.
- `prompts.test.ts`: UTF-8 disclosure budgets, priority indexes, role-specific
  context projection, canonical paths, and oversized-body omission.
- `prompt-snapshot.test.ts`: exact final prompt hashes, retry capture, resume
  behavior, candidate exclusion, and external-evaluator metadata non-mixing.
- `evidence-files.test.ts`: durable Tester files, check output, SHA-256 binding,
  git inclusion, path boundaries, size limits, and runtime-record protection.
- `pi-fake.test.ts`: the real pi SDK session and tool loop driven by a fake
  OpenAI-compatible server declared as a `providers` entry with discovery. Verifies the per-role tool allowlists as the model
  sees them, role-specific extension and skill loading, that disallowed tools
  are rejected, that built-in and allowlisted extension writes work only for
  the Developer, that structured tools are captured, that per-role models from
  the config reach the provider, that invalid configured skills fail before a
  model request, and that usage and transcripts are recorded.
- `pi-resources.test.ts`: resource config merging and validation, deterministic
  file/directory hashing, workspace, runtime-record, symlink, package-entrypoint
  and glob boundaries, reserved-tool checks, drift detection, and paper-resume
  receipt enforcement.

## Extending

- **Another inner harness.** Implement `Harness` in `src/harness/types.ts`
  (one `invoke` per role) and pass it to `runHoh`. The paper's protocol is
  harness-agnostic; the current adapters are `src/harness/pi.ts` and
  `src/harness/codex.ts`.
- **Domain tools and skills.** The Fusepoint run used Godot MCP, asset tools
  and skills. With pi, declare reviewed local paths and per-role extension-tool
  names under the `pi` config shown above; the adapter keeps ambient discovery
  disabled and records the resolved manifest.
- **Prompts.** `prompts/<role>.system.md` and `prompts/<role>.user.md` follow
  appendix A.2 of the paper; `{{slot}}` values are filled by
  `src/runtime/prompts.ts`.

## Roadmap

What to improve next, with the evidence from the first real run: [docs/ROADMAP.md](docs/ROADMAP.md).

## References

- Paper: https://arxiv.org/abs/2609.01481
- Project page: https://flesymeb.github.io/HarnessOfHarness/
- Fusepoint trajectory (the heavier private "GameLoop" runtime's public records): https://github.com/Flesymeb/fusepoint
- pi coding agent SDK docs: `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
