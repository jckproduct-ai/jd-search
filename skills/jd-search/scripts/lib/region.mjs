// 한국 행정구역 문자열 처리 — 게이트의 지역 필터가 여기에 걸려 있다.
//
// 🔴 "서울"처럼 광역만 적힌 공고를 구 단위 조건과 비교해 버리면 멀쩡한 자리가 조용히 사라진다.
//    그래서 판정은 pass/drop 둘이 아니라 **unknown을 포함한 셋**이다.

const SIDO = [
  ['서울특별시', '서울'], ['부산광역시', '부산'], ['대구광역시', '대구'], ['인천광역시', '인천'],
  ['광주광역시', '광주'], ['대전광역시', '대전'], ['울산광역시', '울산'], ['세종특별자치시', '세종'],
  ['경기도', '경기'], ['강원특별자치도', '강원'], ['강원도', '강원'],
  ['충청북도', '충북'], ['충청남도', '충남'], ['전북특별자치도', '전북'], ['전라북도', '전북'],
  ['전라남도', '전남'], ['경상북도', '경북'], ['경상남도', '경남'], ['제주특별자치도', '제주'], ['제주도', '제주'],
];

/** 주소 문자열 → { sido, sigungu, full }. 못 읽으면 해당 항목이 null. */
export function parseRegion(addr) {
  const s = String(addr ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { sido: null, sigungu: null, full: null };

  let sido = null, rest = s;
  for (const [long, short] of SIDO) {
    if (s.startsWith(long)) { sido = short; rest = s.slice(long.length).trim(); break; }
  }
  if (!sido) {
    for (const [, short] of SIDO) {
      if (!s.startsWith(short)) continue;
      sido = short;
      // "서울시 중구" · "경기도 성남시" — 축약형 뒤에 붙는 행정단위 접미사를 마저 떼야
      // 그 다음의 시·군·구가 읽힌다. 안 떼면 "시 중구"가 남아 구 판정이 통째로 실패한다.
      rest = s.slice(short.length).replace(/^(?:특별자치시|특별자치도|특별시|광역시|시|도)/, '').trim();
      break;
    }
  }

  // 시 아래 구가 있는 경우(성남시 분당구·수원시 영통구)는 둘을 붙여야 구분이 된다.
  const m = rest.match(/^([가-힣]+시)\s+([가-힣]+구)/) || rest.match(/^([가-힣]+(?:시|군|구))/);
  const sigungu = m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : null;
  return { sido, sigungu, full: s };
}

const canon = s => String(s ?? '').replace(/\s/g, '');

/**
 * 🔴 전국 광역시에 같은 이름의 구가 있다. 시·도 없이 `중구`라고만 적으면 어디를 뜻하는지 알 수 없다.
 *    게이트가 이걸 사용자에게 알려야 한다 — 조용히 아무 중구나 통과시키면 안 된다.
 */
export const AMBIGUOUS_DISTRICTS = ['중구', '서구', '남구', '동구', '북구', '강서구'];

/** 주소에서 뽑아낸 대조 키. 좁은 것부터 넓은 것 순. */
function regionKeys(r) {
  const keys = [];
  if (r.sido && r.sigungu) keys.push(canon(r.sido + r.sigungu));
  if (r.sigungu) keys.push(canon(r.sigungu));
  if (r.sido) keys.push(canon(r.sido));
  return keys;
}

/**
 * 🔴 `includes` 양방향 대조는 안 된다. `'서울중구'.includes('중구')`가 참이라
 *    사용자가 **`서울 중구`라고 명시했는데 부산 중구 공고가 통과**한다(실측 확인).
 *    행정구역 이름은 부분 문자열로 비교할 대상이 아니다 — 단위(구/시/군) 생략만 허용하고 나머지는 정확히 본다.
 */
function hits(wants, keys) {
  return wants.some(w => keys.some(k => k === w || k === `${w}구` || k === `${w}시` || k === `${w}군`));
}

/**
 * 공고 지역이 사용자의 희망 지역에 드는가.
 *   'pass'    — 든다
 *   'deny'    — denyRegions에 걸렸다
 *   'out'     — 확실히 범위 밖
 *   'unknown' — 판정 불가 (주소 없음 / 광역만 있어 구 단위 조건과 비교 불가)
 * 🔴 unknown은 drop이 아니다. 호출부에서 hold로 넘긴다.
 */
export function regionVerdict(addr, { regions = [], denyRegions = [] } = {}) {
  const r = parseRegion(addr);
  const deny = denyRegions.map(canon).filter(Boolean);
  const want = regions.map(canon).filter(Boolean);
  // 🔴 주소 원문 전체로 대조하지 않는다. 도로명("중구로"·"강남대로")이 구 이름을 품고 있어
  //    범위 밖 공고가 통과해 버린다. 파싱된 행정구역만 본다.
  const keys = regionKeys(r);

  if (deny.length && hits(deny, keys)) return { verdict: 'deny', ...r };
  if (!want.length) return { verdict: 'pass', ...r };   // 조건 없음 = 전국
  if (hits(want, keys)) return { verdict: 'pass', ...r };
  // 광역만 적힌 공고를 구 단위 조건과 비교할 수는 없다 → 판정 불가로 남긴다.
  if (!r.sigungu) return { verdict: 'unknown', ...r };
  return { verdict: 'out', ...r };
}

/**
 * 근무지가 **여러 곳**인 공고의 판정. 사람인은 한 공고에 근무지를 여럿 적는다
 * ("서울 강남구, 서초구, 대전 서구"). 첫 곳만 보면 다닐 수 있는 자리를 범위 밖으로 버린다.
 *
 * 🔴 **하나라도 들면 통과다.** 강남과 부산에 자리가 있는 공고를 "부산이 제외 지역"이라는 이유로
 *    버리면 안 된다 — 사용자는 강남으로 다니면 된다. 제외는 **모든 후보가 막혔을 때만** 성립한다.
 *
 * 우선순위: pass > unknown(=hold) > deny > out
 */
export function regionVerdictAny(addrs, opts = {}) {
  const list = (Array.isArray(addrs) ? addrs : [addrs]).filter(a => String(a ?? '').trim());
  if (!list.length) return { verdict: 'unknown', sido: null, sigungu: null, full: null };
  const seen = list.map(a => regionVerdict(a, opts));
  for (const want of ['pass', 'unknown', 'deny', 'out']) {
    const hit = seen.find(v => v.verdict === want);
    if (hit) return hit;
  }
  return seen[0];
}

const R = 6371;
const rad = d => (d * Math.PI) / 180;

/** 직선거리(km). 통근 실측을 못 할 때의 거친 하한선으로만 쓴다. */
export function haversine(a, b) {
  if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return null;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
