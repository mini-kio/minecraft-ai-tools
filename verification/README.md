# 0.2.0 검증 기록

[summary.json](summary.json)에 현재 자동 검사 결과와 실제 실행 증거 위치를 기록했다. 자동 검사는 95개 중 93개 통과, 실패 0개이며 외부 런타임 선택 검사 2개는 기본 실행에서 생략된다. 실제 서버·브라우저 실행 기록은 별도로 포함한다.

사용자의 최종 요청은 **전체 버전 반복 검증을 중단하고 대표 26.3으로 확인**하는 것이다. 26.3의 네이티브 GUI·한글·핫바·충돌·캡처 등 13개 시나리오가 통과했다. 중단 전 끝난 현 JAR 검증 20개 버전은 보존하며, 1.21.8–1.21.11은 현 JAR 실행 미검증으로 기록한다. 24개 버전 JAR는 모두 빌드됐고, 사전 충돌 데이터는 23개 버전에 있으며 1.21.11은 미생성이다.

- [정확한 Fabric 빌드·실행 증거](../bridges/fabric/compatibility.json)
- [실제 충돌 레지스트리 데이터와 누락 목록](../bridges/fabric/collision-data/index.json)
- [개별 schem/nbt/mca의 실제 26.3 배치·촬영·핫바와 원본 보존](file-stage-client/report.json)
- [ZIP 리소스팩이 실제 렌더링 픽셀을 바꾸는 검사](resource-preview/report.json)
- [네이티브 실내 검사·보행·투어 기록](native-flow/report.json)
- [전체 월드 복사본 관찰과 원본 33개 파일 보존](native-stage/report.json)
- [실제 모델·외부 텍스처 파일의 Blockbench 변경 감지·재검사](../bridges/blockbench/evidence/README.md)
- [Paper 17개 안정 빌드 및 실제 작업 취소 증거](../docs/evidence/servers/README.md)

원본 JSON의 절대 경로는 실행 당시 기록이다. 배포본에서 사용할 수 있는 상대 경로와 SHA256은 summary.json 또는 각 증거 폴더의 metadata/sha256 파일에 있다. 게임 자산·계정·접근 토큰·테스트 월드는 배포하지 않는다. 미리보기 조명·바이옴·특수 렌더러와 개체 의존 충돌은 실제 게임 관찰을 함께 사용한다.
