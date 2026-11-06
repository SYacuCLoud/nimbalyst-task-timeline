# Task Timeline (Nimbalyst 확장)

Nimbalyst 트래커 항목을 시작일(`startDate`)과 마감일(`dueDate`) 기준의 간트형 타임라인으로 보여 주는 확장입니다. 마일스톤은 `targetDate`를 씁니다.

## 주요 기능

- 확대 단계: 일 · 주 · 월
- 그룹 기준: 없음 · 상태 · 담당자 · 우선순위 · 타입
- 타입 필터: `Task + Milestone`(기본) · 전체 · 개별 타입
- 토글: 완료 포함 · 에이전트 작업(`data.createdByAgent`) · 날짜 미지정 표시
- 시작일이나 마감일 중 하나만 있는 항목은 줄무늬 막대로 표시
- 마감이 지난 미완료 항목 강조, 일 단위 보기에서 주말 음영, 오늘 선
- 의존 관계(`dependsOn`) 화살표. 선행 항목이 후행 항목 시작 뒤에 끝나면 다른 색으로 표시
- `오늘` 버튼으로 오늘 위치로 이동
- 막대나 왼쪽 이름을 클릭하면 Nimbalyst 트래커 항목 열기
- 새 항목 만들기
  - 툴바의 `+ 새 항목` 폼: 타입 · 제목 · 시작 · 마감 · 우선순위. Enter로 추가(연속 입력 가능), Esc로 닫기
  - 타임라인 맨 아래 줄을 드래그해 기간을 고르면 폼에 시작·마감일이 채워짐
- 10초마다 자동 새로고침, 보관·삭제된 항목은 제외

## 설치

Windows 기준입니다. 빌드 단계가 없습니다.

1. 저장소를 받습니다: `git clone https://github.com/SYacuCLoud/nimbalyst-task-timeline.git`
2. `manifest.json`과 `dist/`를 `%APPDATA%\@nimbalyst\electron\extensions\com.syacucloud.task-timeline\`에 그대로 복사합니다.
3. Nimbalyst를 다시 시작합니다.

Nimbalyst **Settings > Advanced > Extension Dev Tools**를 켜고 `extension_install`을 써도 됩니다.

## 권한과 제한

- 권한: `nimbalyst-database-read` (트래커 항목 읽기)
- 항목 생성과 열기는 Nimbalyst 렌더러 내부 IPC(`window.electronAPI`, `nimbalyst:navigate-tracker-item` 이벤트)를 사용합니다. 공개 API가 아니므로 Nimbalyst 업데이트로 바뀔 수 있습니다.
- 생성 API가 없는 Nimbalyst 버전에서는 새 항목 폼과 드래그 줄이 나타나지 않고 읽기 전용으로 동작합니다.
- 표시 대상은 날짜가 있는 항목입니다. 날짜가 없는 항목은 `날짜 미지정` 그룹에 따로 모입니다.

## 개발

`dist/index.js`가 손으로 쓴 ES 모듈 원본입니다. 소스 폴더와 빌드 단계가 없으므로 이 파일을 직접 수정합니다.

Nimbalyst 공식 확장이 아닌 개인 프로젝트입니다.
