# 서버 작업 취소와 Paper 검증

## 취소 API

내부 `ServerService.call(action, args)`는 모든 작업에서 `args.signal: AbortSignal`을 받는다. CLI 작업 관리자는 해당 신호를 전달해 취소한다. 취소를 성공으로 처리하는 시점은 실제 읽기·복사 스트림과 소유한 서버 프로세스의 정리가 끝난 뒤다.

- 매니페스트·버전 정보·Paper 빌드 조회와 응답 본문 읽기를 중단한다.
- 서버 JAR는 스트리밍으로 쓰면서 공식 SHA1/SHA256과 크기를 검증한다. 실패·취소 시 임시 다운로드가 남지 않는다.
- 월드는 파일·청크 사이에서 신호를 확인하며 별도 임시 디렉터리에 복사한다. 원본의 심볼릭 링크·정션은 거부한다.
- 구성과 provenance가 완성된 후 최종 디렉터리로 이동하고 세션을 등록한다. 취소되면 등록·인덱스·소유한 임시/최종 디렉터리를 되돌린다.
- `start`에 신호를 주거나 `wait: true`로 호출하면 실제 준비 완료까지 기다린다. 기본 제한은 180초이며 `timeoutMs`로 조절한다. 신호가 없는 기존 `start` 호출은 즉시 `starting` 상태를 반환한다.
- 시작 취소는 **그 호출이 생성한 프로세스만** `stop`으로 종료한다. 3초 안에 멈추지 않으면 강제 종료하고 종료 이벤트를 기다린다. 다른 서버는 건드리지 않는다.
- 정리가 실패하면 `CANCELLATION_CLEANUP_FAILED`를 반환한다. 이 상태를 취소 완료로 표시하면 안 된다. 보통의 정리 완료 취소는 `CANCELLED`다.
- 서비스 종료도 진행 중인 생성 작업을 취소하고 정리 완료를 기다린다. Java 서버 콘솔 인코딩은 UTF-8로 고정한다.

회귀 검증:

```powershell
pnpm build
node node_modules/tsx/dist/cli.mjs --test tests/servers.test.ts
node scripts/verify-server-java.mjs
node scripts/verify-server-cancel.mjs --accept-eula
node scripts/verify-player-cancel.mjs --accept-eula
```

단위 검사는 헤더 대기, 응답 본문, JAR 다운로드, 월드 복사의 두 번째 청크, 최종 세션 등록과 서버 시작에서 취소한다. 실제 Java 검사는 시작 중 취소가 반환된 뒤 해당 PID가 존재하지 않는지도 확인한다.

## 정확한 버전의 Paper 안정 빌드

`verify-paper-matrix.mjs`는 Mojang 정식 버전 목록의 1.20 이상을 대상으로 한다. 각 버전의 공식 Fill API에서 `STABLE` 빌드와 SHA256을 확인하며 다른 버전으로 바꾸지 않는다. 빌드가 없으면 `unavailable`, 빌드는 있지만 검사를 수행하지 않았으면 `available-unverified`, 실제 일곱 시나리오를 모두 통과해야 `passed`다.

```powershell
node scripts/verify-server-java.mjs
pnpm build
node scripts/verify-paper-matrix.mjs --accept-eula --backend bot --resume
node scripts/verify-paper-matrix.mjs --accept-eula --backend fabric --resume
```

접속, 관찰·인벤토리, 실제 이동, 플레이어 명령의 결과, 상자 GUI, 캡처, 이동 취소를 검사한다. 봇 검증은 Mineflayer가 명시한 정확한 버전만 사용한다. 봇 캡처는 Prismarine 근사 렌더링이며 실제 게임 HUD·리소스팩 검증으로 표시하지 않는다. Fabric 검증 결과는 해당 JAR 해시와 실제 프레임버퍼 출처를 별도로 기록한다.

결과와 이미지·서버 로그는 `work/paper-qa`에 저장한다. `--versions 1.21.4`로 일부 버전만 다시 실행할 수 있다. `MCT_DOWNLOAD_USER_AGENT`로 배포 주체의 연락 URL을 포함한 다운로드 User-Agent를 지정할 수 있다. 런타임 준비는 공식 Adoptium JRE 17·21 ZIP의 SHA256을 검증하며 전역 설치와 시스템 설정 변경을 하지 않는다.

공식 근거: [Paper 다운로드 서비스](https://docs.papermc.io/misc/downloads-service/), [Fill API](https://fill.papermc.io/v3/projects/paper), [Mojang 버전 목록](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json).

## 플레이어 작업 취소

`PlayerService.call`도 `args.signal`을 받는다. 이동 취소는 경로 목표와 누른 입력을 해제하고 연결을 유지한다. 연결 도중 취소하면 자신이 만든 봇의 종료 이벤트를 기다린 뒤 미완성 세션을 제거한다. 이미 취소된 신호로 호출하면 기존 연결에 영향을 주지 않는다.

Mineflayer의 상자 열기·인벤토리 거래에는 개별 중단 API가 없다. 진행 중 취소하면 입력을 해제하고 해당 봇 연결의 종료까지 기다린다. 따라서 다시 조작하려면 재연결해야 한다. 촬영 취소는 그 촬영이 소유한 브라우저의 종료를 기다리고 미완성 PNG·메타데이터를 지운다. 브라우저 시작 도중에는 시작 함수가 정리 가능한 핸들을 반환할 때까지 기다린다. 기존 뷰어는 재사용할 수 있다. `player stop`은 이동·촬영·프로토콜 대기도 취소한다. 정리 실패는 서버와 같은 `CANCELLATION_CLEANUP_FAILED`다.

```powershell
$env:MCT_TEST_BROWSER = '1'
node node_modules/tsx/dist/cli.mjs --test tests/players.test.ts tests/servers.test.ts
```

브라우저 검사를 켠 38개 회귀 검사가 실제 Prismarine 청크 렌더링을 포함해 통과했다. 실제 1.21.4 서버에서는 연결 초기 종료 함수가 아직 주입되지 않은 상태의 취소, 이동 정지, 촬영 취소 후 재촬영, 상자 열기 취소 후 연결 종료도 확인했다. 이 결과는 Paper 버전별 게임플레이 결과와 별도로 다룬다.

배포용 검증 자료는 [서버 검증 증거](evidence/servers/README.md)에 모은다. 최종 전체 결과가 완성되고 Fabric 해시가 일치할 때만 다음 명령이 이를 생성한다.

```powershell
node scripts/publish-server-evidence.mjs
```
