# HoH 개선 로드맵

기준 시점: 2026-09-03. 근거는 1945 STRIKE 3루프 실행(`~/Dev/hoh-1945`, run `20260903-1de3ce`)에서 관찰한 것과 논문(arXiv 2609.01481) 본문·부록 A의 요구사항입니다. 각 항목은 **왜(관찰) → 무엇을 → 어떻게 → 검증 → 규모** 순으로 적었습니다. 규모는 한 사람 기준 대략치입니다.

## 우선순위 요약

| # | 항목 | 우선순위 | 규모 | 의존 |
| --- | --- | --- | --- | --- |
| 1 | 증거 등급 강제 (소스만 보고 verified 금지) | P0 | 0.5일 | – |
| 2 | PRD 커버리지 추적 (고정 claim 목록) | P0 | 1일 | 1 |
| 3 | 증거 파일 보존 (`evidence/` 디렉토리와 해시) | P0 | 0.5일 | – |
| 4 | Tester 모델 분리와 사람 체크포인트 | P0 | 0.5일 | – |
| 5 | 저장소 정리: 커밋, CI, README 동기화 | P0 | 0.5일 | – |
| 6 | Tester에 후보 diff 제공 | P1 | 0.2일 | – |
| 7 | 장기 실행 운영: detach/stop/status, 예산, 재시도, 비용 | P1 | 2일 | – |
| 8 | 원장 의미론 강화 (닫힘 조건, 에스컬레이션) | P1 | 0.5일 | 1, 2 |
| 9 | 프롬프트 개선 (커버리지, 이전 diff, QA 리포트) | P1 | 0.5일 | 2, 6 |
| 10 | 역할별 pi 확장·스킬 주입 | P1 | 1일 | – |
| 11 | Developer 토큰 절감 | P2 | 0.5일 | – |
| 12 | MCP 브리지 (외부 시스템이 필요한 프로젝트에 한해) | P2 | 1일 | 10 |
| 13 | 컨테이너/샌드박스 실행 | P2 | 1일 | 7 |
| 14 | 추가 하네스 어댑터 (codex, claude CLI) | P2 | 1일/개 | – |
| 15 | 감사용 입력 해시와 receipt | P2 | 0.5일 | 3 |
| 16 | 대시보드와 기록 확장 | P2 | 1일 | 3 |
| 17 | 프로젝트 유형별 키트 템플릿 | P2 | 0.5일/개 | – |
| 18 | 실험 프로토콜 (Vanilla 비교, 모델 비교) | P2 | 1일 | 4, 14 |

---

## 1. 증거 등급 강제

**왜.** Loop 3 QA에서 `enemy_type_count`와 `pickup_medal_and_bomb_cap`이 `spawnEnemy`, `MAX_BOMBS` 소스를 읽은 것만으로 verified 처리됐다. 논문 3.4.3과 A.4는 "소스 존재만으로는 행동 검증이 아니다"라고 명시한다. 현재 `normalizeEvidence`는 레코드의 `execution_records[].type`을 보지 않는다.

**무엇을.** verified 레코드마다 최소 하나의 **실행 계열 증거**를 요구한다. 없으면 gap(`insufficient_evidence`)으로 강등하고, QA 상태를 재계산한다.

**어떻게.**
- `src/runtime/schemas.ts`: `ExecutionRecordSchema.type`을 열거형으로 고정. 실행 계열 `run | test | check | screenshot | replay | runtime_trace | log | storage`, 정적 계열 `source | config | manifest`.
- `src/runtime/loop.ts` `normalizeEvidence`: verified 레코드에 실행 계열이 하나도 없으면 `status: "gap"`, `severity: "minor"`, `runtime_notes`에 "source-only evidence downgraded" 기록. `claim_id`는 유지해 원장 연속성을 지킨다.
- 시각 요구사항(HUD, 팔레트, 화면)은 `screenshot` 타입을 요구하는 규칙을 PRD 쪽 claim 정의(2번)에서 지정할 수 있게 한다.
- Tester 프롬프트(`prompts/tester.system.md`)에 등급 규칙을 명시하고, `submit_evidence` 툴 설명에도 반영.

**검증.** `loop.test.ts`에 소스만 인용한 verified가 gap으로 강등되는 테스트, 실행 증거가 하나라도 있으면 유지되는 테스트. 1945 loop 3 evidence.json을 fixture로 넣어 강등 결과를 고정.

**규모.** 0.5일.

## 2. PRD 커버리지 추적

**왜.** Tester는 그 루프의 acceptance gate와 preservation gate 위주로 본다. 보스 2페이즈, 스테이지 3 보스 강화, 무기 3단계의 시각 차이, 오디오 항목별 존재는 세 루프 동안 전용 claim이 한 번도 없었다. 그런데 원장이 비면 "완료"처럼 보이고, 다음 Planner는 PRD를 처음부터 다시 해석해야 한다. 논문 A.4의 `C_t = Claims(S, D_t)`는 스펙에서 파생한 고정 claim 집합이다.

**무엇을.** PRD의 수용 기준을 **고정 claim 목록**으로 만들고, 매 루프 각 claim의 상태(`verified | gap | untested`)와 마지막 검증 루프를 기록한다. Planner와 Tester 모두 이 목록을 받는다.

**어떻게.**
- 형식: `<workspace>/.hoh/claims.json` (또는 PRD 옆 `claims.yaml`). 항목: `id`, `criterion`(PRD 문장), `requires`(`["run"]`, `["screenshot"]` 등 필요한 증거 타입), `weight`(선택).
- 생성: `hoh init-claims --spec PRD.md`가 Planner 모델(또는 별도 모델)로 초안을 만들고 사용자가 편집. 실행 시작 시 없으면 자동 생성 후 커밋.
- Tester: `submit_evidence`에 `coverage: { claim_id: status }`를 추가하거나, 레코드의 `claim_id`가 목록의 id와 일치하면 자동 매핑. 목록에 없는 새 claim은 허용(자유 claim).
- 원장과 별개로 `coverage.json`을 갱신: claim별 `last_status`, `last_verified_loop`, `verified_count`.
- README와 `hoh status`에 커버리지 표(verified n / untested m / gap k) 표시.
- Planner 프롬프트에 "untested 또는 오래된(N루프 이상) claim" 섹션 추가(9번).

**검증.** 모의 하네스로 2루프 돌려 untested → verified 전이와 `hoh status` 출력 확인. 강등 규칙(1번)과 결합 테스트.

**규모.** 1일.

## 3. 증거 파일 보존

**왜.** Tester가 찍은 스크린샷과 playtest JSON이 전부 `/tmp`에 있어 실행이 끝나면 사라진다. evidence.json은 관찰 문장만 남는다. Fusepoint는 evidence packet 파일과 sha256으로 관찰을 후보에 묶는다.

**무엇을.** 루프별 증거 디렉토리를 만들고 도구 출력과 스크린샷을 거기에 남기며, 레코드가 그 파일을 경로와 해시로 인용하게 한다.

**어떻게.**
- 런타임이 `HOH_EVIDENCE_DIR=<workspace>/.hoh/iterations/loop-NN/evidence/` 를 체크와 Tester 셸에 export. 체크 결과의 stdout/stderr 전체도 이 디렉토리에 파일로 저장(현재는 tail 4000자만).
- Tester 프롬프트: 스크린샷과 실행 로그는 `$HOH_EVIDENCE_DIR`에 저장하고 `execution_records[].path`에 상대 경로로 인용하라고 지시.
- `normalizeEvidence`: `path`가 evidence 디렉토리 안의 실제 파일이면 `sha256`을 계산해 레코드에 추가. 파일이 없으면 `runtime_notes`에 경고.
- 이 디렉토리는 `.hoh` 아래라 tester 커밋에 포함된다. 용량 제한(예: 파일당 2MB, 루프당 30MB)을 두고 초과분은 목록만 남긴다.
- playtest 도구: `--shot`/`--shots` 기본 경로를 `$HOH_EVIDENCE_DIR`로.

**검증.** 모의 Tester가 evidence 디렉토리에 파일을 쓰고 인용하면 해시가 붙고 커밋되는 테스트. 없는 파일 인용 시 경고 테스트.

**규모.** 0.5일.

## 4. Tester 모델 분리와 사람 체크포인트

**왜.** 이번 실행은 같은 gpt-5.5가 만들고 같은 gpt-5.5가 판정했다. QA PASS가 자기참조적이다. 논문은 벤치마크 평가를 개발 루프 밖에 두었고, Fusepoint에서는 사람이 플레이했다.

**무엇을.** (a) Tester 모델을 다른 계열로 두는 것을 기본 권장으로 문서화하고 설정 예시를 제공. (b) N루프마다 사람 확인을 요구하는 체크포인트 기능.

**어떻게.**
- 설정: `models.tester`는 이미 있음. `hoh.config.json` 예시를 `developer: gpt-5.5`, `tester: glm-5.3` 식으로 바꾸고 README에 이유를 적는다.
- 체크포인트: `config.human_checkpoint: { every_loops: 3, timeout_min: 720 }`. 해당 루프 QA 후 런타임이 `.hoh/checkpoints/loop-NN.md`(플레이 방법, 확인할 claim 목록, 응답 양식)를 쓰고 대기. 사용자가 `hoh accept --loop N` 또는 `hoh reject --loop N --note "..."`로 응답하면 evidence에 `human_review` 레코드가 추가되고 원장에 반영된다. 타임아웃이면 기록만 남기고 진행.
- 독립 평가 옵션: `config.evaluator: { model: "...", every_loops: N }`으로 별도 세션이 read-only로 PRD 대비 점수(루브릭 JSON)를 매기되, 결과는 개발 루프에 **주지 않고** `.hoh/evaluations/`에만 남긴다(논문의 격리 원칙).

**검증.** 모의 하네스로 체크포인트 대기와 accept/reject 흐름 테스트. 평가자 결과가 다음 Planner 프롬프트에 포함되지 않는지 테스트.

**규모.** 0.5일(설정·문서) + 1일(체크포인트·평가자).

## 5. 저장소 정리

**왜.** hoh 런타임 변경분(22개 테스트 통과)이 아직 커밋되지 않았고, 실행 중 고친 내용이 README에 일부만 반영돼 있다.

**무엇을.**
- 초기 커밋과 이후 변경을 의미 단위로 커밋(런타임, 설정, 프로바이더, 실행 중 수정).
- `npm test`를 도는 CI(GitHub Actions) 추가. 가짜 OpenAI 서버 테스트는 네트워크 없이 돈다.
- README에 `worktree_setup`, `HOH_*` 환경변수, 재개 동작, 후보 식별 범위(`artifact_dir`), 런타임 소유 파일 커밋 규칙을 반영(일부 반영됨, 검토 필요).
- `examples/1945/`에 이번 PRD, 설정, tools를 키트로 복사(17번의 첫 항목).
- `~/Dev/hoh/sample_game/`은 사용자 파일이므로 `.gitignore`에 넣거나 examples로 옮길지 사용자가 결정.

**규모.** 0.5일.

## 6. Tester에 후보 diff 제공

**왜.** Tester는 Developer의 요약문만 받는다. 어디가 바뀌었는지 모르면 white-box 검사가 넓고 얕아진다.

**어떻게.** `renderTesterPrompts`에 `git diff --stat`과 상한(예: 400줄)까지의 `git diff base..candidate -- <artifact_dir>`를 넣는다. 초과 시 stat만 주고 "필요하면 `git diff` 직접 실행"을 안내. 큰 단일 파일은 hunk 헤더 위주로 요약.

**검증.** 프롬프트 스냅샷 테스트.

**규모.** 0.2일.

## 7. 장기 실행 운영

**왜.** 이번 실행에서 detach, pid 관리, 중단·재개, 로그 감시를 전부 수동으로 했다. Bash 도구의 10분 제한에 걸려 죽은 적도 있다. 논문의 배포는 며칠 단위다.

**무엇을.**
- `hoh run --detach`: `setsid`로 분리 실행, `.hoh/run.pid`와 `.hoh/run.log` 관리. `hoh stop`(SIGTERM 후 정리), `hoh logs -f`, `hoh status`에 현재 역할·경과 시간 표시.
- 정상 종료 처리: SIGTERM 수신 시 진행 중 역할을 abort하고 worktree를 정리한 뒤 종료(현재는 kill 시 worktree가 남을 수 있음).
- 예산 상한: `config.budget: { max_tokens_per_role, max_tokens_per_loop, max_tokens_per_run, max_cost_usd }`. 초과 시 해당 역할을 중단하고 error 대신 "budget_exhausted" 상태로 루프를 닫는다(Tester면 실패 evidence, Developer면 미커밋 변경을 되돌리고 후보 없음).
- 재시도: 프로바이더 전송 오류(5xx, 타임아웃, 연결 끊김)에서 역할 단위 재시도 N회, 지수 백오프. 논문 B.2는 전송 오류 시 시도를 교체한다. pi의 `auto_retry` 이벤트를 transcript에 남기고, 그 이상은 런타임이 재실행.
- 비용: 프로바이더 모델 설정에 `cost`(1M 토큰당 입력/출력/캐시 단가)를 넣으면 pi가 usage.cost를 채운다. 기본 설정 예시에 gpt-5.5 단가 자리 추가, README·status에 누적 비용 표시.
- 워치독: 역할 타임아웃 외에 "출력 없이 N분" 감지(transcript 마지막 이벤트 시각).

**검증.** detach/stop 통합 테스트(모의 하네스에 sleep 넣기), 예산 초과 시 상태 전이 테스트, 재시도 테스트(가짜 서버가 처음 두 번 503).

**규모.** 2일.

## 8. 원장 의미론 강화

**왜.** `full_prd_content_not_fully_validated`처럼 넓은 claim 하나가 여러 요구를 뭉뚱그려 열리고 닫혔다. 같은 id의 verified 레코드만 있으면 실행 증거 없이도 닫힌다.

**무엇을.**
- 닫힘 조건: 닫는 verified 레코드에 실행 계열 증거가 있어야 함(1번과 연동). 없으면 `fixed_pending_verify` 상태(Fusepoint의 상태)로 두고 다음 루프에 재검증 요구.
- 에스컬레이션: `consecutive_gap_loops >= 2`인 이슈는 Planner 프롬프트 상단에 "반드시 다룰 것"으로 승격. blocker는 1루프부터.
- 넓은 claim 억제: Tester 프롬프트에 "하나의 claim은 하나의 관찰 가능한 행동"을 명시하고, `claim` 문장이 여러 요구를 열거하면(예: 쉼표 3개 이상) 경고 노트.
- 회귀 검증: 회귀(regressed)가 실제로 잡히는 테스트를 실제 모델로 한 번 재현(의도적으로 PRD 요구를 되돌리는 Developer 스크립트를 모의로).

**규모.** 0.5일.

## 9. 프롬프트 개선

**왜.** 현재 프롬프트는 논문 A.2 템플릿을 옮긴 최소 버전이다. 실행에서 드러난 빈틈이 있다.

**무엇을.**
- Planner: 커버리지 표(2번)의 untested·오래된 claim 섹션, 에스컬레이션 이슈 섹션, 직전 Tester 리포트 전문 링크.
- Developer: 직전 루프 diff stat과 QA gap의 `recommended_update`를 문서 상단에, "자체 검증 결과는 주장일 뿐"을 재강조, 증거 디렉토리 사용법(3번).
- Tester: 증거 등급 규칙(1번), diff(6번), 증거 디렉토리(3번), "하나의 claim = 하나의 행동"(8번), 프로젝트별 검증 키트 사용법은 PRD의 "Verification tools" 절에서 자동 발췌.
- 프롬프트 스냅샷 테스트를 두어 변경이 의도적인지 확인.

**규모.** 0.5일.

## 10. 역할별 pi 확장·스킬 주입

**왜.** pi 어댑터가 `noExtensions`, `noSkills`로 프로젝트 자원을 전부 끈다. pi는 서브에이전트, 권한 게이트, 보호 경로, 샌드박스를 예제 확장으로 제공하고 MCP도 확장으로 붙이는 구조라, 이 통로가 없으면 아무것도 못 붙인다.

**어떻게.**
- 설정: `pi.extensions: string[]`, `pi.skills: string[]`, 역할별 override `pi.roles.<role>.{extensions,skills}`.
- 어댑터: `DefaultResourceLoader`에 `additionalExtensionPaths`, `additionalSkillPaths`를 넘긴다. `noExtensions: true`와 병행 시 additional 경로가 로드되는지 pi 소스로 확인하고, 아니면 `extensionsOverride`로 직접 주입.
- 안전: Planner와 Tester에 주입되는 확장이 쓰기 툴을 등록하면 allowlist가 막는지 테스트(툴 이름이 `tools` allowlist에 없으면 노출되지 않아야 함).
- 예시: pi 동봉 `subagent`, `protected-paths`를 Developer에만 붙이는 설정 예제.

**검증.** 가짜 서버 테스트에 확장 하나(커스텀 툴 등록)를 넣어 역할별로 툴 목록이 바뀌는지 확인.

**규모.** 1일.

## 11. Developer 토큰 절감

**왜.** 40KB 단일 파일을 매 턴 재전송해 루프당 캐시 읽기 1.2~2.0M. 게이트웨이가 캐시를 지원해 과금은 덜하지만 컨텍스트 창을 빠르게 채운다.

**무엇을.**
- Developer 프롬프트에 "큰 파일은 offset/limit으로 부분 읽기, grep으로 위치 찾기" 지침.
- pi compaction 설정을 역할별로 노출(`pi.roles.developer.compaction`), 긴 세션에서 자동 요약.
- 큰 파일 프로젝트에서는 PRD에 파일 분할을 허용하는 것도 선택지(이번 PRD는 단일 파일을 요구했음).
- 역할별 thinking level 설정(`:medium`)으로 Developer 출력 토큰 조정 실험.

**규모.** 0.5일.

## 12. MCP 브리지

**왜.** pi는 MCP를 내장하지 않는다. 브라우저 자동화, DB, 외부 API처럼 CLI로 감싸기 어려운 시스템을 다루는 프로젝트가 생기면 툴을 붙일 통로가 필요하다. 게임 엔진(Godot) 키트는 의도적으로 범위에서 뺀다. 웹 게임은 이번 키트로 충분하고, 엔진 프로젝트는 당장 계획이 없다.

**무엇을.** pi 확장 하나로 MCP 서버(stdio)에 연결해 그 툴들을 `pi.registerTool`로 등록한다. 역할별 노출은 기존 allowlist가 담당한다. 우선은 pi 철학대로 CLI 스크립트 + PRD의 "Verification tools" 절로 해결하고, 그것으로 안 되는 시스템이 실제로 나타났을 때만 만든다.

**규모.** 1일.

## 13. 컨테이너/샌드박스 실행

**왜.** 지금은 사용자 권한으로 bash가 그대로 돈다. 며칠 무인 실행이나 신뢰 못 하는 스펙에는 부적합하다. pi도 샌드박스를 제공하지 않는다.

**무엇을.** hoh 자체를 컨테이너 안에서 돌리는 것을 기본 운영 방식으로 문서화하고, 워크스페이스·`.env`·크롬 의존성을 담은 Dockerfile 예제를 제공. Docker 실행은 사용자가 명시적으로 결정할 사항이므로 런타임이 컨테이너를 자동 기동하지는 않는다.

**규모.** 1일.

## 14. 추가 하네스 어댑터

**왜.** 논문의 핵심 주장은 하네스 무관성이다. codex와 claude CLI가 이 머신에 있다. 어댑터가 있으면 같은 PRD로 하네스 비교가 가능하다.

**어떻게.** `Harness.invoke` 구현: CLI를 비대화 모드로 실행(`codex exec`, `claude -p`), 시스템 프롬프트와 사용자 프롬프트 전달, 툴 제한은 CLI 옵션으로 가능한 범위까지(불가능한 부분은 worktree 동결과 `.hoh` 가드가 담당), 구조화 출력은 툴 대신 최종 텍스트의 ```json 블록(`parseJsonBlock`이 이미 처리). usage는 CLI가 주는 범위에서.

**규모.** 어댑터당 1일.

## 15. 감사용 입력 해시와 receipt

**왜.** Fusepoint는 역할 입력 번들, 개발 문서, 후보 트리의 sha256을 receipt로 남겨 재현성과 감사를 보장한다. 지금은 후보 트리 해시만 있다.

**무엇을.** 각 역할 레코드에 `input_sha256`(system+user 프롬프트), `development_plan_sha256`, `spec_sha256`, `config_sha256`을 추가. evidence 레코드의 파일 인용에 해시(3번). `hoh verify --workspace`가 기록의 해시를 재계산해 불일치를 보고.

**규모.** 0.5일.

## 16. 대시보드와 기록 확장

**왜.** `.hoh/README.md`는 루프 표까지만 있다. 여러 실행을 비교하거나 추세를 보기 어렵다.

**무엇을.** 루프별 verified/gap/원장 추세, 역할별 토큰·시간·비용, 커버리지 표를 README에 추가. 정적 HTML 대시보드(`hoh report --html`)로 스크린샷 썸네일과 tester 리포트 링크. 여러 워크스페이스를 한 화면에 모으는 `hoh report --all`.

**규모.** 1일.

## 17. 프로젝트 유형별 키트 템플릿

**무엇을.** `examples/kits/<type>/`에 PRD 템플릿(Verification tools 절 포함), `hoh.config.json`, `tools/`, 체크 정의를 묶는다. 첫 항목은 이번 웹 게임 키트(playtest.mjs, syntax-check.mjs). 다음은 Node 라이브러리(테스트 스위트를 체크로), Python CLI(재구현 벤치마크용 diff 체크), 웹 앱(브라우저 E2E 체크). 게임 엔진 키트는 만들지 않는다.

**규모.** 키트당 0.5일.

## 18. 실험 프로토콜

**왜.** 논문의 비교(Vanilla 연속 실행 대 HoH, 하네스·모델 간 비교, ablation)를 재현할 수단이 없다.

**무엇을.**
- `hoh vanilla --passes N`: 같은 하네스로 계획·QA 없이 N번 연속 개발 패스를 도는 대조군.
- ablation 플래그: `--no-plan-update`(D_1 고정), `--no-evidence`(Planner에 E_{t-1} 미제공), `--no-warm-start`(매 루프 빈 워크스페이스).
- 고정 루브릭 평가(4번 평가자)로 점수화, 결과를 `experiments/` 표로.

**규모.** 1일.

---

## 논문 대비 아직 없는 것 (참고)

- 역할별 툴·스킬의 **점진적 노출**(progressive exposure): 지금은 툴 allowlist만 고정. 10번 이후.
- **phase 기반 quality plan**(Fusepoint의 criterion별 phase 체크): 2번 커버리지가 가벼운 버전.
- **에셋 파이프라인**과 라이선스 추적: 범위 밖.
- **벤치마크 어댑터**(GameCraft-Bench, FrontierSWE, ProgramBench): 18번 이후 필요 시.

## 권장 순서

1 → 2 → 3 → 5를 먼저 끝내고(약 2.5일), 4번의 설정 변경만으로 Tester 모델을 바꿔 1945 PRD를 다시 돌린다. 그 결과가 이번 PASS의 독립 검증이 된다. 그다음 7번(운영)과 10번(확장 주입)을 하면 며칠짜리 무인 실행 준비가 된다.
