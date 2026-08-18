#!/usr/bin/env node
/**
 * serve — 실제로 작업하는 화면. 상태 변경 · 공고 추가 · 목록에서 숨김 · 중복 판정.
 *
 * 실행: node serve.mjs [--profile <id>] [--port 0]
 * 종료: Ctrl+C
 *
 * `out/report.html` 은 보관·공유용이라 **보기 전용**이다. 여기서만 고칠 수 있다.
 * 진행상태는 `state/applications.json` 에 저장한다 — 브라우저 localStorage 에 두면
 * 기기가 바뀌거나 캐시를 지울 때 조용히 사라진다.
 *
 * ── 보안 (이 서버는 이력서·자택주소·지원이력이 있는 디렉터리를 연다) ──────────
 * 🔴 127.0.0.1 에만 바인딩한다. 같은 네트워크의 다른 기기에서 열리면 안 된다.
 * 🔴 매 실행 랜덤 토큰을 만들고 모든 요청에 요구한다. 토큰 없이는 데이터 한 줄도 주지 않는다.
 *    브라우저에 떠 있는 **아무 웹페이지나** localhost 로 요청을 던질 수 있기 때문이다.
 * 🔴 Host 헤더를 검사한다 (DNS 리바인딩 차단). 쓰기 요청은 Origin 까지 본다 (CSRF 차단).
 * 🔴 브라우저를 자동으로 열지 않는다. 주소만 찍는다 — 동의 없이 브라우저를 여는 것은 이 스킬의 금지 항목이다.
 *
 * ── 삭제에 대하여 ────────────────────────────────────────────────────────────
 * 🔴 **레코드를 지우지 않는다.** "삭제"는 목록에서 숨기는 것이고, 기록과 JD 원문은 남는다.
 *    같은 자리가 새 ID로 재공고되는 일이 흔해, 지우면 이력이 끊기고 같은 회사에 두 번 지원하게 된다.
 *    되돌리기는 화면의 "숨긴 공고 보기"에서 한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile, statePath, readJson, writeJson } from './lib/io.mjs';
import { GRADE_LABEL } from './lib/grade.mjs';
import { EXPERIENCE_TAG_LABEL } from './lib/experience.mjs';
import { normCorp } from './lib/text.mjs';
import { mergeVerdicts } from './lib/merge.mjs';
import { parsePostingUrl } from './lib/board_url.mjs';
import { summarizeRuns, runsOf, BOARD_LABEL } from './lib/runstatus.mjs';
import { investmentLine } from './lib/investment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
// 🔴 하위 스크립트에 넘길 프로필은 **실제 디렉터리 이름**이다.
//    profile.yml 의 id 필드와 디렉터리 이름이 다를 수 있어 그걸 믿으면 엉뚱한 프로필에 쓴다.
const PROFILE_ID = path.basename(profile.dir);
const TOKEN = crypto.randomBytes(24).toString('base64url');
const PORT = Number(flag('port') ?? 0);          // 0 = 빈 포트를 OS가 고른다

const DUE_KIND_LABEL = { always: '상시채용', untilFilled: '채용시 마감' };
const STATUSES = ['', '관심', '지원함', '서류 통과', '면접 진행중', '최종 합격', '불합격', '보류'];

// ── 데이터 조립 — render.mjs 와 같은 규칙을 쓴다 ─────────────────────────────
// 🔴 여기서만 지원 이력을 싣는다. report.html 은 공유될 수 있어 기본으로 빼지만,
//    serve 는 로컬 전용이고 그게 존재 이유다.
function buildData() {
  const store = readJson(statePath(profile, 'postings.json'), { postings: {} });
  const gate = readJson(statePath(profile, 'gate.json'), { verdicts: {} });
  const fin = readJson(statePath(profile, 'finance.json'), { companies: {}, baseline: null });
  const dropped = readJson(statePath(profile, 'dropped.json'), { byReason: {}, dropped: [] });
  const apps = readJson(statePath(profile, 'applications.json'), {});
  const hidden = readJson(statePath(profile, 'hidden.json'), { hidden: {} }).hidden ?? {};
  const postings = store.postings ?? {};

  const rows = [];
  for (const [key, p] of Object.entries(postings)) {
    if (p.mergedInto && postings[p.mergedInto]) continue;
    const groupKeys = [key, ...Object.entries(postings).filter(([, q]) => q.mergedInto === key).map(([k]) => k)];
    const g = mergeVerdicts(groupKeys.map(k => gate.verdicts?.[k]).filter(Boolean)) ?? { verdict: 'pass', reason: 'no-gate' };
    if (g.verdict === 'drop') continue;
    const f = fin.companies?.[normCorp(p.company?.name)] ?? {};
    rows.push({
      key, board: p.board, url: p.url, title: p.title,
      sources: (p.sources ?? [{ board: p.board, id: p.id, url: p.url, status: p.status }])
        .map(s => ({ ...s, label: BOARD_LABEL[s.board] ?? s.board })),
      company: p.company?.name ?? '', industry: p.company?.industry ?? null,
      region: g.region ?? p.location?.district ?? null,
      straightKm: g.straightKm ?? null, approx: Boolean(g.approx),
      status: p.status, dueTime: p.dueTime, dueKindLabel: DUE_KIND_LABEL[p.dueKind] ?? null,
      stale: Boolean(p.stale), annualFrom: p.annualFrom, collectedAt: p.collectedAt,
      dupHint: p.mergeCandidates?.length ?? 0,
      dupPairs: (p.mergeCandidates ?? []).map(c => ({
        key: c.key, score: c.score, why: c.why,
        title: postings[c.key]?.title ?? '(없음)', company: postings[c.key]?.company?.name ?? '',
      })),
      tags: [
        ...(g.tags ?? []),
        ...(g.verdict === 'hold' ? ['근무지 미확인'] : []),
        ...(p.stale ? ['조건 밖'] : []),
        ...(p.pinned ? ['직접 추가'] : []),
        ...(p.jdKind === 'imageOnly' ? ['본문 이미지'] : []),
      ],
      grade: f.grade ?? 'u', gradeLabel: GRADE_LABEL[f.grade ?? 'u'], gradeYear: f.gradeYear ?? null,
      // 🔴 리포트와 **같은 규칙**으로 싣는다 (render.mjs 참조). 화면 둘이 갈라지면 안 된다.
      reasons: ((f.grade === 'u' && f.note) ? [] : (f.reasons ?? []))
        .filter(x => x !== (f.investment ? investmentLine(f.investment) : null)),
      investment: f.investment?.latest
        ? { line: investmentLine(f.investment), url: f.investment.latest.url ?? null,
            date: f.investment.latest.date, label: f.investment.latest.label, count: f.investment.count }
        : null,
      gradeBeforeInvestment: f.gradeBeforeInvestment ?? null,
      questions: f.questions ?? [],
      note: f.ambiguous ? '같은 이름의 법인이 여러 곳이라 재무를 붙이지 않았습니다 — 어느 회사인지 확인이 필요합니다'
        : (f.note ?? (fin.updatedAt ? (f.grade === 'u' ? (f.reasons ?? [])[0] : null) : '재무 단계를 아직 돌리지 않았습니다')),
      confirmedBy: f.userDecided && f.userDecided !== 'skip' ? String(f.userDecided) : null,
      vsBaseline: f.vsBaseline ?? null,
      appStatus: apps[key]?.status ?? null,
      appMemo: apps[key]?.memo ?? '',
      hidden: Boolean(hidden[key]),
    });
  }

  const known = rows.filter(r => r.grade !== 'u');
  const companies = new Set(rows.map(r => normCorp(r.company)));
  // 🔴 리포트와 **같은 문구**를 쓴다. 여기서 따로 만들면 화면마다 다른 말을 하게 된다.
  const runSummary = summarizeRuns(runsOf(store));
  const incomplete = [...runSummary.failures, ...runSummary.truncations].map(f => f.text);
  const enabled = Object.entries(profile.sources ?? {})
    .filter(([b, m]) => ['wanted', 'saramin'].includes(b) && m !== 'off').map(([b]) => b);
  const collected = new Set(Object.values(postings).map(p => p.board));

  const visible = rows.filter(r => !r.hidden);
  return {
    title: `공고 ${visible.length}건 · 회사 ${companies.size}곳`,
    generatedAt: new Date().toLocaleString('ko-KR', { hour12: false }),
    criteria: { regions: profile.location?.regions ?? [] },
    baseline: fin.baseline ? { company: fin.baseline.company, year: fin.baseline.year } : null,
    gradeLabels: GRADE_LABEL, boardLabels: BOARD_LABEL,
    tagLabels: { remote: '풀리모트', hybrid: '하이브리드', ...EXPERIENCE_TAG_LABEL, watchlist: '관심회사' },
    reasonLabels: {
      outOfRegion: '희망 지역 밖', denyRegion: '제외 지역', blocklist: '제외 회사',
      excludeRole: '제외 직무 키워드', excludeIndustry: '제외 업종',
      regionUnknown: '근무지 판정 불가', saraminTitleNoise: '사람인 확장검색 잡음',
    },
    stats: [
      { label: '본 목록', value: String(visible.length) },
      { label: '살아있음', value: String(visible.filter(r => r.status !== 'closed').length) },
      { label: '회사', value: String(companies.size) },
      { label: '자금등급 확보', value: `${rows.length ? Math.round(known.length / rows.length * 100) : 0}%` },
      { label: '숨김', value: String(rows.length - visible.length) },
    ],
    rows,
    dropped: { byReason: dropped.byReason ?? {}, items: dropped.dropped ?? [] },
    ambiguous: Object.values(fin.companies ?? {}).filter(c => c.ambiguous).map(c => c.name),
    incomplete,
    incompleteHints: runSummary.hints,
    // 🔴 막힌 보드를 "아직 수집하지 않았습니다"로 적지 않는다 (render.mjs 와 같은 규칙).
    missingBoards: enabled.filter(b => !collected.has(b) && !Object.keys(runsOf(store)).includes(b))
      .map(b => BOARD_LABEL[b] ?? b),
    mergeCandidates: store.lastMerge?.candidates ?? 0,
    staleCount: rows.filter(r => r.stale).length,
    statuses: STATUSES,
    footNote: '이 화면은 이 컴퓨터에서만 열립니다 — 주소를 공유해도 다른 기기에서는 열리지 않습니다. '
      + '진행상태는 state/applications.json 에 저장됩니다. '
      + '"목록에서 숨김"은 삭제가 아닙니다 — 기록과 JD 원문은 남고 아래에서 되돌릴 수 있습니다. '
      + '공유용 파일이 필요하면 node scripts/render.mjs 로 report.html 을 만드십시오(지원 이력은 빠집니다).',
  };
}

// ── 편집 UI (템플릿의 __EDIT__ 자리에 들어간다) ─────────────────────────────
const EDIT_JS = `
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const post = async (path, body) => {
  const res = await fetch(path + '?t=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JD-Token': TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ('HTTP ' + res.status));
  return res.json();
};
const reload = async () => {
  const res = await fetch('/api/data?t=' + encodeURIComponent(TOKEN), { headers: { 'X-JD-Token': TOKEN } });
  const fresh = await res.json();
  D.rows = fresh.rows; D.stats = fresh.stats; D.mergeCandidates = fresh.mergeCandidates;
  $('#stats').textContent = '';
  for (const s of D.stats) { const n = el('div','stat'); n.append(el('b',null,s.value), el('span',null,s.label)); $('#stats').append(n); }
  draw();
};

// 숨긴 공고는 기본으로 목록에서 뺀다. 지운 것이 아니라 접어 둔 것이다.
let showHidden = false;
rowFilter = r => showHidden ? true : !r.hidden;

const bar = el('div','addbar');
bar.append(el('span',null,'공고 추가'));
const addInput = document.createElement('input');
addInput.type = 'url'; addInput.placeholder = '원티드·사람인 공고 주소를 붙여 넣으십시오';
bar.append(addInput);
const addBtn = el('button',null,'가져오기');
const addMsg = el('span','saved','');
addBtn.onclick = async () => {
  const url = addInput.value.trim();
  if (!url) return;
  addBtn.disabled = true; addMsg.className='saved'; addMsg.textContent = '받는 중…';
  try { const r = await post('/api/add', { url }); addMsg.textContent = r.message; addInput.value=''; await reload(); }
  catch (e) { addMsg.className='failed'; addMsg.textContent = '실패: ' + e.message; }
  finally { addBtn.disabled = false; }
};
const hideBtn = el('button',null,'숨긴 공고 보기');
hideBtn.onclick = () => { showHidden = !showHidden; hideBtn.textContent = showHidden ? '숨긴 공고 감추기' : '숨긴 공고 보기'; draw(); };
bar.append(addBtn, hideBtn, addMsg);
$('#list').before(bar);

afterRow = (box, r) => {
  const act = el('div','act');
  if (r.hidden) { const t = el('span','tag','숨김'); box.querySelector('.top').append(t); }

  const sel = document.createElement('select');
  for (const s of D.statuses) sel.append(new Option(s || '진행상태 없음', s));
  sel.value = r.appStatus || '';
  const memo = document.createElement('input');
  memo.type = 'text'; memo.placeholder = '메모'; memo.value = r.appMemo || ''; memo.size = 22;
  const msg = el('span','saved','');
  const save = async () => {
    msg.className='saved'; msg.textContent = '저장 중…';
    try {
      await post('/api/status', { key: r.key, status: sel.value, memo: memo.value });
      r.appStatus = sel.value || null; r.appMemo = memo.value;
      msg.textContent = '저장됨';
    } catch (e) { msg.className='failed'; msg.textContent = '실패: ' + e.message; }
  };
  sel.onchange = save;
  memo.onchange = save;

  const hide = el('button',null, r.hidden ? '목록에 되돌리기' : '목록에서 숨김');
  hide.title = '삭제가 아닙니다. 기록과 JD 원문은 남습니다.';
  hide.onclick = async () => {
    try { await post('/api/hide', { key: r.key, hidden: !r.hidden }); await reload(); }
    catch (e) { msg.className='failed'; msg.textContent = '실패: ' + e.message; }
  };

  const refresh = el('button',null,'지금 확인');
  refresh.title = '이 공고가 아직 살아 있는지 보드에 다시 물어봅니다.';
  refresh.onclick = async () => {
    msg.className='saved'; msg.textContent = '확인 중…';
    try { const x = await post('/api/refresh', { key: r.key }); msg.textContent = x.message; await reload(); }
    catch (e) { msg.className='failed'; msg.textContent = '실패: ' + e.message; }
  };

  act.append(sel, memo, hide, refresh, msg);
  box.append(act);

  // 🔴 합치지 않은 중복 후보 — 사람이 판정하고, 그 판정은 기억된다.
  for (const d of r.dupPairs ?? []) {
    const line = el('div','act');
    line.append(el('span',null, '중복 후보: "' + d.title + '" (유사도 ' + d.score + ')'));
    const yes = el('button',null,'같은 자리 — 합치기');
    const no = el('button',null,'다른 자리 — 따로 두기');
    yes.onclick = async () => { await post('/api/merge', { a: r.key, b: d.key, decision: 'merge' }); await reload(); };
    no.onclick = async () => { await post('/api/merge', { a: r.key, b: d.key, decision: 'separate' }); await reload(); };
    line.append(yes, no);
    box.append(line);
  }
};
draw();
`;

// ── 서버 ────────────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

/**
 * 🔴 토큰·Host·Origin 세 가지를 다 본다.
 *    토큰만 보면 브라우저 주소창 기록이나 Referer 로 새어 나갈 수 있고,
 *    Host 를 안 보면 DNS 리바인딩으로 외부 페이지가 이 서버에 붙는다.
 */
const EXPECTED = Buffer.from(TOKEN);
const tokenOk = t => {
  if (typeof t !== 'string') return false;
  const got = Buffer.from(t);
  // 🔴 길이가 다르면 timingSafeEqual 이 예외를 던진다. 먼저 걸러야 500 이 아니라 403 이 나간다.
  return got.length === EXPECTED.length && crypto.timingSafeEqual(got, EXPECTED);
};

function authorize(req, { write = false } = {}) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!tokenOk(req.headers['x-jd-token'] ?? url.searchParams.get('t'))) {
    return '토큰이 없거나 올바르지 않습니다. 터미널에 찍힌 주소로 여십시오.';
  }
  const host = String(req.headers.host ?? '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return `허용되지 않은 Host: ${host}`;
  if (write) {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin)) return `허용되지 않은 Origin: ${origin}`;
  }
  return null;
}

const readBody = req => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new Error('요청이 너무 큽니다')); req.destroy(); } chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

/** 하위 스크립트를 그대로 실행한다. 로직을 여기에 복사하면 두 벌이 되어 반드시 갈라진다. */
const runScript = (script, args = []) => new Promise(resolve => {
  execFile(process.execPath, [path.join(HERE, script), ...args],
    { env: process.env, encoding: 'utf8', timeout: 120000 },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? err?.message ?? '') }));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const write = req.method === 'POST';
  const bad = authorize(req, { write });
  if (bad) return json(res, 403, { error: bad });

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const data = buildData();
      const tpl = fs.readFileSync(path.join(HERE, 'templates', 'report.html'), 'utf8');
      const html = tpl
        .replace('__TITLE__', data.title)
        .replace('__DATA__', JSON.stringify(data).replace(/</g, '\\u003c'))
        .replace('/* __EDIT__ */', EDIT_JS);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // 🔴 이 화면에 개인정보가 있다. 주소가 외부로 새는 경로를 막는다.
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/data') return json(res, 200, buildData());

    if (req.method === 'POST' && url.pathname === '/api/status') {
      const { key, status, memo } = await readBody(req);
      if (!key) return json(res, 400, { error: 'key 가 없습니다' });
      const file = statePath(profile, 'applications.json');
      const apps = readJson(file, {});
      const prev = apps[key] ?? {};
      // 🔴 이력을 덮어쓰지 않는다. 언제 무엇으로 바꿨는지 남긴다 — 지원 시점은 나중에 반드시 필요해진다.
      const history = [...(prev.history ?? [])];
      if (prev.status && prev.status !== status) history.push({ status: prev.status, until: new Date().toISOString() });
      if (!status && !memo) delete apps[key];
      else apps[key] = { ...prev, status: status || null, memo: memo ?? prev.memo ?? '', updatedAt: new Date().toISOString(), history };
      writeJson(file, apps);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/hide') {
      const { key, hidden } = await readBody(req);
      if (!key) return json(res, 400, { error: 'key 가 없습니다' });
      const file = statePath(profile, 'hidden.json');
      const store = readJson(file, { hidden: {} });
      // 🔴 지우지 않는다. 숨김 표시만 켜고 끈다.
      if (hidden) store.hidden[key] = { at: new Date().toISOString() };
      else delete store.hidden[key];
      store.updatedAt = new Date().toISOString();
      writeJson(file, store);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/merge') {
      const { a, b, decision } = await readBody(req);
      if (!a || !b || !['merge', 'separate'].includes(decision)) return json(res, 400, { error: '잘못된 요청' });
      const file = statePath(profile, 'merges.json');
      const saved = readJson(file, { decisions: {} });
      saved.decisions = { ...(saved.decisions ?? {}), [[a, b].sort().join('|')]: decision };
      saved.updatedAt = new Date().toISOString();
      writeJson(file, saved);
      // 결정을 저장만 하고 반영을 안 하면 화면이 안 바뀐다. 병합을 바로 다시 계산한다.
      const r = await runScript('merge_boards.mjs', ['--profile', PROFILE_ID]);
      return json(res, 200, { ok: true, message: r.ok ? '반영했습니다' : `저장했으나 재계산 실패: ${r.err.slice(0, 200)}` });
    }

    if (req.method === 'POST' && url.pathname === '/api/add') {
      const { url: raw } = await readBody(req);
      // 🔴 붙여 넣은 주소를 그대로 넘기지 않는다. 지원하는 보드·형태인지 여기서 먼저 막는다.
      if (!parsePostingUrl(raw)) return json(res, 400, { error: '원티드·사람인 공고 주소가 아닙니다' });
      const r = await runScript('add_posting.mjs', ['--profile', PROFILE_ID, '--url', raw]);
      if (!r.ok) return json(res, 500, { error: (r.err || r.out).trim().split('\n').pop()?.slice(0, 200) || '실패' });
      return json(res, 200, { ok: true, message: r.out.trim().split('\n').pop() ?? '추가했습니다' });
    }

    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const { key } = await readBody(req);
      const store = readJson(statePath(profile, 'postings.json'), { postings: {} });
      const p = store.postings?.[key];
      if (!p) return json(res, 404, { error: '없는 공고입니다' });
      const r = await runScript('check_alive.mjs', ['--profile', PROFILE_ID, '--board', p.board, '--only', key]);
      const after = readJson(statePath(profile, 'postings.json'), { postings: {} }).postings?.[key];
      const label = { alive: '살아 있습니다', closed: '마감됐습니다', unknown: '확인하지 못했습니다 — 마감으로 처리하지 않았습니다' };
      return json(res, 200, { ok: true, message: label[after?.aliveState] ?? (r.ok ? '확인했습니다' : '확인 실패') });
    }

    return json(res, 404, { error: '없는 경로입니다' });
  } catch (e) {
    return json(res, 500, { error: String(e.message ?? e).slice(0, 300) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  console.log('jd-search serve — 이 컴퓨터에서만 열립니다 (127.0.0.1 전용, 매 실행 새 토큰)\n');
  console.log(`  http://127.0.0.1:${port}/?t=${TOKEN}\n`);
  console.log('  🔴 이 주소에는 지원 이력이 그대로 보입니다. 화면을 공유할 때 주의해 주십시오.');
  console.log('  🔴 브라우저는 자동으로 열지 않습니다. 위 주소를 직접 열어 주십시오.');
  console.log('  공유용 파일이 필요하면:  node scripts/render.mjs   (지원 이력은 빠집니다)');
  console.log('\n  종료: Ctrl+C');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\n종료합니다.'); server.close(() => process.exit(0)); });
}
