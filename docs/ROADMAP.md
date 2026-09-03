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

현재 런타임은 세 역할의 분리 호출, 이전 후보 warm-start, QA용 동결 worktree, 구조화된 증거, 반복 원장, Git 이력, 재개를 이미 갖췄다. 즉 최소 HoH 루프는 작동한다. 다음 핵심 작업은 이미 끝난 기능을 다시 만드는 것이 아니라, **논문 모드의 고정 실행 계약을 명시적으로 강제하고 QA가 변경 후보를 더 정확히 검사하도록 만드는 것**이다.

## 우선순위 요약

| # | 항목 | 분류 | 상태 | 우선순위 | 예상 규모 | 의존 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 실행 증거 등급 강제 | Core | 완료 | 유지 | – | – |
| 2 | PRD 커버리지 카탈로그 | Extension | 완료 | 유지 | – | 1 |
| 3 | 증거 파일 보존과 해시 | Core | 완료 | 유지 | – | – |
| 4 | 논문 실행 계약 고정 | Core | 부분 완료 | P0 | 0.5일 | – |
| 5 | 저장소·CI·문서 기준선 | Ops | 완료 | 유지 | – | – |
| 6 | QA에 후보 diff 제공 | Core | 대기 | P1 | 0.25일 | – |
| 7 | 장기 실행 제어·예산·재시도 | Ops | 부분 완료 | P1 | 1.5~2일 | 4 |
| 8 | 원장 에스컬레이션 / 후보 복구 | Core / Draft | 부분 완료 | P1 | 0.5~1일 | 1, 2 |
| 9 | 점진적 컨텍스트 노출과 프롬프트 정리 | Core | 부분 완료 | P1 | 0.5~1일 | 2; QA diff 연결은 6 |
| 10 | 역할별 pi 확장·스킬 주입 | Full | 대기 | P1 | 1일 | 4 |
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

## 4. 논문 실행 계약 고정 — 다음 Core 작업

**문제.** 현재는 역할별 모델 override와 실행 중 설정 변경을 허용한다. 이는 제품 기능으로는 유용하지만, 논문의 고정 하네스-모델 구성과 고정 반복 예산 `T`를 재현한 실행인지 구별하기 어렵게 한다.

**구현.** 설정에 실행 프로토콜을 명시한다.

```json
{
  "protocol": "paper"
}
```

- `paper`: 세 역할의 base harness와 버전, provider/model ID, reasoning 설정은 같다. 역할별 prompt, 읽기·쓰기 권한, 도구·스킬 집합은 달라도 되지만 run 시작 시 고정된 role contract로 기록한다. 시작 시 정한 `T`와 이 계약은 실행 중 바꿀 수 없다.
- `extended`: 역할별 모델, 사람 체크포인트, 기타 운영 확장을 허용한다. 결과에는 반드시 non-paper run으로 표시한다.
- 실행 시작 시 harness/model/reasoning/role contract/tool policy/초기 `T`를 묶은 `protocol_sha256`을 기록한다.
- resume 시 현재 설정과 receipt가 다르면 중단한다. 반복 수 연장은 같은 실행의 수정이 아니라 새 run 또는 명시적 fork로 기록한다.
- QA의 독립성은 다른 모델이 아니라 새 세션, read-only 후보, 별도 QA worktree, 역할별 도구 제한으로 검사한다.
- 기존 config에 `protocol`이 없으면 현재 동작을 보존하기 위해 `extended`로 해석하고 manifest에 legacy default를 남긴다. 새 문서와 예시는 `paper`를 명시한다.

**수용 기준.** 같은 구성의 `paper` run은 정상 실행된다. 모델·도구·`T`를 바꾼 resume은 거부된다. `extended` run은 허용되지만 manifest와 report에 명확히 표시된다. `protocol` 없는 기존 config는 `extended`와 legacy marker로 재현되고, 새 예시는 `paper`를 명시한다.

## 5. 저장소·CI·문서 기준선 — 완료

런타임, PRD coverage, 재현 가능한 검증이 의미 단위 커밋으로 정리돼 있고 CI와 README, 예제가 현재 동작과 맞춰져 있다. 기준일 현재 `npm test` 결과는 48/48 통과다.

## 6. QA에 후보 diff 제공 — 다음 QA 정확도 작업

**문제.** QA는 Developer의 요약만으로 검사 범위를 추론한다. 후보의 실제 변경 지점을 모르면 white-box 검사가 넓고 얕아질 수 있다.

**구현.** QA 입력 번들에 다음을 추가한다.

- `git diff --stat <base>..<candidate> -- <artifact_dir>`
- 크기 상한까지의 diff hunk와 변경 파일 목록
- 상한을 넘으면 stat과 hunk header만 제공하고, QA가 read-only Git 명령으로 상세 diff를 열 수 있게 한다.
- runtime-owned 파일과 `.hoh` 기록은 제품 후보 diff에서 제외한다.

**수용 기준.** 프롬프트 스냅샷에서 base/candidate가 정확하고 artifact 경계 밖 파일이 섞이지 않는다. 대형 diff도 입력 예산 상한을 넘지 않는다.

## 7. 장기 실행 제어·예산·재시도 — 부분 완료

재개와 상태 기록은 있으나 장시간 무인 실행을 위한 lifecycle 제어가 부족하다. 이 항목은 논문 알고리즘의 필수 조건이 아니라 운영 안정성 작업이다.

남은 작업:

- `run --detach`, PID·로그 기록, `stop`, `logs -f`, 현재 역할·경과 시간 표시
- SIGTERM 시 진행 중 역할 종료와 임시 QA worktree 정리
- 역할·루프·run 단위 토큰/비용/시간 예산과 `budget_exhausted` 종료 상태
- transport timeout, 5xx, 연결 끊김에 한정한 역할 단위 재시도와 지수 backoff
- 출력 정지 watchdog과 재시도 이력 보존

모델이 낸 QA 실패나 개발 결과를 전송 오류처럼 자동 재시도하지 않는다. 사람 체크포인트는 `extended` 프로토콜에서만 선택적으로 제공한다.

`paper` run이 예산을 소진한 뒤 resume할 때는 기존 한도 안의 미완료 시도만 이어갈 수 있다. `T`, 토큰, 비용 한도를 늘리려면 원 run을 보존한 새 run/fork로 기록한다.

**수용 기준.** detach한 모의 run을 status/stop으로 제어할 수 있고, SIGTERM 뒤 고아 worktree가 남지 않는다. 가짜 provider의 일시적 503은 설정 횟수만큼 재시도하며, 예산 초과는 재개 가능한 명시적 상태로 끝난다.

## 8. 원장 에스컬레이션 / 후보 복구 — 부분 완료

실행 증거가 없는 claim은 닫히지 않고 원장 전이가 보존된다. coverage의 `verified | gap | untested`는 전체 PRD 관측 상태이고, ledger의 `open | closed | regressed`는 발견된 이슈의 수명주기다.

### 8A. 에스컬레이션 — Core

남은 작업:

- blocker는 다음 루프에서 즉시, 동일 gap이 2회 연속이면 상단 필수 항목으로 승격
- 하나의 claim이 여러 관찰 행동을 뭉뚱그리지 않도록 QA 지침과 경고 추가
- `open`, `closed`, `regressed`와 재개 후 상태 전이의 회귀 테스트 보강

### 8B. 후보 복구 — Draft, opt-in

사이트 초안의 `A_{\pi_t}` 후보 계보 선택은 별도 확장으로만 고려한다. 최신 후보가 host-latched, 즉 런타임의 결정적 build/launch gate에서 다음 base로 사용할 수 없다고 고정 판정된 경우에만 이전 정상 후보를 선택할 수 있다. 모델 QA의 단순 실패만으로 자동 rollback하지 않으며, 선택한 base, 차단 근거, 보존한 branch를 모두 기록한다. 기본값은 arXiv v1처럼 직전 후보 `A_{t-1}`이다.

## 9. 점진적 컨텍스트 노출과 프롬프트 정리 — 부분 완료

현재 역할 프롬프트에는 evidence와 coverage가 대부분 inline으로 들어간다. 작은 실행에는 단순하지만, 장기 실행에서는 컨텍스트가 누적되고 역할별 최소 정보 원칙이 약해진다.

남은 작업:

- 먼저 요약 index와 경로만 제공하고, 크기 임계값 이하에서만 전체 내용을 inline하는 progressive disclosure
- Planner: 열린 gap, 오래된 claim, 직전 QA 결론 중심
- Developer: 승인된 plan, 직전 gap의 권고, 이전 후보와 변경 경계 중심
- QA: 스펙, plan, 후보 diff, 검증 도구, evidence 제출 계약 중심
- 매 역할의 최종 system/user prompt snapshot과 입력 해시 보존
- 외부 evaluator 결과가 세 역할 입력에 섞이지 않는 부정 테스트

**수용 기준.** 작은 fixture의 동작은 유지하면서 큰 evidence/coverage fixture의 prompt 크기가 상한 안에 들어온다. 역할별로 금지된 정보가 노출되지 않는다.

## 10. 역할별 pi 확장·스킬 주입 — 대기

현재 pi 어댑터는 extensions와 skills를 끈 상태다. 논문의 역할별 하네스 구성 능력을 더 충실히 재현하려면 명시적 경로만 선택적으로 주입할 수 있어야 한다.

- 전역과 역할별 `extensions`, `skills` 설정
- 경로 allowlist와 실행 manifest 기록
- 확장이 등록한 도구에도 기존 역할별 tool allowlist 적용
- Planner와 QA에 쓰기 도구가 노출되지 않는 통합 테스트
- `paper` protocol에서도 역할별 도구·스킬은 허용하되, base harness/model/native capability는 같게 유지하고 각 역할의 집합과 버전을 run 시작 시 role contract로 고정

## 11. Developer 컨텍스트·토큰 절감 — 대기

- 큰 파일은 검색 후 부분 읽기를 우선하도록 지침 추가
- 역할별 compaction 설정과 사용량 기록 노출
- diff와 evidence의 inline 상한을 9번의 disclosure 정책과 공유
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

현재 candidate/spec/catalog/evidence 계열 해시가 일부 기록된다. 다음을 하나의 run receipt로 완성한다.

- 각 역할의 system+user 입력 해시
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

- **Core 완료**: 4, 6, 8A, 9가 자동 테스트와 함께 완료
- **논문 전체 시스템에 근접**: Core에 10, 15가 추가 완료
- **논문 실험 재현 가능**: 14의 최소 1개 대체 어댑터와 18이 완료되고 외부 평가 격리가 검증됨
- **운영 완성도 향상**: 실제 장기 실행 필요에 맞춰 7, 11, 16을 선택적으로 완료

## 권장 진행 순서

1. **4번**으로 paper/extended 실행을 구분하고 고정 계약을 잠근다.
2. 서로 독립적인 **6번 후보 diff**와 **8A 에스컬레이션**을 병렬로 진행한다.
3. **9번 progressive disclosure**를 적용한다. 기본 disclosure 작업은 6번과 병렬 착수할 수 있지만 QA diff 연결은 6번 계약이 끝난 뒤 합친다.
4. **10번**으로 역할별 하네스 자원을 안전하게 노출한다.
5. 실제 장기 run 전에 **7번**의 lifecycle·예산·재시도를 추가한다.
6. 초안식 **8B 후보 복구**는 실제 결정적 회귀가 관찰될 때만 별도 opt-in으로 검증한다.
7. 성능 비교가 필요해졌을 때만 **14번과 18번**을 묶어 실험한다.

12, 13, 16, 17은 구체적인 사용 사례가 생기기 전에는 확장하지 않는다.
