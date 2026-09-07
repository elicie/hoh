# hoh — Harness-of-Harness 런타임

[English](README.md) | **한국어**

*Harness of Harness: Multi-Day Autonomous Software Development with Continual Improvement*
(arXiv 2609.01481) 논문의 Harness-of-Harness(HoH) 루프 구현입니다.
HoH는 코딩 에이전트를 감싸 실행을 관리합니다. 각 반복에서 동일한 하네스를
역할별 프롬프트와 권한으로 세 번 호출하고, 결과물과 QA 증거를 다음 반복에 전달합니다.

```
E_0 = ∅
for t = 1..T:
  D_t = Planner(S, E_{t-1}; read_only(A_{t-1}))       # 개발 문서
  A_t = Developer(A_{t-1}; S, D_t)                    # 유일한 작성 역할
  E_t = Tester(read_only(A_t); S, D_t, Runtime.check(A_t))   # 증거 묶음
```

기본 내부 하네스는 SDK를 통해 사용하는 [pi coding agent](https://github.com/earendil-works/pi)이며,
논문에서 평가한 하네스 중 하나입니다. `extended` 실행에는 Codex CLI 어댑터도 사용할 수 있습니다.
이 저장소의 런타임은 논문에서 말하는 결정적 런타임(deterministic Runtime)에 해당합니다.
역할별 입력을 고정하고, 권한을 적용하고, 증거를 정확한 후보 버전에 연결하며, 모든 루프를 Git에 기록합니다.

## 어디에 활용할 수 있나요?

작성된 명세를 반복 실행하고 기록을 검토할 수 있는 개발 루프로 바꿉니다.
제품을 처음부터 끝까지 만드는 것 외에도 여러 작업에 활용할 수 있습니다.

**기존 결과물을 명세에 맞게 개선하기.** 이미 있는 코드를 작업 공간으로 지정하고,
충족해야 할 제품 요구사항 문서(PRD)를 작성하면 루프가 차이를 줄여 나갑니다.
실제 실행 사례에서는 약 1,000줄의 단일 파일 브라우저 게임을 세 루프 동안 개선했습니다.
적 종류가 네 가지에서 다섯 가지로 늘었고, 점수 메달, 폭탄 수 제한, ALL CLEAR 엔딩,
편대 보너스, 스테이지별 음악이 추가되었습니다. 네 개의 스모크 검사는 계속 통과했고,
이슈 원장의 네 이슈가 모두 닫혔습니다. 시작 결과물은 `loop-00-<hash>` 후보로 식별하며,
이를 이어서 개발하는 웜 스타트(warm start)를 사용합니다.

**빈 작업 공간에서 만들기.** 시작 결과물이 없으면 첫 번째 루프에서 프로젝트를 만듭니다.
각 루프는 고정된 후보 버전, 결정적 검사, 해당 트리에 판정이 연결되는 별도 QA 단계로 끝납니다.

**코드가 실제로 무엇을 입증하는지 확인하기.** 인수 조건을 작성하고 `init-claims`로
검증 항목(claim) 카탈로그를 고정한 다음 루프를 한 번 실행합니다.
증거 묶음과 커버리지 맵은 실행 증거로 뒷받침되는 조건과 단순 주장에 머무는 조건을 구분합니다.
소스만 읽은 검증은 자동으로 하향 처리하므로, “함수가 있다”는 사실만으로 “동작한다”고 인정하지 않습니다.
루프에는 항상 Developer 단계가 포함되어 계획에 따라 코드를 변경하므로, 읽기 전용 감사가 필요하다면
용도가 다릅니다. 별도 브랜치에서 실행하세요.

**같은 작업에서 모델 비교하기.** `models.planner` / `developer` / `tester`를 바꾸고
같은 PRD를 새로운 작업 공간에서 실행합니다. 예산 원장은 역할별 토큰, 비용, 경과 시간을 기록하고,
이슈 원장은 열린 이슈와 닫힌 이슈를 기록하므로 이슈 하나를 해결하는 데 드는 비용을 추적할 수 있습니다.
다른 Tester 모델은 다른 관점을 제공할 수 있습니다. 독립적인 성능 평가에는 별도 벤치마크나 사람의 평가 기준이 필요합니다.

**다른 하네스 사용하기.** 공통 역할 인터페이스로 pi SDK와 Codex CLI를 구동합니다.
현재 Codex는 `extended` 실행을 지원합니다. CLI가 실제 실행 모델을 보고하지 않으므로
엄격한 `paper` 모델 검증을 충족하거나 봉인된 논문 실험에 참여할 수 없습니다.
새 어댑터는 `Harness`를 구현하면 됩니다.

**논문의 구성 요소 제거 실험(ablation) 실행하기.** 실험 하네스는 `hoh`, `vanilla`,
`no-plan-update`, `no-evidence`, `no-warm-start`의 다섯 조건을 담은 계획을 봉인합니다.
해시로 고정한 초기 결과물 A0를 매번 새로 복사해 실행하고, 정확한 후보 트리를 보관한 뒤,
개발 프롬프트를 보지 못하는 블라인드 평가기로 점수를 매깁니다.
루프, 계획 갱신, 증거 피드백, 웜 스타트 중 어떤 요소가 효과를 내는지 조사하기 위한 장치입니다.

**다른 사람이 확인할 수 있는 실행 기록 만들기.** `protocol: "paper"`에서는 하네스 버전,
하나로 확정된 모델 식별자, 역할 프롬프트·도구 계약, 런타임 정책, 반복 예산을 실행 시작 시
검증 기록(receipt)에 고정합니다. `hoh verify`는 설정, 인증 정보, 네트워크 없이
로컬 파일과 Git 객체만으로 전체 실행 상태를 다시 검사합니다. Git 이력, 증거 파일,
민감 정보를 가린 프롬프트 스냅샷으로 실행 과정을 사후에 살펴볼 수 있습니다.

**명세 충족 상태를 지속적으로 유지하기.** 닫힌 이슈에서 다시 발견된 결함은 회귀로 기록되고
필수 작업으로 승격됩니다. 주기적으로 실행을 재개하면 명세 준수 상태를 유지하는 데 활용할 수 있습니다.

### 적합하지 않은 경우

원문에 제시된 약 1,000줄 결과물의 실행 사례에서는 루프당 약 25만 입력 토큰과
20분의 역할 실행 시간이 들었습니다. 파일 하나의 작은 수정은 직접 처리하는 편이 저렴할 수 있습니다.
또한 인수 조건을 무언가 실행해서 확인할 수 있어야 합니다. 결정적 검사와 관찰 가능한 동작이 없으면
QA는 소스 읽기에 그치며, 런타임은 이를 검증 완료로 인정하지 않습니다.
역할은 사용자 프로세스의 권한과 셸 접근 권한으로 실행되므로, 신뢰할 수 없는 명세나 도구에는 격리가 필요합니다.
작업 방향은 PRD, 설정, 이슈 원장으로 조절합니다. `extended`에서는 선택적 체크포인트를 통해
Developer가 시작하기 전에 각 개발 계획을 승인할 수 있습니다.

## 빠른 시작

Node.js 22.19 이상과 Git이 필요합니다. 모델은 실제 모델 실행에만 필요하며,
아래 모의 실행에는 필요하지 않습니다.

```bash
npm install
npm run build
```

명령 형식은 `node dist/cli.js <command>`입니다. `npm link`를 실행하면 같은 진입점을
PATH에서 `hoh`로 사용할 수 있습니다.

### 1. 모델 없이 모의 실행

`mock` 하네스는 스크립트로 작성된 Planner, Developer, Tester를 재생합니다.
모델 토큰을 사용하기 전에 두 루프의 전체 기록을 확인할 수 있습니다.

```bash
node dist/cli.js run    --workspace /tmp/hoh-demo --spec examples/demo-PRD.md --config examples/mock.config.json
node dist/cli.js status --workspace /tmp/hoh-demo
```

`status`는 실행 수명 주기, 프로토콜 및 실행 검증 기록, 이슈 원장, PRD 커버리지,
루프별 요약을 출력합니다.

```
Run 20260906-cbc90a — protocol PAPER, harness mock, budget 2 loops
Run receipt: VERIFIED 68a18aa26998708d9547745888228bbef803cc81f73baef18973984bb5717b05
Ledger: open 0, regressed 0, closed 1, all 1
Coverage: verified 3, untested 0, gap 0, all 3

Loop  Candidate            QA        Verified/Gaps  Objective
   1  loop-01-ba29bc99ea4c FAIL      2/1            Bootstrap a launchable artifact …
   2  loop-02-dc68b032ff02 PASS      3/0            Repair the missing result state …
```

전체 개발 기록은 `/tmp/hoh-demo/.hoh/README.md`에 있습니다.
각 루프는 해당 작업 공간의 Git 이력에 `docs` / `feat` / `test` 커밋으로 남습니다.

### 2. 실제 모델로 실행

예제의 `gateway`, `MODEL_API_KEY`, `https://api.example.com/v1`은 예시 값입니다.
설정의 공급자 URL, 인증 정보 참조, 모델 ID를 사용하는 서비스에 맞게 지정하세요.

```bash
# 1. 인증 정보는 커밋하는 설정 파일 밖에 보관
echo 'MODEL_API_KEY=…' > .env          # .env는 Git에서 제외되며 자동 로드됨

# 2. 설정에 엔드포인트와 모델을 지정한 뒤 해석 결과 확인
node dist/cli.js config --workspace ../my-project

# 3. 필요하면 고정 PRD claim 카탈로그 초안을 생성하고 검토
node dist/cli.js init-claims --workspace ../my-project --spec ../my-project/PRD.md

# 4. 설정한 예산으로 백그라운드 실행하고 진행 상황 확인
node dist/cli.js run  --workspace ../my-project --spec ../my-project/PRD.md --detach
node dist/cli.js logs --workspace ../my-project -f
```

백업된 전용 Git 브랜치나 작업 공간을 사용하고, 실행 중 사람이 동시에 수정하지 않도록 하세요.
HoH는 커밋과 워크트리를 만들며, 역할이 허용된 실행 기록 경계를 벗어나 작성한 내용을 되돌립니다.

`config`는 모델 패턴을 해석하지 못하거나 인증 정보가 없으면 0이 아닌 종료 코드를 반환하므로,
실행 전 확인에 사용할 수 있습니다.

```
Providers (pi models file: ../my-project/.hoh/pi-models.json):
  gateway: https://api.example.com/v1 [openai-completions] — 23 model(s) (discovered)
Models per role:
  planner   gateway/gpt-5.5:high  -> gateway/gpt-5.5 (thinking high)  [auth ok]
  developer gateway/gpt-5.5:high  -> gateway/gpt-5.5 (thinking high)  [auth ok]
  tester    gateway/gpt-5.5:high  -> gateway/gpt-5.5 (thinking high)  [auth ok]
```

`examples/1945/`에는 실제 세 루프 실행에 사용한 입력 구성이 있습니다.
기계적으로 검사할 수 있는 QA 계약을 담은 PRD, 네 개의 결정적 검사,
헤드리스 Chrome 플레이 테스트 드라이버, 해시로 검증하는 `worktree_setup`을 포함합니다.

## CLI 참고

| 명령 | 기능 |
| --- | --- |
| `run` | 루프를 시작하거나 재개합니다. 모든 기록을 `<workspace>/.hoh/`에 쓰고 역할 경계마다 커밋합니다 |
| `init-claims` | Planner 모델이 명세에서 `.hoh/claims.json` 초안을 만듭니다. 첫 루프 전에 편집할 수 있습니다 |
| `status` | 수명 주기, 프로토콜·실행 검증 기록, 모델, 예산, 원장, 커버리지, 루프별 표를 표시합니다 |
| `verify` | 오프라인으로 실행 검증 기록을 확인합니다. 로컬 파일과 Git 객체만 읽으며 설정, `.env`, 공급자, 하네스를 로드하지 않습니다 |
| `stop` | 활성 실행에 중단을 요청한 뒤 런타임의 워크트리·기록 정리를 최대 20초 기다립니다 |
| `logs` | 실행 로그를 출력합니다. `-f`는 새 출력을 계속 표시합니다 |
| `config` | 유효 설정, 발견한 공급자 모델, 역할별 모델 해석 결과와 인증 상태를 표시합니다 |

| 옵션 | 적용 명령 | 의미 |
| --- | --- | --- |
| `--workspace`, `-w` | 전체 | 제품 작업 공간입니다. 기본값은 현재 디렉터리입니다 |
| `--spec`, `-s` | `run`, `init-claims` | PRD 경로입니다. `run`은 최초 실행 시 `.hoh/spec.md`로 복사하며 재개 시 생략합니다 |
| `--config`, `-c` | `run`, `init-claims`, `config` | 이번 호출에 사용할 설정 파일입니다. 재개 시 생략하면 보호된 `.hoh/config.json`을 재사용합니다 |
| `--loops`, `-n` | `run` | 반복 예산 `T`입니다. `extended`에서는 저장되며, `paper`에서는 최초 `T`의 변경을 거부합니다 |
| `--detach` | `run` | 분리된 프로세스에서 실행하고 즉시 반환합니다. 로그 경로를 출력합니다 |
| `--follow`, `-f` | `logs` | 중단할 때까지 새 출력을 계속 표시합니다 |

종료 코드는 성공 시 `0`, 잘못된 설정·없는 실행·검증 실패·중단 대기 시간 초과 시 `1`,
취소하거나 중단한 실행에서는 `130` / `143`입니다.

실행 수명 주기 파일은 `.hoh/`가 아닌 작업 공간의 Git 디렉터리에 있으므로 커밋되지 않습니다.
경로는 `.git/hoh/process.json`과 `.git/hoh/run.log`입니다.

## 실행할 프로젝트 준비하기

실행에는 PRD와 모델 설정이 필요합니다. 검사와 고정 claim 카탈로그를 추가하면
프로젝트에 맞는 검증을 구성할 수 있습니다.

**1. 사용자가 관찰할 수 있는 인수 조건을 담은 PRD.** Tester가 소스를 읽는 것만으로 판단하지 않고,
결과물을 실행해서 확인할 수 있는 조건을 작성하세요. 제공하는 검증 도구와 호출 방법도 포함합니다.
동작을 관찰하려면 디버그 훅이 필요한 제품이라면 그 훅을 PRD의 요구사항으로 명시하세요.
`examples/1945/PRD.md`의 읽기 전용 `window.__dbg`가 예입니다.

**2. 결정적 검사.** QA 전에 고정된 후보에서 실행하며, 실패는 blocker 등급의 결함(gap)이 됩니다.
표준 출력과 표준 오류가 증거로 커밋되므로, 검사는 빠르고 비대화형이어야 하며 출력에 비밀 정보가 없어야 합니다.

```json
"worktree_setup": "npm ci --prefix tools --ignore-scripts",
"checks": [
  { "name": "syntax", "command": "node ../tools/syntax-check.mjs index.html", "timeout_min": 1 },
  { "name": "boot", "command": "node ../tools/playtest.mjs --file index.html --seconds 3 --fail-on-errors", "timeout_min": 2,
    "claims": { "boot_smoke": "The page runs for 3 seconds without reported errors." } }
]
```

검사는 커밋된 파일만 들어 있는 격리 워크트리의 `artifact_dir`에서 실행됩니다.
`tools/node_modules`처럼 추적하지 않는 디렉터리는 없으므로 `worktree_setup`에서 설치하거나
`$HOH_WORKSPACE`를 기준으로 의존성을 찾도록 하세요.
검사와 Tester에는 `HOH_CANDIDATE_DIR`, `HOH_EVIDENCE_DIR`도 전달됩니다.

`checks[].claims`는 안정적인 claim ID를 해당 명령이 검사하는 정확한 조건에 연결합니다.
등록된 claim만 `verified`가 될 수 있고, 같은 ID에 연결된 모든 검사가 온전한 출력 증거와 함께 통과해야 합니다.
런타임이 검사 기록을 연결하고 등록된 조건을 저장하므로, QA가 같은 ID를 재사용해 주장 범위를 넓힐 수 없습니다.
등록되지 않은 관찰은 성공한 QA 셸 명령이라도 gap으로 남습니다.
검사가 실제로 확인하는 조건만 등록하고 인수 검사 코드는 운영자가 관리하세요.
런타임은 증거 연결을 강제하지만 임의 검사기의 정확성이나 완전성까지 보장하지는 않습니다.

**3. 선택적 claim 카탈로그.** `.hoh/claims.json`은 인수 조건별로 안정적인 claim과
필요한 실행 증거 유형을 보관합니다. `init-claims`로 초안을 만든 뒤 범위와 `requires` 필드를 검토하세요.
런타임은 선언된 요구사항을 적용하지만 모델이 필요한 항목을 빠짐없이 선언했는지는 입증하지 못합니다.
기본값인 `claim_catalog: "existing"`은 파일이 있으면 사용하고, 없으면 카탈로그 없이 핵심 루프를 실행합니다.
`"off"`는 카탈로그 로드를 끄고, `"generate"`는 첫 루프 전 초안 생성을 명시적으로 켜며 유효한 카탈로그를
만들지 못하면 실패합니다. 카탈로그의 조건과 검사에 연결한 조건은 일치해야 합니다.
어느 모드에서든 자유 관찰은 gap으로 남길 수 있고, 검사에 연결된 claim을 등록하는 데 카탈로그가 필수는 아닙니다.

루프를 사용하기 전에 전체 구성을 확인하세요.

```bash
node dist/cli.js config --workspace ../my-project     # 모델과 인증 정보 확인
node dist/cli.js run --workspace /tmp/probe --spec ../my-project/PRD.md --config examples/mock.config.json
```

## 실행 운영하기

**진행 상황 보기.** `logs -f`는 실행 로그를 계속 표시하고, `status`는 실행 중에도
현재 시점의 요약을 보여 줍니다. 기록 조회용 명령으로 실행 중 사용할 수 있습니다.

**중단하고 재개하기.** `stop`은 협력적 종료를 요청합니다. 활성 역할을 취소하고,
검사 프로세스 그룹을 종료하며, 취소된 QA 시도는 판정을 기록하지 않고 워크트리를 제거합니다.
재개할 때 별도 재개 옵션은 필요하지 않습니다.

```bash
node dist/cli.js stop --workspace ../my-project
node dist/cli.js run  --workspace ../my-project        # 중단 지점부터 계속 실행
```

`run`은 `evidence.json`이 `HEAD`에 커밋된 마지막 루프 다음부터 재개합니다.
미완료 루프에서는 저장된 계획과 개발 문서를 재사용하고, 현재 `artifact_dir` 해시가 일치할 때만
기록된 Developer 결과를 재사용합니다. 검사와 Tester는 같은 후보 트리를 대상으로 다시 실행합니다.
해시가 다르면 중단합니다. 재개 시 `--config`를 생략하면 역할이 수정했을 수 있는 루트 설정 파일 대신
실행에 보관된 보호된 설정 사본을 사용합니다.

**예산 늘리기.** `extended` 실행은 `--loops <n>`으로 `T`를 늘릴 수 있습니다.
`paper`에서는 최초 루프·토큰·비용·경과 시간 상한이 변경 불가능한 검증 기록에 포함되므로,
상한을 높이려면 다른 작업 공간에서 새 실행을 시작하세요.

**개발 전에 계획 검토하기.** `protocol: "extended"`와 `human_checkpoint: true`를 설정하고
대화형 포그라운드 터미널에서 CLI를 실행합니다. 정확한 계획을 표시하고, Developer 실행 전에 `yes`를 요구합니다.
거절하면 루프가 중단됩니다. 재개하면 계획을 재사용하고 승인을 다시 요청합니다.
승인 기록은 `iterations/loop-NN/approval.json`에 저장되며 계획의 정확한 바이트와 프로토콜 해시에 연결됩니다.
검토 대기 시간은 활성 예산 시간에서 제외됩니다. 라이브러리 호출자는 `runHoh`에
`approvePlan(checkpoint): Promise<boolean>`을 전달하고 대기 중 `checkpoint.signal`을 처리해야 합니다.
분리 실행과 비대화형 CLI에서는 모델을 호출하기 전에 이 옵션을 거부합니다.

**예산 소진은 런타임 오류가 아닙니다.** 상한에 도달하면 미완료 루프를 보존하고 재개 가능한
`budget_exhausted` 상태를 반환합니다. QA 판정이나 `error.json`은 만들지 않습니다.
원장은 pi의 같은 세션 내 재시도를 포함해 완료된 역할이 반환한 사용량을 부과합니다.
예외를 던진 호출의 사용량은 0으로 추정하지 않고 확인 불가로 기록합니다.
사용량 집계는 loop-1 Planner부터 시작하므로 선택적인 loop-0 claim 초안 생성은 집계 밖입니다.

**진행 상황은 QA PASS뿐 아니라 원장으로 판단하기.** Gap은 이슈를 열고, verified 기록은 이슈를 닫으며,
닫힌 이슈에서 다시 나타난 gap은 회귀가 됩니다. Blocker 또는 두 연속 루프에 나타난 gap은 다음 루프의 필수 작업입니다.
Fusepoint 실행 기록에서는 96개 루프 중 PASS가 두 번이었습니다.
PASS에 도달하지 못해도 매 루프에서 이슈를 해결하고 있을 수 있습니다.

**실행 후 기록 확인하기.** `.hoh/README.md`는 생성된 개발 기록,
`.hoh/iterations/loop-NN/tester_report.md`는 사람이 읽는 QA 보고서입니다.
`verify`는 전체 실행 상태를 오프라인으로 다시 검사합니다.

## 문제 해결

| 증상 | 원인과 해결 방법 |
| --- | --- |
| 모듈이나 실행 파일이 없어 검사가 즉시 실패함 | 격리 워크트리에는 커밋된 파일만 있습니다. `worktree_setup`에서 설치하거나 `$HOH_WORKSPACE`에서 의존성을 찾도록 하세요 |
| `config`에 `NO CREDENTIALS`가 표시됨 | `providers.<name>.api_key`가 가리키는 `$ENV_VAR`가 없습니다. 작업 공간이나 현재 디렉터리의 `.env`에 넣거나 export 하세요 |
| `cannot resume loop N: artifact tree … differs` | 기록된 후보 이후 `artifact_dir` 내용이 바뀌었습니다. 해당 트리를 복원하거나 새 실행을 시작하세요 |
| 후보 변경에 대한 runtime blocker로 QA가 실패함 | Tester가 현재 루프의 증거 디렉터리 밖에 썼습니다. 변경을 되돌리고 QA를 실패 처리하는 것이 의도된 동작입니다 |
| 실행이 멈춘 것처럼 보임 | `status`에서 활성 역할과 경과 시간을 확인하세요. 공급자 무응답은 `timeouts.output_idle_ms`, 역할 실행 시간은 `timeouts.role_min`으로 제한합니다 |
| `Started detached HoH run` 이후 `status`에 아무것도 없음 | `.git/hoh/run.log` 또는 `logs`를 확인하세요. 시작 단계 오류는 수명 주기 상태가 생기기 전에 로그에 기록됩니다 |
| 이미 활성 실행이 있어 시작을 거부함 | 작업 공간마다 한 실행만 허용합니다. `stop`으로 중단하거나 다른 작업 공간을 사용하세요 |
| 기록을 직접 편집한 뒤 `verify`가 실패함 | `.hoh/`는 런타임 소유입니다. Git 이력에서 복원하세요. 검증 기록은 모든 정식 실행 기록에 연결됩니다 |

## 런타임이 강제하는 규칙

| 역할 | 기본 pi 허용 도구 | 작업 디렉터리 | 산출물 |
| --- | --- | --- | --- |
| Project Planner | `read grep find ls` + `submit_development_document` | 작업 공간 | D_t (`development_document.md`) |
| Developer | `read bash edit write grep find ls` | 작업 공간 | A_t (커밋 + 결과물 트리 해시 → 후보 ID) |
| QA Tester | `read bash grep find ls` + `submit_evidence` | 후보의 격리 Git 워크트리 | E_t (`evidence.json`) |

Codex도 같은 작업 공간 경계와 구조화된 산출물을 유지합니다.
다만 검증 기록에는 pi의 개별 내장 도구 이름 대신 실제 Codex 샌드박스 기능을 기록합니다.

- **실행 프로토콜.** `protocol: "paper"`는 하네스와 버전, 하나의 모델·추론 패턴,
  역할 프롬프트·도구 계약, 런타임 정책, 반복 예산을 실행 기간 동안 고정합니다.
  정규화된 SHA-256 검증 기록을 `.hoh/run.json`에 저장하고, 계약 변경 시 재개를 거부합니다.
  `protocol: "extended"`는 제품별 역할 모델과 예산 재정의를 허용합니다.
  필드가 없는 설정은 기존 `extended`로 취급하며 사후에 paper 호환 실행으로 표시하지 않습니다.
- **오프라인으로 검증 가능한 실행 상태.** 안정적인 체크포인트에서 `.hoh/receipt.json`은
  모든 정식 `.hoh` 일반 파일의 SHA-256, 확정된 하네스·모델·역할 계약,
  Developer 후보의 과거 Git 커밋과 트리를 연결합니다. `hoh verify`는 로컬 파일과 Git 객체만 읽고,
  설정, `.env`, 공급자, 하네스를 로드하지 않습니다. 체크섬은 불일치를 탐지하지만 서명이나 진위 증명은 아닙니다.
  파일을 읽는 동안 작업 공간이 변경되지 않는다는 전제가 있습니다. 검증 기록 자신과 생성된 `.hoh/README.md`는
  제외하며, CLI 검증은 목록에 없는 정식 기록 파일이나 안전하지 않은 항목도 거부합니다.
- **봉인된 실험 실행 관리.** 역할 실행 전에 변경 불가능한 계획으로 다섯 비교 조건,
  공통 하네스·모델·명세·예산·A0, 표본, 반복, 평가기 식별 정보, 분석, 제외 및 재시도 규칙을 고정합니다.
  각 시도는 입력을 다시 확인하고 새 작업 공간에서 한 조건을 실행합니다. Git 환경을 정리한 상태에서
  정확한 후보 트리를 보관한 후에 블라인드 평가기를 호출합니다.
  조건·프로토콜·실행·평가기·원시 결과·집계·완료 검증 기록을 연결해 미완료 실행 의도나 완료 후 추가 기록을 거부합니다.
- **실험의 신뢰 경계.** 평가기는 별도 프로세스에서 중립화한 작업·표본·결과물 입력만 받습니다.
  출력 크기를 제한하고 부모 환경을 상속하지 않습니다. 검증 기록은 실제 실행 파일의 바이트와 선언한 버전·평가 기준이
  사전 등록값과 일치하는지 확인하고, 점수가 개발 프롬프트에 들어가지 않게 합니다.
  제공된 평가 기준 자체를 독립적인 정답으로 만들어 주지는 않으므로, 성능 주장에는 공식 벤치마크나
  독립적인 사람의 평가 기준이 필요합니다. 신뢰할 수 있고 협력적으로 동작하는 평가 코드와 저장소를 전제로 하며,
  파일 시스템·네트워크 샌드박스가 아닙니다. SHA-256 검증 기록은 서명이 아닌 체크섬입니다.
- **후보 식별.** Developer가 끝나면 작업 공간을 커밋하고 Git ignore 규칙을 반영해
  설정된 `artifact_dir` 하위 트리만 해시합니다. `artifact_dir: "."`은 `.hoh/`를 제외한 작업 공간 전체입니다.
  후보 ID는 `loop-NN-<tree hash>`입니다. 범위가 좁은 `artifact_dir`를 쓰면 다른 위치의 파일이 고정 커밋에
  포함될 수 있지만 후보 ID나 QA 전후 해시는 바꾸지 않습니다.
- **QA용 후보 diff.** Developer 기록에 개발 전후의 전체 Git SHA를 저장합니다.
  Tester에는 결과물 범위의 변경 통계, 파일 목록, 패치, 읽기 전용 조회 명령을 제공합니다.
  인라인 블록은 32 KiB까지이며, 더 큰 패치는 메타데이터와 hunk 헤더만 보여 줍니다.
  `.hoh`와 `artifact_dir` 밖 경로는 포함하지 않습니다. QA 재개 시에는 이후 런타임 전용 HEAD가 아니라
  기록된 후보 커밋을 재사용합니다.
- **고정된 QA 대상.** 검사와 Tester는 해당 커밋의 분리된 Git 워크트리에서 실행합니다.
  검사 전, Tester 전, Tester 후 트리 해시를 확인하고 불일치하면 runtime blocker로 QA를 실패 처리합니다.
- **실행 기록 보호.** Developer가 `.hoh/` 아래를 변경하면 되돌립니다.
  Tester는 현재 루프의 증거 디렉터리에만 쓸 수 있고, 다른 작업 공간·실행 기록을 변경하면 되돌린 뒤 QA를 실패 처리합니다.
  활성 역할의 대화 기록 이벤트는 하네스 프로세스 내부에 버퍼링하고 변경 감시를 통과한 뒤 저장하므로,
  역할이 보이는 파일을 수정해서 런타임 로그를 위조할 수 없습니다.
  저장 경계에서 설정이 참조하는 공급자 인증 정보와 제한된 인증 구문을 가립니다.
- **구조화된 출력 필수.** Planner와 Tester는 TypeBox 스키마가 적용된 도구로 산출물을 제출합니다.
  Codex에는 최종 JSON 출력 계약을 전달합니다. 산출물이 없으면 런타임 안내를 붙여 한 번 재시도합니다.
  그래도 Planner가 제출하지 않으면 루프를 중단하고, Tester가 제출하지 않으면 실패 증거 묶음
  (`tester.no_structured_output`)을 만듭니다.
- **증거 정규화**(논문 부록 A.4). Verified와 gap 기록을 구분하고, 양쪽에 있는 claim은 gap으로 취급합니다.
  실패한 결정적 검사는 blocker gap이 되고, 소스·설정·매니페스트만으로 한 검증은 하향 처리합니다.
  고정 claim은 `requires`의 모든 증거 유형을 만족해야 합니다. 인정되는 각 기록은 런타임이 캡처한
  성공한 설정 검사 또는 QA 셸 실행과 현재 해시가 일치하는 보존 파일을 인용해야 합니다.
  검증 완료에는 추가로 사전 선언한 `checks[].claims` 연결과, 연결된 모든 검사의 온전한 성공 증거가 필요합니다.
  런타임이 증거를 붙이고 등록된 조건을 claim 문장으로 사용합니다. 연결되지 않은 claim은 gap이며,
  연결된 검사가 실패하면 해당 claim ID가 blocker gap이 됩니다.
  QA의 `printf PASS`나 모델이 제출한 검증 기록만으로는 검증을 성립시킬 수 없습니다.
  등록한 조건과 검사 품질은 검사 작성자의 책임이며, 실행 출처만으로 요구사항 전체의 검증 범위를 입증할 수는 없습니다.
- **고정 PRD 커버리지.** `.hoh/claims.json`은 공개 인수 조건마다 안정적인 claim을 유지합니다.
  `.hoh/coverage.json`은 `verified`, `gap`, `untested` 상태, 마지막 검증 루프, 검증 횟수를 기록합니다.
  Planner와 Tester에는 우선순위 색인과 정식 경로를 제공하고, 표가 문맥 크기 한도 안에 들어갈 때만 전문을 인라인으로 넣습니다.
  자유 claim도 허용합니다. 증거는 카탈로그 해시에 연결되므로 claim을 편집하면 수정된 claim을 다시 검증할 때까지
  이전 증거를 사용할 수 없습니다.
- **이슈 원장.** Gap은 이슈를 열고 verified 기록은 닫으며, 닫힌 이슈의 gap은 회귀입니다.
  정확히 같은 claim ID로 루프 간 같은 결함을 식별합니다. 이후 성공한 런타임 검사는 명령과 보존 증거가 일치할 때
  자신의 기존 `check.<name>` 이슈를 닫을 수 있지만, 제품 claim을 검증하거나 QA 판정을 바꾸지는 않습니다.
  Blocker와 두 연속 루프에 관찰된 gap은 다음 루프의 필수 작업이며, Planner의 선택 작업보다 먼저,
  Developer 문서의 맨 위에 표시합니다. 중복·재생 관찰은 한 번만 계산합니다.
  Planner는 크기를 제한한 원장 보기를 받고, 필수·미해결 이슈는 개발 문서를 통해 Developer와 Tester에 전달됩니다.
  진행 상황은 QA PASS뿐 아니라 원장과 결정적 검사로 측정합니다. Fusepoint의 PASS는 96개 루프 중 두 번이었습니다.
- **역할별 점진적 문맥 제공.** 긴 명세·증거·원장·커버리지·검사·개발 문서는 정식 경로,
  SHA-256, 크기를 제한한 색인으로 표현합니다. 8 KiB까지는 전문을 인라인으로 넣고, 더 큰 내용은 필요할 때 읽습니다.
  재시도 안내를 포함한 루프별 역할의 system+user 입력은 96 KiB로 제한합니다.
  Developer용 검사는 개발 문서에 한 번만 넣습니다. QA에는 현재 계획, 후보 diff, 현재 검사,
  커버리지, 명세를 제공하며 Developer 요약이나 별도의 중복 원장은 제공하지 않습니다.
- **도구 환경.** 모든 루프 역할은 `HOH_WORKSPACE`(주 작업 공간), `HOH_RUN_ID`, `HOH_LOOP`,
  `HOH_ROLE`(역할 이름)을 상속합니다. 셸을 제공하는 역할은 셸에서 읽을 수 있습니다.
  `worktree_setup`과 검사에는 `HOH_CANDIDATE_DIR`(격리 워크트리),
  `HOH_EVIDENCE_DIR`(주 작업 공간의 영구 증거 디렉터리), `HOH_ROLE=check`를 추가합니다.
  Tester에는 같은 두 디렉터리와 `HOH_ROLE=tester`를 전달합니다.
  `worktree_setup`은 후보 워크트리 루트에서, 검사는 그 안의 `artifact_dir`에서 실행합니다.
  추적하지 않는 파일은 워크트리에 없으므로 `$HOH_WORKSPACE`에서 찾거나 setup에서 의존성을 설치할 수 있습니다.
- **영구 증거 파일.** 검사는 파일 크기 한도 안에서 전체 stdout·stderr를 루프의 `evidence/checks/`에 보존하고,
  JSON에는 짧은 끝부분만 유지합니다. 너무 큰 출력은 생략 정보를 담은 작은 매니페스트로 대체합니다.
  Tester가 상대 경로로 인용한 스크린샷, 로그, 재생 데이터, 저장소 스냅샷에는 런타임이 계산한 SHA-256을 붙입니다.
  링크와 특수 파일을 거부하며 한도는 파일당 2 MiB, 루프당 30 MiB입니다.
  Git에 커밋되므로 검사에서 비밀 정보나 개인정보를 출력하지 않아야 합니다.
- **재개.** `hoh run`을 다시 실행하면 `evidence.json`이 `HEAD`에 커밋된 마지막 루프 다음부터 이어갑니다.
  미완료 루프의 계획과 개발 문서는 재사용합니다. 현재 `artifact_dir` 해시가 일치할 때만 Developer 결과를 재사용하고,
  같은 후보 트리에서 검사와 Tester를 다시 실행합니다. 해시가 다르면 중단합니다.
- **Git 기록과 소유권.** `.hoh/`는 런타임이 관리하며 허용된 출력 밖의 역할 변경은 되돌립니다.
  새 실행은 시작 작업 공간과 실행 기록을 `hoh-runtime`으로 스냅샷합니다.
  설정·시작·오류·QA 전 검사 기록 갱신도 같은 작성자를 사용합니다.
  Planner, Developer, 최종 QA 경계는 각각 `hoh-planner-bot`, `hoh-developer-bot`, `hoh-tester-bot`의
  `docs(loop-NN)`, `feat(loop-NN)`, `test(loop-NN)` 커밋입니다.
  Tester 접근 전 런타임의 `chore(loop-NN)` 커밋으로 Developer 기록과 검사 로그를 고정하므로,
  재생성한 런타임 파일이 다음 역할의 변경으로 기록되지 않습니다.
- **프롬프트 스냅샷.** 루프 `1..T`의 각 역할에 전달한 최종 system·user 입력을 메모리에서 해시하며,
  마지막 구조화 출력 재시도 안내도 포함합니다. `prompts/`에는 민감 정보를 가린 사본,
  원본 입력 해시, 저장본 해시, 고정 규칙별 교체 횟수를 저장합니다.
  선택적 loop-0 claim 초안 대화 기록에도 같은 저장 시 마스킹 경계를 적용합니다.
  키 없는 SHA-256은 재현성 체크섬이며 기밀성·진위 보장 수단이 아닙니다.
  알려진 템플릿이나 경우의 수가 적은 값은 추측할 수 있으므로 `.hoh` 기록은 여전히 민감하며 자동으로 공개해도 안전해지지 않습니다.
- **명시적 pi 리소스.** Pi 확장과 스킬은 기본적으로 꺼져 있습니다.
  작업 공간 상대 경로를 전역 또는 역할별로 켤 수 있고, 확장 도구는 역할 허용 목록에 이름이 있을 때만 활성화됩니다.
  실제 경로와 재귀적 내용 해시를 `.hoh/pi-resources.json`에 저장하고 로드 전후에 재검사하며 새 프로토콜 검증 기록에 포함합니다.
  확장은 신뢰하는 실행 코드이지 샌드박스가 아닙니다. 모델이 호출할 도구를 제한하더라도 검토한 로컬 코드와 범위를 제한한 인증 정보를 사용하세요.
- **역할별 pi 문맥 압축.** HoH가 외부 pi 압축 설정을 고정된 전역 정책과 선택적 역할별 재정의로 대체합니다.
  압축 성공 시 역할 사용량과 실행 보고서에 압축 전후 문맥 추정치를 표시하고,
  요약 호출에서 보고한 토큰과 비용을 해당 역할에 부과합니다.
- **협력적 취소.** 라이브러리 호출자는 `runHoh`에 `signal`을 전달할 수 있습니다.
  Claim 초안, 모든 역할 호출, setup, 검사에 전파됩니다. Pi는 활성 세션을 취소하고 검사 프로세스 그룹을 종료합니다.
  취소된 QA 시도는 QA 판정이나 런타임 실패를 기록하지 않고 워크트리를 제거합니다.
- **영구 리소스 예산.** 활성 경과 시간, 총 토큰, 비용에 역할·루프·실행별 상한을 선택적으로 설정하고
  역할 실행 전에 검사합니다. 완료된 `RoleUsage`는 `.hoh/budget.json`에 원자적으로 부과하며,
  상한 도달 시 QA 판정이나 `error.json` 없이 재개 가능한 `budget_exhausted`를 반환합니다.

## 실행 디렉터리 구성 (`<workspace>/.hoh/`)

```
run.json                    실행 ID, 예산 T, 하네스, 모델, 검사
spec.md                     S, 공개 명세 (--spec에서 복사)
pi-resources.json           확정된 역할별 확장·스킬·도구 매니페스트와 해시
budget.json                 원자적으로 갱신하는 역할·루프·실행 사용량 원장과 소진 상태
receipt.json                정규 실행 상태 해시, 식별 정보, 과거 후보
ledger.json                 이슈 원장
claims.json                 고정 PRD claim 카탈로그와 필수 증거 유형
coverage.json               claim별 상태, 마지막 검증 루프, 검증 횟수
claims-transcript.jsonl     선택적 claim 초안 생성의 모델 이벤트
README.md                   생성된 개발 기록
iterations/loop-NN/
  planner.json              Planner 보충 내용과 사용량
  development_document.md   D_t (결정적 기본 틀과 보충 내용)
  approval.json             계획과 프로토콜에 연결한 선택적 사람 승인 기록
  developer.json            후보 ID, 트리 해시, 커밋, 변경 경로, 위반 사항
  checks.json               고정 후보에서 실행한 결정적 검사 결과
  evidence.json             E_t
  evidence/                 해시를 붙인 QA 산출물과 보존된 검사 출력
  prompts/<role>.json       민감 정보를 가린 프롬프트, 정확한 입력 해시, 저장 메타데이터
  tester_report.md          사람이 읽는 QA 보고서
  transcripts/<role>.jsonl  어댑터 세션 이벤트 또는 모의 기록
  error.json                루프가 오류로 중단되었을 때만 생성
```

## 설정

프로토콜, 모델, 공급자, 하네스, 예산, 검사, 재시도, 시간 제한은 CLI 옵션이 아니라 설정 파일에 둡니다.
저장소의 `hoh.config.json`을 편집하거나 `--config`로 다른 파일을 지정하세요.
공급자는 OpenAI 호환 엔드포인트이며 `GET {base_url}/models`로 모델 목록을 조회할 수 있습니다.
루트 설정은 `paper`를 사용하고, 아래의 역할별 모델 분리 예제는 의도적으로 `extended`를 사용합니다.

```json
{
  "protocol": "extended",
  "harness": "pi",
  "providers": {
    "gateway": {
      "base_url": "https://api.example.com/v1",
      "api_key": "$MODEL_API_KEY",
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
    "default": "gateway/gpt-5.5:high",
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
  "pi": {
    "compaction": { "enabled": true, "reserve_tokens": 16384, "keep_recent_tokens": 20000 },
    "roles": { "developer": { "compaction": { "keep_recent_tokens": 12000 } } }
  }
}
```

| 키 | 의미 |
| --- | --- |
| `protocol` | `paper`는 최초 하네스·모델·역할·런타임 계약과 `T`를 고정합니다. `extended`는 아래의 제품별 재정의를 허용합니다. 없으면 기존 `extended`입니다 |
| `harness` | `pi`(프로세스 내 SDK), `codex`(비대화형 Codex CLI), `mock`(스크립트 모의 실행) |
| `claim_catalog` | 기본값 `existing`: 기존 카탈로그만 사용. `off`: 무시. `generate`: 없을 때 초안 생성 |
| `human_checkpoint` | 선택적 boolean, 기본값 false, `extended` 전용. 포그라운드 CLI 또는 `runHoh`의 `approvePlan`으로 Developer 실행 전에 승인 요구 |
| `providers.<name>.base_url` | OpenAI 호환 엔드포인트(`…/v1`). `$ENV` 참조 가능 |
| `providers.<name>.api_key` | `"$ENV_VAR"` 또는 `"!command"`. 설정이 실행 기록과 함께 커밋되므로 리터럴 키는 localhost 엔드포인트에만 허용 |
| `providers.<name>.api` | `openai-completions`(기본값), `openai-responses`, `anthropic-messages` |
| `providers.<name>.models` | `"discover"`는 `GET {base_url}/models`를 조회하고 이미지·동영상·임베딩·오디오 모델을 제외합니다. ID 또는 객체 목록을 직접 지정할 수도 있습니다 |
| `providers.<name>.discover.exclude` / `include` | 발견한 ID에 적용하는 정규식 조각 |
| `providers.<name>.model_defaults` / `model_overrides` | 모델별 `reasoning`, `context_window`, `max_tokens`, `input`, `cost`, `compat`. 재정의 키는 모델 ID |
| `providers.<name>.model_overrides.<id>.thinking_level_map` | pi 수준을 공급자의 추론 강도 값에 연결합니다. Luna는 `{"xhigh":"xhigh","max":"max"}`로 `:max`를 유지합니다. `null`은 미지원 수준 |
| `providers.<name>.headers` / `compat` | 추가 헤더(`$ENV` 허용)와 pi 호환성 옵션(snake_case 허용) |
| `models.default` | 모든 역할의 기본 모델 패턴. pi는 `provider/model[:thinking]`, Codex는 `codex/model[:minimal\|low\|medium\|high\|xhigh]` |
| `models.planner` / `developer` / `tester` | `extended`에서 역할별 재정의. `paper`에서는 설정된 모든 패턴이 같아야 하며 확정된 식별자를 검증 기록에 저장 |
| `loops` | 반복 예산 T |
| `artifact_dir` | 작업 공간 안의 결과물 디렉터리. `.`은 `.hoh/`를 제외한 전체 작업 공간 |
| `worktree_setup` | QA 시도마다 검사 전에 격리 후보 워크트리 루트에서 한 번 실행하는 선택적 명령(예: `cd tools && npm ci`). `HOH_*` 검사 환경을 사용하고 `setup` 검사로 기록합니다. 실패하면 QA를 차단합니다. `artifact_dir` 안에서 ignore되지 않은 파일을 생성·변경하면 후보 해시 검사로 QA가 무효화됩니다 |
| `checks[]` | QA 전에 고정 후보에서 실행할 결정적 명령. `name`, `command`, 선택적 `timeout_min`, 안정적인 ID를 정확한 검사 조건에 연결하는 `claims`를 사용합니다. 연결된 모든 검사가 통과한 claim만 검증 완료 가능 |
| `timeouts.role_min` / `check_min` | 역할 및 결정적 검사의 실제 경과 시간 제한 |
| `timeouts.provider_ms` | 공급자 요청별 상한. 같은 pi 세션이 재시도 분류를 담당하도록 pi SDK 수준의 재시도는 비활성화 |
| `timeouts.output_idle_ms` / `websocket_connect_ms` | 스트림 무응답 감시와 WebSocket 연결 상한 |
| `retry.*` | 같은 세션 내 일시적 오류 재시도 정책. 활성화 여부, 횟수, 지수 백오프 기본값, 허용할 최대 서버 지연 |
| `budgets.role` / `loop` / `run` | 선택적 `elapsed_ms`(양의 정수), `total_tokens`(양의 정수), `cost`(소수 허용, 양의 유한수) 상한. 범위나 항목을 생략하면 무제한. Codex CLI는 금액을 보고하지 않으므로 시간·토큰 상한만 가능 |
| `pi.agent_dir` | pi 인증·모델 디렉터리. 기본값 `~/.pi/agent` |
| `pi.compaction` | 모든 역할에 적용할 런타임 압축 기본값. `enabled`, 양의 `reserve_tokens`, 양의 `keep_recent_tokens`. 기본값은 `true`, `16384`, `20000` |
| `pi.extensions` / `pi.skills` | 모든 역할에서 로드할 검토된 작업 공간 상대 리소스 경로. 외부 pi 자동 탐색은 계속 비활성화 |
| `pi.roles.<role>.extensions` / `skills` | `planner`, `developer`, `tester` 중 해당 역할만 로드할 추가 리소스 |
| `pi.roles.<role>.extension_tools` | 해당 역할에 노출할 확장 등록 도구의 정확한 이름. 내장 도구와 `submit_*` 이름은 예약됨 |
| `pi.roles.<role>.compaction` | `planner`, `developer`, `tester`의 전역 압축 정책 부분 재정의 |

최소 Codex 실행은 설치된 `codex` 실행 파일과 기존 인증을 사용합니다.
어댑터는 CLI 버전을 고정하고 외부 Codex 설정과 저장소 지시를 무시하며,
HoH 역할 프롬프트를 명시적으로 전달합니다. 대화형 승인과 웹 검색을 끄고,
`--json`과 `--output-schema` 결과를 공통 역할 결과로 변환합니다.

QA 호출에는 고정 워크트리 밖에 있는 현재 증거 디렉터리의 쓰기 권한을 부여합니다.
프롬프트와 스냅샷은 CLI의 최종 JSON 스키마 계약을 사용합니다.
요청한 모델은 설정과 대화 기록에 남기되 실제 보고 모델은 확인 불가로 유지합니다.
그 식별자를 독립적으로 확인할 수 있을 때까지 역할 실행 전에 `paper`를 거부합니다.

```json
{
  "protocol": "extended",
  "harness": "codex",
  "models": { "default": "codex/gpt-5.6:high" },
  "loops": 3,
  "artifact_dir": ".",
  "checks": [],
  "budgets": { "run": { "elapsed_ms": 32400000, "total_tokens": 750000 } }
}
```

아래 예제는 모든 역할에 공통 스킬 하나를 로드하고, 검토한 확장과 도구는 Developer에만 로드합니다.

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

각 목록은 실제 존재하는 일반 파일이나 디렉터리를 받습니다. 설정 경로는 작업 공간 안이면서
`.hoh` 밖으로 해석되어야 하며, 디렉터리 리소스에는 심볼릭 링크가 없어야 합니다.
`package.json`에 선언한 확장 패키지 진입점도 설정·해시된 디렉터리 안에 있어야 합니다.
정확한 경로와 단순한 `*` / `?` glob만 허용해 중괄호·문자 클래스·extglob 확장이 경계를 넘지 않게 합니다.
유효하지 않은 스킬, 로드하지 못한 확장 진입점, pi 내장 도구(`powershell` 포함)나 `submit_*`를 대체하는
확장 도구는 모델 요청 전에 실패합니다. 새 `paper` 실행은 역할별 확정 경로, 바이트, 확장 도구 허용 목록을
변경 불가능한 역할 계약에 고정하므로 리소스가 바뀌면 재개 대신 새 실행이 필요합니다.

설정은 다음 순서로 결정하며 먼저 찾은 항목이 우선합니다.

1. `--config <file>`
2. `<workspace>/.hoh/config.json`: 실행 기록과 함께 커밋한 사본. 재개 시 실질적인 변경은 `extended`만 허용
3. 현재 디렉터리의 `./hoh.config.json`: 이 저장소에서 실행하면 저장소의 파일 사용
4. 내장 기본값

`--loops <n>`이 유일한 CLI 실행 시 재정의 옵션입니다. `extended`에서는 저장하고,
`paper`에서는 최초 `T`를 바꾸면 거부합니다. 런타임은 실행 시작 때만 `paper` 검증 기록을 만들고,
재개 전 저장된 기록 자체의 해시를 검증하며 현재 계약을 다시 계산합니다.
하네스가 검증 기록의 확정 식별자와 다른 모델을 보고하면 해당 호출을 거부합니다.
검증 기록 도입 전 실행은 항상 `extended`로 보존합니다. 재구성한 기록에는 `legacy_reconstruction`을 표시하며,
원래 실행 시작 조건을 증명하는 기록으로 취급하지 않습니다.

공급자 설정에는 리터럴 키 대신 환경변수 참조를 기록합니다. 현재 디렉터리와 작업 공간의 `.env`를
자동으로 로드하며 이 저장소의 `.env`는 Git에서 제외합니다. `.hoh/pi-models.json`에도 `$ENV` 참조를 유지합니다.
셸을 사용할 수 있는 역할, setup, 검사는 런타임 환경을 상속하므로 해당 값을 읽거나 출력할 수 있습니다.
프롬프트·대화 기록을 저장하기 전에 설정된 공급자 키와 인증 헤더가 참조하는 값을 제거합니다.
관련 없는 환경변수를 훑거나 마스킹만을 위해 `!command`를 실행하지는 않습니다.
권한 범위를 제한한 인증 정보와 신뢰하는 명세·도구를 사용하세요. HoH는 환경변수 샌드박스가 아닙니다.
`hoh config`는 모델 탐색을 다시 실행해 목록을 출력하고, 엔드포인트에 연결할 수 없으면 이전 탐색 목록을 재사용합니다.
역할 기록에는 하네스가 보고한 모델 식별자를 저장합니다. Codex를 포함해 식별자가 없으면 확인 불가로 남기며,
요청한 모델로 대신 채우지 않습니다.

```bash
node dist/cli.js config --workspace ../my-game   # 유효 설정, 역할별 모델 해석, 인증 확인
```

## 실험 하네스 (라이브러리 API)

논문의 구성 요소 제거 실험용 비교 하네스는 CLI가 아닌 라이브러리입니다.
역할 실행 전에 `hoh`, `vanilla`, `no-plan-update`, `no-evidence`, `no-warm-start`의
다섯 조건을 포함하는 변경 불가능한 계획을 고정합니다.

```ts
import {
  registerExperiment,
  experimentAssignments,
  runExperimentAttempt,
  aggregateExperimentDirectory,
} from "hoh/dist/experiment/orchestrator.js";

// 1. 표본, 반복, 예산, 평가기 식별 정보, 재시도 규칙을 계획에 봉인합니다.
const manifest = await registerExperiment({
  experiment_root: "/tmp/exp",
  samples: [{
    task_id: "1945",
    sample_id: "s1",
    workspace: "/tmp/a0/1945",        // 변경 전 A0. 해시를 계획에 고정
    spec_path: "/tmp/a0/1945/PRD.md",
    evaluator_task: "Score the artifact against the rubric.",
    evaluator_sample: "1945 STRIKE",
  }],
  repetitions: 3,
  assignment_seed: 20260903,
  budget: { unit: "total_tokens", limit: 750_000 },
  evaluator: {
    argv: ["/usr/bin/node", "/opt/rubric/score.mjs"],   // 셸 문자열이 아닌 실행 파일과 정확한 인수
    version: "1.0.0",
    rubric_sha256: "…",
    executable_sha256: "…",
  },
  metric: "overall",
  exclusion_rules: ["infrastructure_failure"],
  retry: { max_attempts: 2, retryable_failure_codes: ["transport"] },
  harness,                              // createHarness(config, workspace)에서 생성
  config,                               // 공통 ConfigPatch
});

// 2. 각 실험 조합을 새로운 A0 사본에서 실행합니다.
for (const a of experimentAssignments(manifest)) {
  await runExperimentAttempt({
    experiment_root: "/tmp/exp",
    attempt_id: `${a.cell_id}-${a.sample_id}-${a.repetition}`,
    ...a,
    workspace: freshCopyOfA0(),
    spec_path: "/tmp/a0/1945/PRD.md",
    evaluator_task: "Score the artifact against the rubric.",
    evaluator_sample: "1945 STRIKE",
    harness,
    config,
  });
}

// 3. 매크로 평균과 부트스트랩 95% 구간으로 결과를 봉인합니다.
await aggregateExperimentDirectory("/tmp/exp");
```

실험 루트에는 `manifest.json`, `raw-results.jsonl`, `aggregate.json`, `complete.json`,
`receipts/`, `intents/`가 쌓입니다. 각 시도는 봉인된 입력을 재검증하고 자체 작업 공간에서 한 조건을 실행한 뒤
정확한 후보 트리를 보관합니다. 그 후 환경을 상속하지 않는 별도 프로세스에서 블라인드 평가기를 호출합니다.
점수는 개발 프롬프트에 들어가지 않습니다. 앞의 신뢰 경계에서 설명했듯 제공된 평가 기준 자체가 독립적 정답은 아니므로,
성능 주장에는 공식 벤치마크나 독립적인 사람의 평가 기준이 여전히 필요합니다.

## 테스트

```bash
npm test
```

- `loop.test.ts`: 스크립트 하네스의 전체 루프, 후보 고정, 결과물 범위와 크기를 제한한 QA diff,
  `.hoh/` 보호, 재시도·대체 경로, 안정적인 재개 지점, 검사 실패.
- `cancellation.test.ts`: 검사 프로세스 그룹 종료, 잘못된 QA·런타임 실패 기록 없이 취소 시 QA 워크트리 정리.
- `budget.test.ts`: 설정 검증, 역할 경계의 실행 차단, 누적 시간·토큰·비용 집계, 재개 안정성, 오류 없는 예산 소진.
- `codex-harness.test.ts`: 정확한 비대화형 CLI 옵션, 스키마 매핑, 프로세스 그룹 취소, 어댑터 버전,
  실제 역할 정책 검증 기록, 증거 디렉터리 접근, 명령 캡처, 모델 보고 없는 paper 거부, 가짜 CLI를 통한 전체 extended 루프.
- `runtime-integrity.test.ts`: 위조 QA 거부, 선택적 카탈로그 모드, 공통 실패 역할 복구, 사람 승인·재개 연결.
- `experiment-manifest.test.ts`: 변경 불가능한 다섯 조건 계획, 공통 예산, 평가기 식별 정보,
  추가만 가능한 결과, 재시도 계보, 유효성 규칙.
- `experiment-evaluator.test.ts`: 중립화한 직렬화 입력, 정확한 argv·실행 파일 해시,
  크기가 제한되고 유한 숫자만 허용하는 JSON 출력, 환경 차단, 신뢰하는 평가기 위협 모델에서의 프로세스 그룹 취소.
- `experiment-conditions.test.ts`: 다섯 조건의 구체적인 정책, 공통 프로토콜·모델 식별자, 고정 A0 동작, 평가기 격리.
- `experiment-aggregate.test.ts`: 매니페스트·원시 결과·평가기 검증 기록 연결, 제외 규칙 일관성,
  결정적인 매크로 평균과 부트스트랩 구간.
- `experiment-orchestrator.test.ts`: 역할 실행 전 등록, 다섯 조건, 정확한 후보 보관,
  변경·심볼릭 링크 거부, 영구 실행 의도 기록, 동시 실행 배제, SHA-1·SHA-256 저장소의 완료 후 봉인.
- `ledger.test.ts`: 정확한 gap 식별, 중복·재생의 멱등성, 연속 루프 승격, open·closed·regressed 전이.
- `config.test.ts`: 설정 병합·검증, paper·extended 검증 기록과 재개 보호, 설정 파일 우선순위,
  하네스·실행 기록에 역할별 모델 전달, 공급자 검증, pi models.json 매핑, 모델 탐색.
- `coverage.test.ts`: 고정 claim 초기화, 루프 간 상태 전이, 필수 증거 유형, 프롬프트·보고서·status 출력, `init-claims`.
- `prompts.test.ts`: UTF-8 입력 크기 예산, 우선순위 색인, 역할별 문맥 구성, 정식 경로,
  큰 본문 생략, 무제한 fixture 대비 Developer 프롬프트의 바이트·토큰 추정치 감소.
- `prompt-snapshot.test.ts`: 마스킹 전 정확한 프롬프트 해시, 저장 마스킹 메타데이터,
  재시도 캡처, 재개, 후보에서의 제외, 외부 평가기 메타데이터 비혼입.
- `storage-redaction-integration.test.ts`: 메모리의 정확한 역할 입력을 유지하면서 프롬프트·대화 저장본에서 설정 인증 정보 제거.
- `receipt.test.ts` 및 `run-receipt-integration.test.ts`: 정규 검증 기록 검사, 크기를 제한한 안전한 읽기,
  과거 후보 재구성, 전체 실행 상태 연결, 변조 보고, 설정·공급자에 독립적인 CLI 검증.
- `evidence-files.test.ts`: 영구 Tester 파일, 검사 출력, SHA-256 연결, Git 포함,
  경로 경계, 크기 제한, 실행 기록 보호.
- `pi-fake.test.ts`: 탐색을 사용하는 `providers` 항목으로 선언한 가짜 OpenAI 호환 서버로 실제 pi SDK 세션과 도구 루프 구동.
  모델이 보는 역할별 허용 목록, 역할별 확장·스킬 로드, 금지 도구 거부,
  Developer만 내장·허용 확장 도구로 쓰기 가능, 구조화 제출 캡처, 설정 모델의 공급자 전달,
  모델 요청 전 잘못된 스킬 거부, 사용량·대화 기록 저장을 확인합니다.
- `pi-resources.test.ts`: 리소스 설정 병합·검증, 결정적인 파일·디렉터리 해시,
  작업 공간·실행 기록·심볼릭 링크·패키지 진입점·glob 경계, 예약 도구 검사,
  변경 탐지, paper 재개 시 검증 기록 적용.

## 확장하기

- **다른 내부 하네스.** `src/harness/types.ts`의 `Harness`를 구현하고(역할마다 `invoke` 호출 한 번)
  `runHoh`에 전달하세요. 논문의 프로토콜은 하네스에 종속되지 않으며,
  현재 어댑터는 `src/harness/pi.ts`, `src/harness/codex.ts`입니다.
- **분야별 도구와 스킬.** Fusepoint 실행은 Godot MCP, 에셋 도구, 스킬을 사용했습니다.
  Pi에서는 위 `pi` 설정에 검토한 로컬 경로와 역할별 확장 도구 이름을 선언하세요.
  어댑터는 외부 자동 탐색을 비활성화하고 확정된 매니페스트를 기록합니다.
- **프롬프트.** `prompts/<role>.system.md`와 `prompts/<role>.user.md`는 논문 부록 A.2를 따릅니다.
  `{{slot}}` 값은 `src/runtime/prompts.ts`에서 채웁니다.

## 로드맵

첫 실제 실행의 증거와 다음 개선 항목은 [docs/ROADMAP.md](docs/ROADMAP.md)를 참고하세요.

## 참고 자료

- 논문: https://arxiv.org/abs/2609.01481
- 프로젝트 페이지: https://flesymeb.github.io/HarnessOfHarness/
- Fusepoint 실행 기록(더 큰 비공개 “GameLoop” 런타임의 공개 기록): https://github.com/Flesymeb/fusepoint
- pi coding agent SDK 문서: `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
