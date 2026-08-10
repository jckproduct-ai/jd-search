// 교차 보드 중복 병합 — `board:id` 유니크는 보드 **안**의 중복만 잡는다.
// 같은 자리가 원티드·사람인에 동시에 올라오는 건 흔하고, 그대로 두면 목록이 두 배로 부푼다.
//
// 🔴 **틀린 방향이 서로 다르다.**
//      병합을 안 하면  → 중복 2건이 목록에 보인다. 눈에 보이는 잡음이고 사용자가 스스로 안다.
//      잘못 병합하면  → 서로 다른 자리 하나가 목록에서 **조용히 사라진다.** 알 방법이 없다.
//    이 제품은 조용한 손실을 가장 나쁜 실패로 본다 → **불확실하면 병합하지 않는다.**
//    합치지 않은 후보는 버리지 않고 "중복일 수 있음"으로 표시만 한다.
//
// 부분일치 5건 사고(`lib/match.mjs`)·재공고 오연결(`check_alive.mjs`)과 같은 원칙이다.
// 근거가 강할 때만 잇는다.

import { normCorp, similarity } from './text.mjs';
import { parseRegion } from './region.mjs';

export const TITLE_THRESHOLD = 0.8;

const canon = s => String(s ?? '').replace(/\s/g, '');

/**
 * 제목에서 **보드마다 다르게 붙이는 수식어**만 떼고 비교한다.
 *
 * 🔴 임계값을 낮추는 것과는 다르다. 실측에서 같은 자리가 이렇게 갈렸다:
 *      사람인 "서비스기획 팀원 (부산)"
 *      원티드 "서비스기획 팀원 (신입~5년 이하 / 부산)"     → 유사도 0.64, 보류
 *    괄호 안은 경력·지역 표기뿐인데, 그건 **제목이 아니라 조건**이고 이미 따로 대조하고 있다
 *    (지역은 regionKeys, 경력은 annualFrom). 두 번 세면 같은 자리가 다른 자리가 된다.
 *
 * 🔴 그렇다고 괄호를 전부 떼면 안 된다. "프로덕트 매니저 (커머스)"와 "(물류)"는 **다른 자리**다.
 *    → 괄호 안이 경력·지역·고용형태뿐일 때만 뗀다. 하나라도 다른 말이 섞이면 그대로 둔다.
 */
const SIDO = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
  '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const NOISE = [
  /^신입$/, /^경력$/, /^경력무관$/, /^무관$/, /^신입[·,\/~-]?경력$/,
  /^\d+\s*년?\s*(이상|이하|↑|↓|\+)?$/, /^(신입|\d+년)\s*~\s*\d+\s*년?\s*(이상|이하)?$/,
  /^경력\s*\d+\s*년?\s*(이상|이하|↑|↓)?$/, /^\d+\s*~\s*\d+\s*년/,
  /^(정규직|계약직|인턴|파견|프리랜서|위촉직|병역특례|채용전환형|수습)$/,
  /^(재택|원격|하이브리드|풀리모트)$/,
  new RegExp(`^(${SIDO.join('|')})(전체)?$`),
  /^[가-힣]+(시|군|구|동)$/,
];
const isNoise = t => NOISE.some(re => re.test(t.trim()));

export function normalizeTitle(title, companyName = '') {
  let s = String(title ?? '').trim();

  // 🔴 사람인은 제목 앞에 "[회사명]"을 붙이는 일이 흔하다. **그 회사명일 때만** 뗀다.
  //    아무 대괄호나 떼면 "[신입]"과 "[백엔드]"를 똑같이 취급하게 된다.
  const co = normCorp(companyName);
  if (co) {
    s = s.replace(/^\s*[[［]([^\]］]+)[\]］]\s*/, (m, inner) => (normCorp(inner) === co ? '' : m));
  }

  // 괄호 안이 조건 표기뿐이면 통째로 뗀다.
  s = s.replace(/[(（[［]([^)）\]］]*)[)）\]］]/g, (m, inner) => {
    const parts = String(inner).split(/[,\/·|]/).map(x => x.trim()).filter(Boolean);
    if (!parts.length) return '';
    return parts.every(isNoise) ? ' ' : m;
  });

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 공고의 지역을 **시·도까지 붙은** 대조 키 집합으로 만든다.
 *
 * 🔴 시·군·구만으로 대조하면 안 된다. 중·서·남·동·북·강서구는 전국에 흔해
 *    "부산 중구 개발자"와 "서울 중구 개발자"가 한 건으로 합쳐진다.
 *    시·도를 모르는 항목은 키를 만들지 않는다 — 그게 병합 보류의 근거가 된다.
 */
export function regionKeys(p) {
  const raws = [
    ...(p?.location?.all ?? []),
    p?.location?.full,
    [p?.location?.label, p?.location?.district].filter(Boolean).join(' '),
  ].filter(Boolean);

  const keys = new Set();
  for (const raw of raws) {
    const r = parseRegion(raw);
    if (r.sido && r.sigungu) keys.add(canon(r.sido + r.sigungu));
  }
  return keys;
}

/**
 * 두 공고가 같은 자리인가.
 * @returns {{same:boolean, score:number, why:string}}
 *
 * 통과 조건 (전부 충족해야 한다)
 *   ① 서로 다른 보드           — 같은 보드 안의 중복은 id 로 이미 접힌다
 *   ② 회사명 정규화 **완전일치** — 🔴 부분일치 금지 ("미소" → "미소무역" 함정)
 *   ③ 제목 유사도 ≥ 0.8
 *   ④ 시·도까지 붙은 지역 키가 하나 이상 겹칠 것 — 🔴 한쪽이라도 모르면 보류
 */
export function isSamePosting(a, b) {
  if (!a || !b) return { same: false, score: 0, why: 'missing' };
  if (a.board === b.board) return { same: false, score: 0, why: 'same-board' };

  const ca = normCorp(a.company?.name), cb = normCorp(b.company?.name);
  if (!ca || !cb) return { same: false, score: 0, why: 'no-company' };
  if (ca !== cb) return { same: false, score: 0, why: 'company-differs' };

  // 원문끼리 / 조건 표기를 뗀 것끼리 둘 다 보고 높은 쪽을 쓴다.
  const score = Math.max(
    similarity(a.title, b.title),
    similarity(normalizeTitle(a.title, a.company?.name), normalizeTitle(b.title, b.company?.name)),
  );
  if (score < TITLE_THRESHOLD) return { same: false, score, why: 'title-below-threshold' };

  const ka = regionKeys(a), kb = regionKeys(b);
  // 🔴 지역을 모르는 쪽이 있으면 합치지 않는다. 제목이 비슷하다는 이유만으로
  //    다른 도시의 같은 이름 자리를 하나로 만들면 한 건이 목록에서 사라진다.
  if (!ka.size || !kb.size) return { same: false, score, why: 'region-unknown' };
  if (![...ka].some(k => kb.has(k))) return { same: false, score, why: 'region-differs' };

  return { same: true, score, why: 'company+title+region' };
}

/**
 * 대표(primary)를 고른다.
 *
 * 🔴 **살아있는 쪽이 먼저다.** 한 보드에서 내려가고 다른 보드엔 남아 있는 일이 흔하다
 *    (SKILL.md 의 마감 함정 3번). 마감된 쪽을 대표로 세우면 산 자리가 마감으로 보인다.
 * 그다음은 정보가 많은 쪽 — 좌표 > JD 원문 > 먼저 수집된 것.
 */
export function pickPrimary(group) {
  const rank = p => [
    p.status === 'closed' ? 1 : 0,                        // 살아있는 쪽 먼저
    p.location?.lat == null ? 1 : 0,                      // 좌표 있는 쪽 먼저 (원티드)
    p.jd ? 0 : 1,                                         // JD 원문 있는 쪽 먼저
    String(p.collectedAt ?? '9999'),                      // 먼저 수집된 쪽
  ];
  return [...group].sort((x, y) => {
    const rx = rank(x), ry = rank(y);
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] < ry[i] ? -1 : 1;
    return 0;
  })[0];
}

export const keyOf = p => `${p.board}:${p.id}`;

/**
 * 전체 공고를 훑어 병합 그룹을 만든다. **멱등** — 매번 처음부터 다시 계산한다.
 *
 * @param postings  레코드 배열
 * @param decisions { "keyA|keyB": "merge" | "separate" }  사용자가 직접 정한 것. 🔴 규칙보다 우선한다
 * @returns {{groups, candidates, stats}}
 *   groups     확정 병합 — [{primary, members:[key], score}]
 *   candidates 보류 — [{a, b, score, why}]  합치지 않고 "중복일 수 있음"으로만 알린다
 */
export function planMerge(postings, decisions = {}) {
  const list = postings.filter(Boolean);
  const byKey = new Map(list.map(p => [keyOf(p), p]));
  const pairKey = (x, y) => [x, y].sort().join('|');

  // 후보 짝을 만든다. 회사명이 같은 것끼리만 비교하면 O(n²)이 회사 안으로 줄어든다.
  const byCompany = new Map();
  for (const p of list) {
    const c = normCorp(p.company?.name);
    if (!c) continue;
    if (!byCompany.has(c)) byCompany.set(c, []);
    byCompany.get(c).push(p);
  }

  const edges = [];           // 확정 병합할 짝
  const candidates = [];      // 보류 — 사람에게 보여만 준다
  for (const group of byCompany.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const pk = pairKey(keyOf(a), keyOf(b));
        const decided = decisions[pk];

        // 🔴 사용자가 정한 것은 규칙이 뒤집지 않는다. 매번 같은 것을 다시 묻지 않기 위해서다.
        if (decided === 'separate') continue;
        if (decided === 'merge') { edges.push({ a, b, score: 1, by: 'user' }); continue; }

        const v = isSamePosting(a, b);
        if (v.same) edges.push({ a, b, score: v.score, by: 'rule' });
        else if (a.board !== b.board && v.score >= 0.6) candidates.push({ a: keyOf(a), b: keyOf(b), score: Math.round(v.score * 100) / 100, why: v.why });
      }
    }
  }

  // 🔴 한 공고가 여러 짝에 걸리면 자동으로 잇지 않는다.
  //    "이 회사에 비슷한 제목 3건" 은 재공고 오연결과 같은 상황이다 — 추측으로 잇지 않는다.
  const degree = new Map();
  for (const e of edges) {
    if (e.by === 'user') continue;
    for (const k of [keyOf(e.a), keyOf(e.b)]) degree.set(k, (degree.get(k) ?? 0) + 1);
  }
  const keep = [], deferred = [];
  for (const e of edges) {
    const ka = keyOf(e.a), kb = keyOf(e.b);
    if (e.by === 'user' || ((degree.get(ka) ?? 0) <= 1 && (degree.get(kb) ?? 0) <= 1)) keep.push(e);
    else deferred.push({ a: ka, b: kb, score: Math.round(e.score * 100) / 100, why: 'multiple-candidates' });
  }
  candidates.push(...deferred);

  // 연결 요소로 묶는다 (사용자 확정이 A-B, B-C면 A-B-C 한 묶음).
  const parent = new Map();
  const find = k => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(k) !== root) { const next = parent.get(k); parent.set(k, root); k = next; }
    return root;
  };
  for (const k of byKey.keys()) parent.set(k, k);
  for (const e of keep) { const ra = find(keyOf(e.a)), rb = find(keyOf(e.b)); if (ra !== rb) parent.set(ra, rb); }

  const clusters = new Map();
  for (const k of byKey.keys()) {
    const r = find(k);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(k);
  }

  const groups = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const primary = pickPrimary(members.map(k => byKey.get(k)));
    groups.push({
      primary: keyOf(primary),
      members,
      boards: [...new Set(members.map(k => byKey.get(k).board))],
      score: Math.max(...keep.filter(e => members.includes(keyOf(e.a))).map(e => Math.round(e.score * 100) / 100), 0),
    });
  }

  return {
    groups,
    candidates,
    stats: { postings: list.length, merged: groups.reduce((n, g) => n + g.members.length - 1, 0), groups: groups.length, candidates: candidates.length },
  };
}

/**
 * 게이트 판정을 그룹 단위로 합친다.
 * 🔴 같은 자리인데 보드마다 근무지 표기가 달라 한쪽만 통과하는 일이 있다
 *    (사람인은 근무지를 여러 곳 적고, 원티드는 한 곳만 적는다).
 *    **가장 관대한 판정을 그룹 전체에 적용한다** — 추측으로 공고를 버리지 않는다.
 */
export const RANK = { pass: 0, hold: 1, drop: 2 };
export function mergeVerdicts(verdicts) {
  const list = verdicts.filter(Boolean);
  if (!list.length) return null;
  return [...list].sort((a, b) => RANK[a.verdict] - RANK[b.verdict])[0];
}
