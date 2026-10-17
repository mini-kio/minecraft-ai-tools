# Blockbench 실제 런타임 검증

검증기는 공식 Windows portable 앱을 프로젝트의 `work/blockbench-qa` 안에만 내려받고, GitHub 공식 릴리스의 SHA256과 파일 크기를 확인한다. 매 실행마다 별도 `--userData` 디렉터리를 사용한다. 설치된 Blockbench와 사용자의 프로젝트·설정·계정은 사용하지 않는다.

## 실행

의존성 설치와 `pnpm build`가 끝난 프로젝트 루트에서 PowerShell로 실행한다.

```powershell
$env:MCT_BLOCKBENCH_VERSION = '4.12.6'
node scripts/verify-blockbench-prepare.mjs
node scripts/verify-blockbench-runtime.mjs
```

4.12.6에서는 실제 파일에서 플러그인을 불러오고, 실제 파일 시스템을 통해 생성한 `.bbmodel`을 읽는다. 앱의 개발용 CDP 연결은 로컬호스트에 한정하며 테스트가 끝나면 소유한 테스트 앱을 종료한다. 숨겨진 테스트 창에서도 재생을 검증하기 위해 **격리된 테스트 프로필에서만** 백그라운드 렌더링을 켠다. 평상시 앱에서는 Blockbench의 백그라운드 렌더링 설정에 따라 창이 비활성일 때 재생 시간이 멈출 수 있다.

현재 5.2.2의 모델·렌더링 API도 다음과 같이 검증할 수 있다.

```powershell
$env:MCT_BLOCKBENCH_VERSION = '5.2.2'
node scripts/verify-blockbench-prepare.mjs
node scripts/verify-blockbench-runtime.mjs
```

4.12.6과 5.2.2 모두 실제 파일 플러그인 로더와 실제 CLI 파일 읽기를 사용한다. CLI가 모델 JSON과 외부 PNG/JPEG를 읽어 원본 코덱에 전달하고, Blockbench의 실제 프리뷰·텍스처·애니메이션·WebGL 렌더러와 실제 WebSocket을 사용한다. 메모리 파일 어댑터나 모의 파일 시스템을 사용하지 않는다. 5.2.2에서는 현재 코덱으로 `.bbmodel` 5.0 파일을 생성한 뒤 실제 파일에서 다시 읽는다.

이 연결 구조는 Blockbench의 파일 시스템 권한 승인을 요구하지 않는다. 사용자가 제공한 모델과 이미지 파일은 CLI가 읽는다. 플러그인 연결 설정은 앱의 **MCT: 연결 설정**에 입력한다. 테스트는 앱 권한·보안 설정을 변경하지 않는다.

## 확인하는 동작

- 본·텍스처·면별 UV·애니메이션 정보가 실제 앱의 모델과 일치한다.
- PNG가 요청한 640×480이며, 투명한 빈 화면 대신 모델 픽셀이 존재한다.
- 같은 카메라에서 애니메이션 시간을 0초에서 0.5초로 바꾸면 이미지 해시가 달라진다.
- 재생 요청 후 실제 타임라인이 진행되고, 일시 정지 요청으로 멈춘다.
- 카메라 위치를 바꾸면 이미지가 달라지며, 연속 프레임의 시간이 요청값과 일치한다.
- 존재하지 않는 클립과 잘못된 시간·좌표는 오류로 반환한다.
- 관찰·카메라·캡처·샘플링 전후 원본 파일의 SHA256이 같다.
- 잘못된 JSON으로 다시 불러오기를 시도해도 이전 프로젝트가 유지된다.
- 모델 및 외부 텍스처 편집은 changed/changedFiles로 감지하며, reload 후 새 기준을 기록한다.
- 외부 PNG를 수정하고 다시 불러오면 같은 카메라·애니메이션 시간에서 실제 화면 픽셀이 달라진다.
- 외부에서 높이를 수정한 모델을 다시 불러오면 새 높이를 읽는다.
- 세션을 닫으면 도구가 연 프로젝트만 닫히고 다른 프로젝트가 유지된다.

각 실행의 `run-*/evidence.json`에 응답·검증 항목·픽셀 수·해시·이미지 경로·앱 버전과 제한을 기록한다. `latest.json`은 가장 최근 실행의 결과를 가리킨다. 테스트는 블록 모델 생성이나 애니메이션 성공을 가짜 응답으로 대체하지 않는다.

배포본에는 [버전별 실제 검증 보고서와 대표 PNG](../bridges/blockbench/evidence/README.md)를 포함한다. 각 이미지·원본 보고서의 SHA256과 검증 범위는 같은 폴더의 `metadata.json`에 있다.

5.2.2 콘솔 오류 2건은 [MCT를 불러오지 않은 독립 비교 실행](../bridges/blockbench/evidence/5.2.2/vanilla-startup-baseline.json)에서도 그대로 재현됐다. 앱 시작 화면의 `Interface.Resizers.start_screen_width.update()` 두 호출이 없는 리사이즈 객체를 참조한 오류이며, 공식 앱 소스맵의 위치·비교 조건·판정 범위를 [진단 기록](../bridges/blockbench/evidence/5.2.2/console-diagnosis.json)에 남겼다. MCT를 평가하기 전 앱 시작 단계에서 발생했으므로 플러그인 오류로 판정하지 않는다. 원본 오류를 지우거나 앱을 수정하지 않았으며, 새 전체 실행에서 4.12.6은 15개, 5.2.2는 16개 동작·픽셀 검증을 통과했다.

동일한 비교 실행을 다시 수행하려면 5.2.2를 준비한 뒤 다음과 같이 실행한다. `baseline-complete`는 모델 기능 통과 결과와 구별되는 비교 실행 상태다.

```powershell
$env:MCT_BLOCKBENCH_BOOT_ONLY = '1'
node scripts/verify-blockbench-runtime.mjs
$env:MCT_BLOCKBENCH_BOOT_ONLY = '0'
```

## Blockbench 5.2의 실제 사용

`mct bridge config`의 endpoint/token을 앱의 **MCT: 연결 설정**에 붙여 넣는다. 최신 연결은 CLI가 모델과 외부 텍스처 데이터를 전달하므로 앱에서 파일 읽기 권한을 승인할 필요가 없다. 연결 JSON에는 로컬 접근 토큰이 포함되므로 공개하지 않는다.

모델 폴더 밖의 텍스처를 사용한다면 `model open --asset-root PROJECT_FOLDER`로 CLI가 읽을 프로젝트 범위를 명시한다. 원본 모델·이미지를 저장하거나 수정하지 않는다. 변경은 자동으로 감지하며 재검사 시 `model reload`를 호출한다.

## 실제 검증에서 수정한 오류

기존 플러그인은 애니메이션 포즈를 적용한 뒤 `Canvas.updateAll()`을 호출해 본의 변환을 초기화했다. 따라서 응답의 시간은 0.5초여도 0초와 같은 이미지가 나왔다. 현재는 모델 형상을 갱신한 뒤 포즈를 적용하고 촬영한다. 실제 앱에서 두 시간의 이미지 해시가 달라지는 회귀 검증을 포함한다.

또한 `Modes.animate`는 선택 가능한 모드 객체가 아니라 현재 상태를 나타내는 불리언이다. `Modes.options.animate.select()`로 실제 애니메이션 모드에 들어가도록 수정했다. 이 수정 전에는 재생 요청이 성공으로 반환되어도 편집 모드에 남아 실제 타임라인이 진행되지 않았다.

## 공식 근거

- [플러그인 API와 개발·테스트 안내](https://www.blockbench.net/wiki/docs/plugin/)
- [4.12.6 공식 릴리스](https://github.com/JannisX11/blockbench/releases/tag/v4.12.6)
- [5.2.2 공식 릴리스](https://github.com/JannisX11/blockbench/releases/tag/v5.2.2)
- [5.2.2 네이티브 API 및 폴더 권한 구현](https://github.com/JannisX11/blockbench/blob/v5.2.2/js/native_apis.ts)
- [별도 userData를 지원하는 공식 앱 실행부](https://github.com/JannisX11/blockbench/blob/v5.2.2/electron/main.js)
