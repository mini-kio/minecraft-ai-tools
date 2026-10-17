# 미리보기 렌더링과 실제 게임 화면

독립 뷰어는 정확한 게임 버전의 Java 클라이언트 자산과 사용자가 지정한 리소스팩을 읽는다. 실제 게임 화면은 구현된 네이티브 뷰어를 통해 같은 버전의 Fabric 클라이언트에서 관찰한다. 독립 뷰어의 결과에는 항상 `fidelity.exactGamePixels: false`가 포함된다.

## 텍스처와 모델

- `.png.mcmeta`의 프레임 순서, 기본 `frametime`, 프레임별 `time`, `width`·`height`, `interpolate`를 사용한다. 시간은 Minecraft의 20Hz 틱에 맞추며 보간 시 RGBA 채널을 섞는다. PNG를 덮어쓴 팩에 `.mcmeta`가 없으면 아래 팩의 애니메이션을 상속하지 않는다.
- 가중 모델 배열과 multipart 배열은 각 블록 좌표에 기반한 일정한 선택을 한다. 입력 순서와 다시 불러오기에 따라 변형이 바뀌지 않는다. 모든 블록에 첫 번째 항목을 적용하지 않는다. 미리보기 난수 방식은 게임 내부 버전별 난수 방식과 다를 수 있다.
- 블록 속성이 생략되면 해당 버전의 기본 상태를 채워 모델을 선택한다. 원래 블록 상태 키는 결과에 유지한다.
- 물·용암은 상태의 `level`에 맞는 높이, 인접 유체의 면 제거, 실제 유체 텍스처와 애니메이션을 사용한다. 흐름 경사·굴절·혼합 순서는 게임과 차이가 있다.

뷰어의 텍스처 재생 컨트롤에서 시간을 고정할 수 있다. 내부 `captureViewer`의 `animationTimeMs`도 시간을 고정한다. 캡처는 실제 적용한 `animationTimeMs`, 프레임 인덱스와 보간 비율을 반환한다. CLI에서 추가 인자는 JSON `--data`로 전달할 수 있다.

## 환경과 엔티티

블록의 `environment.light.sky`·`block`이 있으면 밝기에 적용한다. `biomeTint`의 `grass`·`foliage`·`water` RGB가 있으면 해당 값을 사용하고, 바이옴 이름만 있으면 표시용 색상표를 사용한다. 빛이 없는 포맷과 미확인 입력은 알려진 정보로 표시하지 않는다. 실제 조명 셰이더와 바이옴 색상 혼합은 게임 렌더러에서 확인한다.

저장된 엔티티와 블록 엔티티는 이름이 붙은 선택 가능한 윤곽으로 표시한다. 선택하면 원본에서 읽은 위치·회전·NBT를 볼 수 있다. 이 윤곽은 실제 엔티티 모델이나 애니메이션을 대신한다고 주장하지 않는다. `fidelity.entityRendering`·`blockEntityRendering`은 `labelled-proxies`다.

## 패킷 계약

`resourcePreview.models`는 형상 키에서 면 배열로 매핑한다. 가중 변형과 유체는 `modelAssignments["x,y,z"]`로 각 블록의 형상 키를 지정한다. 기존 단일 모델의 상태 키도 유지한다.

`textures[id].animation`은 다음 정보를 담는다.

```json
{
  "frameWidth": 16,
  "frameHeight": 16,
  "columns": 1,
  "frames": [{"index": 0, "durationMs": 200}, {"index": 1, "durationMs": 400}],
  "totalDurationMs": 600,
  "interpolate": true,
  "tickMs": 50
}
```

미리보기는 블록별 `environment`, 최상위 `entities`·`blockEntities`를 받는다. 환경 필드는 저장 파일에 있을 때만 알려진 값으로 표시하며, 누락 이유와 각 입력의 개수를 캡처 메타데이터에 남긴다.

## 대표 검증: 26.3

추가 게임 버전 실행 없이 26.3 자산과 실제 Chromium을 사용한 한 가지 대표 시나리오를 검증했다. 빨강 프레임, 보라 보간 프레임, 파랑 프레임, 긴 프레임의 유지 시간, 반복 시작을 실제 캡처 픽셀로 확인했다. 엔티티·상자 윤곽과 환경 입력의 출처도 같은 시나리오에서 확인했다.

```powershell
$env:MCT_TEST_BROWSER = '1'
$env:MCT_RENDER_EVIDENCE_DIR = 'work/rendering-26.3'
node node_modules/tsx/dist/cli.mjs --test tests/rendering.test.ts
```

형상·가중치·메타데이터의 단위 검사는 `tests/resources.test.ts`에 있다. 이 검사는 게임 서버나 클라이언트를 실행하지 않는다. 대표 검증 이미지·보고서는 지정한 증거 폴더에 저장되며 게임 자산 자체는 배포하지 않는다.
