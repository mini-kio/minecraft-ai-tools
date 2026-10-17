# Minecraft AI Tools · mct

AI가 만든 마인크래프트 맵과 모델을 관찰하고, 게임에서 직접 조작하며, 건물 내부를 검사하는 로컬 CLI입니다. 파일 작성과 설계는 기존 AI가 담당합니다.

## 실행

Node.js 24 이상과 pnpm이 필요합니다. Downloads의 프로젝트에는 의존성과 빌드 결과가 준비되어 있습니다. 배포 ZIP에는 소스·CLI 빌드·24개 버전의 Fabric 보조 모드를 포함하며, 압축을 푼 곳에서는 아래 설치 명령을 실행합니다.

```powershell
cd C:\Users\kiola\Downloads\minecraft-ai-tools
.\mct.cmd --help
.\mct.cmd doctor
```

새로 설치하거나 소스를 수정한 경우:

```powershell
pnpm install
pnpm build
pnpm exec playwright install chromium
pnpm test
```

CLI는 필요할 때 로컬 daemon을 자동으로 시작합니다. JSON은 stdout, 진단은 stderr로 출력합니다. 세션과 이미지는 `.mct/`에 저장합니다. `mct daemon stop`은 연결을 해제하고 관리 중인 테스트 서버를 종료합니다. daemon 재시작 후 맵·플레이어·모델 연결은 다시 열어야 하며 진행 중인 작업을 자동 재실행하지 않습니다.

장시간 명령은 `--async`로 실행하면 작업 ID를 반환합니다. `job cancel JOB_ID`는 다운로드·월드 복사·서버 시작·실내 검사·이동·촬영·모델 샘플링에 취소 신호를 보내며, 파일·프로세스·입력이 정리될 때까지 상태는 `cancelling`입니다. 정리에 실패하면 실패 이유를 반환합니다.

## 맵과 건물 내부

입력: Java 월드 폴더, `.mca`, Sponge `.schem` v1–3, Java structure `.nbt`. 원본 파일은 읽기 전용입니다. 26.x의 `dimensions/minecraft/overworld` 배치와 새 블록 팔레트도 읽습니다. 큰 월드는 필요한 구역을 `--data`로 지정합니다.

```powershell
node examples/create-demo.mjs work/demo
$opened = .\mct.cmd map open work/demo/two-floor-house.schem | ConvertFrom-Json
$map = $opened.result.session
.\mct.cmd map capture $map --cut-y 2
.\mct.cmd map slice $map --axis x --at 8
.\mct.cmd interior check $map --inspection work/demo/inspection.json
.\mct.cmd map inspect $map --position 12,1,2
```

데모에는 올라갈 수 있는 계단과 침실, 닫힌 문으로 막힌 창고, 낮은 천장이 있습니다. 보고서는 도달 가능·현재 보행 조건에서 실패·판정 불가를 구분하고 실패 좌표와 이미지를 제공합니다. `viewerUrl`을 브라우저에서 열면 회전·확대·블록 선택·높이 절단이 가능합니다.

독립 3D 뷰어는 정확한 버전의 Java 클라이언트 자산에서 모델·텍스처를 읽습니다. 최초 사용 시 필요한 공식 자산을 확인·다운로드하며, 게임 본체 자산은 배포 ZIP에 포함하지 않습니다. 폴더 또는 ZIP 리소스팩을 겹쳐 적용할 수 있고, 뒤의 팩이 우선합니다.

```powershell
.\mct.cmd map resources MAP_ID --resource-pack pack.zip
.\mct.cmd map capture MAP_ID --cut-y 2
.\mct.cmd map capture MAP_ID --no-textures
```

`--assets-jar`로 동일 버전의 로컬 클라이언트 JAR을 사용할 수 있습니다. 부모 모델·좌표별 가중 블록 상태·multipart·UV 회전·UV lock, `.mcmeta` 프레임 길이와 보간을 처리합니다. 저장된 청크의 조명·바이옴 색상과 유체 높이를 반영하며 엔티티는 선택 가능한 대체 형태로 표시합니다. 실제 엔티티 모습과 특수 렌더러를 포함한 정확한 화면은 Fabric으로 stage한 뒤 `map view`의 실시간 게임 화면 또는 `map capture`에서 확인합니다. 미리보기의 근사 범위는 JSON에 표시합니다.

0.3.0은 `.schem`·`.nbt`의 자유 엔티티와 탑승 관계도 복사본으로 가져옵니다. 입력을 다시 가져올 때 기존 수입 엔티티를 확인하고 교체하며, 텍스트 표시의 줄바꿈 등 원본 NBT는 이진 저장소로 보존합니다.

오프라인 충돌 표가 없는 게임 버전에서는 일치하는 실제 클라이언트로 표를 생성한 후 다시 검사할 수 있습니다. 특수 이동이나 관측하지 않은 맥락 의존 충돌은 계속 판정 불가로 표시합니다.

`map stage`의 테스트 서버 시야 거리는 기본 12청크이며 `--view-distance 2..32`로 조절합니다. 큰 건물을 위에서 관찰할 때 서버가 전송하는 청크와 게임 안개 범위를 함께 확보합니다. 실내 방문 실패 보고서는 실제 막힌 좌표와 당시 목표 좌표를 보존합니다.

```powershell
.\mct.cmd map collisions MAP_ID --client CLIENT_ID
.\mct.cmd map capture MAP_ID --animation-time-ms 200
```

직접 제작하고 이 CLI로 관찰한 예제: [크리스마스 마을](https://github.com/mini-kio/snowy-christmas-village), [애니메이션 크리스마스 모델 5종](https://github.com/mini-kio/snowy-christmas-models).

큰 월드의 구역 선택 예 (`bounds.json`에 구조화된 인자를 저장):

```powershell
@'
{"bounds":{"min":{"x":0,"y":50,"z":0},"max":{"x":31,"y":90,"z":31}}}
'@ | Set-Content -Encoding utf8 bounds.json
.\mct.cmd map view MAP_ID --input bounds.json
```

Windows의 `.cmd`와 PowerShell 인자 처리 과정에서 인라인 JSON의 따옴표가 사라질 수 있으므로, 구조화된 인자는 `--input FILE`을 권장합니다.

검사는 `examples/inspection.json`처럼 입구, 층, 이름 붙인 방문 지점을 받습니다. 좌표는 블록 단위이며 entry와 targets.position은 플레이어 발 위치입니다. 일반 보행·계단·반 블록을 검사하고 점프·수영·사다리·특수 이동은 자동으로 가능하다고 가정하지 않습니다. 문은 현재 열린 상태를 사용합니다.

`bridges/fabric/collision-data`의 정확한 게임 레지스트리 데이터를 사용하면 최신 버전도 게임 연결 없이 일반 블록·계단·문의 충돌을 검사합니다. 사전 추출 데이터는 23개 버전에 있으며 1.21.11은 미생성으로 표시합니다. 해당 버전은 기존 충돌 라이브러리 또는 실제 클라이언트에서 확인합니다. 위치·이웃·개체 상태에 의존하는 충돌은 추출 당시의 조건이 맞는 경우만 사용하고, 나머지는 `unknown`으로 보고합니다.

정확한 최신 게임 충돌 데이터로 검사할 수 있습니다:

```powershell
.\mct.cmd interior check --client CLIENT_ID --inspection inspection.json
.\mct.cmd player move CLIENT_ID --position 10.5,65,20.5 --timeout-ms 30000
.\mct.cmd interior tour MAP_ID --inspection inspection.json --player PLAYER_ID --async
```

실제 클라이언트 이동은 현재 로드된 블록의 충돌 형상으로 경로를 계산하고, 보행 입력과 실제 위치 변화로 도착을 확인합니다. 블록 설치·파괴나 순간이동으로 보행 성공을 만들지 않습니다. 각 실제 방문에서는 네 방향 이미지를 캡처합니다. 보고서의 기하학적 경로와 실제 방문 증거는 구분됩니다.

## 실제 게임과 가짜 플레이어

실제 게임은 사용자가 기존 런처로 로그인·실행합니다. `bridges/fabric/dist/`의 **게임과 정확히 같은 버전** JAR을 해당 Fabric 프로필의 mods 폴더에 넣고 재시작합니다. 모드는 Fabric Loader를 사용하며 Fabric API는 필수 의존성이 아닙니다.

```powershell
.\mct.cmd client list
.\mct.cmd client attach '게임프로필\.mct\fabric-PID.json'
.\mct.cmd client observe CLIENT_ID
.\mct.cmd client capture CLIENT_ID
.\mct.cmd player look CLIENT_ID --yaw 1.57 --pitch 0
.\mct.cmd client input CLIENT_ID --key forward --duration-ms 500
.\mct.cmd client inventory CLIENT_ID
.\mct.cmd player inventory CLIENT_ID --operation select --slot 3
.\mct.cmd client input CLIENT_ID --key chat
.\mct.cmd client gui CLIENT_ID --type text --text '안녕하세요'
.\mct.cmd client input CLIENT_ID --key escape
.\mct.cmd client stop CLIENT_ID
```

GUI 클릭 좌표는 응답 screen.width/height의 논리 좌표입니다. 이미지 픽셀 크기와 다를 수 있습니다. `gui`는 click, scroll, text, key를 지원합니다. 키코드가 필요한 저수준 GUI 입력은 해당 연결의 native API이며, 일반 게임 이동은 forward/jump 같은 의미 단위를 사용합니다. CLI look 명령과 관찰의 yaw/pitch는 라디안입니다. 보조 모드의 원본 HTTP API는 도 단위를 사용하며 CLI가 변환합니다.

가벼운 프로토콜 봇:

```powershell
.\mct.cmd player connect 127.0.0.1:25565 --version 1.21.4 --username MCTObserver
.\mct.cmd player observe PLAYER_ID
.\mct.cmd player move PLAYER_ID --position 5.5,65,8.5
.\mct.cmd player command PLAYER_ID --text 'say inspection started'
.\mct.cmd player capture PLAYER_ID
.\mct.cmd player disconnect PLAYER_ID
```

`--backend auto`는 라이브러리가 지원하는 정확한 버전에서 봇을 사용하고, 그 외에는 같은 버전의 연결된 실제 클라이언트를 사용합니다. 게임 버전을 낮춰 연결하지 않습니다. 온라인 봇은 `--auth microsoft`를 명시하면 JSON에 로그인 안내가 반환됩니다. 토큰 캐시는 `.mct/auth/`에만 저장합니다. 이미 로그인한 실제 클라이언트 연결도 가능합니다.

## Blockbench 모델

Blockbench Desktop의 Plugins → Load Plugin from File에서 `bridges/blockbench/mct_bridge.js`를 설치합니다. Blockbench 5 이상에서는 `mct bridge config` 결과의 endpoint/token을 Blockbench의 Tools → MCT 연결 설정에 넣습니다. 구버전은 기본 프로젝트 경로의 daemon 설정도 자동으로 읽습니다. 이 설정에는 로컬 접근 토큰이 포함되므로 공개 자료에 복사하지 않습니다.

```powershell
.\mct.cmd model open model.bbmodel
.\mct.cmd model inspect MODEL_ID
.\mct.cmd model camera MODEL_ID --position 40,30,40 --target 0,8,0
.\mct.cmd model animation MODEL_ID --clip walk --time 0.5
.\mct.cmd model capture MODEL_ID
.\mct.cmd model sample MODEL_ID --clip walk --from 0 --to 1 --frames 8
.\mct.cmd model reload MODEL_ID
.\mct.cmd model watch MODEL_ID
```

모델은 전용 프로젝트로 열며 원본을 저장하지 않습니다. `.bbmodel`과 Java block/item JSON을 원래 렌더러에서 확인합니다. 커스텀 몹의 게임 적용은 프로젝트가 사용하는 리소스팩·플러그인·모드에서 검증합니다.

CLI가 실제 모델·외부 PNG/JPEG를 읽어 데이터를 전송하므로 Blockbench에 별도의 파일 시스템 권한을 줄 필요가 없습니다. 모델과 텍스처의 외부 편집은 `changed`·`changedFiles`로 감지하고 `reload` 후 새 기준을 기록합니다. 외부 텍스처가 모델 폴더 밖에 있으면 `model open --asset-root PROJECT_FOLDER`로 프로젝트 범위를 지정합니다.

## 테스트 환경과 실제 월드 보기

서버 기능에는 버전에 맞는 Java가 필요합니다: 1.20–1.20.4는 Java 17, 1.20.5–1.21.11은 Java 21, 26.x는 Java 25. `--java-path` 또는 `MCT_JAVA`로 실행 파일을 지정합니다.

```powershell
.\mct.cmd test create --version 26.3 --accept-eula --port 25573
.\mct.cmd test start SERVER_ID --java-path 'JDK경로\bin\java.exe'
.\mct.cmd test observe SERVER_ID
.\mct.cmd test command SERVER_ID --text 'say test'
.\mct.cmd test stop SERVER_ID
```

공식 다운로드의 체크섬을 검증합니다. 테스트 서버는 localhost에서만 접속 가능한 offline 환경입니다. `--accept-eula`는 Minecraft EULA 수락 의사를 명시하는 옵션입니다. Paper는 `--software paper`로 선택하며 해당 정확한 버전에 안정 빌드가 있어야 합니다.

전체 월드 폴더는 복사본을 테스트 서버에서 열고 실제 게임으로 확인할 수 있습니다. `.schem`·Java 구조물 `.nbt`는 같은 버전의 새 테스트 월드에 블록·블록 엔티티를 배치하며, 단일 `.mca`는 영역과 필요한 외부 청크를 복사합니다. 연결할 클라이언트는 먼저 서버에서 나와 있어야 합니다.

```powershell
.\mct.cmd map stage MAP_ID --client CLIENT_ID --accept-eula --java-path 'JDK경로\bin\java.exe'
.\mct.cmd map camera MAP_ID --position 0,80,0 --target 10,65,10
.\mct.cmd map capture MAP_ID
.\mct.cmd map close MAP_ID
```

이 경로의 자유 카메라는 격리한 월드의 관전 모드입니다. 원본에는 쓰지 않습니다. 파일 배치는 서버 로그로 실제 처리를 확인하고, 큰 입력은 `--input` 파일의 bounds 필드로 구역을 한정할 수 있습니다. [배치 범위와 데이터 보존](docs/file-staging.md)에 상세 조건을 기록합니다.

`map camera --position`은 플레이어의 발 좌표입니다. `--target`은 바라볼 월드 좌표이며, 이동 후 실제 플레이어 위치와 발보다 1.62블록 높은 눈 위치를 기준으로 시선을 맞춥니다. Minecraft가 정수 X·Z를 블록 중앙으로 보정한 결과는 반환되는 `actualPosition`과 `eyePosition`에 반영됩니다.

## 검증과 현재 범위

- `pnpm test`: 파일 읽기·원본 보존·충돌·계단·문·실패 좌표·연결·취소·체크섬·버전 계약 검증.
- `tests/players-live.test.ts`: 실제 1.21.4 Vanilla 서버와 봇·상자·시야 캡처 검증. 환경변수 `MCT_TEST_LIVE=1`, `MCT_TEST_JAVA=java.exe 경로`로 실행합니다.
- Fabric의 버전별 빌드와 실제 실행 결과는 `bridges/fabric/compatibility.json` 및 `docs/testing-legacy.md`를 확인합니다. 컴파일 성공과 실제 시나리오 통과는 따로 기록합니다.
- 24개 버전의 보조 모드를 빌드했습니다. 사용자의 요청에 따라 대표 버전 26.3에서 강화된 통합 검증을 통과하고, 나머지 전체 버전 검증은 중단했습니다. 완료된 20개 버전 기록을 보존하며, 현 JAR 기준 1.21.8–1.21.11은 미검증입니다. [통합 검증 기록](verification/README.md)에 실제 이미지와 범위가 있습니다.
- Paper는 정확한 버전의 안정 빌드가 있는 17개에서 실제 동작을 확인했고, 안정 빌드가 없는 7개를 구분합니다. [서버 검증 기록](docs/evidence/servers/README.md)을 확인합니다.
- Blockbench 4.12.6·5.2.2에서 실제 CLI 파일 읽기와 실제 코덱·렌더러·애니메이션·텍스처 변경·재검사를 확인합니다. [검증 안내](docs/testing-blockbench.md)에 실행 범위를 기록합니다.
- 3D 미리보기는 Java 모델·텍스처·리소스팩을 적용합니다. 실제 조명·엔티티·리소스팩 렌더링의 최종 결과는 `minecraft-client` 캡처로 확인합니다.
- 게임/Blockbench 연결이 없거나 버전별 기능이 지원되지 않으면 명시적 오류를 반환합니다. 오래된 이미지와 확인되지 않은 도달 결과를 성공으로 반환하지 않습니다.
