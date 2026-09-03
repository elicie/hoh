# hoh — Harness-of-Harness on top of the pi coding agent

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

The inner harness is the [pi coding agent](https://github.com/earendil-works/pi)
through its SDK (one of the three harnesses evaluated in the paper). The
runtime in this repository is the part the paper calls "the deterministic
Runtime": it freezes each role's inputs, enforces permissions, binds evidence
to the exact candidate, and records every loop in git.

## What the runtime enforces

| Role | Tools (pi allowlist) | Working directory | Deliverable |
| --- | --- | --- | --- |
| Project Planner | `read grep find ls` + `submit_development_document` | workspace | D_t (`development_document.md`) |
| Developer | `read bash edit write grep find ls` | workspace | A_t (commit + artifact tree hash → candidate id) |
| QA Tester | `read bash grep find ls` + `submit_evidence` | isolated git worktree of the candidate | E_t (`evidence.json`) |

- **Candidate identity.** After the Developer finishes, the runtime commits and
  hashes the artifact tree (everything except `.hoh/`). The candidate id is
  `loop-NN-<tree hash>`.
- **Frozen QA.** Deterministic checks and the Tester run in a detached git
  worktree of that commit. The tree is hashed before checks, before Tester, and
  after Tester; a mismatch fails QA with a runtime blocker.
- **Runtime records are off limits.** Developer changes under `.hoh/` are
  reverted. Tester writes are limited to the current loop's evidence directory;
  attempts to change other workspace or runtime records are reverted and fail QA.
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
  Planner and Tester prompts receive the full table; free claims remain allowed.
  Evidence is bound to the catalog hash, so editing a claim makes its old
  evidence ineligible until the revised claim is verified again.
- **Issue ledger.** Gaps open issues, verified records close them, a gap on a
  closed issue marks a regression. Open issues are shown to every Planner and
  Tester. Loop progress is measured by the ledger and the deterministic
  checks, not only by QA PASS (the Fusepoint trajectory has 2 PASS in 96 loops).
- **Environment for tools.** Checks, `worktree_setup`, and the roles' shells see
  `HOH_WORKSPACE` (main workspace), `HOH_CANDIDATE_DIR` (isolated worktree, during
  checks and QA), `HOH_EVIDENCE_DIR` (durable files for the current QA loop),
  `HOH_RUN_ID`, `HOH_LOOP`, `HOH_ROLE`. Untracked files (such as
  `tools/node_modules`) are not in the worktree; tools can resolve them from
  `$HOH_WORKSPACE` or be installed by `worktree_setup`.
- **Durable evidence files.** Checks preserve complete stdout and stderr (within
  the file limit) under the loop's `evidence/checks/` directory while keeping
  compact tails in JSON; oversized output becomes a small omission manifest.
  Tester screenshots, logs, replay data, and storage snapshots cited by relative
  path receive a runtime-computed SHA-256. Links and special files are rejected;
  limits are 2 MiB per file and 30 MiB per loop. Because these files are committed
  to git, checks must not print secrets or personal data.
- **Resume.** Re-running `hoh run` continues after the last completed loop. Inside
  a loop, recorded planner and developer results are reused, so a crash during QA
  re-runs only the tester against the same candidate commit.
- **Git record.** `docs(loop-NN)`, `feat(loop-NN)`, and `test(loop-NN)` commits
  by `hoh-planner-bot`, `hoh-developer-bot`, and `hoh-tester-bot`, plus a
  runtime `chore(loop-NN)` commit that freezes check logs before Tester access
  and a regenerated `.hoh/README.md` development record.

## Layout of a run (`<workspace>/.hoh/`)

```
run.json                    run id, budget T, harness, model, checks
spec.md                     S, the public specification (copied from --spec)
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
  tester_report.md          human-readable QA report
  transcripts/<role>.jsonl  pi session events (or mock records)
  error.json                present only when the loop aborted
```

## Configuration

Models, providers, harness, budget, checks and timeouts live in a config file,
not in CLI flags. This repository ships `hoh.config.json`; edit it (or point
`--config` at another file). Providers are OpenAI-compatible endpoints; model
lists can be discovered from `GET {base_url}/models`.

```json
{
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
  "timeouts": { "role_min": 60, "check_min": 10 },
  "pi": {}
}
```

| Key | Meaning |
| --- | --- |
| `harness` | `pi` (real) or `mock` (scripted dry run) |
| `providers.<name>.base_url` | OpenAI-compatible endpoint (`…/v1`); may reference `$ENV` |
| `providers.<name>.api_key` | `"$ENV_VAR"` or `"!command"`. Literal keys are accepted only for localhost endpoints, because the config is committed with the run record |
| `providers.<name>.api` | `openai-completions` (default), `openai-responses`, or `anthropic-messages` |
| `providers.<name>.models` | `"discover"` (fetch `GET {base_url}/models`, drop image/video/embedding/audio models) or an explicit list of ids / objects |
| `providers.<name>.discover.exclude` / `include` | regex fragments applied to discovered ids |
| `providers.<name>.model_defaults` / `model_overrides` | `reasoning`, `context_window`, `max_tokens`, `input`, `cost`, `compat` per model; overrides are keyed by model id |
| `providers.<name>.headers` / `compat` | extra headers (`$ENV` allowed) and pi compat flags (snake_case accepted) |
| `models.default` | model pattern used by every role: `provider/model[:thinking]`. Custom providers from `providers` and pi's built-in ones (`anthropic/…`, `openai-codex/…`, `minimax/…`) both work |
| `models.planner` / `developer` / `tester` | per-role override. The paper uses one fixed model for all roles; overrides are optional |
| `loops` | iteration budget T |
| `artifact_dir` | artifact directory inside the workspace (`.` = whole workspace minus `.hoh/`) |
| `worktree_setup` | optional command run in the root of the isolated candidate worktree before the checks (e.g. `cd tools && npm ci`); recorded as check `setup` |
| `checks[]` | deterministic commands run on the frozen candidate before QA (`name`, `command`, optional `timeout_min`) |
| `timeouts.role_min` / `check_min` | wall-clock limits |
| `pi.agent_dir` | pi's credential/models directory (default `~/.pi/agent`) |

Resolution order, first wins:

1. `--config <file>`
2. `<workspace>/.hoh/config.json` — the run's own copy, committed with the record; edit it between invocations to change models mid-run
3. `./hoh.config.json` in the current directory (this repo's file when you run from here)
4. built-in defaults

`--loops <n>` is the only run-time override; it is stored back into the run config.
Secrets never enter the record: `.env` files in the current directory and in
the workspace are loaded automatically (this repo's `.env` is git-ignored), and
the generated pi provider file `.hoh/pi-models.json` keeps `$ENV` references.
`hoh config` re-runs discovery and prints the model list; when the endpoint is
unreachable, the previously discovered list is reused.
Every role record stores the model that was actually used, so `.hoh/README.md`
shows which model produced each plan, candidate, and evidence bundle.

```bash
node dist/cli.js config --workspace ../my-game   # effective config, per-role model resolution, credential check
```

## Install and run

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

Re-running with the same workspace resumes after the last completed loop;
`--loops <n>` extends the budget. If `claims.json` is absent, `run` asks the
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

- `loop.test.ts`: end-to-end loops with a scripted harness, ledger
  transitions, candidate freezing, `.hoh/` guard, retry and fallback paths,
  resume, failed checks.
- `config.test.ts`: config merge and validation, file resolution order,
  per-role models reaching the harness and the run record, stored config on
  resume, provider validation, pi models.json mapping, model discovery.
- `coverage.test.ts`: fixed-claim initialization, cross-loop status transitions,
  required evidence types, prompt/report/status rendering, and `init-claims`.
- `evidence-files.test.ts`: durable Tester files, check output, SHA-256 binding,
  git inclusion, path boundaries, size limits, and runtime-record protection.
- `pi-fake.test.ts`: the real pi SDK session and tool loop driven by a fake
  OpenAI-compatible server declared as a `providers` entry with discovery. Verifies the per-role tool allowlists as the model
  sees them, that disallowed tools are rejected, that built-in `write`/`bash`
  work for the Developer, that structured tools are captured, that per-role
  models from the config reach the provider, and that usage and transcripts
  are recorded.

## Extending

- **Another inner harness.** Implement `Harness` in `src/harness/types.ts`
  (one `invoke` per role) and pass it to `runHoh`. The paper's protocol is
  harness-agnostic; the pi adapter is `src/harness/pi.ts`.
- **Domain tools and skills.** The Fusepoint run used Godot MCP, asset tools
  and skills. With pi, add them through the `DefaultResourceLoader` options
  in the adapter (`additionalExtensionPaths`, `additionalSkillPaths`) or by
  registering custom tools per role.
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
