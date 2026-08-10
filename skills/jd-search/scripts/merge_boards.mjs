#!/usr/bin/env node
/**
 * 2단계 merge — 교차 보드 중복 병합.
 *
 * 실행: node merge_boards.mjs [--profile <id>] [--show]
 * 출력: state/postings.json 갱신 (mergedInto · sources) · state/merges.json
 *
 * 같은 자리가 원티드·사람인에 동시에 올라오는 건 흔하다. 그대로 두면 목록이 두 배로 부풀고,
 * 어느 쪽에 지원했는지도 헷갈린다.
 *
 * 🔴 **레코드를 지우지 않는다.** 종속 건에 `mergedInto` 만 붙이고 대표에 출처를 모은다.
 *    지우면 이력이 끊기고, 병합이 틀렸을 때 되돌릴 수 없다 (D6 과 같은 원칙).
 *
 * 🔴 **불확실하면 병합하지 않는다.** 합치지 않은 후보는 `state/merges.json` 의 candidates 에
 *    남고 리포트에 "중복일 수 있음"으로 표시된다. 판정 규칙은 `lib/merge.mjs` 머리말에 있다.
 *
 * 사용자가 직접 정한 것(serve 의 "합치기/따로 두기")은 `state/merges.json` 의 decisions 에 남고
 * **규칙보다 우선한다.** 매번 같은 것을 다시 판정하지 않기 위해서다.
 */
import { loadProfile, statePath, readJson, writeJson } from './lib/io.mjs';
import { planMerge, keyOf } from './lib/merge.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
const file = statePath(profile, 'postings.json');
const store = readJson(file);
if (!store) { console.error('postings.json 이 없습니다. collect 단계를 먼저 돌려 주십시오.'); process.exit(1); }

const mergeFile = statePath(profile, 'merges.json');
const saved = readJson(mergeFile, { decisions: {}, updatedAt: null });

const postings = Object.values(store.postings ?? {});
const boards = [...new Set(postings.map(p => p.board))];
if (boards.length < 2) {
  console.log(`보드가 ${boards.length}개(${boards.join(', ') || '없음'})뿐이라 교차 병합할 것이 없습니다.`);
  console.log('  사람인도 모으려면:  node scripts/collect_saramin.mjs');
  process.exit(0);
}

const { groups, candidates, stats } = planMerge(postings, saved.decisions ?? {});

if (argv.includes('--show')) {
  console.log(`병합 대상 ${stats.groups}묶음 · 보류 ${stats.candidates}건 (아무것도 쓰지 않았습니다)\n`);
  for (const g of groups) {
    console.log(`  [합침] ${store.postings[g.primary].company?.name} — 유사도 ${g.score}`);
    for (const m of g.members) console.log(`      ${m === g.primary ? '대표' : '종속'}  ${m}  ${store.postings[m].title}`);
  }
  for (const c of candidates) {
    console.log(`  [보류] ${c.a} ↔ ${c.b}  유사도 ${c.score} — ${c.why}`);
  }
  process.exit(0);
}

// 🔴 멱등하게 만든다 — 이전 실행이 붙인 표시를 먼저 전부 걷어내고 새로 계산한 것만 붙인다.
//    안 걷어내면 검색 조건이 바뀌어 병합이 풀려야 할 때 옛 표시가 그대로 남는다.
for (const p of postings) {
  delete p.mergedInto;
  delete p.sources;
  delete p.mergeCandidates;
}

for (const g of groups) {
  const primary = store.postings[g.primary];
  const members = g.members.map(k => store.postings[k]);

  primary.sources = members.map(m => ({
    board: m.board, id: m.id, url: m.url,
    status: m.status, dueTime: m.dueTime ?? null,
  }));
  // 🔴 한 보드에서 마감돼도 다른 보드에 살아 있으면 그 자리는 살아 있는 것이다.
  //    대표를 살아있는 쪽으로 골랐지만, 마감 뒤 재수집으로 뒤집힐 수 있으니 여기서 한 번 더 본다.
  if (members.some(m => m.status !== 'closed')) primary.status = 'active';
  primary.mergedBoards = g.boards;

  for (const m of members) {
    if (keyOf(m) === g.primary) continue;
    m.mergedInto = g.primary;
  }
}

// 보류 후보는 양쪽에 표시만 한다. 합치지 않는다.
for (const c of candidates) {
  for (const [self, other] of [[c.a, c.b], [c.b, c.a]]) {
    const p = store.postings[self];
    if (!p) continue;
    (p.mergeCandidates ??= []).push({ key: other, score: c.score, why: c.why });
  }
}

store.updatedAt = new Date().toISOString();
store.lastMerge = { runId: new Date().toISOString(), ...stats };
writeJson(file, store);
writeJson(mergeFile, {
  updatedAt: new Date().toISOString(),
  decisions: saved.decisions ?? {},
  groups, candidates,
});

console.log(`공고 ${stats.postings}건 · 보드 ${boards.join('+')}`);
console.log(`  합친 묶음 ${stats.groups}개 (중복 ${stats.merged}건이 대표 아래로 들어갔습니다)`);
for (const g of groups.slice(0, 8)) {
  const p = store.postings[g.primary];
  console.log(`    ${p.company?.name} — ${String(p.title).slice(0, 34)} [${g.boards.join('+')}] 유사도 ${g.score}`);
}
if (groups.length > 8) console.log(`    … 외 ${groups.length - 8}묶음`);

if (candidates.length) {
  console.log(`\n  🔴 합치지 않은 중복 후보 ${candidates.length}건 — 근거가 약해 보류했습니다.`);
  console.log('     잘못 합치면 서로 다른 자리 하나가 목록에서 조용히 사라집니다. 리포트에 "중복일 수 있음"으로 표시됩니다.');
  for (const c of candidates.slice(0, 5)) {
    const a = store.postings[c.a], b = store.postings[c.b];
    const why = { 'region-unknown': '한쪽 근무지를 몰라서', 'region-differs': '근무지가 달라서', 'multiple-candidates': '비슷한 후보가 여럿이라', 'title-below-threshold': '제목 유사도가 낮아서' }[c.why] ?? c.why;
    console.log(`     ${a?.company?.name} — "${String(a?.title).slice(0, 24)}" ↔ "${String(b?.title).slice(0, 24)}" (${why}, 유사도 ${c.score})`);
  }
  if (candidates.length > 5) console.log(`     … 외 ${candidates.length - 5}건`);
}
console.log(`\n→ ${file}`);
