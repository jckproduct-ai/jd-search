#!/usr/bin/env node
/**
 * 3단계 alive — 살아있는 공고만 남기고, **내려간 자리의 재공고를 되찾는다.**
 *
 * 실행: node check_alive.mjs [--profile <id>] [--all] [--board wanted|saramin]
 * 출력: state/postings.json 갱신 (+ 재공고로 발견한 신규 공고 · JD 원문)
 *
 * 🔴 **공고 ID 하나만 보면 살아있는 자리를 놓친다.** 실측에서 "마감"으로 잡힌 것 중 6건이
 *    실제로는 살아 있었다 — 같은 자리가 새 ID로 다시 올라와 있었기 때문이다.
 *    그래서 이 단계는 "죽은 것 지우기"가 아니라 **"산 것 되찾기"** 다.
 *
 * 🔴 세 갈래로 판정한다. 네트워크 오류를 마감으로 굳히지 않는다.
 *      alive / closed / unknown(다음 실행에 다시 본다)
 *
 * 🔴 **보드마다 마감 판정 신호가 전혀 다르다.** 하나의 규칙으로 묶으면 한쪽이 반드시 틀린다.
 *    그래서 보드별 어댑터로 나눠 두었다. 새 보드를 붙일 때 여기만 늘리면 된다.
 *
 *      원티드   API `status` 필드          — 명시적 상태값이 온다
 *      사람인   상세의 `<div class="status">` — info_timer / 상시 채용 / 채용시 마감 / 마감되었습니다
 *
 *    🔴 어느 보드에서도 **날짜 경과를 마감 근거로 쓰지 않는다.** 연장·상시 전환이 흔하고,
 *       사람인은 실측 40건 중 9건(22%)이 아예 마감일이 없는 상시·채용시 공고다.
 *
 * 이 단계가 새 공고를 만들면 gate·finance 대상이 늘어난다.
 * → 표준 루프는 `collect → merge → gate → alive → gate·finance 재실행 → render` 다.
 */
import { loadProfile, statePath, readJson, writeJson } from './lib/io.mjs';
import * as wanted from './lib/wanted.mjs';
import * as saramin from './lib/saramin.mjs';
import { similarity, normCorp, matchesAny } from './lib/text.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
const file = statePath(profile, 'postings.json');
const store = readJson(file);
if (!store) { console.error('postings.json 이 없습니다. collect 단계를 먼저 돌려 주십시오.'); process.exit(1); }

const runId = new Date().toISOString();
const roles = profile.target?.roles ?? [];

// ── 보드 어댑터 ─────────────────────────────────────────────────────────────
// 각 어댑터는 네 가지만 안다: 상태 확인 / 회사 식별 / 회사 단위 재검색 / 레코드 만들기.
// 그 바깥의 판단(무엇을 되찾을지, 어떻게 이을지)은 보드와 무관하게 아래 공통 로직이 한다.

const ADAPTERS = {
  wanted: {
    /** @returns {{state:'alive'|'closed'|'unknown', error?}} */
    async check(p) {
      const d = await wanted.fetchDetail(p.id);
      if (d.unknown) return { state: 'unknown', error: d.error };
      // 🔴 마감 근거는 `status` 뿐이다. dueTime 경과는 쓰지 않는다.
      if (d.gone || (d.job?.status ?? 'active') !== 'active') return { state: 'closed', gone: Boolean(d.gone) };
      return { state: 'alive' };
    },
    /** 🔴 회사명 `includes` 로 채택하면 "미소 → 미소무역" 함정이 재현된다. 보드 회사 ID를 쓴다. */
    async searchCompany(c) {
      const { items } = await wanted.listByQuery(c.name, { max: 100 });
      return items
        .filter(it => (it.status ?? 'active') === 'active')
        .filter(it => (c.boardId ? it.company?.id === c.boardId : normCorp(it.company?.name) === normCorp(c.name)))
        .map(it => ({ id: String(it.id), title: it.position, raw: it }));
    },
    async record(item, matched) {
      const d = await wanted.fetchDetail(item.id);
      if (!d.job) return null;
      return wanted.toRecord(profile, d.job, item.raw, matched);
    },
  },

  saramin: {
    async check(p) {
      const d = await saramin.fetchDetail(p.id);
      if (d.gone) return { state: 'closed', gone: true };
      if (d.unknown) return { state: 'unknown', error: d.error };
      // 🔴 상태 블록과 지원 버튼이 어긋나면 parseDetail 이 null 을 준다 → 마감으로 굳히지 않는다.
      if (d.detail.state === 'closed') return { state: 'closed', gone: false };
      if (d.detail.state === 'active') return { state: 'alive', detail: d.detail };
      return { state: 'unknown', error: '상태 신호가 서로 어긋남' };
    },
    /** 사람인 회사 식별자는 `csn`(암호화 문자열). 없으면 정규화 상호 완전일치로만 좁힌다. */
    async searchCompany(c) {
      // 🔴 사람인 검색 결과에는 상태가 없다. 여기서는 후보만 모으고,
      //    실제 살아있음은 record() 가 상세를 받을 때 확인한다(마감이면 버린다).
      const { items } = await saramin.listByQuery(c.name, () => true, { maxPages: 2 });
      return items
        .filter(it => (c.boardId ? it.csn === c.boardId : normCorp(it.company) === normCorp(c.name)))
        .map(it => ({ id: String(it.id), title: it.title, raw: it }));
    },
    async record(item, matched) {
      const r = await saramin.toRecord(profile, item.raw, matched);
      if (r.gone || r.unknown) return null;
      // 🔴 재검색으로 찾았는데 상세에서 마감으로 나오면 되찾은 것이 아니다. 넣지 않는다.
      if (r.rec.status === 'closed') return null;
      return r.rec;
    },
  },
};

const onlyBoard = flag('board');
const all = Object.entries(store.postings ?? {})
  .filter(([, p]) => ADAPTERS[p.board] && (!onlyBoard || p.board === onlyBoard));

if (!all.length) {
  console.error(onlyBoard ? `보드 "${onlyBoard}" 공고가 없습니다.` : '확인할 수 있는 보드의 공고가 없습니다.');
  process.exit(1);
}

// 확인 대상: 살아있다고 알려진 것 + 지난번 판정 불가였던 것. --all 이면 마감 건까지.
// --only <board:id> 면 그 하나만 (serve 의 "지금 확인" 버튼이 쓴다).
const only = flag('only');
const targets = only
  ? all.filter(([k]) => k === only)
  : all.filter(([, p]) => argv.includes('--all') || p.status === 'active' || p.aliveState === 'unknown');
if (only && !targets.length) { console.error(`"${only}" 공고가 없습니다.`); process.exit(1); }

if (!targets.length) { console.log('확인할 공고가 없습니다.'); process.exit(0); }
const byBoardCount = targets.reduce((a, [, p]) => (a[p.board] = (a[p.board] ?? 0) + 1, a), {});
console.log(`살아있음 재확인 ${targets.length}건 (${Object.entries(byBoardCount).map(([b, n]) => `${b} ${n}`).join(' · ')})\n`);

// ── 1. 개별 공고 상태 확인 ──────────────────────────────────────────────────
const closed = [];
let alive = 0, unknown = 0;

for (const [i, [key, p]] of targets.entries()) {
  process.stdout.write(`\r[${i + 1}/${targets.length}] ${p.board.padEnd(8)} ${String(p.company?.name ?? '').slice(0, 16).padEnd(18)}`);
  const r = await ADAPTERS[p.board].check(p);

  if (r.state === 'unknown') {
    // 🔴 조회 실패는 마감이 아니다. 상태를 건드리지 않고 다음 실행에 다시 본다.
    p.aliveState = 'unknown';
    p.aliveCheckedAt = runId;
    p.aliveError = r.error;
    unknown++;
    continue;
  }
  delete p.aliveError;
  p.aliveCheckedAt = runId;

  if (r.state === 'alive') {
    p.status = 'active'; p.aliveState = 'alive';
    if (r.detail?.dueTime !== undefined) { p.dueTime = r.detail.dueTime; p.dueKind = r.detail.dueKind; }
    alive++;
    continue;
  }
  p.status = 'closed';
  p.aliveState = 'closed';
  p.closedAt ??= runId;
  if (r.gone) p.goneAt ??= runId;
  closed.push([key, p]);
}
process.stdout.write('\n');
console.log(`  살아있음 ${alive} · 마감 ${closed.length} · 판정 불가 ${unknown}`);

// ── 2. 🔴 마감 건은 회사 단위로 재공고를 되짚는다 ────────────────────────────
//     여기가 이 단계의 본론이다. 하나씩 지우고 끝내면 산 자리를 잃는다.
//     🔴 회사는 **보드별로** 묶는다. 같은 회사라도 보드가 다르면 식별자도 검색 방식도 다르다.
const byCompany = new Map();
for (const [, p] of closed) {
  const name = p.company?.name;
  if (!name) continue;
  const boardId = p.company?.boardId;
  const k = `${p.board}|${boardId ? `id:${boardId}` : `nm:${normCorp(name)}`}`;
  if (!byCompany.has(k)) byCompany.set(k, { board: p.board, name, boardId, posts: [] });
  byCompany.get(k).posts.push(p);
}

const skipped = [];
let found = 0, relinked = 0, ambiguous = 0;
if (byCompany.size) console.log(`\n마감 ${closed.length}건 → 회사 ${byCompany.size}곳에서 재공고 확인`);

for (const [i, c] of [...byCompany.values()].entries()) {
  process.stdout.write(`\r  [${i + 1}/${byCompany.size}] ${c.board.padEnd(8)} ${c.name.slice(0, 16).padEnd(18)}`);
  let live = [];
  try { live = await ADAPTERS[c.board].searchCompany(c); }
  catch { continue; }
  if (!live.length) continue;

  for (const old of c.posts) {
    // 🔴 "같은 자리"로 자동 연결하는 것은 **유사도 0.8 이상이 정확히 1건일 때만** 한다.
    //    여러 건이면 잇지 않고 "이 회사에 살아있는 공고 N건"으로만 알린다.
    //    부분일치 구제로 5건을 틀린 교훈과 같은 원칙이다 — 추측으로 잇지 않는다.
    const strong = live.map(it => ({ it, s: similarity(old.title, it.title) })).filter(x => x.s >= 0.8);
    if (strong.length === 1) {
      old.supersededBy = `${c.board}:${strong[0].it.id}`;
      old.supersededTitle = strong[0].it.title;
      relinked++;
    } else {
      old.liveAtCompany = live.map(it => `${c.board}:${it.id}`);
      if (strong.length > 1) ambiguous++;
    }
  }

  // 🔴 **회사에 살아있는 공고를 전부 끌어오면 안 된다.**
  //    실측에서 PM 자리를 되찾으려다 같은 회사의 "Senior Backend Engineer"가 목록에 들어왔다.
  //    조용한 손실을 막으려다 조용한 잡음을 만드는 셈이다.
  //    → 되찾는 것은 ① 옛 공고와 같은 자리로 연결된 것, 또는 ② 내 직군 키워드에 걸리는 것뿐이다.
  const linked = new Set(c.posts.map(p => p.supersededBy).filter(Boolean));
  for (const it of live) {
    const key = `${c.board}:${it.id}`;
    if (store.postings[key]) continue;
    const inScope = linked.has(key) || !roles.length || matchesAny(it.title, roles).length > 0;
    if (!inScope) { skipped.push(`${c.name} — ${it.title}`); continue; }

    const rec = await ADAPTERS[c.board].record(it, [`재공고:${c.name}`]);
    if (!rec) continue;
    rec.seenRunId = runId;
    rec.aliveState = 'alive';
    rec.discoveredVia = 'check_alive';
    // 🔴 지원 이력 승계 — 옛 공고에 진행 상태가 있었으면 새 ID로 이어 준다.
    const origin = c.posts.find(p => p.supersededBy === key);
    if (origin) rec.rebornFrom = `${origin.board}:${origin.id}`;
    store.postings[key] = rec;
    found++;
  }
}
if (byCompany.size) process.stdout.write('\n');

// ── 3. 지원 이력 승계 ───────────────────────────────────────────────────────
// 🔴 새 ID로 다시 올라온 자리에 지원 이력이 끊기면, 사용자는 같은 회사에 두 번 지원한다.
const appsFile = statePath(profile, 'applications.json');
const apps = readJson(appsFile, {});
let carried = 0;
for (const [, p] of all) {
  if (!p.supersededBy) continue;
  const from = `${p.board}:${p.id}`, to = p.supersededBy;
  if (!apps[from] || apps[to]) continue;
  apps[to] = { ...apps[from], carriedFrom: from, carriedAt: runId, history: [...(apps[from].history ?? []), from] };
  carried++;
}
if (carried) writeJson(appsFile, apps);

store.updatedAt = new Date().toISOString();
store.lastAliveRun = { runId, checked: targets.length, alive, closed: closed.length, unknown, found, relinked };
writeJson(file, store);

console.log(`\n재공고로 되찾은 공고 ${found}건 · 같은 자리로 연결 ${relinked}건`);
if (skipped.length) {
  console.log(`  (같은 회사에 살아있지만 내 직군이 아니라 가져오지 않은 공고 ${skipped.length}건)`);
  for (const s of skipped.slice(0, 5)) console.log(`     ${s}`);
}
if (ambiguous) console.log(`  (제목이 비슷한 후보가 여럿이라 자동 연결하지 않은 건 ${ambiguous}건 — 리포트에 "이 회사에 살아있는 공고" 로 표시됩니다)`);
if (carried) console.log(`  지원 이력 ${carried}건을 새 공고로 승계했습니다.`);
if (unknown) console.log(`\n⚠ ${unknown}건은 조회에 실패해 판정하지 못했습니다. 마감으로 처리하지 않았고 다음 실행에서 다시 봅니다.`);
if (found) console.log('\n🔴 새 공고가 생겼으니 merge_boards·gate·finance 를 다시 돌린 뒤 render 하십시오.');
console.log(`→ ${file}`);
