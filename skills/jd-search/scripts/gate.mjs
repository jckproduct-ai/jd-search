#!/usr/bin/env node
/**
 * 2단계 gate — 지역·제외조건으로 컷.
 *
 * 실행: node gate.mjs [--profile <id>]
 * 출력: state/gate.json · state/dropped.json
 *
 * 게이트를 앞에 두는 이유는 뒤 단계(재무·통근)의 대상 건수가 줄어 API 호출이 같은 비율로 줄기 때문이다.
 *
 * 🔴 결과는 세 갈래다. `drop`으로 뭉개지 말 것.
 *      pass  범위 안 / 풀리모트 / 관심회사
 *      hold  판정 불가 — 근무지 비공개, "서울"처럼 광역만, 주소 없음
 *            → **버리지 않고 후속 단계에도 그대로 태운다.** 헤드헌터 익명 공고가 여기 들어온다
 *      drop  범위 밖 확정 — 사유를 남긴다
 *
 * 🔴 추측한 값으로 공고를 버리지 않는다. 직선거리는 **참고로 붙일 뿐 컷에 쓰지 않는다** —
 *    실측에서 등기주소와 실제 근무지가 시·도 단위로 어긋난 사례가 흔했다.
 */
import { loadProfile, statePath, readJson, writeJson } from './lib/io.mjs';
import { regionVerdict, regionVerdictAny, haversine, AMBIGUOUS_DISTRICTS } from './lib/region.mjs';
import { matchesAny, normCorp } from './lib/text.mjs';
import { experienceTags } from './lib/experience.mjs';
import { summarizeRuns, runsOf } from './lib/runstatus.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
const loc = profile.location ?? {};
const tgt = profile.target ?? {};

const store = readJson(statePath(profile, 'postings.json'));
if (!store) {
  console.error('postings.json 이 없습니다. collect 단계를 먼저 돌려 주십시오.');
  process.exit(1);
}
const postings = Object.values(store.postings ?? {});

// 🔴 0건일 때 **왜 0건인지 말하지 않고 멈추면** 사용자에게 남는 것은 "추천 0건"뿐이다.
//    실제로 보드가 차단된 사용자가 이 자리에서 끊겨 리포트조차 못 받았다 (2026-08-18 사용자 제보).
//    수집이 돌긴 돌았는데 0건이면 **멈추지 않는다** — 빈 결과를 사유와 함께 넘겨
//    리포트가 "무엇이 막혔고 무엇을 하면 되는지"를 화면에 싣게 한다.
const runSummary = summarizeRuns(runsOf(store));
if (!postings.length) {
  if (!runSummary.everRan) {
    console.error('수집된 공고가 없고 수집 기록도 없습니다. collect 단계를 먼저 돌려 주십시오.');
    process.exit(1);
  }
  console.log('수집된 공고가 0건입니다 — 이번 실행에서 아래가 막혔습니다.');
  for (const f of runSummary.failures) console.log(`  ✖ ${f.text}`);
  for (const t of runSummary.truncations) console.log(`  ⚠ ${t.text}`);
  if (!runSummary.failures.length && !runSummary.truncations.length) {
    console.log('  (수집은 정상으로 끝났습니다. 검색 키워드나 지역 조건이 너무 좁을 수 있습니다)');
  }
  for (const h of runSummary.hints) console.log(`  → ${h}`);
  writeJson(statePath(profile, 'gate.json'), {
    updatedAt: new Date().toISOString(),
    criteria: { regions: loc.regions ?? [], denyRegions: loc.denyRegions ?? [], remote: loc.remote ?? 'normal', excludeRoles: tgt.excludeRoles ?? [] },
    tally: {}, verdicts: {},
  });
  console.log('\n빈 결과로 다음 단계에 넘깁니다 — 리포트 상단에 같은 사유가 실립니다.');
  process.exit(0);
}

const watch = (profile.watchlist ?? []).map(normCorp).filter(Boolean);
const block = (profile.blocklist ?? []).map(normCorp).filter(Boolean);
const home = loc.homeCoord && loc.homeCoord.lat ? loc.homeCoord : null;

// 🔴 중구·서구·남구·동구·북구·강서구는 여러 광역시에 같은 이름으로 있다.
//    시·도 없이 적으면 부산 중구 공고가 서울 중구를 찾는 사람 목록에 들어온다. 조용히 넘기지 않는다.
const vague = (loc.regions ?? []).filter(r => AMBIGUOUS_DISTRICTS.includes(String(r).replace(/\s/g, '')));
if (vague.length) {
  console.log(`⚠ 지역 조건 ${vague.map(v => `"${v}"`).join(', ')} 는 여러 광역시에 같은 이름이 있습니다.`);
  console.log(`  "서울 ${vague[0]}"처럼 시·도를 함께 적어 주십시오. 지금은 전국의 같은 이름 구가 모두 통과합니다.\n`);
}

function judge(p) {
  const company = normCorp(p.company?.name);
  const tags = [];

  if (block.some(b => company.includes(b))) {
    return { verdict: 'drop', reason: 'blocklist', detail: p.company?.name };
  }

  // 🔴 관심 회사는 조건과 무관하게 항상 본다. 통근 90분이어도 본다.
  const isWatch = watch.some(w => company.includes(w));

  // 제외 키워드 — 키워드가 겹쳐 딸려 온 직무를 자른다.
  const badRole = matchesAny(p.title, tgt.excludeRoles ?? []);
  if (badRole.length && !isWatch) {
    return { verdict: 'drop', reason: 'excludeRole', detail: badRole.join(', ') };
  }
  const badInd = matchesAny(p.company?.industry, tgt.excludeIndustries ?? []);
  if (badInd.length && !isWatch) {
    return { verdict: 'drop', reason: 'excludeIndustry', detail: badInd.join(', ') };
  }

  // 경력 — 🔴 버리지 않는다. 탭으로 나눌 수 있게 표시만 한다. 판정은 전부 lib/experience.mjs 에 있다.
  tags.push(...experienceTags(tgt, p.annualFrom));

  // 원격 — 풀리모트는 거리를 보지 않는다.
  const remoteMode = loc.remote ?? 'normal';
  if (p.remote === 'full' && remoteMode === 'bypass') {
    return { verdict: 'pass', reason: 'remote-full', tags: [...tags, 'remote'] };
  }
  if (p.remote === 'hybrid') tags.push('hybrid');
  if (isWatch) return { verdict: 'pass', reason: 'watchlist', tags: [...tags, 'watchlist'] };

  const addr = p.location?.full || '';
  const opts = { regions: loc.regions ?? [], denyRegions: loc.denyRegions ?? [] };
  // 🔴 사람인은 한 공고에 근무지를 여럿 적는다("서울 강남구, 서초구, 대전 서구").
  //    첫 곳만 보면 다닐 수 있는 자리를 범위 밖으로 버린다 — 전부 본다.
  const all = Array.isArray(p.location?.all) && p.location.all.length ? p.location.all : [addr];
  let rv = regionVerdictAny(all, opts);
  // 상세주소에 시·도가 빠진 공고("디지털로31길 12, …")가 흔하다.
  // 보드가 따로 주는 광역/구 필드로 한 번 더 본다.
  if (rv.verdict === 'unknown' && (p.location?.district || p.location?.label)) {
    const alt = regionVerdict(`${p.location.label ?? ''} ${p.location.district ?? ''}`.trim(), opts);
    if (alt.verdict !== 'unknown') rv = alt;
  }
  const km = home && p.location?.lat ? haversine(home, { lat: p.location.lat, lng: p.location.lng }) : null;
  const geo = { region: rv.sigungu ?? rv.sido ?? null, straightKm: km === null ? null : Math.round(km * 10) / 10 };

  if (rv.verdict === 'deny') return { verdict: 'drop', reason: 'denyRegion', detail: geo.region, tags, ...geo };
  if (rv.verdict === 'out') return { verdict: 'drop', reason: 'outOfRegion', detail: geo.region, tags, ...geo };
  // 🔴 광역만 적혀 있거나 주소가 없으면 판정 불가다. 버리면 좋은 자리를 잃고,
  //    안 보이니 사용자는 그 손실을 알 방법조차 없다.
  if (rv.verdict === 'unknown') return { verdict: 'hold', reason: 'regionUnknown', detail: addr || '근무지 비공개', tags, ...geo };
  return { verdict: 'pass', reason: 'inRegion', tags, ...geo };
}

const result = {};
const dropped = [];
for (const p of postings) {
  const j = judge(p);
  result[`${p.board}:${p.id}`] = j;
  if (j.verdict === 'drop') {
    dropped.push({ key: `${p.board}:${p.id}`, company: p.company?.name, title: p.title, url: p.url, reason: j.reason, detail: j.detail ?? null });
  }
}

const tally = Object.values(result).reduce((a, j) => (a[j.verdict] = (a[j.verdict] ?? 0) + 1, a), {});

writeJson(statePath(profile, 'gate.json'), { updatedAt: new Date().toISOString(), criteria: { regions: loc.regions ?? [], denyRegions: loc.denyRegions ?? [], remote: loc.remote ?? 'normal', excludeRoles: tgt.excludeRoles ?? [] }, tally, verdicts: result });

// 🔴 수집 단계가 제목 필터로 자른 건을 덮어쓰지 않는다. 제외 목록은 단계별로 쌓이는 하나의 장부다.
const dropFile = statePath(profile, 'dropped.json');
const prevDrop = readJson(dropFile, { dropped: [] });
const fromCollect = (prevDrop.dropped ?? []).filter(d => d.reason === 'titleKeywordMiss');
const all = [...fromCollect, ...dropped];
const byReason = all.reduce((a, d) => (a[d.reason] = (a[d.reason] ?? 0) + 1, a), {});
writeJson(dropFile, { updatedAt: new Date().toISOString(), byReason, dropped: all });

console.log(`대상 ${postings.length}건`);
console.log(`  pass ${tally.pass ?? 0} · hold ${tally.hold ?? 0} · drop ${tally.drop ?? 0}`);
// 🔴 통근 상한(maxCommuteMin)은 아직 적용되지 않는다. 적용하는 척하면 안 된다.
if (loc.maxCommuteMin) console.log(`  (통근 상한 ${loc.maxCommuteMin}분은 아직 적용되지 않습니다 — 통근 실측 단계 미구현. 지역 필터만 적용했습니다)`);
if (!home) console.log('  (자택 좌표 미설정 — 직선거리 표시 없음)');
for (const [r, n] of Object.entries(byReason)) console.log(`    drop:${r} ${n}건`);
// 🔴 제외 건수는 반드시 보인다. 조용히 자르지 않는다.
console.log(`\n제외 ${all.length}건(수집 단계 ${fromCollect.length} + 게이트 ${dropped.length})의 사유가 state/dropped.json 에 남았습니다.`);

// 🔴 공고가 좀 나왔다고 해서 차단 사실을 덮지 않는다. 한 보드가 통째로 빠진 목록을 전수로 읽게 된다.
if (runSummary.failures.length) {
  console.log(`\n⚠ 이번 목록은 완전하지 않습니다 — ${runSummary.failures.map(f => f.text).join(', ')}`);
  for (const h of runSummary.hints) console.log(`  → ${h}`);
}
