# 홍보 채널 지도 (2026-08-18 실측)

저장소: https://github.com/jckproduct-ai/jd-search

## 현재 도달 실측

| 항목 | 값 | 측정 |
|---|---|---|
| 저장소 생성 | 2026-08-10 | GitHub API |
| 별 | 1 | GitHub API |
| 14일 조회 | 7회 · 순방문 2명 | `/traffic/views` |
| Watchers | 0 | GitHub API |
| 이슈 | 0 | GitHub API |

물건 문제가 아니라 도달 문제다. README·스크린샷·CI·라이선스는 이미 갖춰져 있는데 유입 경로가 없었다.

## 조치 완료 (2026-08-18)

- 토픽 15개 등록 — `claude-code` `claude-plugin` `agent-skills` `ai-agent` `job-search` `job-board` `recruiting` `career` `korea` `korean` `dart` `financial-analysis` `due-diligence` `zero-dependency` `nodejs`
- Discussions 활성화 — 피드백 창구가 이슈밖에 없었다
- 저장소 설명에 영문 병기 — GitHub 검색은 영어 질의가 압도적으로 많다
- README에 영문 요약 블록 추가 — awesome 리스트 심사자와 영어권 유입 대비

## 채널별 자격 요건 (실측 확인)

### 지금 가능

| 채널 | 조건 | 초안 |
|---|---|---|
| GeekNews (news.hada.io) | 없음. 사람이 직접 제출 | `geeknews_20260818.md` |
| velog · 브런치 | 없음 | `blog_20260818.md` |
| Threads · Instagram | 없음 | `social_20260818.md` |
| 저장소 Discussions 첫 글 | 없음 | `discussions_welcome.md` |
| OKKY · 커리어리 | 없음. 광고 톤이면 역효과 | `blog_20260818.md` 요약본 재사용 |

### 아직 자격 미달 — 별을 먼저 모아야 한다

| 리스트 | 별 | 요건 | 현재 상태 |
|---|---|---|---|
| hesreallyhim/awesome-claude-code | 52.5k | 첫 커밋 후 14일 경과 + 지속 개발, 또는 별 100개 | 8일차. **2026-08-24부터 자격 충족** |
| travisvn/awesome-claude-skills | 14.7k | 별 10개 미만이면 자동 종료 | 별 1개. 미달 |
| ComposioHQ/awesome-claude-skills | 72.7k | 스킬 본문을 그들 저장소에 복사 | AGPL-3.0 과 라이선스 충돌 소지. 보류 |

awesome 리스트가 홍보의 출발점이 아니라 도착점이다. hesreallyhim 은 기여 문서에서 이 순서를 직접 못박고 있다 — "만든다 → 리스트 등재 → 사용자 확보"가 아니라 "만든다 → 사용자 확보 → 등재"다.

### 제출 규칙 (위반 시 차단 위험)

- hesreallyhim: **웹 UI 이슈 폼으로만** 제출. PR 금지, `gh` CLI 불가. 한 번에 하나만. 설명은 홍보 문구가 아니라 서술문, 이모지 금지, 한 줄
- travisvn: 포크 후 PR. 형식 `- **[이름](링크)** - 설명`
- 전 채널 공통: 게시는 사람이 직접 한다. 자동 포스팅 금지

## 순서

1. GeekNews 제출 (지금)
2. velog 글 게시 → GeekNews 에 글도 별도 제출 가능
3. 유입·별 관찰 1주
4. 2026-08-24 이후 hesreallyhim 이슈 폼 제출
5. 별 10개 넘으면 travisvn PR

## 홍보문에 쓸 수 있는 숫자 (전부 실측)

| 숫자 | 근거 |
|---|---|
| 재무 확보율 48.9% (사람인 135곳) · 50.0% (원티드 30곳) · 62.2% (표본 98곳) | README 재무 데이터 표 |
| 마감일 없는 공고 22% (사람인 40건 중 9건) | README |
| 회귀 테스트 668건, 네트워크·키 없이 통과 | `node skills/jd-search/scripts/test/run.mjs` 2026-08-18 실행 |
| 의존성 0개 · 필수 키 1개 | `package.json` · README |
| 통근 시간 실측 미구현 | README. **홍보문에도 반드시 함께 적는다** |

부풀리지 않는다. 이 도구의 정체성이 "빠진 것을 빠졌다고 말하는 것"이라, 홍보가 과장하면 첫 문장부터 자기모순이 된다.
