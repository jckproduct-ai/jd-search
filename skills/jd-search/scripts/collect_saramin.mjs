#!/usr/bin/env node
/**
 * 1단계 collect — 사람인.
 *
 * 실행: node collect_saramin.mjs [--profile <id>] [--query "키워드1,키워드2"] [--pages 12] [--max 200] [--refresh]
 * 출력: ~/.jd-search/<프로필>/state/postings.json
 *       ~/.jd-search/<프로필>/state/jd/saramin-<id>.md   🔴 JD 원문
 *
 * 🔴 원티드에 없는 공고는 사용자에게 **존재 자체가 안 보인다.** 이 단계가 그 손실을 메운다.
 * 🔴 자동 지원·이력서 제출은 만들지 않는다. 이 스크립트는 읽기만 한다.
 * 🔴 요청 간 1초. 병렬 순회 금지.
 *
 * ── 원티드와 결정적으로 다른 두 가지 ──────────────────────────────────────
 *
 * ① **검색이 형태소를 쪼개 확장한다.** "서비스기획" 한 단어에 10,685건이 나온다(실측).
 *    따옴표 정확검색도 무효였다. 그래서 "전부 훑기"가 성립하지 않는다.
 *    → 제목 매치율이 바닥나는 지점에서 멈추고, **어디서 왜 멈췄는지 리포트에 적는다.**
 *    실측 감쇠: p1 95% · p2 95% · p3 88% · p4 31% · p5 2% · p6 0%
 *
 * ② **좌표를 주지 않고 근무지가 여러 곳일 수 있다.** 목록은 첫 곳만 보여 준다.
 *    → 상세를 받아 전체 근무지를 `location.all` 에 담는다. 게이트가 하나라도 걸리면 통과시킨다.
 */
import fs from 'node:fs';
import { loadProfile, statePath, readJson, writeJson, requireSourceEnabled } from './lib/io.mjs';
import { matchesAny } from './lib/text.mjs';
import { listByQuery, toRecord, planDetailBudget } from './lib/saramin.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
};
const has = name => argv.includes(`--${name}`);

const profile = loadProfile(flag('profile') || undefined);
try { requireSourceEnabled(profile, 'saramin', 'web'); }
catch (e) { console.error(e.message); process.exit(1); }

const roles = profile.target?.roles ?? [];
const queries = String(flag('query') || roles.join(','))
  .split(',').map(s => s.trim()).filter(Boolean);
if (!queries.length) {
  console.error('검색 키워드가 없습니다. profile.yml 의 target.roles 를 채우거나 --query 로 넘겨 주십시오.');
  process.exit(1);
}
const MAX_PAGES = Number(flag('pages', 12));
const watch = (profile.watchlist ?? []).map(String);

// 🔴 정지 조건이자 잡음 차단선. roles 가 비어 있으면 멈출 근거가 없다 —
//    그때는 첫 페이지만 보고 사용자에게 키워드를 채우라고 말한다.
const isRelevant = title => !roles.length || matchesAny(title, roles).length > 0;

const file = statePath(profile, 'postings.json');
const store = readJson(file, { updatedAt: null, postings: {} });
const before = Object.keys(store.postings).length;

const runId = new Date().toISOString();
const manifest = { runId, board: 'saramin', queries: [], complete: true };

const seen = new Map();
for (const q of queries) {
  process.stdout.write(`검색 "${q}" … `);
  try {
    const { items, pages, stoppedBy, rates } = await listByQuery(q, isRelevant, {
      maxPages: roles.length ? MAX_PAGES : 1,
    });
    for (const it of items) {
      const prev = seen.get(it.id);
      seen.set(it.id, { item: it, matched: [...new Set([...(prev?.matched ?? []), q])] });
    }
    // 🔴 "관련도 바닥에서 멈춤"은 정상 종료다. "페이지 상한에서 멈춤"은 **잘린 것**이다 —
    //    사용자가 그 차이를 모르면 부분 결과를 전수로 읽는다.
    const truncated = stoppedBy === 'maxPages';
    manifest.queries.push({ query: q, ok: true, found: items.length, pages, stoppedBy, truncated, rates });
    if (truncated) manifest.complete = false;
    const tail = truncated
      ? ` ⚠ --pages ${MAX_PAGES} 상한에서 잘림`
      : (stoppedBy === 'relevanceFloor' ? ` (${pages}p까지 훑고 관련도 바닥에서 종료)` : ` (${pages}p, 결과 끝)`);
    console.log(`${items.length}건${tail}`);
  } catch (e) {
    manifest.queries.push({ query: q, ok: false, error: e.message });
    manifest.complete = false;
    console.log(`✖ 실패 (${e.message})`);
  }
}

// 관심 회사는 🔴 조건과 무관하게 항상 수집한다. 제목이 내 직군이 아니어도 본다.
for (const name of watch) {
  process.stdout.write(`관심회사 "${name}" … `);
  try {
    const { items, pages, stoppedBy } = await listByQuery(name, () => true, { maxPages: 2 });
    const hit = items.filter(it => (it.company ?? '').includes(name));
    for (const it of hit) {
      const prev = seen.get(it.id);
      seen.set(it.id, { item: it, matched: [...new Set([...(prev?.matched ?? []), `watchlist:${name}`])], watch: true });
    }
    manifest.queries.push({ query: `watchlist:${name}`, ok: true, found: hit.length, pages, stoppedBy });
    console.log(`${hit.length}건`);
  } catch (e) {
    manifest.queries.push({ query: `watchlist:${name}`, ok: false, error: e.message });
    manifest.complete = false;
    console.log(`✖ 실패 (${e.message})`);
  }
}

// 🔴 목록 단계에서 이미 제목 관련도로 걸렀다(그게 정지 조건이기도 하다).
//    하지만 **걸러진 사실 자체를 남겨야** 사용자가 키워드 누락을 알아챈다.
//    사람인은 확장 검색이라 제외량이 커서 전량을 장부에 쌓으면 리포트가 잡음에 묻힌다
//    → 제외는 **집계와 표본만** 남긴다. 원티드(전량 기록)와 다른 이유를 여기 적어 둔다.
let excludedCount = 0;
for (const r of manifest.queries) {
  for (const p of r.rates ?? []) excludedCount += p.items - p.hits;
}

// 🔴 공고 하나당 상세·본문 2요청이고 요청 간 1초다. 300건이면 10분이다.
//    상한을 두되 **잘랐다는 사실을 반드시 남긴다** — 조용히 자르면 사용자는 그게 전부인 줄 안다.
//    규칙 자체는 `lib/saramin.mjs` 의 `planDetailBudget` 에 있다 (테스트가 물게 하려고 뺐다).
const allSeen = [...seen.entries()];
// 🔴 JD 원문이 없으면 --refresh 없이도 다시 받는다. 공고는 마감되면 사라져 소급이 안 된다.
//    🔴 조회에 실패한 본문(`failed`)도 다시 받는다. 다만 **이미지형(`imageOnly`)은 다시 받지 않는다** —
//       다음에 받아도 여전히 이미지다. 매 실행 헛조회만 늘고 기록은 이미 사실대로 남아 있다.
const needsFetch = id => {
  const e = store.postings[`saramin:${id}`];
  if (!e || has('refresh')) return true;
  return !e.jd || !fs.existsSync(e.jd) || e.jdKind === 'failed';
};
const { allowed, cutOff, max: MAX_FETCH, firstRunFull } = planDetailBudget(
  allSeen.map(([id]) => id), needsFetch,
  { maxFlag: flag('max', null), firstRun: !Object.values(store.postings).some(p => p.board === 'saramin') },
);
if (cutOff > 0) {
  manifest.complete = false;
  // 🔴 `seen`(목록에서 본 건수)과 `pending`(못 받은 건수)은 다르다. 이미 받아 둔 것이 섞여 있어서다.
  //    둘을 뭉치면 "0/292 잘림"처럼 실제보다 크게 잃은 것처럼 보인다 — 경고도 정확해야 믿는다.
  manifest.detailTruncated = { seen: allSeen.length, fetched: allowed.size, pending: cutOff, max: MAX_FETCH };
}

console.log(`\n유니크 ${allSeen.length}건 · 제목 무관 제외 약 ${excludedCount}건(사람인 확장검색 잡음)`);
if (cutOff > 0) console.log(`⚠ 상세 조회는 --max ${MAX_FETCH} 까지만 합니다 — ${cutOff}건을 이번에 못 받았습니다.`);
// 🔴 오래 걸리는 것 자체는 문제가 아니다. **말 없이 오래 걸리는 것**이 문제다.
if (firstRunFull && allowed.size > 50) {
  const min = Math.max(1, Math.round(allowed.size * 2 / 60));
  console.log(`\n🔴 첫 실행이라 ${allowed.size}건을 전부 받습니다 — 약 ${min}분 걸립니다.`);
  console.log('   공고 하나당 상세·본문 2요청이고, 사람인에 부담을 주지 않으려고 요청 간 1초를 지킵니다.');
  console.log('   다음 실행부터는 새 공고만 받으므로 훨씬 빠릅니다.');
  console.log('   지금 줄이려면 중단하고  --max 200  을 붙여 다시 실행해 주십시오 (못 받은 건수는 리포트에 적힙니다).\n');
}

let added = 0, updated = 0, gone = 0, failed = 0, done = 0;
for (const [id, v] of allSeen) {
  const key = `saramin:${id}`;
  const existing = store.postings[key];

  // 이미 받아 둔 공고 — 네트워크를 쓰지 않으므로 상한에서 세지 않는다.
  if (!allowed.has(id)) {
    if (existing) {
      existing.matchedKeywords = [...new Set([...(existing.matchedKeywords ?? []), ...v.matched])];
      existing.seenRunId = runId;
      updated++;
    }
    continue;
  }

  done++;
  process.stdout.write(`\r[${done}/${allowed.size}] ${String(v.item.company ?? '').slice(0, 16).padEnd(18)}`);

  const r = await toRecord(profile, v.item, v.matched);
  if (r.unknown) { failed++; continue; }
  if (r.gone) {
    // 🔴 지우지 않는다. 같은 자리가 새 ID로 재공고되는 일이 흔해 check_alive 가 판단하게 남긴다.
    if (existing) { existing.status = 'closed'; existing.goneAt = new Date().toISOString(); }
    gone++;
    continue;
  }
  r.rec.seenRunId = runId;
  if (existing) { store.postings[key] = { ...existing, ...r.rec }; updated++; }
  else { store.postings[key] = r.rec; added++; }
}
process.stdout.write('\n');

// 🔴 검색 조건이 바뀌면 옛 조건 공고가 그대로 남는다. 지우지 않고 stale 로만 표시한다.
//    단 이번 실행이 부분 실패였으면 표시하지 않는다 — 네트워크 오류를 "조건에서 빠짐"으로 오해하게 된다.
let staled = 0;
if (manifest.complete) {
  for (const p of Object.values(store.postings)) {
    if (p.board !== 'saramin') continue;
    // 🔴 손으로 넣은 공고는 애초에 검색 조건 밖이라서 넣은 것이다. 조건 밖이라고 표시하면 안 된다.
    if (p.pinned) continue;
    if (p.seenRunId === runId) { if (p.stale) delete p.stale; continue; }
    if (!p.stale) { p.stale = true; p.staleSince = runId; staled++; }
  }
}

store.updatedAt = new Date().toISOString();
// 🔴 보드마다 lastRun 을 따로 둔다. 하나의 lastRun 을 공유하면 사람인 수집이
//    원티드의 "부분 실패" 경고를 덮어써 사용자가 그 경고를 영영 못 본다.
store.runs = { ...(store.runs ?? {}), saramin: manifest };
if (store.lastRun?.board === 'wanted') store.runs.wanted ??= store.lastRun;
writeJson(file, store);

// 제외 집계를 장부에 남긴다 (전량이 아니라 집계 — 위 주석의 이유).
const dropFile = statePath(profile, 'dropped.json');
const dropStore = readJson(dropFile, { byReason: {}, dropped: [] });
const keep = (dropStore.dropped ?? []).filter(d => d.reason !== 'saraminTitleNoise');
if (excludedCount) {
  keep.push({
    key: 'saramin:noise', company: '', title: `사람인 확장검색 잡음 약 ${excludedCount}건`,
    url: 'https://www.saramin.co.kr/zf_user/search/recruit', reason: 'saraminTitleNoise',
    detail: '사람인 검색은 형태소를 쪼개 확장해 무관한 공고가 대량으로 섞인다. 제목이 target.roles 어디에도 걸리지 않아 제외',
  });
}
dropStore.dropped = keep;
dropStore.byReason = dropStore.dropped.reduce((a, d) => (a[d.reason] = (a[d.reason] ?? 0) + 1, a), {});
dropStore.updatedAt = new Date().toISOString();
writeJson(dropFile, dropStore);

const all = Object.values(store.postings);
const mine = all.filter(p => p.board === 'saramin');
console.log(`\n신규 ${added} · 갱신 ${updated} · 내려감 ${gone} · 실패 ${failed}${staled ? ` · 조건 밖으로 이동 ${staled}` : ''}`);
console.log(`사람인 보관 ${mine.length}건 (전체 ${before} → ${all.length}건)`);
if (!roles.length) {
  console.log('\n⚠ target.roles 가 비어 있어 첫 페이지만 봤습니다.');
  console.log('  사람인 검색은 한 단어에 1만 건 넘게 나옵니다 — 키워드를 채워야 어디서 멈출지 판단할 수 있습니다.');
}
if (!manifest.complete) {
  const bad = manifest.queries.filter(q => !q.ok || q.truncated)
    .map(q => `${q.query}(${q.ok ? '상한에서 잘림' : '실패'})`);
  if (manifest.detailTruncated) bad.push(`상세 조회 ${manifest.detailTruncated.fetched}/${manifest.detailTruncated.seen}건에서 잘림`);
  console.log(`\n⚠ 이번 수집은 완전하지 않습니다 — ${bad.join(', ')}`);
  console.log('  리포트 상단에도 같은 경고가 표시됩니다. 이 결과를 "전수"로 읽지 마십시오.');
}
// 🔴 겹침을 **확인하지 않고 있다고 단정하지 않는다.** 다른 보드 공고가 하나도 없으면
//    겹칠 대상 자체가 없다. 세어 보지 않은 사실을 도구가 말하면 사용자는 나머지 경고도 안 믿는다.
const others = all.filter(p => p.board && p.board !== 'saramin').length;
if (others) {
  console.log(`\n다른 보드 공고 ${others}건이 함께 보관돼 있습니다 — 같은 자리가 겹칠 수 있습니다.`);
  console.log('  병합:  node scripts/merge_boards.mjs');
}
console.log(`→ ${file}`);
