#!/usr/bin/env node
/**
 * 1단계 collect — 점핏(jumpit).
 *
 * 실행: node collect_jumpit.mjs [--profile <id>] [--query "키워드1,키워드2"] [--max 200] [--refresh]
 * 출력: ~/.jd-search/<프로필>/state/postings.json
 *       ~/.jd-search/<프로필>/state/jd/jumpit-<id>.md   🔴 JD 원문
 *
 * 🔴 공고는 마감되면 페이지째 사라져 소급이 안 된다. 본문을 받은 그 자리에서 저장한다.
 * 🔴 자동 지원·이력서 제출은 만들지 않는다. 이 스크립트는 읽기만 한다.
 *
 * 엔드포인트는 `lib/jumpit.mjs` 머리말 참조 (키 불필요, 2026-08-18 실측).
 */
import fs from 'node:fs';
import { loadProfile, statePath, readJson, writeJson, requireSourceEnabled } from './lib/io.mjs';
import { matchesAny } from './lib/text.mjs';
// 🔴 수집·마감재확인이 같은 경로를 쓰도록 점핏 로직은 lib/jumpit.mjs 하나로 모아 둔다.
import { postingUrl, listByQuery, fetchDetail, toRecord, cleanTitle } from './lib/jumpit.mjs';
import { planDetailBudget } from './lib/budget.mjs';
import { diagnose } from './lib/http.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
};
const has = name => argv.includes(`--${name}`);

const profile = loadProfile(flag('profile') || undefined);
try { requireSourceEnabled(profile, 'jumpit', 'api'); }
catch (e) { console.error(e.message); process.exit(1); }

const queries = String(flag('query') || (profile.target.roles ?? []).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);
if (!queries.length) {
  console.error('검색 키워드가 없습니다. profile.yml 의 target.roles 를 채우거나 --query 로 넘겨 주십시오.');
  process.exit(1);
}
const LIST_MAX = 400;
// 🔴 목록 단계에서 제목으로 거른다. 점핏 검색은 공백이 든 키워드를 무시해서
//    (`서비스 기획` → 724건, 그중 관련 0건) 전부 받아 두면 잡음만 쌓인다.
//    사람인과 같은 방식이다 — 거기서도 한 단어에 1만 건이 나온다.
const roles = profile.target.roles ?? [];
const isRelevant = title => !roles.length || matchesAny(title, roles).length > 0;
const watch = (profile.watchlist ?? []).map(String);

const file = statePath(profile, 'postings.json');
const store = readJson(file, { updatedAt: null, postings: {} });
const before = Object.keys(store.postings).length;

// 🔴 실행 manifest — 어느 키워드가 성공했고 어디서 잘렸는지 남긴다.
//    부분 성공을 전수로 보여 주지 않는다. 리포트 상단 경고가 이 기록을 읽는다.
const runId = new Date().toISOString();
const manifest = { runId, board: 'jumpit', queries: [], complete: true };

const seen = new Map();
const remember = (it, q, extra = {}) => {
  const k = String(it.id);
  const prev = seen.get(k);
  seen.set(k, { item: it, ...prev, ...extra, matched: [...new Set([...(prev?.matched ?? []), q])] });
};

for (const q of queries) {
  process.stdout.write(`검색 "${q}" … `);
  try {
    const { items, truncated, total, pages, stoppedBy, rates, keywordIgnored } = await listByQuery(q, isRelevant, { max: LIST_MAX });
    for (const it of items) remember(it, q);
    manifest.queries.push({ query: q, ok: true, found: items.length, total, truncated, pages, stoppedBy, rates, keywordIgnored });
    if (truncated) manifest.complete = false;
    console.log(`${items.length}건 (${pages}페이지 · ${total ?? '?'}건 중)`
      + `${truncated ? ` ⚠ ${LIST_MAX}건 한도에서 잘림` : ''}`
      + `${keywordIgnored ? ' ⚠ 이 키워드는 점핏 검색이 무시합니다' : ''}`);
  } catch (e) {
    // 🔴 실패 종류를 여기서 굳혀 둔다. 나중에 문자열에서 되살리려 하면 문구가 바뀌는 순간 못 읽는다.
    const d = diagnose(e);
    manifest.queries.push({ query: q, ok: false, error: d.message, kind: d.kind, status: d.status, label: d.label, hint: d.hint });
    manifest.complete = false;
    console.log(`✖ ${d.label} (${d.message})`);
  }
}

// 관심 회사는 🔴 조건과 무관하게 항상 수집한다.
for (const name of watch) {
  process.stdout.write(`관심회사 "${name}" … `);
  try {
    // 🔴 관심 회사는 직군 필터를 걸지 않는다 — 조건과 무관하게 항상 본다.
    const { items } = await listByQuery(name, () => true, { max: LIST_MAX });
    const hit = items.filter(it => String(it.companyName ?? '').includes(name));
    for (const it of hit) remember(it, `watchlist:${name}`, { watch: true });
    manifest.queries.push({ query: `watchlist:${name}`, ok: true, found: hit.length });
    console.log(`${hit.length}건`);
  } catch (e) {
    const d = diagnose(e);
    manifest.queries.push({ query: `watchlist:${name}`, ok: false, error: d.message, kind: d.kind, status: d.status, label: d.label, hint: d.hint });
    manifest.complete = false;
    console.log(`✖ ${d.label} (${d.message})`);
  }
}

// 🔴 제목 필터는 **목록 단계에서 이미 끝났다**(lib/jumpit.mjs). 여기서 또 거르지 않는다.
//    원티드는 목록이 정확해서 collect 가 거르지만, 점핏은 검색이 키워드를 무시해서
//    전량을 받아 두면 잡음 수백 건이 dropped.json 에 쌓이고 **다른 보드가 남긴 진짜 제외 건이 묻힌다.**
//    대신 "이 키워드는 점핏에서 안 먹는다"는 사실을 아래에서 사용자에게 말해 준다.
const targets = [...seen.entries()];
console.log(`\n대상 ${targets.length}건`);

const ignored = manifest.queries.filter(q => q.keywordIgnored).map(q => q.query);
if (ignored.length) {
  console.log(`\n⚠ 점핏 검색이 무시한 키워드: ${ignored.map(q => `"${q}"`).join(' · ')}`);
  console.log('  공백이 든 키워드는 점핏에서 사실상 전체 목록을 돌려줍니다 — 공고가 없는 것이 아닙니다.');
  console.log('  target.roles 에 **붙여 쓴 표기**를 함께 넣어 주십시오 (예: "서비스 기획" 과 함께 "서비스기획").');
}

// 🔴 상세 조회 예산 — 첫 실행은 전량, 재실행은 200. 상한은 **실제로 받아야 하는 건수만** 센다.
//    규칙은 `lib/budget.mjs` 에 있다 (보드가 공유한다 · 테스트가 문다).
const needsFetch = ([id]) => {
  const existing = store.postings[`jumpit:${id}`];
  const jdMissing = !existing?.jd || !fs.existsSync(existing.jd);
  return !existing || has('refresh') || jdMissing;
};
const firstRun = !Object.values(store.postings).some(p => p.board === 'jumpit');
const { allowed, cutOff, max: MAX_FETCH, firstRunFull } = planDetailBudget(
  targets.map(([id]) => id),
  id => needsFetch([id]),
  { maxFlag: flag('max'), firstRun },
);
if (firstRunFull && allowed.size) {
  console.log(`\n첫 실행이라 ${allowed.size}건을 전부 받습니다 (건당 1초, 약 ${Math.ceil(allowed.size / 60)}분).`);
}
if (cutOff > 0) {
  manifest.complete = false;
  manifest.detailTruncated = { seen: targets.length, fetched: allowed.size, pending: cutOff, max: MAX_FETCH };
}

let added = 0, updated = 0, gone = 0, failed = 0, skipped = 0;
for (const [i, [id, v]] of targets.entries()) {
  const key = `jumpit:${id}`;
  const existing = store.postings[key];
  process.stdout.write(`\r[${i + 1}/${targets.length}] ${String(v.item.companyName ?? '').slice(0, 16).padEnd(18)}`);

  if (!needsFetch([id])) {
    existing.matchedKeywords = [...new Set([...(existing.matchedKeywords ?? []), ...v.matched])];
    existing.seenRunId = runId;
    updated++;
    continue;
  }
  // 예산 밖이면 손대지 않는다 — 다음 실행에서 받는다.
  if (!allowed.has(id)) { skipped++; continue; }

  const d = await fetchDetail(id);
  if (d.unknown) { failed++; continue; }
  if (d.gone) {
    // 🔴 여기서 지우지 않는다. 같은 자리가 새 ID로 재공고되는 일이 흔해
    //    회사 단위 재검색(check_alive)이 판단하게 남겨 둔다.
    if (existing) { existing.status = 'closed'; existing.goneAt = new Date().toISOString(); }
    gone++;
    continue;
  }
  const rec = toRecord(profile, d.job, v.item, v.matched);
  rec.seenRunId = runId;
  if (existing) { store.postings[key] = { ...existing, ...rec }; updated++; }
  else { store.postings[key] = rec; added++; }
}
process.stdout.write('\n');

// 🔴 검색 조건이 바뀌면(PM → QA) 옛 조건으로 모은 공고가 그대로 남아 리포트에 섞인다.
//    지우지는 않는다 — 이력이고, 되돌릴 수도 있다. 대신 **이번 실행에서 안 보인 건**은 stale로 표시한다.
//    단 이번 실행이 부분 실패였으면 표시하지 않는다. 네트워크 오류를 "조건에서 빠짐"으로 오해하게 된다.
let staled = 0;
if (manifest.complete) {
  for (const p of Object.values(store.postings)) {
    if (p.board !== 'jumpit') continue;
    if (p.pinned) continue;   // 손으로 넣은 공고는 애초에 검색 조건 밖이라서 넣은 것이다
    if (p.seenRunId === runId) { if (p.stale) delete p.stale; continue; }
    if (!p.stale) { p.stale = true; p.staleSince = runId; staled++; }
  }
}

store.updatedAt = new Date().toISOString();
store.runs = { ...(store.runs ?? {}), jumpit: manifest };
if (store.lastRun?.board) store.runs[store.lastRun.board] ??= store.lastRun;
writeJson(file, store);

const all = Object.values(store.postings);
console.log(`\n신규 ${added} · 갱신 ${updated} · 내려감 ${gone} · 실패 ${failed}`
  + `${skipped ? ` · 예산 밖 ${skipped}` : ''}${staled ? ` · 조건 밖으로 이동 ${staled}` : ''}`);
console.log(`보관 ${before} → ${all.length}건 (살아있음 ${all.filter(p => p.status === 'active' && !p.stale).length})`);
if (!manifest.complete) {
  const bad = manifest.queries.filter(q => !q.ok || q.truncated)
    .map(q => (q.ok ? `${q.query}(잘림)` : `${q.query} — ${q.label ?? '실패'}`));
  if (manifest.detailTruncated) {
    bad.push(`상세를 못 받은 것이 ${manifest.detailTruncated.pending}건 남음 (--max ${MAX_FETCH})`);
  }
  console.log(`\n⚠ 이번 수집은 완전하지 않습니다 — ${bad.join(', ')}`);
  console.log('  리포트 상단에도 같은 경고가 표시됩니다. 이 결과를 "전수"로 읽지 마십시오.');
  for (const h of [...new Set(manifest.queries.filter(q => !q.ok && q.hint).map(q => q.hint))]) {
    console.log(`\n  → ${h}`);
  }
}
console.log(`→ ${file}`);
