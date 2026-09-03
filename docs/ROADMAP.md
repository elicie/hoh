# HoH 개선 로드맵

기준 시점: 2026-09-03

이 문서는 현재 저장소의 구현 상태를 [arXiv:2609.01481v1](https://arxiv.org/abs/2609.01481v1)에 맞춰 다시 정리한 실행 로드맵이다. 프로젝트 사이트의 [Harness of Harness 초안 PDF](https://flesymeb.github.io/HarnessOfHarness/assets/paper/harness-of-harness.pdf)는 이전 설계 아이디어를 확인하는 보조 자료로만 사용한다. 공식 저장소의 구현은 아직 공개 예고 상태이므로, 이 프로젝트의 목표는 원본 코드와의 바이트 단위 호환이 아니라 논문에 기술된 동작 계약을 재현하는 것이다.

## 해석 원칙

1. **arXiv v1이 정본이다.** 두 문서가 다르면 arXiv v1의 알고리즘, 역할 계약, 실험 조건을 따른다.
2. **논문 핵심과 로컬 확장을 구분한다.** 논문 재현에 필요한 동작과 운영 편의 기능을 같은 요구사항처럼 쓰지 않는다.
3. **독립 QA는 다른 모델을 뜻하지 않는다.** 논문의 기본 실행은 같은 고정 하네스-모델 구성을 Planner, Developer, QA의 분리된 호출에 사용한다. 독립성은 역할별 컨텍스트·권한 분리, 후보 동결, 증거 기반 판정에서 나온다.
4. **`C_t = Claims(S, D_t)`는 루프별 claim 집합이다.** 고정 PRD claim 카탈로그는 누락 방지를 위한 유용한 로컬 확장이지만 논문 자체의 필수 조건은 아니다. 자유 claim을 계속 허용한다.
5. **외부 평가는 개발 루프와 격리한다.** 벤치마크 점수나 evaluator 결과가 다음 Planner, Developer, QA 입력으로 되돌아가면 실험 결과로 인정하지 않는다.

## 분류와 상태

분류:

- **Core**: arXiv v1의 HoH 실행 계약을 재현하는 데 필요
- **Full**: 논문 부록의 전체 시스템에 가까워지기 위한 기능
- **Experiment**: 논문의 비교 실험과 ablation을 재현하는 기능
- **Ops**: 장시간 실행을 안전하고 편하게 운영하기 위한 기능
- **Extension**: 논문 밖의 프로젝트 고유 기능
- **Draft**: 사이트 초안에만 있거나 arXiv v1과 다른 아이디어

상태:

- **완료**: 코드와 자동 검증이 모두 있음
- **부분 완료**: 핵심 경로는 있으나 명시된 수용 기준이 남음
- **대기**: 아직 구현하지 않음
- **필요 시**: 실제 사용 사례가 생길 때만 진행

우선순위는 P0가 다음 구현을 막는 계약, P1이 그 계약 직후의 Core·안정성 작업, P2가 실험·감사 완성도, P3가 실제 수요가 생길 때의 확장을 뜻한다.

## 현재 판단

현재 런타임은 세 역할의 분리 호출, 이전 후보 warm-start, QA용 동결 worktree, 실제 후보 diff, 구조화된 증거, 반복 gap 에스컬레이션, 점진적 역할 컨텍스트, 역할별 pi 자원, Git 이력, 재개와 논문 실행 계약 고정을 갖췄다. 명시한 Core 계약과 10번은 완료됐다. 다음 작업은 장기 실행 중 안전한 정지를 먼저 보장하는 **7번 lifecycle·취소 계약**이다.

## 우선순위 요약

| # | 항목 | 분류 | 상태 | 우선순위 | 예상 규모 | 의존 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 실행 증거 등급 강제 | Core | 완료 | 유지 | – | – |
| 2 | PRD 커버리지 카탈로그 | Extension | 완료 | 유지 | – | 1 |
| 3 | 증거 파일 보존과 해시 | Core | 완료 | 유지 | – | – |
| 4 | 논문 실행 계약 고정 | Core | 완료 | 유지 | – | – |
| 5 | 저장소·CI·문서 기준선 | Ops | 완료 | 유지 | – | – |
| 6 | QA에 후보 diff 제공 | Core | 완료 | 유지 | – | – |
| 7 | 장기 실행 제어·예산·재시도 | Ops | 부분 완료 | P1 | 1.5~2일 | 4 |
| 8 | 원장 에스컬레이션 / 후보 복구 | Core / Draft | 8A 완료 / 8B 필요 시 | 유지 | – | 1, 2 |
| 9 | 점진적 컨텍스트 노출과 프롬프트 정리 | Core | 완료 | 유지 | – | 2, 6 |
| 10 | 역할별 pi 확장·스킬 주입 | Full | 완료 | 유지 | – | 4 |
| 11 | Developer 컨텍스트·토큰 절감 | Ops | 대기 | P2 | 0.5일 | 9 |
| 12 | MCP 브리지 | Extension | 필요 시 | P3 | 1일 | 10 |
| 13 | 샌드박스 실행 가이드 | Ops | 필요 시 | P3 | 1일 | 7 |
| 14 | 추가 하네스 어댑터 | Experiment | 대기 | P2 | 1일/개 | 4 |
| 15 | 입력 receipt와 무결성 검증 | Full | 부분 완료 | P2 | 0.5일 | 3, 4 |
| 16 | 실행 리포트 확장 | Ops | 부분 완료 | P2 | 1일 | 3, 15 |
| 17 | 프로젝트 유형별 검증 키트 | Extension | 부분 완료 | P3 | 0.5일/개 | – |
| 18 | 대조군·ablation·외부 평가 프로토콜 | Experiment | 대기 | P2 | 1~2일 | 4, 14, 15 |

---

## 1. 실행 증거 등급 강제 — 완료

논문의 증거 기반 QA 계약에 맞춰, `verified` claim은 실행 계열 증거가 있어야 한다. 소스·설정·manifest만 인용한 레코드는 `insufficient_evidence` gap으로 강등하고 QA 상태를 다시 계산한다. 시각 claim의 screenshot 요구, 파일 존재와 해시 검증, 관련 회귀 테스트도 구현돼 있다.

유지 조건:

- 실행 계열과 정적 계열 증거 타입의 구분을 깨지 않는다.
- 새 evidence 타입을 추가할 때 어떤 계열인지 명시하고 테스트한다.
- source-only 판정이 다시 `verified`를 만들지 못하도록 회귀 테스트를 유지한다.

## 2. PRD 커버리지 카탈로그 — 완료된 로컬 확장

고정 `claims.json`과 누적 `coverage.json`은 긴 실행에서 스펙 누락을 방지한다. Planner와 QA는 미검증·오래된 claim을 볼 수 있고, 상태는 `verified | gap | untested`로 추적된다.

논문과의 경계:

- 논문의 `C_t`를 전역 고정 집합으로 해석하지 않는다.
- 카탈로그 밖의 자유 claim을 허용해 `Claims(S, D_t)`의 루프별 발견을 보존한다.
- 카탈로그는 편의 기능이며, 없다고 해서 Core 실행을 막지 않는다.

## 3. 증거 파일 보존과 해시 — 완료

루프별 `evidence/` 디렉터리, `HOH_EVIDENCE_DIR`, 검사 stdout/stderr 보존, 파일 크기 제한, 상대 경로와 SHA-256 기록이 구현돼 있다. 증거는 임시 디렉터리가 아니라 후보 이력과 함께 보존된다.

유지 조건:

- evidence 경로 탈출과 없는 파일 인용을 거부하거나 명시적으로 경고한다.
- 파일 해시와 evidence record의 연결을 보존한다.
- 대용량 증거가 저장소를 무제한 키우지 않도록 현재 상한을 유지한다.

## 4. 논문 실행 계약 고정 — 완료

`paper`와 `extended` protocol이 설정과 run record에 구현돼 있다. `paper`는 동일한 resolved model/reasoning, harness와 adapter version, 초기 `T`, 전체 config, 역할별 prompt·도구·workspace 계약을 canonical SHA-256 receipt로 고정한다. resume 시 저장 receipt 자체의 해시를 먼저 검산하고 현재 계약을 다시 계산하며, 어느 쪽이든 다르면 config와 run record를 갱신하기 전에 중단한다.

설정에 실행 프로토콜을 명시한다.

```json
{
  "protocol": "paper"
}
```

- `paper`: 세 역할의 base harness와 버전, resolved provider/model ID, reasoning 설정은 같다. 역할별 prompt, 읽기·쓰기 권한, 도구·스킬 집합은 달라도 되지만 run 시작 시 고정된 role contract로 기록한다. 시작 시 정한 `T`와 이 계약은 실행 중 바꿀 수 없다.
- `extended`: 역할별 모델과 현재·향후 운영 확장을 허용하는 non-paper run으로 표시한다.
- 실행 시작 시 harness/model/reasoning/role contract/tool policy/초기 `T`를 묶은 `protocol_sha256`을 기록한다.
- resume 시 현재 설정과 receipt가 다르면 중단한다. 반복 수 연장은 같은 실행을 수정하지 않고 다른 workspace의 새 run으로 시작한다.
- 실제 역할 호출이 receipt의 resolved model identity와 다른 모델을 보고하면 해당 실행을 실패시킨다.
- QA의 독립성은 다른 모델이 아니라 새 세션, read-only 후보, 별도 QA worktree, 역할별 도구 제한으로 검사한다.
- 기존 config에 `protocol`이 없으면 현재 동작을 보존하기 위해 `extended`로 해석하고 manifest에 legacy default를 남긴다. 이때 사후 생성한 receipt는 `legacy_reconstruction`으로 표시해 과거 시작 조건의 증명처럼 취급하지 않는다. 새 config 예시는 목적에 맞는 protocol을 반드시 명시한다.

자동 테스트는 동일한 `paper` resume, configured/resolved 모델·runtime policy·`T`·harness version 변경 거부, 저장 receipt 변조 감지, 거부 시 config/run record 불변, legacy `extended` 이관을 검증한다. status와 생성 report는 protocol 종류, legacy/origin marker, receipt hash를 표시한다.

## 5. 저장소·CI·문서 기준선 — 완료

런타임, PRD coverage, 재현 가능한 검증이 의미 단위 커밋으로 정리돼 있고 CI와 README, 예제가 현재 동작과 맞춰져 있다. 기준일 현재 `npm test` 결과는 75/75 통과다.

## 6. QA에 후보 diff 제공 — 완료

Developer 전후의 전체 Git SHA를 candidate record에 고정하고, QA worktree와 diff가 이 endpoint를 함께 사용한다. 따라서 Tester 실패 뒤 runtime error commit이 추가된 resume에서도 동일한 후보를 다시 검사한다.

- QA 입력에는 `artifact_dir`로 제한한 diff stat, 변경 파일 목록, patch와 정확한 read-only Git 명령이 들어간다.
- 루트 artifact에서도 `.hoh`를 literal exclude하고 rename detection을 꺼서 경계 밖 경로가 rename source로 새지 않게 한다.
- 전체 inline block은 UTF-8 32 KiB로 제한한다. 초과 시 변경 본문은 버리고 bounded stat·파일 목록·파일 metadata·hunk header만 제공한다.
- 기존 `DeveloperRecord.changed_paths`는 Developer의 전체 non-runtime 변경 감사 기록으로 유지하고, 제품 후보 diff와 섞지 않는다.
- traversal이나 runtime-owned `.hoh`를 가리키는 `artifact_dir` 설정은 거부한다.

자동 테스트는 정확한 base/candidate SHA, artifact 경계 밖 파일과 `.hoh` 제외, 대형 diff 본문 제거와 byte 상한, runtime-only HEAD가 전진한 뒤의 QA resume을 검증한다.

## 7. 장기 실행 제어·예산·재시도 — 부분 완료

재개와 상태 기록은 있으나 장시간 무인 실행을 위한 lifecycle 제어가 부족하다. 이 항목은 논문 알고리즘의 필수 조건이 아니라 운영 안정성 작업이다.

완료된 기반:

- `runHoh`의 `AbortSignal`을 loop-0 claim 작성, 모든 역할 호출, setup과 deterministic check까지 전달한다.
- 외부 취소 시 pi session을 abort하고 check의 전체 process group을 종료한다.
- Tester 취소를 QA 실패나 runtime error로 기록하지 않으며 임시 QA worktree와 환경 경계를 정리한다.
- pi의 ambient 설정보다 우선하는 provider request, stream idle, WebSocket connect timeout과 transient retry 횟수·지수 backoff를 run config에 고정한다. provider SDK 자체 retry는 0으로 두어 같은 pi session이 timeout·5xx·연결 끊김만 분류하고 이어간다.
- `auto_retry_start`·`auto_retry_end` 전체 이력은 역할 transcript에, retry 횟수와 경과 시간은 역할 record와 Markdown report에 보존한다.

남은 작업:

- `run --detach`, PID·로그 기록, `stop`, `logs -f`, 현재 역할·경과 시간 표시
- CLI SIGTERM·stop 요청을 위 취소 계약에 연결
- 역할·루프·run 단위 토큰/비용/시간 예산과 `budget_exhausted` 종료 상태

모델이 낸 QA 실패나 개발 결과를 전송 오류처럼 자동 재시도하지 않는다. 사람 체크포인트는 `extended` 프로토콜에서만 선택적으로 제공한다.

`paper` run이 예산을 소진한 뒤 resume할 때는 기존 한도 안의 미완료 시도만 이어갈 수 있다. `T`, 토큰, 비용 한도를 늘리려면 원 run을 보존한 새 run/fork로 기록한다.

**수용 기준.** detach한 모의 run을 status/stop으로 제어할 수 있고, SIGTERM 뒤 고아 worktree가 남지 않는다. 가짜 provider의 일시적 503은 설정 횟수만큼 재시도하며, 예산 초과는 재개 가능한 명시적 상태로 끝난다.

## 8. 원장 에스컬레이션 / 후보 복구 — 부분 완료

실행 증거가 없는 claim은 닫히지 않고 원장 전이가 보존된다. coverage의 `verified | gap | untested`는 전체 PRD 관측 상태이고, ledger의 `open | closed | regressed`는 발견된 이슈의 수명주기다.

### 8A. 에스컬레이션 — Core 완료

동일 gap의 identity는 trim한 뒤 대소문자를 구분하는 exact `claim_id`다. claim 문구가 바뀌어도 id가 같으면 같은 issue이고, 문구가 같아도 id가 다르면 별개다.

- 한 evidence bundle의 중복 id는 한 번만 계산하고 가장 강한 gap severity를 보존하며, gap과 verified가 충돌하면 gap이 이긴다.
- streak는 바로 이전 완료 루프에서도 같은 gap이 관찰됐을 때만 증가한다. 같은 루프 replay는 멱등이고, gap이 빠진 루프는 streak를 즉시 0으로 되돌린다.
- blocker와 2회 연속 gap은 다음 Planner 입력과 Development Document의 최상단 필수 이슈로 승격한다.
- QA system prompt와 evidence schema는 서로 독립적으로 pass/fail할 수 있는 행동을 하나의 claim으로 묶지 말고 분리하도록 경고한다.
- `open → closed → regressed`, duplicate, replay, skipped loop, severity와 stable ordering을 자동 테스트한다.

### 8B. 후보 복구 — Draft, opt-in

사이트 초안의 `A_{\pi_t}` 후보 계보 선택은 별도 확장으로만 고려한다. 최신 후보가 host-latched, 즉 런타임의 결정적 build/launch gate에서 다음 base로 사용할 수 없다고 고정 판정된 경우에만 이전 정상 후보를 선택할 수 있다. 모델 QA의 단순 실패만으로 자동 rollback하지 않으며, 선택한 base, 차단 근거, 보존한 branch를 모두 기록한다. 기본값은 arXiv v1처럼 직전 후보 `A_{t-1}`이다.

## 9. 점진적 컨텍스트 노출과 프롬프트 정리 — 완료

기존 `.hoh` 기록을 정본으로 유지하면서 `1..T`의 세 역할 입력을 path-first progressive disclosure로 바꿨다. 각 context block은 canonical path, exact view의 SHA-256, UTF-8 크기와 최대 4 KiB index를 먼저 제공한다. exact view는 8 KiB 이하에서만 inline하며, 실제 retry notice까지 포함한 최종 role system+user 입력은 합계 96 KiB를 넘기지 못한다. 이 수치는 논문이 정한 값이 아니라 재현 가능한 로컬 runtime policy다. PRD coverage를 만드는 선택적 loop-0 Planner 호출은 기존 `claims-transcript.jsonl` 계약을 유지한다.

- Planner는 스펙, 직전 QA 결론·evidence, mandatory 우선 open ledger, `gap → never-tested → stale → recent` coverage index와 직전 check를 받는다.
- Developer는 스펙, 승인된 development document, 이전 후보와 변경 경계만 받는다. base check는 development document 안의 단일 사본으로 전달한다.
- QA는 스펙, development document, 6번의 후보 diff, 현재 deterministic check와 coverage를 받는다. 편향 가능한 Developer summary와 development document에 이미 반영된 standalone ledger는 중복 전달하지 않는다.
- inline이 생략됐거나 index가 불충분하면 역할이 명시된 정본 파일을 읽도록 system contract가 요구한다.
- 각 역할에 실제로 전달된 마지막 system/user prompt와 개별·결합 SHA-256을 `prompts/<role>.json`에 보존한다. structured-output retry의 runtime notice도 포함한다.
- 큰 다국어 fixture의 byte 상한, omitted-body sentinel, 역할별 금지 입력, retry snapshot, mid-loop resume, 후보 commit에서 runtime snapshot 제외, 하네스 프로세스 내부 transcript buffering을 자동 테스트한다.
- 이전 record에 임의 `external_evaluator` metadata를 넣어도 다음 세 역할의 렌더링 prompt와 snapshot에는 섞이지 않는 부정 테스트가 있다. evaluator 파일·프로세스 자체를 workspace 밖에 두는 완전한 실험 격리는 18번 범위다.

## 10. 역할별 pi 확장·스킬 주입 — 완료

pi의 ambient extensions와 skills는 계속 끈 채, 설정에 명시한 workspace 내부 경로만 전역 또는 역할별로 주입한다. 파일과 디렉터리의 realpath·내용 SHA-256·역할별 extension tool allowlist는 `.hoh/pi-resources.json`과 protocol role contract에 기록된다. 각 역할 호출 직전과 로드 직후에 동일 자원을 재검산한다.

유지 조건:

- configured path가 workspace 밖이나 `.hoh`로 resolve되는 경우, directory 내부 symbolic link, hashed directory 밖을 가리키거나 advanced glob으로 경계를 우회할 수 있는 package entrypoint를 거부한다.
- 확장 로드 오류, 유효한 항목을 만들지 못한 extension·skill, skill 진단, 모든 pi built-in(`powershell` 포함)·`submit_*` 도구 충돌, 등록되지 않은 allowlist 도구를 역할 실행 전에 실패시킨다.
- Planner와 QA에는 Developer 전용 확장 쓰기 도구·스킬이 노출되지 않는 실제 pi SDK 통합 테스트를 유지한다.
- `paper` resume은 역할별 경로·내용·도구 집합이 달라지면 기존 manifest를 덮어쓰기 전에 거부한다.
- resource 필드가 없던 legacy `paper` receipt는 현재 manifest가 비어 있을 때만 호환한다. 과거에 무시되던 설정이 새 capability로 활성화되면 새 run을 요구한다.
- tool allowlist는 모델 호출 권한 경계이지 확장 코드 sandbox가 아니다. 확장은 검토된 신뢰 코드로만 취급한다.

## 11. Developer 컨텍스트·토큰 절감 — 부분 완료

완료된 기반:

- Developer는 큰 파일을 통째로 읽기 전에 `grep`·`find`로 대상 경로와 symbol을 찾고 bounded partial read를 우선한다.
- context exact view, index, candidate diff, 전체 role prompt의 UTF-8 byte 상한을 하나의 runtime policy로 공유한다. 기존 import 경로는 호환을 유지한다.
- 경계값의 inclusive 동작과 Developer가 spec, 승인된 development document, 실제 mandatory blocker를 계속 받는지를 자동 테스트한다.

남은 작업:

- 역할별 compaction 설정과 사용량 기록 노출
- 최적화 전후의 prompt 크기와 토큰 사용량을 fixture로 비교

비용 절감 때문에 Developer가 스펙, 승인 plan, 열린 blocker를 보지 못하게 해서는 안 된다.

## 12. MCP 브리지 — 실제 요구가 생길 때만

CLI나 프로젝트 도구로 표현할 수 없는 브라우저, DB, 외부 서비스가 실제 검증 요구로 등장할 때 pi extension을 통해 MCP 도구를 등록한다. 지금은 추상 브리지를 먼저 만들지 않는다. 역할별 allowlist, 자격 증명 경계, transcript 기록이 설계 전제다.

## 13. 샌드박스 실행 가이드 — 실제 운영 요구가 생길 때만

장시간 또는 신뢰할 수 없는 입력을 실행할 때 필요한 격리 경계, workspace mount, secret 전달, 브라우저 의존성, 네트워크 정책을 문서화한다. Docker나 인프라 변경은 사용자의 해당 작업에 대한 명시적 승인과 프로젝트 인프라 지침 확인 없이는 실행하지 않는다.

## 14. 추가 하네스 어댑터 — 실험 준비

논문의 하네스 비교를 재현하려면 우선 Codex와 OpenCode 계열 어댑터를 대상으로 한다. Claude 등 논문 표에 없는 조합은 확장 실험으로 분리한다.

공통 계약:

- 동일한 spec, `T`, 모델 조건, 역할 입력과 출력 schema
- 비대화형 실행과 구조화 출력 복구
- 역할별 도구 권한과 QA 후보 동결
- usage, transcript, 실패 사유를 공통 receipt로 변환

어댑터 수를 늘리기 전에 하나의 대체 하네스로 end-to-end 실험 manifest가 재현되는지 먼저 검증한다.

## 15. 입력 receipt와 무결성 검증 — 부분 완료

현재 candidate/spec/catalog/evidence 계열 해시, protocol/config/role-contract receipt, 역할별 최종 prompt snapshot과 입력 해시가 기록되고, protocol receipt는 resume 시 자체 해시를 검산한다. 다음을 하나의 run receipt와 독립 검증 명령으로 완성한다.

- 역할별 prompt snapshot hash를 candidate·plan·evidence와 연결한 receipt
- spec, development plan, config, protocol, candidate tree 해시
- 역할별 resolved harness/model/reasoning/tool policy
- evidence 파일 해시와 claim 연결
- `hoh verify --workspace`의 불일치 보고
- exact prompt는 메모리에서 해시하고, 저장 snapshot에는 credential·secret redaction을 적용해 redaction 여부를 기록

receipt는 비밀 값 자체를 저장하지 않고, 재현에 필요한 공개 설정과 해시만 보존한다.

## 16. 실행 리포트 확장 — 부분 완료

현재 루프 상태와 기본 기록 위에 다음 추세를 추가한다.

- 루프별 verified/gap/untested와 원장 전이
- 역할별 시간·토큰·비용·재시도
- protocol 종류와 receipt 검증 상태
- evidence와 QA report의 상대 링크

정적 HTML은 실제로 여러 run을 비교할 필요가 생긴 뒤 추가한다. JSON run record, ledger, coverage를 정본으로 두고 CLI와 Markdown report는 여기서 생성되는 view로 유지한다.

## 17. 프로젝트 유형별 검증 키트 — 부분 완료된 확장

`examples/1945` 웹 게임 예제가 첫 검증 키트 역할을 한다. 다음 키트는 실제 프로젝트가 생길 때 `PRD + config + tools + checks`의 최소 묶음으로 추가한다. Node, Python, 웹 앱용 범용 플랫폼을 미리 만들지 않는다. 각 키트는 프로젝트 고유 도구가 저장소 밖 경로나 임시 상태에 의존하지 않는지 검증한다.

## 18. 대조군·ablation·외부 평가 프로토콜 — 대기

논문과 같은 성능 주장을 하려면 런타임 기능보다 먼저 실험 격리를 보장해야 한다.

필요 항목:

- 동일 하네스·모델·스펙·예산의 Vanilla 연속 개발 대조군
- `no-plan-update`, `no-evidence`, `no-warm-start` ablation
- artifact 생성 전에 버전이 고정된 공식 benchmark evaluator 또는 독립 human rubric
- scorer를 세 역할과 별도 프로세스로 실행하고, evaluator 입력에서 run label과 개발 중간 점수를 가리는 격리
- seed, protocol receipt, 실패·재시도, 유효/무효 run 판정이 포함된 experiment manifest
- 실행 전에 표본, 반복 횟수, 집계 방식, 불확실성 보고법을 고정한 분석 계획
- 원시 결과와 집계 스크립트 보존

외부 ground truth가 없는 자체 QA PASS를 벤치마크 점수로 사용하지 않는다. 이 프로토콜과 evaluator 독립성이 완성되기 전에는 논문 대비 성능 향상 수치를 주장하지 않는다.

---

## 완료 판정 기준

- **Core 완료**: 4, 6, 8A, 9가 자동 테스트와 함께 완료됨
- **논문 전체 시스템에 근접**: Core에 10, 15가 추가 완료
- **논문 실험 재현 가능**: 14의 최소 1개 대체 어댑터와 18이 완료되고 외부 평가 격리가 검증됨
- **운영 완성도 향상**: 실제 장기 실행 필요에 맞춰 7, 11, 16을 선택적으로 완료

## 권장 진행 순서

1. 완료된 **10번**의 역할별 하네스 자원 계약을 유지한다.
2. 다음으로 **7번**의 lifecycle·취소를 먼저 만들고 예산·재시도를 이어서 추가한다.
3. 초안식 **8B 후보 복구**는 실제 결정적 회귀가 관찰될 때만 별도 opt-in으로 검증한다.
4. 성능 비교가 필요해졌을 때만 **14번과 18번**을 묶어 실험한다.

12, 13, 16, 17은 구체적인 사용 사례가 생기기 전에는 확장하지 않는다.
