#!/usr/bin/env node
/**
 * 1단계 collect — 인크루트.
 *
 * 실행: node collect_incruit.mjs [--profile <id>] [--query "키워드1,키워드2"] [--max 200] [--refresh]
 * 출력: ~/.jd-search/<프로필>/state/postings.json
 *       ~/.jd-search/<프로필>/state/jd/incruit-<id>.md   🔴 JD 원문
 *
 * 🔴 공고는 마감되면 페이지째 사라져 소급이 안 된다. 본문을 받은 그 자리에서 저장한다.
 * 🔴 자동 지원·이력서 제출은 만들지 않는다. 이 스크립트는 읽기만 한다.
 * 🔴 인크루트는 EUC-KR 이다. 인코딩 처리는 `lib/incruit.mjs` 안에 있다 — 여기서 손대지 말 것.
 */
import fs from 'node:fs';
import { loadProfile, statePath, readJson, writeJson, requireSourceEnabled } from './lib/io.mjs';
import { matchesAny } from './lib/text.mjs';
import { listByQuery, toRecord } from './lib/incruit.mjs';
import { planDetailBudget } from './lib/budget.mjs';
import { diagnose } from './lib/http.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
};
const has = name => argv.includes(`--${name}`);

const profile = loadProfile(flag('profile') || undefined);
try { requireSourceEnabled(profile, 'incruit', 'web'); }
catch (e) { console.error(e.message); process.exit(1); }

const queries = String(flag('query') || (profile.target.roles ?? []).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);
if (!queries.length) {
  console.error('검색 키워드가 없습니다. profile.yml 의 target.roles 를 채우거나 --query 로 넘겨 주십시오.');
  process.exit(1);
}
const roles = profile.target.roles ?? [];
// 🔴 목록 단계에서 제목으로 거른다. 검색이 넓게 잡아서 전부 받아 두면 잡음만 쌓인다(사람인과 같다).
const isRelevant = title => !roles.length || matchesAny(title, roles).length > 0;
const watch = (profile.watchlist ?? []).map(String);

const file = statePath(profile, 'postings.json');
const store = readJson(file, { updatedAt: null, postings: {} });
const before = Object.keys(store.postings).length;

const runId = new Date().toISOString();
const manifest = { runId, board: 'incruit', queries: [], complete: true };

const seen = new Map();
const remember = (it, q, extra = {}) => {
  const prev = seen.get(String(it.id));
  seen.set(String(it.id), { item: it, ...prev, ...extra, matched: [...new Set([...(prev?.matched ?? []), q])] });
};

for (const q of queries) {
  process.stdout.write(`검색 "${q}" … `);
  try {
    const { items, pages, stoppedBy, rates } = await listByQuery(q, isRelevant);
    for (const it of items) remember(it, q);
    const truncated = stoppedBy === 'maxPages';
    manifest.queries.push({ query: q, ok: true, found: items.length, pages, stoppedBy, rates, truncated });
    if (truncated) manifest.complete = false;
    console.log(`${items.length}건 (${pages}페이지, ${stoppedBy})`);
  } catch (e) {
    const d = diagnose(e);
    manifest.queries.push({ query: q, ok: false, error: d.message, kind: d.kind, status: d.status, label: d.label, hint: d.hint });
    manifest.complete = false;
    console.log(`✖ ${d.label} (${d.message})`);
  }
}

// 관심 회사는 🔴 조건과 무관하게 항상 수집한다 (직군 필터를 걸지 않는다).
for (const name of watch) {
  process.stdout.write(`관심회사 "${name}" … `);
  try {
    const { items } = await listByQuery(name, () => true, { maxPages: 2 });
    const hit = items.filter(it => String(it.company ?? '').includes(name));
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

const targets = [...seen.entries()];
console.log(`\n대상 ${targets.length}건`);

// 🔴 상세 조회 예산 — 첫 실행은 전량, 재실행은 200. 상한은 **실제로 받아야 하는 건수만** 센다.
const needsFetch = id => {
  const existing = store.postings[`incruit:${id}`];
  return !existing || has('refresh') || !existing.jd || !fs.existsSync(existing.jd);
};
const firstRun = !Object.values(store.postings).some(p => p.board === 'incruit');
const { allowed, cutOff, max: MAX_FETCH, firstRunFull } = planDetailBudget(
  targets.map(([id]) => id), needsFetch, { maxFlag: flag('max'), firstRun },
);
if (firstRunFull && allowed.size) {
  console.log(`첫 실행이라 ${allowed.size}건을 전부 받습니다 (건당 1초, 약 ${Math.ceil(allowed.size / 60)}분).`);
}
if (cutOff > 0) {
  manifest.complete = false;
  manifest.detailTruncated = { seen: targets.length, fetched: allowed.size, pending: cutOff, max: MAX_FETCH };
}

let added = 0, updated = 0, gone = 0, failed = 0, skipped = 0;
for (const [i, [id, v]] of targets.entries()) {
  const key = `incruit:${id}`;
  const existing = store.postings[key];
  process.stdout.write(`\r[${i + 1}/${targets.length}] ${String(v.item.company ?? '').slice(0, 16).padEnd(18)}`);

  if (!needsFetch(id)) {
    existing.matchedKeywords = [...new Set([...(existing.matchedKeywords ?? []), ...v.matched])];
    existing.seenRunId = runId;
    updated++;
    continue;
  }
  if (!allowed.has(id)) { skipped++; continue; }

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

// 🔴 이번 실행에서 안 보인 건은 stale 로 표시한다 (지우지 않는다).
//    단 부분 실패였으면 표시하지 않는다 — 네트워크 오류를 "조건에서 빠짐"으로 오해하게 된다.
let staled = 0;
if (manifest.complete) {
  for (const p of Object.values(store.postings)) {
    if (p.board !== 'incruit' || p.pinned) continue;
    if (p.seenRunId === runId) { if (p.stale) delete p.stale; continue; }
    if (!p.stale) { p.stale = true; p.staleSince = runId; staled++; }
  }
}

store.updatedAt = new Date().toISOString();
store.runs = { ...(store.runs ?? {}), incruit: manifest };
if (store.lastRun?.board) store.runs[store.lastRun.board] ??= store.lastRun;
writeJson(file, store);

const all = Object.values(store.postings);
console.log(`\n신규 ${added} · 갱신 ${updated} · 내려감 ${gone} · 실패 ${failed}`
  + `${skipped ? ` · 예산 밖 ${skipped}` : ''}${staled ? ` · 조건 밖으로 이동 ${staled}` : ''}`);
console.log(`보관 ${before} → ${all.length}건 (살아있음 ${all.filter(p => p.status === 'active' && !p.stale).length})`);
if (!manifest.complete) {
  const bad = manifest.queries.filter(q => !q.ok || q.truncated)
    .map(q => (q.ok ? `${q.query}(잘림)` : `${q.query} — ${q.label ?? '실패'}`));
  if (manifest.detailTruncated) bad.push(`상세를 못 받은 것이 ${manifest.detailTruncated.pending}건 남음 (--max ${MAX_FETCH})`);
  console.log(`\n⚠ 이번 수집은 완전하지 않습니다 — ${bad.join(', ')}`);
  console.log('  리포트 상단에도 같은 경고가 표시됩니다. 이 결과를 "전수"로 읽지 마십시오.');
  for (const h of [...new Set(manifest.queries.filter(q => !q.ok && q.hint).map(q => q.hint))]) {
    console.log(`\n  → ${h}`);
  }
}
console.log(`→ ${file}`);
