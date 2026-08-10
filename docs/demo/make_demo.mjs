#!/usr/bin/env node
/**
 * README 스크린샷용 예시 데이터 생성기.
 *
 * 실행:
 *   JD_SEARCH_HOME=/tmp/jd-demo node docs/demo/make_demo.mjs
 *   JD_SEARCH_HOME=/tmp/jd-demo node skills/jd-search/scripts/render.mjs --profile demo
 *
 * 🔴 회사명·숫자는 전부 가공이다. 실제 회사를 "위험"으로 표시한 화면을 공개 저장소에 싣지 않기 위해서다.
 *    화면 자체는 실제 렌더러(`render.mjs`)가 그대로 만든다 — 목업이 아니라 진짜 출력이다.
 * 🔴 등급·태그·경고를 한 화면에 다 담도록 표본을 짰다. 좋음/양호/경고/위험/미확인,
 *    상시채용·채용시 마감, 본문 이미지, 보드 중복 합침, 동명이인, 수집 잘림 경고까지.
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.JD_SEARCH_HOME;
if (!HOME) {
  console.error('JD_SEARCH_HOME 을 지정해 주십시오.  예: JD_SEARCH_HOME=/tmp/jd-demo node docs/demo/make_demo.mjs');
  process.exit(1);
}
const ROOT = path.join(HOME, 'demo');
const DIR = path.join(ROOT, 'state');
fs.mkdirSync(DIR, { recursive: true });

const w = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2));
const 억 = n => n * 1e8;
const now = '2026-08-10T09:00:00.000Z';

const rows = [
  { c: '가온랩스',       t: '서비스기획자 (커머스)',          r: '강남구',       b: 'wanted',  grade: 'g', y: 2025, rev: 1240, op: 96,  eq: 880,  af: 3, due: '2026-08-29T23:59:00+09:00' },
  { c: '테라픽스',       t: '프로덕트 매니저 — 결제 도메인',   r: '성남시 분당구', b: 'saramin', grade: 'g', y: 2025, rev: 3180, op: 402, eq: 2410, af: 5, due: null, dueKind: 'always' },
  { c: '마루소프트',     t: '프로덕트 오너 (B2B SaaS)',      r: '서초구',       b: 'wanted',  grade: 'o', y: 2025, rev: 412,  op: 18,  eq: 260,  af: 4, due: '2026-09-05T23:59:00+09:00', merged: true },
  { c: '별하나테크',     t: 'UX 기획자 — 앱 개편',           r: '마포구',       b: 'saramin', grade: 'o', y: 2024, rev: 88,   op: 6,   eq: 41,   af: 0, due: null, dueKind: 'untilFilled', jdKind: 'imageOnly' },
  { c: '노을커머스',     t: '서비스 기획 (신규 서비스)',      r: '강남구',       b: 'wanted',  grade: 'w', y: 2025, rev: 634,  op: -71, eq: 190,  af: 7, due: '2026-08-22T23:59:00+09:00' },
  { c: '한결데이터',     t: '프로덕트 매니저 (데이터 플랫폼)', r: '성남시 분당구', b: 'saramin', grade: 'w', y: 2025, rev: 121,  op: -14, eq: 33,   af: 2, due: '2026-08-31T23:59:00+09:00' },
  { c: '새벽모빌리티',   t: '서비스기획 · 물류 도메인',       r: '서초구',       b: 'saramin', grade: 'r', y: 2025, rev: 96,   op: -58, eq: -12,  af: 5, due: '2026-09-12T23:59:00+09:00' },
  { c: '들녘헬스케어',   t: '프로덕트 오너 (헬스케어)',       r: '마포구',       b: 'saramin', grade: 'u', af: 3, due: '2026-08-27T23:59:00+09:00', note: 'DART 미등록 — 외부감사 대상이 아닌 규모로 보입니다' },
  { c: '푸른창고',       t: '서비스기획자 (풀리모트)',        r: null,           b: 'wanted',  grade: 'u', af: 1, due: null, dueKind: 'always', remote: 'full', ambiguous: true },
  { c: '이레인터랙티브', t: 'Product Manager (Global)',     r: '서초구',       b: 'wanted',  grade: 'g', y: 2025, rev: 2260, op: 311, eq: 1780, af: 8, due: '2026-09-01T23:59:00+09:00' },
];

const GRADE_REASON = {
  g: ['영업흑자 2년 연속', '자본총계가 연간 영업손실의 3배 이상'],
  o: ['영업흑자', '자본 완충 3배 이상'],
  w: ['영업적자', '자본 완충 1~3배'],
  r: ['자본잠식 (자본총계 0 이하)'],
};
const GRADE_LABEL = { g: '좋음', o: '양호', w: '경고', r: '위험', u: '미확인' };

const postings = {};
const verdicts = {};
const companies = {};

rows.forEach((r, idx) => {
  const i = idx + 1;
  const key = `${r.b}:${900000 + i}`;
  const saraminUrl = `https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${50900000 + i}`;
  const url = r.b === 'wanted' ? `https://www.wanted.co.kr/wd/${900000 + i}` : saraminUrl;
  const sido = r.r?.startsWith('성남') ? '경기' : '서울';

  postings[key] = {
    board: r.b, id: String(900000 + i), url, title: r.t,
    company: { name: r.c, industry: null, boardId: `demo-${i}` },
    location: r.r
      ? { label: sido, district: r.r, full: `${sido} ${r.r}`, lat: null, lng: null, all: [`${sido} ${r.r}`] }
      : { label: null, district: null, full: '', lat: null, lng: null, all: [] },
    status: 'active', aliveState: 'active',
    dueTime: r.due ?? null, dueKind: r.dueKind ?? (r.due ? 'date' : null),
    annualFrom: r.af, annualTo: null,
    jdKind: r.jdKind ?? 'text',
    remote: r.remote ?? 'unknown',
    tags: [], matchedKeywords: ['서비스기획'],
    collectedAt: now, jd: null, seenRunId: now,
    // 🔴 같은 자리가 두 보드에 있으면 링크를 둘 다 싣는다 — 한쪽이 먼저 내려간다.
    ...(r.merged ? {
      sources: [
        { board: 'wanted', id: String(900000 + i), url, status: 'active' },
        { board: 'saramin', id: String(50900000 + i), url: saraminUrl, status: 'active' },
      ],
    } : {}),
  };

  const tags = [];
  if (r.af > 5) tags.push('aboveMyLevel');
  if (r.af === 0) tags.push('belowMyLevel');
  if (r.remote === 'full') tags.push('remote');
  verdicts[key] = r.remote === 'full'
    ? { verdict: 'pass', reason: 'remote-full', tags, region: null, straightKm: null }
    : { verdict: 'pass', reason: 'inRegion', tags, region: r.r, straightKm: null };

  companies[r.c] = {
    name: r.c,
    byYear: r.y ? { [r.y]: { revenue: 억(r.rev), operatingProfit: 억(r.op), equity: 억(r.eq), basis: 'separate' } } : {},
    grade: r.grade, gradeYear: r.y ?? null, gradeLabel: GRADE_LABEL[r.grade],
    reasons: GRADE_REASON[r.grade] ?? [], stale: false,
    source: r.y ? (i % 2 ? 'DART 감사보고서' : '공공데이터포털 기업재무') : null,
    note: r.note ?? null,
    ...(r.ambiguous ? { ambiguous: { prompt: `"${r.c}" 와 같은 이름의 법인이 3곳입니다.` } } : {}),
    questions: (r.grade === 'w' || r.grade === 'r')
      ? ['최근 적자의 원인이 일회성인지, 구조적인지 여쭤봐도 될까요?', '현재 런웨이와 다음 조달 계획은 어떻게 되는지요?']
      : (r.grade === 'u' ? ['공시 자료를 찾지 못했습니다 — 최근 매출 추이를 여쭤봐도 될까요?'] : []),
    postings: [key],
  };
});

w('postings.json', {
  updatedAt: now,
  postings,
  runs: {
    wanted: { runId: now, board: 'wanted', complete: true, queries: [] },
    saramin: {
      runId: now, board: 'saramin', complete: false,
      queries: [{ query: '프로덕트 매니저', ok: true, truncated: true, found: 193 }],
      detailTruncated: { seen: 1035, fetched: 150, pending: 885, max: 150 },
    },
  },
  lastMerge: { merged: 1, candidates: 2 },
});
w('gate.json', {
  updatedAt: now,
  criteria: { regions: ['강남구', '서초구', '마포구', '성남시 분당구'] },
  tally: { pass: 10, hold: 0, drop: 4 },
  verdicts,
});
w('finance.json', { updatedAt: now, usedPubData: true, baseline: null, companies });

const dropped = [
  { key: 'saramin:54900301', company: '두레시스템', title: '전략기획팀 / 서비스기획자', url: 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=54900301', reason: 'excludeRole', detail: '전략기획' },
  { key: 'wanted:900302', company: '남산블록', title: '프로덕트 매니저 (Web3)', url: 'https://www.wanted.co.kr/wd/900302', reason: 'excludeIndustry', detail: '블록체인' },
  { key: 'saramin:54900303', company: '동백테크', title: '서비스기획 (부산)', url: 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=54900303', reason: 'outOfRegion', detail: '부산 해운대구' },
  { key: 'wanted:900304', company: '해맞이랩', title: 'UX 기획자', url: 'https://www.wanted.co.kr/wd/900304', reason: 'regionUnknown', detail: '주소에 시·군·구가 없습니다' },
  { key: 'saramin:noise', company: '', title: '사람인 확장검색 잡음 약 3116건', url: 'https://www.saramin.co.kr/zf_user/search/recruit', reason: 'saraminTitleNoise', detail: '사람인 검색은 형태소를 쪼개 확장해 무관한 공고가 대량으로 섞인다. 제목이 target.roles 어디에도 걸리지 않아 제외' },
];
w('dropped.json', {
  updatedAt: now,
  dropped,
  byReason: dropped.reduce((a, d) => (a[d.reason] = (a[d.reason] ?? 0) + 1, a), {}),
});

fs.writeFileSync(path.join(ROOT, 'profile.yml'), `version: 1
id: demo
target:
  roles:
    - 서비스기획
    - 프로덕트 매니저
    - 프로덕트 오너
    - UX 기획
  excludeRoles:
    - 전략기획
  excludeIndustries:
    - 블록체인
  years: 5
location:
  home: ""
  regions:
    - 강남구
    - 서초구
    - 마포구
    - 성남시 분당구
  denyRegions: []
  remote: bypass
watchlist: []
blocklist: []
baseline:
  company: ""
sources:
  wanted:    api
  saramin:   web
  linkedin:  off
finance:
  enabled: true
  staleYears: 3
documents: []
`);

console.log(`예시 데이터 작성 완료 → ${DIR}`);
console.log(`다음:  JD_SEARCH_HOME=${HOME} node skills/jd-search/scripts/render.mjs --profile demo`);
