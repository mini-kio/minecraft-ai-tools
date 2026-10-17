# AI 사용 계약

1. `mct --help`, `mct doctor`, `mct session list`로 실행 환경을 확인한다.
2. 명령 결과의 `ok`를 확인한다. 오류 코드는 누락된 연결과 버전 불일치를 구분한다.
3. JSON의 imagePath는 별도의 이미지 읽기 도구로 열어 관찰한다. 경로를 받았다는 사실만으로 내용을 보았다고 말하지 않는다.
4. 관찰 결과의 source, version/gameVersion, observedAt, frame/tick을 함께 사용한다. java-resource-model-preview/structural-preview와 실제 게임 framebuffer의 표현 차이를 고려한다.
5. 큰 월드는 bounds를 지정한다. 전체 월드를 메모리에 올리거나 파일 전체를 명령 출력에 나열하지 않는다.
6. 내부를 만들기 전에 층과 방별 방문 지점을 inspection.json에 정한다. 구조 제작 후 평면·단면·내부 시점을 확인하고 가구 배치 후 다시 검사한다.
7. unreachable_in_profile은 현재 보행 조건의 결과다. unknown은 추가 관찰이 필요하다. 정적 검사 결과로 실제 방문을 주장하지 않는다.
8. 원본 파일 변경은 기존 파일 도구로 수행한다. mct의 reload로 새 결과를 읽고 source 변경 여부를 확인한다.
9. 이동은 시간 제한을 지정한다. 멈추거나 경로가 막히면 stop하고 observe로 상태를 다시 확인한다.
10. 명령 전송 성공과 서버 실행 성공을 구분한다. 서버 로그·메시지·GUI·상태 변화로 검증한다.

기본 출력은 JSON이며 --data JSON과 --input FILE로 구조화된 인자를 전달한다. 예외 작업은 --async로 시작하고 job status/cancel로 관리한다. 세션 ID는 현재 daemon 실행에 속한다.

모델 inspect/watch의 changed 및 changedFiles로 외부 수정을 감지하고 reload로 갱신한다. job cancel 뒤 cancelling은 정리가 진행 중임을 뜻한다. cancelled/failed 최종 상태를 확인한다. 파일 맵은 map stage로 격리된 실제 월드에서 볼 수 있고, resourcePack을 적용한 미리보기와 실제 게임 화면의 차이는 source와 limitations로 확인한다.
