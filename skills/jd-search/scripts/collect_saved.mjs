#!/usr/bin/env node
/**
 * 1단계 collect — **내가 저장한 검색 결과 HTML**.
 *
 * 실행: node collect_saved.mjs --file <저장한.html> [--file …] [--dir <폴더>] [--max 200] [--refresh]
 * 출력: ~/.jd-search/<프로필>/state/postings.json  ·  state/jd/<보드>-<id>.md
 *
 * 쓰는 법 (사용자에게 안내할 순서):
 *   1. 브라우저에서 평소처럼 그 사이트의 검색 결과를 연다 (로그인이 필요하면 로그인한 채로)
 *   2. 페이지를 저장한다 (⌘S / Ctrl+S — "웹페이지, 전체" 도 되고 "HTML만" 도 된다)
 *   3. 그 파일을 이 스크립트에 넣는다
 *
 * 🔴 이 스크립트는 **저장본에서 공고 주소만** 꺼낸다. 회사명·제목·마감·근무지는
 *    각 보드의 검증된 상세 파서가 다시 읽는다. 저장본 화면 글자를 그대로 믿으면
 *    보드가 화면을 바꾸는 순간 엉뚱한 값이 조용히 들어온다.
 * 🔴 `profile.yml` 의 `sources.<보드>` 가 `off` 면 저장본에 들어 있어도 받지 않는다.
 *    파일을 넣었다는 것이 "그 보드에 접속해도 된다"는 뜻은 아니다 (링크드인이 정확히 그 경우다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, statePath, readJson, writeJson } from './lib/io.mjs';
import { extractPostings, describeSaved, hasLinkedIn } from './lib/saved.mjs';
import { planDetailBudget } from './lib/budget.mjs';
import { diagnose } from './lib/http.mjs';
import { boardLabel } from './lib/runstatus.mjs';

import { recordFromId, canAdd } from './lib/board_adapters.mjs';

const argv = process.argv.slice(2);
const flags = name => argv.reduce((a, v, i) => (v === `--${name}` && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const flag = (name, def = null) => flags(name)[0] ?? def;
const has = name => argv.includes(`--${name}`);

const profile = loadProfile(flag('profile') || undefined);

// ── 입력 파일 모으기 ────────────────────────────────────────────────────────
const files = [...flags('file')];
for (const dir of flags('dir')) {
  for (const f of fs.readdirSync(dir)) {
    if (/\.(html?|htm)$/i.test(f)) files.push(path.join(dir, f));
  }
}
if (!files.length) {
  console.error('저장한 HTML 파일을 지정해 주십시오.  예: node collect_saved.mjs --file ~/Downloads/검색결과.html');
  console.error('  브라우저에서 검색 결과를 연 뒤 ⌘S(Ctrl+S)로 저장한 파일이면 됩니다.');
  process.exit(1);
}

/** 🔴 인크루트처럼 EUC-KR 로 저장된 파일이 있다. UTF-8 로 읽으면 주소는 살아도 진단 문구가 깨진다. */
function readHtml(file) {
  const buf = fs.readFileSync(file);
  const head = buf.subarray(0, 4096).toString('latin1');
  const cs = (head.match(/charset=["']?([A-Za-z0-9\-_]+)/i) ?? [])[1];
  const charset = cs && !/^utf-?8$/i.test(cs) ? cs.toLowerCase() : 'utf-8';
  try { return new TextDecoder(charset).decode(buf); } catch { return buf.toString('utf8'); }
}

const file = statePath(profile, 'postings.json');
const store = readJson(file, { updatedAt: null, postings: {} });
const before = Object.keys(store.postings).length;
const runId = new Date().toISOString();
const manifest = { runId, board: 'saved', queries: [], complete: true };

// ── 저장본에서 공고 주소 뽑기 ───────────────────────────────────────────────
const found = new Map();
let sawLinkedIn = false;
for (const f of files) {
  let html;
  try { html = readHtml(f); }
  catch (e) {
    console.log(`✖ ${path.basename(f)} — 파일을 읽지 못했습니다 (${e.message})`);
    manifest.queries.push({ query: path.basename(f), ok: false, error: e.message, label: '파일 읽기 실패' });
    manifest.complete = false;
    continue;
  }
  const { postings, base, skipped } = extractPostings(html);
  const site = describeSaved(html);
  if (hasLinkedIn(html)) sawLinkedIn = true;
  for (const p of postings) if (!found.has(`${p.board}:${p.id}`)) found.set(`${p.board}:${p.id}`, p);

  const byBoard = postings.reduce((a, p) => (a[p.board] = (a[p.board] ?? 0) + 1, a), {});
  const summary = Object.entries(byBoard).map(([b, n]) => `${boardLabel(b)} ${n}`).join(' · ') || '0';
  console.log(`${path.basename(f)}${site ? ` (${site})` : ''} — ${summary}건`);
  manifest.queries.push({ query: path.basename(f), ok: true, found: postings.length, byBoard, base });
  // 🔴 기준 주소를 못 찾아 버린 상대 링크가 있으면 말해 준다. 조용히 줄어드는 것이 가장 나쁘다.
  if (skipped.relativeNoBase) {
    console.log(`  ⚠ 기준 주소를 찾지 못해 상대 경로 링크 ${skipped.relativeNoBase}개를 건너뛰었습니다.`);
    console.log('    "웹페이지, 전체" 로 저장하거나 공고 주소가 절대 주소로 들어 있는 화면을 저장해 주십시오.');
    manifest.complete = false;
  }
}

if (sawLinkedIn) {
  // 🔴 주소를 알아도 받지 않는다. 도구가 링크드인에 접속하면 제재가 **사용자 개인 계정**에 온다.
  console.log('\n⚠ 링크드인 공고가 저장본에 들어 있습니다 — 이 도구는 링크드인을 받지 않습니다.');
  console.log('  이유는 두 가지입니다. (1) 도구가 접속하면 제재가 이 컴퓨터가 아니라 **당신 계정**에 옵니다.');
  console.log('  (2) 저장본 화면 글자만으로 회사·마감을 읽는 파서는 아직 검증하지 못했습니다 — 지어내지 않습니다.');
  console.log('  지금은 눈으로 보시고, 넣고 싶은 공고만 add_posting 으로 하나씩 넣어 주십시오.');
}

const isOff = p => (profile.sources?.[p.board] ?? 'api') === 'off';
const targets = [...found.values()].filter(p => !isOff(p) && canAdd(p.board));
const offBoards = [...new Set([...found.values()].filter(isOff).map(p => p.board))];
const noAdapter = [...new Set([...found.values()].filter(p => !isOff(p) && !canAdd(p.board)).map(p => p.board))];

console.log(`\n공고 주소 ${found.size}건 · 받을 수 있는 것 ${targets.length}건`);
for (const b of offBoards) console.log(`  · ${boardLabel(b)} 는 profile.yml 에서 off 라 건너뜁니다`);
if (noAdapter.length) console.log(`  · 수집기가 없는 보드: ${noAdapter.map(boardLabel).join(' · ')}`);

// 🔴 상세 조회 예산 — 다른 보드와 같은 규칙(첫 실행 전량 · 재실행 200 · 받아야 할 것만 셈).
const needsFetch = key => {
  const existing = store.postings[key];
  return !existing || has('refresh') || !existing.jd || !fs.existsSync(existing.jd);
};
const firstRun = !Object.values(store.postings).some(p => p.via === 'saved');
const { allowed, cutOff, max: MAX_FETCH } = planDetailBudget(
  targets.map(p => `${p.board}:${p.id}`), needsFetch, { maxFlag: flag('max'), firstRun },
);
if (cutOff > 0) {
  manifest.complete = false;
  manifest.detailTruncated = { seen: targets.length, fetched: allowed.size, pending: cutOff, max: MAX_FETCH };
}

let added = 0, updated = 0, gone = 0, failed = 0, skipped = 0;
for (const [i, p] of targets.entries()) {
  const key = `${p.board}:${p.id}`;
  const existing = store.postings[key];
  process.stdout.write(`\r[${i + 1}/${targets.length}] ${boardLabel(p.board).padEnd(6)} ${p.id.padEnd(14)}`);

  if (!needsFetch(key)) { existing.seenRunId = runId; updated++; continue; }
  if (!allowed.has(key)) { skipped++; continue; }

  let r;
  try { r = await recordFromId(profile, p.board, p.id, ['저장본']); }
  catch (e) { r = { unknown: true, error: diagnose(e).message }; }

  if (r.unknown) { failed++; continue; }
  if (r.gone) {
    if (existing) { existing.status = 'closed'; existing.goneAt = new Date().toISOString(); }
    gone++;
    continue;
  }
  // 🔴 어디서 온 공고인지 남긴다. 검색 조건으로 모은 것이 아니라서
  //    다른 수집기가 "조건 밖으로 이동(stale)"으로 표시하면 안 된다 — `pinned` 가 그 표시다.
  r.rec.seenRunId = runId;
  r.rec.via = 'saved';
  r.rec.pinned = true;
  if (existing) { store.postings[key] = { ...existing, ...r.rec }; updated++; }
  else { store.postings[key] = r.rec; added++; }
}
process.stdout.write('\n');

store.updatedAt = new Date().toISOString();
store.runs = { ...(store.runs ?? {}), saved: manifest };
if (store.lastRun?.board) store.runs[store.lastRun.board] ??= store.lastRun;
writeJson(file, store);

const all = Object.values(store.postings);
console.log(`\n신규 ${added} · 갱신 ${updated} · 내려감 ${gone} · 실패 ${failed}${skipped ? ` · 예산 밖 ${skipped}` : ''}`);
console.log(`보관 ${before} → ${all.length}건`);
if (manifest.detailTruncated) {
  console.log(`\n⚠ 상세를 못 받은 것이 ${manifest.detailTruncated.pending}건 남았습니다 (--max ${MAX_FETCH}).`);
  console.log('  같은 파일로 다시 실행하면 이어서 받습니다.');
}
console.log(`→ ${file}`);
