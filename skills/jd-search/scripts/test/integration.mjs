// 단계 간 계약 테스트 — 네트워크 없이 돈다.
//
// 순수 함수 테스트만으로는 **단계 사이에서 데이터가 사라지는 사고**를 못 잡는다.
// 실제로 겪은 것들이다: `--only` 실행이 나머지를 지움 / 게이트가 수집 단계의 제외 기록을 덮어씀 /
// 손상된 JSON을 빈 값으로 읽고 덮어씀 / 지원 이력이 공유용 리포트에 실려 나감.
//
// 임시 JD_SEARCH_HOME 을 만들어 gate·render 를 진짜 프로세스로 돌리고 산출물을 확인한다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PROFILE = `version: 1
id: default
target:
  roles: [프로덕트 매니저, PM]
  excludeRoles: [사업개발]
location:
  regions: [강남구, 서울 중구]
  denyRegions: []
  remote: bypass
  maxCommuteMin: 60
watchlist: []
blocklist: []
sources:
  wanted: api
  saramin: api
finance:
  enabled: false
`;

const posting = (id, over = {}) => ({
  board: 'wanted', id, url: `https://www.wanted.co.kr/wd/${id}`,
  title: '프로덕트 매니저', company: { name: `회사${id}`, industry: 'IT' },
  location: { label: '서울', district: '강남구', full: '서울특별시 강남구 테헤란로 1', lat: 37.5, lng: 127.0 },
  status: 'active', dueTime: null, annualFrom: 3, annualTo: 10, remote: 'unknown',
  tags: [], matchedKeywords: ['PM'], collectedAt: new Date(0).toISOString(),
  ...over,
});

const saraminPosting = (id, over = {}) => ({
  board: 'saramin', id, url: `https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${id}`,
  title: '프로덕트 매니저', company: { name: `회사${id}`, industry: null, boardId: `csn${id}` },
  location: { label: '서울', district: '강남구', full: '서울 강남구', lat: null, lng: null, all: ['서울 강남구'] },
  status: 'active', dueTime: null, dueKind: 'untilFilled', annualFrom: 3, annualTo: null, remote: 'unknown',
  jdKind: 'text', tags: [], matchedKeywords: ['PM'], collectedAt: new Date(1000).toISOString(),
  ...over,
});

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jdsearch-it-'));
  const dir = path.join(home, 'default');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.yml'), PROFILE);
  return { home, dir };
}

const run = (home, script, args = []) =>
  execFileSync(process.execPath, [path.join(SCRIPTS, script), ...args],
    { env: { ...process.env, JD_SEARCH_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Host 헤더를 직접 정한 GET. fetch 는 Host 를 금지 헤더로 막아 리바인딩 검사를 확인할 수 없다. */
const rawStatus = (port, pathname, host) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: host } },
    res => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  req.end();
});

export async function runIntegration(ok, eq) {
  // ── 1. 게이트가 수집 단계의 제외 기록을 덮어쓰지 않는가 ────────────────────
  {
    const { home, dir } = makeHome();
    fs.writeFileSync(path.join(dir, 'state', 'postings.json'), JSON.stringify({
      updatedAt: new Date(0).toISOString(),
      postings: {
        'wanted:1': posting('1'),                                                                    // 강남구 → pass
        'wanted:2': posting('2', { location: { label: '서울', district: '종로구', full: '서울특별시 종로구 새문안로 1' } }),  // → drop
        'wanted:3': posting('3', { location: { label: '부산', district: '중구', full: '부산광역시 중구 중앙대로 1' } }),      // → drop (서울 중구만 원함)
      },
    }));
    // 수집 단계가 제목 필터로 자른 기록
    fs.writeFileSync(path.join(dir, 'state', 'dropped.json'), JSON.stringify({
      byReason: { titleKeywordMiss: 1 },
      dropped: [{ key: 'wanted:9', company: '회사9', title: '프로덕트 오너', url: 'x', reason: 'titleKeywordMiss', detail: '제목 미일치' }],
    }));

    run(home, 'gate.mjs');
    const dropped = readJson(path.join(dir, 'state', 'dropped.json'));
    ok(dropped.dropped.some(d => d.reason === 'titleKeywordMiss'),
      '  게이트가 수집 단계의 제목 제외 기록을 지우지 않는다',
      JSON.stringify(dropped.byReason));
    eq(dropped.dropped.filter(d => d.reason === 'outOfRegion').length, 2, '  범위 밖 2건을 사유와 함께 기록');

    const gate = readJson(path.join(dir, 'state', 'gate.json'));
    eq(gate.verdicts['wanted:1'].verdict, 'pass', '  강남구는 통과');
    eq(gate.verdicts['wanted:3'].verdict, 'drop', '  "서울 중구"를 원했으므로 부산 중구는 제외');

    // ── 2. 리포트가 제외 건을 싣고, 지원 이력은 기본으로 빼는가 ──────────────
    fs.writeFileSync(path.join(dir, 'state', 'applications.json'),
      JSON.stringify({ 'wanted:1': { status: '면접 진행중' } }));

    run(home, 'render.mjs');
    const html = fs.readFileSync(path.join(dir, 'out', 'report.html'), 'utf8');
    ok(!html.includes('면접 진행중'),
      '  🔴 지원 이력은 리포트에 기본으로 나가지 않는다 (report.html은 공유될 수 있는 파일이다)');
    ok(html.includes('titleKeywordMiss') || html.includes('제목'),
      '  수집 단계의 제외 건도 리포트에 실린다');

    run(home, 'render.mjs', ['--with-status']);
    ok(fs.readFileSync(path.join(dir, 'out', 'report.html'), 'utf8').includes('면접 진행중'),
      '  --with-status 를 주면 지원 이력이 들어간다');

    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 3. 손상된 JSON을 빈 값으로 읽고 덮어쓰지 않는가 ───────────────────────
  {
    const { home, dir } = makeHome();
    fs.writeFileSync(path.join(dir, 'state', 'postings.json'), '{"postings": {"wanted:1": {broken');
    let failed = false, msg = '';
    try { run(home, 'gate.mjs'); } catch (e) { failed = true; msg = String(e.stderr ?? e.message); }
    ok(failed, '  🔴 손상된 postings.json 을 만나면 멈춘다 (빈 값으로 읽고 덮어쓰면 이력이 전멸한다)');
    ok(/손상|corrupt/i.test(msg), '  무엇이 잘못됐는지 사용자에게 말한다', msg.slice(0, 120));
    // 원본이 그대로 남아 있어야 한다
    ok(fs.readFileSync(path.join(dir, 'state', 'postings.json'), 'utf8').includes('broken'),
      '  손상 파일을 덮어쓰지 않는다');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 4. 개인정보 디렉터리·파일 권한 ────────────────────────────────────────
  {
    const { home, dir } = makeHome();
    fs.writeFileSync(path.join(dir, 'state', 'postings.json'),
      JSON.stringify({ postings: { 'wanted:1': posting('1') } }));
    run(home, 'gate.mjs');
    const mode = f => fs.statSync(f).mode & 0o777;
    eq(mode(path.join(dir, 'state', 'gate.json')), 0o600, '  🔴 상태 파일은 0600 (같은 컴퓨터의 다른 계정이 못 읽게)');
    eq(mode(path.join(dir, 'state')), 0o700, '  🔴 상태 디렉터리는 0700');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 5. 덮어쓰기 전 백업이 남는가 ──────────────────────────────────────────
  {
    const { home, dir } = makeHome();
    const pf = path.join(dir, 'state', 'postings.json');
    fs.writeFileSync(pf, JSON.stringify({ postings: { 'wanted:1': posting('1') } }));
    run(home, 'gate.mjs');
    run(home, 'gate.mjs');
    ok(fs.existsSync(path.join(dir, 'state', 'gate.json.bak')),
      '  두 번째 실행이 직전 상태를 .bak 으로 남긴다');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 6. 교차 보드 병합이 실제 파이프라인에서 성립하는가 ─────────────────────
  {
    const { home, dir } = makeHome();
    const pf = path.join(dir, 'state', 'postings.json');
    fs.writeFileSync(pf, JSON.stringify({
      postings: {
        // 같은 자리 (회사·제목·지역 일치) — 합쳐져야 한다
        'wanted:1': posting('1', { company: { name: '(주)같은회사' } }),
        'saramin:1': saraminPosting('1', { company: { name: '같은회사', boardId: 'csnA' } }),
        // 같은 회사 다른 자리 — 합치면 안 된다
        'saramin:2': saraminPosting('2', { title: '백엔드 개발자', company: { name: '같은회사', boardId: 'csnA' } }),
      },
    }));

    run(home, 'merge_boards.mjs');
    let store = readJson(pf);
    eq(store.postings['saramin:1'].mergedInto, 'wanted:1', '  🔴 교차 보드 중복이 대표 아래로 들어간다');
    eq(store.postings['wanted:1'].sources?.length, 2, '  대표가 출처를 둘 다 들고 있다');
    ok(!store.postings['saramin:2'].mergedInto, '  같은 회사의 다른 자리는 합치지 않는다');
    // 🔴 지우지 않는다 — 병합이 틀렸을 때 되돌릴 수 있어야 한다.
    ok(store.postings['saramin:1'].title, '  🔴 종속 레코드를 지우지 않는다');

    // 멱등 — 두 번 돌려도 결과가 같아야 한다 (표시가 쌓이면 안 된다)
    run(home, 'merge_boards.mjs');
    store = readJson(pf);
    eq(store.postings['wanted:1'].sources?.length, 2, '  두 번 돌려도 출처가 늘어나지 않는다 (멱등)');
    eq(store.lastMerge.merged, 1, '  병합 건수도 그대로');

    // 리포트는 대표만 행으로 만든다
    run(home, 'gate.mjs');
    run(home, 'render.mjs');
    const html = fs.readFileSync(path.join(dir, 'out', 'report.html'), 'utf8');
    const data = JSON.parse(html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1].replace(/\\u003c/g, '<'));
    eq(data.rows.filter(r => r.key === 'saramin:1').length, 0, '  종속 건은 리포트에 행으로 나오지 않는다');
    eq(data.rows.find(r => r.key === 'wanted:1').sources.length, 2, '  🔴 대표 행에 두 보드 링크가 모두 실린다');
    ok(data.rows.find(r => r.key === 'wanted:1').sources.some(s => s.label === '사람인'), '  보드 이름을 한글로 표시한다');

    // 사용자가 "따로 두기"로 정하면 규칙이 뒤집지 않는다
    fs.writeFileSync(path.join(dir, 'state', 'merges.json'),
      JSON.stringify({ decisions: { 'saramin:1|wanted:1': 'separate' } }));
    run(home, 'merge_boards.mjs');
    ok(!readJson(pf).postings['saramin:1'].mergedInto, '  🔴 사용자 결정("따로 두기")이 규칙보다 우선한다');

    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 7. 동명이인 결정이 저장되고 캐시가 무효화되는가 ────────────────────────
  {
    const { home, dir } = makeHome();
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'finance.json'), JSON.stringify({
      updatedAt: new Date(0).toISOString(),
      companies: {
        미소: {
          name: '미소', grade: 'u', byYear: {},
          ambiguous: {
            where: 'data.go.kr', prompt: '...', candidates: [
              { corpNm: '미소', crno: '1101110000001', addr: '서울 강남구' },
              { corpNm: '미소', crno: '1101110000002', addr: '부산 해운대구' },
            ],
          },
        },
      },
    }));
    // 🔴 결정을 저장해도 캐시가 남아 있으면 다음 실행이 옛 결과를 그대로 쓴다.
    fs.writeFileSync(path.join(dir, 'cache', 'finance.json'),
      JSON.stringify({ 미소: { name: '미소', source: null, byYear: {} } }));

    run(home, 'resolve_company.mjs', ['--pick', '미소=2']);
    const ch = readJson(path.join(dir, 'state', 'company_choices.json'));
    eq(ch.choices['미소'].crno, '1101110000002', '  고른 법인등록번호를 저장한다');
    eq(Object.keys(readJson(path.join(dir, 'cache', 'finance.json'))).length, 0,
      '  🔴 결정과 함께 재무 캐시를 지운다 (안 지우면 옛 판정이 그대로 남는다)');

    // 법인번호가 없는 후보는 근거가 안 되므로 채택하지 않는다
    run(home, 'resolve_company.mjs', ['--reset', '미소']);
    ok(!readJson(path.join(dir, 'state', 'company_choices.json')).choices['미소'],
      '  --reset 으로 되돌릴 수 있다');

    // "모르겠음"도 결정으로 저장돼 다시 묻지 않는다
    run(home, 'resolve_company.mjs', ['--pick', '미소=0']);
    eq(readJson(path.join(dir, 'state', 'company_choices.json')).choices['미소'].skip, true,
      '  "모르겠음"도 저장해 같은 질문을 반복하지 않는다');

    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 8. serve 는 토큰 없이 아무것도 주지 않는가 ─────────────────────────────
  // 🔴 이 서버는 이력서·자택주소·지원이력이 있는 디렉터리를 연다. 인증이 뚫리면 그게 전부 샌다.
  {
    const { home, dir } = makeHome();
    fs.writeFileSync(path.join(dir, 'state', 'postings.json'),
      JSON.stringify({ postings: { 'wanted:1': posting('1') } }));
    fs.writeFileSync(path.join(dir, 'state', 'applications.json'),
      JSON.stringify({ 'wanted:1': { status: '면접 진행중' } }));

    const child = spawn(process.execPath, [path.join(SCRIPTS, 'serve.mjs'), '--port', '0'],
      { env: { ...process.env, JD_SEARCH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    for (let i = 0; i < 60 && !/http:\/\/127\.0\.0\.1:\d+\/\?t=/.test(out); i++) await sleep(100);
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([A-Za-z0-9_-]+)/);

    if (!m) {
      ok(false, '  serve 가 주소를 출력한다', out.slice(0, 200));
    } else {
      const [, port, token] = m;
      const base = `http://127.0.0.1:${port}`;
      const get = (p, headers = {}) => fetch(base + p, { headers });

      eq((await get('/api/data')).status, 403, '  🔴 토큰 없이는 데이터를 주지 않는다');
      eq((await get(`/api/data?t=${token}x`)).status, 403, '  🔴 틀린 토큰도 거부한다');
      // 🔴 fetch 로는 Host 를 바꿀 수 없다(금지 헤더). 리바인딩 검사는 raw 요청으로만 확인된다.
      eq(await rawStatus(port, `/api/data?t=${token}`, 'evil.example.com'), 403,
        '  🔴 Host 가 로컬이 아니면 거부한다 (DNS 리바인딩 차단)');
      eq(await rawStatus(port, `/api/data?t=${token}`, `127.0.0.1:${port}`), 200,
        '  같은 요청도 Host 가 로컬이면 통과한다 (검사가 지나치지 않다)');

      const okRes = await get(`/api/data?t=${token}`);
      eq(okRes.status, 200, '  올바른 토큰이면 준다');
      const data = await okRes.json();
      eq(data.rows[0].appStatus, '면접 진행중', '  serve 에서는 지원 이력이 보인다 (로컬 전용이라서)');

      // 🔴 CSRF — 브라우저에 떠 있는 다른 사이트가 쓰기를 던질 수 있다.
      const csrf = await fetch(`${base}/api/status?t=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: JSON.stringify({ key: 'wanted:1', status: '불합격' }),
      });
      eq(csrf.status, 403, '  🔴 외부 Origin 의 쓰기 요청을 거부한다 (CSRF 차단)');
      eq(readJson(path.join(dir, 'state', 'applications.json'))['wanted:1'].status, '면접 진행중',
        '  거부된 요청이 데이터를 바꾸지 않았다');

      // "삭제"는 숨김이다 — 레코드를 지우지 않는다
      await fetch(`${base}/api/hide?t=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ key: 'wanted:1', hidden: true }),
      });
      ok(readJson(path.join(dir, 'state', 'postings.json')).postings['wanted:1'],
        '  🔴 "목록에서 숨김"이 공고 레코드를 지우지 않는다');
      eq(readJson(path.join(dir, 'state', 'hidden.json')).hidden['wanted:1'] ? 1 : 0, 1, '  숨김 표시만 남는다');

      // 지원하지 않는 주소는 받지 않는다
      const badAdd = await fetch(`${base}/api/add?t=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ url: 'https://evil.example.com/?x=wanted.co.kr/wd/1' }),
      });
      eq(badAdd.status, 400, '  🔴 호스트가 다른 주소는 추가하지 않는다');
    }
    child.kill('SIGTERM');
    await sleep(150);
    fs.rmSync(home, { recursive: true, force: true });
  }
}
