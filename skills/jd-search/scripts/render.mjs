#!/usr/bin/env node
/**
 * 6단계 render — report.html 한 장.
 *
 * 실행: node render.mjs [--profile <id>] [--out <경로>]
 * 출력: ~/.jd-search/<프로필>/out/report.html
 *
 * 🔴 외부 리소스 0. 인라인 CSS/JS만 — 인터넷이 끊긴 곳에서도 열려야 한다.
 * 🔴 자택 주소·이력서 내용은 리포트에 넣지 않는다. 좌표도 넣지 않는다.
 * 🔴 제외 건수와 사유를 항상 싣는다. 조용히 자르지 않는다.
 *
 * 이 파일은 **보기·필터·정렬 전용**이다. 상태 변경·추가·삭제는 serve가 맡는다
 * (진행상태를 브라우저 localStorage에 두면 기기가 바뀔 때 조용히 사라진다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, statePath, outPath, readJson } from './lib/io.mjs';
import { GRADE_LABEL } from './lib/grade.mjs';
import { normCorp } from './lib/text.mjs';
import { mergeVerdicts } from './lib/merge.mjs';
import { EXPERIENCE_TAG_LABEL } from './lib/experience.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
const store = readJson(statePath(profile, 'postings.json'));
if (!store) { console.error('postings.json 이 없습니다. collect 단계를 먼저 돌려 주십시오.'); process.exit(1); }

const gate = readJson(statePath(profile, 'gate.json'), { verdicts: {} });
const fin = readJson(statePath(profile, 'finance.json'), { companies: {}, baseline: null });
const dropped = readJson(statePath(profile, 'dropped.json'), { byReason: {}, dropped: [] });

// 🔴 지원 이력(면접·탈락)은 기본으로 리포트에 넣지 않는다.
//    report.html 은 보관·공유용이라고 문서에 적혀 있는데, 지원 상태가 실려 나가면
//    "지원 이력은 이 컴퓨터를 벗어나지 않는다"는 약속이 파일 하나로 깨진다.
//    실수로 새는 쪽이 실수로 빠지는 쪽보다 훨씬 비싸다 → 넣으려면 명시적으로 요구해야 한다.
const withStatus = argv.includes('--with-status');
const apps = withStatus ? readJson(statePath(profile, 'applications.json'), {}) : {};

const TAG_LABEL = { remote: '풀리모트', hybrid: '하이브리드', ...EXPERIENCE_TAG_LABEL, watchlist: '관심회사' };
const REASON_LABEL = {
  outOfRegion: '희망 지역 밖', denyRegion: '제외 지역', blocklist: '제외 회사',
  excludeRole: '제외 직무 키워드', excludeIndustry: '제외 업종',
  regionUnknown: '근무지 판정 불가',
  saraminTitleNoise: '사람인 확장검색 잡음',
};
const BOARD_LABEL = { wanted: '원티드', saramin: '사람인' };
const DUE_KIND_LABEL = { always: '상시채용', untilFilled: '채용시 마감' };

const postings = store.postings ?? {};
const rows = [];
for (const [key, p] of Object.entries(postings)) {
  // 🔴 병합된 종속 건은 행으로 만들지 않는다. 대표 행이 출처를 모두 들고 있다.
  //    (레코드 자체는 지우지 않았다 — 병합이 틀렸을 때 되돌릴 수 있어야 한다)
  if (p.mergedInto && postings[p.mergedInto]) continue;

  // 🔴 같은 자리인데 보드마다 근무지 표기가 달라 한쪽만 통과하는 일이 있다.
  //    묶음 안에서 **가장 관대한 판정**을 쓴다 — 추측으로 공고를 버리지 않는다.
  const groupKeys = [key, ...Object.entries(postings).filter(([, q]) => q.mergedInto === key).map(([k]) => k)];
  const g = mergeVerdicts(groupKeys.map(k => gate.verdicts?.[k]).filter(Boolean))
    ?? { verdict: 'pass', reason: 'no-gate' };
  if (g.verdict === 'drop') continue;                       // 제외 건은 하단 펼침에만 싣는다
  const f = fin.companies?.[normCorp(p.company?.name)] ?? {};
  rows.push({
    key, board: p.board, url: p.url, title: p.title,
    // 🔴 같은 공고가 두 보드에 있으면 링크를 둘 다 싣는다. 한쪽이 먼저 내려가기 때문이다.
    sources: (p.sources ?? [{ board: p.board, id: p.id, url: p.url, status: p.status }])
      .map(s => ({ ...s, label: BOARD_LABEL[s.board] ?? s.board })),
    company: p.company?.name ?? '', industry: p.company?.industry ?? null,
    region: g.region ?? p.location?.district ?? null,
    straightKm: g.straightKm ?? null,
    approx: Boolean(g.approx),                              // 구 중심점 근사 여부 (통근 단계가 채운다)
    status: p.status, dueTime: p.dueTime, dueKindLabel: DUE_KIND_LABEL[p.dueKind] ?? null,
    stale: Boolean(p.stale),
    annualFrom: p.annualFrom, collectedAt: p.collectedAt,
    // 🔴 합치지 않은 중복 후보는 사용자에게 알린다. 조용히 두면 같은 자리에 두 번 지원한다.
    dupHint: p.mergeCandidates?.length ? p.mergeCandidates.length : 0,
    tags: [
      ...(g.tags ?? []),
      ...(g.verdict === 'hold' ? ['근무지 미확인'] : []),
      ...(p.stale ? ['조건 밖'] : []),
      ...(p.pinned ? ['직접 추가'] : []),
      // 🔴 본문이 이미지뿐인 공고는 그렇게 적는다. 저장된 JD 원문에 글자가 없다는 뜻이다.
      ...(p.jdKind === 'imageOnly' ? ['본문 이미지'] : []),
    ],
    grade: f.grade ?? 'u', gradeLabel: GRADE_LABEL[f.grade ?? 'u'], gradeYear: f.gradeYear ?? null,
    // 🔴 미확인일 때는 "공시 데이터 없음" 대신 **왜 못 찾았는지**를 보여 준다.
    //    DART 미등록인지, 동명이인이라 못 붙인 것인지, 아직 안 돌린 것인지는 서로 다른 상황이다.
    reasons: (f.grade === 'u' && f.note) ? [] : (f.reasons ?? []),
    questions: f.questions ?? [],
    note: f.ambiguous
      ? `같은 이름의 법인이 여러 곳이라 재무를 붙이지 않았습니다 — 어느 회사인지 확인이 필요합니다`
      : (f.note ?? (fin.updatedAt ? (f.grade === 'u' ? (f.reasons ?? [])[0] : null) : '재무 단계를 아직 돌리지 않았습니다')),
    // 🔴 사람이 확인한 것과 규칙이 자동으로 정한 것을 구분해 보여 준다. 사람의 선택도 틀릴 수 있다.
    confirmedBy: f.userDecided && f.userDecided !== 'skip' ? String(f.userDecided) : null,
    vsBaseline: f.vsBaseline ?? null,
    appStatus: apps[key]?.status ?? null,
  });
}

const known = rows.filter(r => r.grade !== 'u');
const companies = new Set(rows.map(r => normCorp(r.company)));

// 🔴 부분 성공을 부분 성공이라고 표시한다. 조용한 부분 실패가 이 제품에서 가장 나쁜 실패다.
//    보드마다 실행 기록이 따로 있다 — 하나로 합쳐 보면 한 보드의 경고가 다른 보드에 묻힌다.
const runs = { ...(store.runs ?? {}), ...(store.lastRun ? { [store.lastRun.board ?? 'wanted']: store.lastRun } : {}) };
const incomplete = [];
for (const [board, run] of Object.entries(runs)) {
  if (!run || run.complete !== false) continue;
  for (const q of run.queries ?? []) {
    if (q.ok && !q.truncated) continue;
    incomplete.push(`${BOARD_LABEL[board] ?? board} "${q.query}" — ${q.ok ? `${q.found}건에서 잘림` : '조회 실패'}`);
  }
  const t = run.detailTruncated;
  if (t) incomplete.push(`${BOARD_LABEL[board] ?? board} — 목록에서 ${t.seen}건을 찾았으나 상세는 ${t.fetched}건까지만 받았습니다 (--max ${t.max})`);
}
// 🔴 아직 한 번도 안 돌린 보드가 있으면 그 사실도 경고다. 안 돌린 보드의 공고는 존재 자체가 안 보인다.
const enabledBoards = Object.entries(profile.sources ?? {})
  .filter(([b, mode]) => ['wanted', 'saramin'].includes(b) && mode !== 'off').map(([b]) => b);
const collected = new Set(Object.values(postings).map(p => p.board));
const missingBoards = enabledBoards.filter(b => !collected.has(b));

const merged = store.lastMerge ?? null;
const data = {
  title: `공고 ${rows.length}건 · 회사 ${companies.size}곳`,
  generatedAt: new Date().toLocaleString('ko-KR', { hour12: false }),
  criteria: { regions: profile.location?.regions ?? [] },
  baseline: fin.baseline ? { company: fin.baseline.company, year: fin.baseline.year } : null,
  gradeLabels: GRADE_LABEL, tagLabels: TAG_LABEL, reasonLabels: REASON_LABEL, boardLabels: BOARD_LABEL,
  stats: [
    { label: '본 목록', value: String(rows.length) },
    { label: '살아있음', value: String(rows.filter(r => r.status !== 'closed').length) },
    { label: '회사', value: String(companies.size) },
    { label: '자금등급 확보', value: `${rows.length ? Math.round(known.length / rows.length * 100) : 0}%` },
    { label: '제외', value: String(dropped.dropped?.length ?? 0) },
    ...(merged?.merged ? [{ label: '보드 중복 합침', value: String(merged.merged) }] : []),
  ],
  rows,
  dropped: { byReason: dropped.byReason ?? {}, items: dropped.dropped ?? [] },
  ambiguous: Object.values(fin.companies ?? {}).filter(c => c.ambiguous).map(c => c.name),
  incomplete,
  missingBoards: missingBoards.map(b => BOARD_LABEL[b] ?? b),
  mergeCandidates: merged?.candidates ?? 0,
  staleCount: rows.filter(r => r.stale).length,
  commuteApplied: false,   // 통근 실측 단계 미구현 — 리포트가 "다닐 수 있는 범위"를 주장하지 않게 한다
  footNote: '자금등급은 공공데이터포털 기업재무와 DART 전자공시에서 받은 공개 정보로 판정한 것이며, '
    + '기준연도를 함께 봐 주십시오. 확보하지 못한 회사는 추측하지 않고 미확인으로 둡니다. '
    + '공고의 살아있음 여부는 마감 재확인(alive)을 마지막으로 돌린 시점 기준입니다. '
    + '사람인은 좌표를 주지 않아 직선거리가 표시되지 않습니다. '
    + '통근 시간은 실측 단계가 없어 지역 조건만 적용했습니다. '
    + '상태 변경·추가·삭제는 이 파일이 아니라 serve에서 합니다.',
};

const tpl = fs.readFileSync(path.join(HERE, 'templates', 'report.html'), 'utf8');
// </script> 가 JSON 안에 들어가면 문서가 거기서 끊긴다.
const json = JSON.stringify(data).replace(/</g, '\\u003c');
// 🔴 정적 리포트에는 편집 UI를 넣지 않는다. 상태 변경은 serve 가 맡는다
//    (브라우저 localStorage 에 두면 기기가 바뀔 때 조용히 사라진다).
const html = tpl.replace('__TITLE__', data.title).replace('__DATA__', json).replace('/* __EDIT__ */', '');

const dest = flag('out') || outPath(profile, 'report.html');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, html);

console.log(`공고 ${rows.length}건 · 회사 ${companies.size}곳 · 자금등급 확보 ${known.length}/${rows.length}`);
console.log(`제외 ${dropped.dropped?.length ?? 0}건은 리포트 하단 펼침에 사유와 함께 실렸습니다.`);
console.log(`→ ${dest}`);
