// 투자 정보 — DART 공시 제목에서 **자금이 실제로 들어온 사건**만 뽑는다.
//
// 왜 제목만 보는가 (2026-08-18 CEO 요청으로 착수):
//   공시 목록은 재무를 찾느라 이미 받아 둔 것이라 **요청이 늘지 않는다.**
//   원문을 열면 금액까지 알 수 있지만 회사당 요청이 한 번씩 더 늘고, 서식이 제각각이라
//   금액 오추출이 곧바로 **잘못된 등급**이 된다. 그래서 지금은 "있었다"까지만 사실로 다루고,
//   🔴 **금액을 모른다는 사실을 문구에 그대로 적는다.**
//
// 🔴 이 목록에서 가장 중요한 것은 **넣지 않은 것들**이다.
//   무상증자      자금이 들어오지 않는다. 잉여금을 자본금으로 옮기는 회계 처리다
//   자기주식 취득·소각·유상감자   자금이 **나간다**
//   타법인 주식 취득   회사가 **남에게** 투자한 것이다
//   대량보유상황보고   기존 주주끼리의 지분 매매다. 회사로 들어온 돈이 아니다
//   이것들을 "투자 유치"로 세면, 돈이 나간 회사가 돈을 받은 회사로 보인다.

/**
 * 조달성 공시 — `equity: true` 는 **지분(신주) 발행으로 자본이 실제로 늘어나는 것**뿐이다.
 * 🔴 순서가 규칙이다. 위에서부터 먼저 맞는 것 하나만 쓴다 —
 *    `소액공모(지분증권)` 이 `소액공모` 보다 먼저 와야 채무 소액공모가 지분으로 둔갑하지 않는다.
 */
export const FUNDING_KINDS = [
  { kind: 'paidInCapital', label: '유상증자 결정', equity: true, re: /유\s*상\s*증\s*자.*결\s*정/ },
  { kind: 'securitiesEquity', label: '지분증권 증권신고서', equity: true, re: /증권신고서\s*\(\s*지분증권\s*\)/ },
  { kind: 'smallOfferingEquity', label: '소액공모(지분증권)', equity: true, re: /소액공모[\s\S]*지분증권|지분증권[\s\S]*소액공모/ },
  // 🔴 아래부터는 **부채로 들어온 돈**이다. 자본잠식 판정을 뒤집을 근거가 되지 못한다.
  //    `소액공모` 는 종류가 안 적혀 있으면 지분으로 치지 않는다 — 모를 때는 등급을 움직이지 않는 쪽이 안전하다.
  { kind: 'securitiesDebt', label: '채무증권 증권신고서', equity: false, re: /증권신고서\s*\(\s*채무증권\s*\)/ },
  { kind: 'smallOffering', label: '소액공모', equity: false, re: /소액공모/ },
  { kind: 'convertibleBond', label: '전환사채 발행 결정', equity: false, re: /전환사채권?\s*발행\s*결정/ },
  { kind: 'bondWithWarrant', label: '신주인수권부사채 발행 결정', equity: false, re: /신주인수권부사채권?\s*발행\s*결정/ },
  { kind: 'exchangeableBond', label: '교환사채 발행 결정', equity: false, re: /교환사채권?\s*발행\s*결정/ },
];

/**
 * 🔴 자금이 들어오지 않거나 나가는 공시. 조달 패턴보다 **먼저** 걸러야 한다.
 *
 * `철회·취소·해제` — 결정했다가 **되돌린 것**이다. 돈이 들어오지 않았다.
 * `종속회사` — 자회사가 받은 돈이다. **이 회사로 들어온 것이 아니다.**
 *   (`[기재정정]` 은 같은 사건을 다시 낸 것이라 제외하지 않는다. 사건 자체는 살아 있다.)
 */
const NOT_FUNDING = /무\s*상\s*증\s*자|자기주식|주식\s*소각|유\s*상\s*감\s*자|무\s*상\s*감\s*자|타법인|대량보유|임원ㆍ주요주주|임원·주요주주|철\s*회|취\s*소|해\s*제|종속회사/;

const DART_URL = rcpNo => `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;

/** `2026.01.16` → `2026-01-16`. 형식이 다르면 그대로 돌려준다 (지어내지 않는다). */
export const normDate = d => {
  const m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/.exec(String(d ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : (d ?? null);
};

/** 두 날짜 사이 개월 수. 알 수 없으면 null — 🔴 모르는 것을 0으로 만들지 않는다. */
export function monthsSince(dateStr, now = new Date()) {
  const iso = normDate(dateStr);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(then.getTime())) return null;
  return (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
}

/**
 * 공시 목록 → 조달 사건 목록 (최신순). 순수 함수라 테스트가 문다.
 * @param {Array<{report, date, rcpNo}>} reports  `lib/dart.mjs` 의 공시검색 결과
 */
export function investmentEvents(reports = [], { now = new Date() } = {}) {
  const out = [];
  for (const r of reports ?? []) {
    const title = String(r?.report ?? '');
    if (!title || NOT_FUNDING.test(title)) continue;
    const hit = FUNDING_KINDS.find(k => k.re.test(title));
    if (!hit) continue;
    out.push({
      kind: hit.kind, label: hit.label, equity: hit.equity,
      title: title.replace(/\s+/g, ' ').trim(),
      date: normDate(r.date),
      months: monthsSince(r.date, now),
      rcpNo: r.rcpNo ?? null,
      url: r.rcpNo ? DART_URL(r.rcpNo) : null,
    });
  }
  // 날짜 문자열이 YYYY-MM-DD 로 정규화돼 있어 사전순 = 시간순이다.
  return out.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

/** 등급에 반영하는 창(개월). 🔴 이 숫자를 바꾸면 등급이 바뀐다 — 문서와 테스트가 함께 물고 있다. */
export const RECENT_MONTHS = 12;

/**
 * 사건 목록 → 리포트·등급이 쓰는 요약.
 * @returns {{count, latest, months, recentEquity, items}}
 */
export function summarizeInvestment(events = [], { recentMonths = RECENT_MONTHS } = {}) {
  const items = events ?? [];
  if (!items.length) {
    return { count: 0, latest: null, months: null, recentEquity: false, recentEquityEvent: null, items: [] };
  }
  const latest = items[0];
  // 🔴 "최근 조달"은 **지분 발행**만 센다. 전환사채는 부채로 들어오는 돈이라
  //    자본잠식 판정을 뒤집을 근거가 되지 못한다.
  // 🔴 `months >= 0` 이 빠지면 **미래 날짜 공시가 자동으로 "최근"이 된다** — 날짜를 잘못 읽었을 때
  //    그 오류가 곧바로 등급 완화로 이어진다. 모르는 것(null)도 최근으로 치지 않는다.
  const brief = e => ({ label: e.label, date: e.date, months: e.months, url: e.url });
  const equityHit = items.find(e => e.equity && e.months !== null && e.months >= 0 && e.months <= recentMonths);
  return {
    count: items.length,
    latest: brief(latest),
    months: latest.months,
    recentEquity: Boolean(equityHit),
    // 🔴 완화의 근거가 된 **바로 그 공시**를 들고 다닌다. `latest` 를 쓰면
    //    "유상증자 때문에 낮췄는데 화면에는 전환사채가 근거로 뜨는" 일이 생긴다.
    recentEquityEvent: equityHit ? brief(equityHit) : null,
    items: items.slice(0, 5),
  };
}

/** 리포트·콘솔이 함께 쓰는 한 줄. 🔴 금액을 모른다는 사실을 빼지 않는다. */
export function investmentLine(summary) {
  if (!summary?.latest) return null;
  const { label, date } = summary.latest;
  const more = summary.count > 1 ? ` 외 ${summary.count - 1}건` : '';
  return `${date} ${label}${more} — 금액은 공시 원문에서 확인해 주십시오`;
}
