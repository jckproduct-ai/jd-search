#!/usr/bin/env node
/**
 * 1단계 collect — 원티드.
 *
 * 실행: node collect_wanted.mjs [--profile <id>] [--query "키워드1,키워드2"] [--max 300] [--refresh]
 * 출력: ~/.jd-search/<프로필>/state/postings.json
 *       ~/.jd-search/<프로필>/state/jd/wanted-<id>.md   🔴 JD 원문
 *
 * 🔴 공고는 마감되면 페이지째 사라져 소급이 안 된다. 본문을 받은 그 자리에서 저장한다.
 * 🔴 자동 지원·이력서 제출은 만들지 않는다. 이 스크립트는 읽기만 한다.
 *
 * 엔드포인트 (토큰 불필요, 2026-08-10 실측):
 *   목록  GET /api/v4/jobs?country=kr&query=<kw>&job_sort=job.latest_order&years=-1&locations=all&limit&offset
 *         → links.next 로 이어진다. 통합검색(/api/chaos/search/v1/results)은 12건에서 끊기니 쓰지 말 것.
 *   상세  GET /api/v4/jobs/<id>  → job.status · address.geo_location.location(위경도) · detail(본문)
 *         → 404 = 내려간 공고
 */
import fs from 'node:fs';
import { loadProfile, statePath, readJson, writeJson, requireSourceEnabled } from './lib/io.mjs';
import { matchesAny } from './lib/text.mjs';
// 🔴 수집·마감재확인이 같은 경로를 쓰도록 원티드 로직은 lib/wanted.mjs 하나로 모아 둔다.
import { ORIGIN, listByQuery as listRaw, fetchDetail, toRecord } from './lib/wanted.mjs';
import { diagnose } from './lib/http.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
};
const has = name => argv.includes(`--${name}`);

const profile = loadProfile(flag('profile') || undefined);
try { requireSourceEnabled(profile, 'wanted', 'api'); }
catch (e) { console.error(e.message); process.exit(1); }

const queries = String(flag('query') || (profile.target.roles ?? []).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);
if (!queries.length) {
  console.error('검색 키워드가 없습니다. profile.yml 의 target.roles 를 채우거나 --query 로 넘겨 주십시오.');
  process.exit(1);
}
const MAX = Number(flag('max', 400));
const watch = (profile.watchlist ?? []).map(String);

const file = statePath(profile, 'postings.json');
const store = readJson(file, { updatedAt: null, postings: {} });
const before = Object.keys(store.postings).length;

const listByQuery = q => listRaw(q, { max: MAX });

// 🔴 실행 manifest — 어느 키워드가 성공했고 어디서 잘렸는지 남긴다.
//    키워드 5개 중 2개가 네트워크 오류인데 정상 종료하면, 사용자는 나머지 3개짜리 리포트를
//    "전수조사 결과"로 읽는다. 부분 성공은 부분 성공이라고 적어야 한다.
const runId = new Date().toISOString();
const manifest = { runId, board: 'wanted', queries: [], complete: true };

const seen = new Map();
for (const q of queries) {
  process.stdout.write(`검색 "${q}" … `);
  try {
    const { items, truncated } = await listByQuery(q);
    for (const it of items) {
      const k = String(it.id);
      const prev = seen.get(k);
      seen.set(k, { item: it, matched: [...new Set([...(prev?.matched ?? []), q])] });
    }
    manifest.queries.push({ query: q, ok: true, found: items.length, truncated });
    if (truncated) manifest.complete = false;
    console.log(`${items.length}건${truncated ? ` ⚠ --max ${MAX} 한도에서 잘림` : ''}`);
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
    const { items, truncated } = await listByQuery(name);
    const hit = items.filter(it => (it.company?.name ?? '').includes(name));
    for (const it of hit) {
      const k = String(it.id);
      const prev = seen.get(k);
      seen.set(k, { item: it, matched: [...new Set([...(prev?.matched ?? []), `watchlist:${name}`])], watch: true });
    }
    manifest.queries.push({ query: `watchlist:${name}`, ok: true, found: hit.length, truncated });
    if (truncated) manifest.complete = false;
    console.log(`${hit.length}건`);
  } catch (e) {
    const d = diagnose(e);
    manifest.queries.push({ query: `watchlist:${name}`, ok: false, error: d.message, kind: d.kind, status: d.status, label: d.label, hint: d.hint });
    manifest.complete = false;
    console.log(`✖ ${d.label} (${d.message})`);
  }
}

// 제목이 키워드에 걸리지 않는 건은 검색엔진 잡음이다. 관심회사 건은 예외로 통과시킨다.
// 🔴 여기서 자른 것도 **제외 건이다.** 콘솔 한 줄로 흘리면 리포트에 안 실리고,
//    사용자는 자기 직군 공고가 키워드 표기 차이로 잘려 나간 것을 알 방법이 없다.
//    (예: roles에 "PO"만 있고 "프로덕트 오너"가 없으면 한글 표기 공고가 전량 사라진다)
const roles = profile.target.roles ?? [];
const targets = [];
const titleNoise = [];
for (const entry of seen.entries()) {
  const [, v] = entry;
  if (v.watch || !roles.length || matchesAny(v.item.position, roles).length > 0) { targets.push(entry); continue; }
  titleNoise.push({
    key: `wanted:${v.item.id}`, company: v.item.company?.name ?? '', title: v.item.position,
    url: `${ORIGIN}/wd/${v.item.id}`, reason: 'titleKeywordMiss',
    detail: `제목이 target.roles 어디에도 걸리지 않음`,
  });
}

console.log(`\n유니크 ${seen.size}건 · 제목 무관 제외 ${titleNoise.length}건 · 대상 ${targets.length}건`);
if (titleNoise.length) {
  console.log(`  (제외된 제목 예: ${titleNoise.slice(0, 3).map(t => `"${t.title}"`).join(' · ')})`);
  console.log('  키워드 표기가 빠져서 잘린 것이 있는지 확인해 주십시오. state/dropped.json 에 전부 남습니다.');
}

let added = 0, updated = 0, gone = 0, failed = 0;
for (const [i, [id, v]] of targets.entries()) {
  const existing = store.postings[`wanted:${id}`];
  process.stdout.write(`\r[${i + 1}/${targets.length}] ${String(v.item.company?.name ?? '').slice(0, 16).padEnd(18)}`);

  // 이미 받아 둔 건은 다시 받지 않는다 (--refresh 로 강제).
  // 🔴 단, JD 원문이 없으면 다시 받는다. 공고는 마감되면 사라져 소급이 안 되므로
  //    "공고는 있는데 원문이 없는" 상태를 방치하면 그대로 영구 손실이 된다.
  const jdMissing = !existing?.jd || !fs.existsSync(existing.jd);
  if (existing && !has('refresh') && !jdMissing) {
    existing.matchedKeywords = [...new Set([...(existing.matchedKeywords ?? []), ...v.matched])];
    existing.status = v.item.status === 'active' ? 'active' : 'closed';
    existing.seenRunId = runId;
    updated++;
    continue;
  }
  const d = await fetchDetail(id);
  if (d.unknown) { failed++; continue; }
  const j = d.job;

  if (d.gone) {
    // 🔴 여기서 지우지 않는다. 같은 자리가 새 ID로 재공고되는 일이 흔해
    //    회사 단위 재검색(check_alive)이 판단하게 남겨 둔다.
    if (existing) { existing.status = 'closed'; existing.goneAt = new Date().toISOString(); }
    gone++;
    continue;
  }
  const rec = toRecord(profile, j, v.item, v.matched);
  rec.seenRunId = runId;
  if (existing) { store.postings[`wanted:${id}`] = { ...existing, ...rec }; updated++; }
  else { store.postings[`wanted:${id}`] = rec; added++; }
}
process.stdout.write('\n');

// 🔴 검색 조건이 바뀌면(PM → QA) 옛 조건으로 모은 공고가 그대로 남아 리포트에 섞인다.
//    지우지는 않는다 — 이력이고, 되돌릴 수도 있다. 대신 **이번 실행에서 안 보인 건**은 stale로 표시한다.
//    단 이번 실행이 부분 실패였으면 표시하지 않는다. 네트워크 오류를 "조건에서 빠짐"으로 오해하게 된다.
let staled = 0;
if (manifest.complete) {
  for (const p of Object.values(store.postings)) {
    if (p.board !== 'wanted') continue;
    // 🔴 손으로 넣은 공고는 애초에 검색 조건 밖이라서 넣은 것이다. 조건 밖이라고 표시하면 안 된다.
    if (p.pinned) continue;
    if (p.seenRunId === runId) { if (p.stale) { delete p.stale; } continue; }
    if (!p.stale) { p.stale = true; p.staleSince = runId; staled++; }
  }
}

store.updatedAt = new Date().toISOString();
store.lastRun = manifest;
writeJson(file, store);

// 제목 필터로 자른 건을 제외 목록에 합친다 (게이트가 나중에 자기 몫을 덧붙인다).
const dropFile = statePath(profile, 'dropped.json');
const dropStore = readJson(dropFile, { byReason: {}, dropped: [] });
const keep = (dropStore.dropped ?? []).filter(d => d.reason !== 'titleKeywordMiss');
dropStore.dropped = [...keep, ...titleNoise];
dropStore.byReason = dropStore.dropped.reduce((a, d) => (a[d.reason] = (a[d.reason] ?? 0) + 1, a), {});
dropStore.updatedAt = new Date().toISOString();
writeJson(dropFile, dropStore);

const all = Object.values(store.postings);
console.log(`\n신규 ${added} · 갱신 ${updated} · 내려감 ${gone} · 실패 ${failed}${staled ? ` · 조건 밖으로 이동 ${staled}` : ''}`);
console.log(`보관 ${before} → ${all.length}건 (살아있음 ${all.filter(p => p.status === 'active' && !p.stale).length})`);
if (!manifest.complete) {
  const bad = manifest.queries.filter(q => !q.ok || q.truncated);
  console.log(`\n⚠ 이번 수집은 완전하지 않습니다 — ${bad.map(q => (q.ok ? `${q.query}(잘림)` : `${q.query} — ${q.label ?? '실패'}`)).join(', ')}`);
  console.log('  리포트 상단에도 같은 경고가 표시됩니다. 이 결과를 "전수"로 읽지 마십시오.');
  // 🔴 무엇이 잘못됐는지만 말하고 끝내지 않는다. 사용자가 **다음에 할 일**을 적는다 —
  //    "추천 0건"만 받은 사용자는 도구가 고장 났다고 판단하고 다시 열지 않는다.
  for (const h of [...new Set(manifest.queries.filter(q => !q.ok && q.hint).map(q => q.hint))]) {
    console.log(`\n  → ${h}`);
  }
}
console.log(`→ ${file}`);
