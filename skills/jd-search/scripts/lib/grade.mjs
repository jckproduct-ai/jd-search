// 자금등급 룰 — 재무 숫자를 "지원해도 되는가"로 옮긴다.
//
// 🔴 등급은 반드시 **기준연도와 함께** 나간다. 2022년 수치로 2026년 등급을 매긴 사고가 실측에서 4건 있었다.
// 🔴 자본이 두터운 적자 기업(대규모 조달)을 위험으로 내리면 안 된다. 토스가 자본 1조인데 강등됐었다.

export const GRADE_LABEL = { g: '좋음', o: '양호', w: '경고', r: '위험', u: '미확인' };
export const GRADE_ORDER = ['r', 'w', 'u', 'o', 'g'];

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {object} byYear  { 2025: {revenue, operatingProfit, equity, liabilities, ...}, 2024: {...} }
 * @param {object} opt     { staleYears=3, now=올해 }
 * @returns {{grade, year, reasons:string[], stale:boolean, series}}
 */
export function gradeCompany(byYear, opt = {}) {
  const staleYears = opt.staleYears ?? 3;
  const now = opt.now ?? new Date().getFullYear();

  const years = Object.keys(byYear ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  const series = years.map(y => ({ year: y, ...byYear[y] }))
    .filter(r => num(r.revenue) !== null || num(r.operatingProfit) !== null || num(r.equity) !== null);

  if (!series.length) return { grade: 'u', year: null, stale: false, reasons: ['공시 데이터 없음'], series: [] };

  const latest = series[0];
  // 🔴 두 번째로 최신인 자료를 무조건 "직전연도"로 쓰면 안 된다.
  //    2025·2022 두 해만 있는 회사가 "영업적자 2년 연속"으로 경고를 먹는다 — 사이 2년은 자료가 없을 뿐이다.
  //    연속 판정(연속 적자·연속 흑자·매출 성장)은 **바로 앞 해가 실제로 있을 때만** 한다.
  // 🔴 회계 기준(별도/연결)이 다르면 추세 비교 자체가 성립하지 않는다.
  //    연결 매출과 별도 매출을 비교하면 회계 기준 변경이 "성장"으로 둔갑한다.
  const candidate = series[1] ?? null;
  const sameBasis = !latest.basis || !candidate?.basis || latest.basis === candidate.basis;
  const prev = (candidate && candidate.year === latest.year - 1 && sameBasis) ? candidate : null;
  const gapNote = candidate && !prev
    ? (candidate.year !== latest.year - 1
        ? `직전연도(${latest.year - 1}) 자료가 없어 추세는 판정하지 않음`
        : `${candidate.year}년은 ${candidate.basis} 기준이라 ${latest.basis} 기준과 비교하지 않음`)
    : null;

  // 🔴 낡은 자료로 등급을 매기지 않는다.
  if (now - latest.year >= staleYears) {
    return { grade: 'u', year: latest.year, stale: true, series,
      reasons: [`최신 자료가 ${latest.year}년 — ${staleYears}년 이상 낡아 등급을 매기지 않음`] };
  }

  const equity = num(latest.equity);
  const op = num(latest.operatingProfit);
  const opPrev = prev ? num(prev.operatingProfit) : null;
  const rev = num(latest.revenue);
  const revPrev = prev ? num(prev.revenue) : null;
  const liab = num(latest.liabilities);

  const reasons = [];
  const 억 = v => (v === null ? '—' : `${(v / 1e8).toFixed(1)}억`);
  const turning = op !== null && op > 0 && opPrev !== null && opPrev <= 0;   // 흑자전환 신호
  const lossStreak = op !== null && op < 0 && opPrev !== null && opPrev < 0; // 영업적자 2년 이상
  // 🔴 자본이 연간 영업적자의 10배 이상이면 대규모 조달 기업이다. 강등하지 않는다.
  const cushioned = equity !== null && equity > 0 && op !== null && op < 0 && equity >= Math.abs(op) * 10;

  // ① 위험 — 자본총계 ≤ 0 이고 영업흑자도 아님
  //    🔴 경계는 `< 0`이 아니라 `≤ 0`이다. 자본총계가 정확히 0이면 자본이 전부 잠식된 상태이고,
  //       `< 0`으로만 보면 그 회사가 어느 분기에도 안 걸려 "미확인"으로 빠져나간다.
  //    (직전연도가 없어 "흑자전환"인지까지는 몰라도, 당기 영업흑자면 위험까지 내리지 않는다)
  if (equity !== null && equity <= 0 && !(op !== null && op > 0)) {
    reasons.push(`자본총계 ${억(equity)} — 완전자본잠식`);
    if (op !== null) reasons.push(`영업${op < 0 ? '손실' : '이익'} ${억(Math.abs(op))}`);
    return done('r');
  }

  // ② 경고
  if (equity !== null && equity <= 0 && op !== null && op > 0) {
    reasons.push(turning
      ? `자본총계 ${억(equity)} 자본잠식이나 ${latest.year}년 영업이익 ${억(op)} 흑자전환`
      : `자본총계 ${억(equity)} 자본잠식이나 ${latest.year}년 영업이익 ${억(op)}`);
    return done('w');
  }
  if (lossStreak && !cushioned) {
    reasons.push(`영업적자 2년 연속 (${prev.year} ${억(opPrev)} → ${latest.year} ${억(op)})`);
    if (equity !== null) reasons.push(`자본총계 ${억(equity)}`);
    return done('w');
  }
  // 자본총계 ≤ 0이면 부채비율은 계산하지 않는다 (분모 붕괴).
  if (equity !== null && equity > 0 && liab !== null) {
    const ratio = (liab / equity) * 100;
    if (ratio > 400 && !cushioned) {
      reasons.push(`부채비율 ${ratio.toFixed(0)}% (부채 ${억(liab)} / 자본 ${억(equity)})`);
      return done('w');
    }
  }

  // ③ 좋음 — 영업흑자 2년 연속 · 자본 > 0 · 매출 성장
  //    (문서상 순서는 양호가 앞이지만, 양호의 "흑자 1~2년차"가 이 조건을 덮어버리므로 먼저 본다)
  const growing = rev !== null && revPrev !== null && rev > revPrev;
  if (op !== null && op > 0 && opPrev !== null && opPrev > 0 && equity !== null && equity > 0 && growing) {
    reasons.push(`영업흑자 2년 연속 (${prev.year} ${억(opPrev)} → ${latest.year} ${억(op)})`);
    reasons.push(`매출 ${억(revPrev)} → ${억(rev)} 성장 · 자본총계 ${억(equity)}`);
    return done('g');
  }

  // ④ 양호 — 흑자 1~2년차, 손익분기, 또는 적자지만 자본이 연간 영업적자의 3배 이상
  //    🔴 `op > 0`만 보면 **영업이익이 정확히 0인 회사**가 어느 분기에도 안 걸려 미확인으로 빠진다.
  //       손익분기는 "판정 불가"가 아니라 적자가 아니라는 사실이다.
  if (op !== null && op >= 0) {
    reasons.push(op === 0 ? `${latest.year}년 영업손익 0 — 손익분기`
      : turning ? `${latest.year}년 영업이익 ${억(op)} 흑자전환` : `${latest.year}년 영업이익 ${억(op)}`);
    if (rev !== null && revPrev !== null && rev <= revPrev) reasons.push(`매출은 ${억(revPrev)} → ${억(rev)} 감소`);
    if (equity !== null) reasons.push(`자본총계 ${억(equity)}`);
    return done('o');
  }
  if (op !== null && op < 0 && equity !== null && equity >= Math.abs(op) * 3) {
    reasons.push(`영업손실 ${억(Math.abs(op))}이나 자본총계 ${억(equity)} — 연간 손실의 ${(equity / Math.abs(op)).toFixed(1)}배`);
    return done('o');
  }
  // 🔴 적자인데 자본 완충이 3배 미만이면 경고다. **미확인으로 내리면 안 된다** —
  //    숫자가 버젓이 있는데 "미확인"이 뜨면 사용자는 데이터가 없다고 읽는다.
  if (op !== null && op < 0 && equity !== null && equity > 0) {
    reasons.push(`${latest.year}년 영업손실 ${억(Math.abs(op))} · 자본총계 ${억(equity)} — 연간 손실의 ${(equity / Math.abs(op)).toFixed(1)}배에 그침`);
    return done('w');
  }

  // 판정에 필요한 항목이 모자란 경우 — 추측하지 않는다.
  reasons.push('손익·자본 항목이 모자라 판정 불가');
  return done('u');

  function done(grade) {
    if (gapNote) reasons.push(gapNote);
    return { grade, year: latest.year, basis: latest.basis ?? null, stale: false, reasons, series, cushioned };
  }
}

/**
 * 기준선(현직장) 대비 ▲▼. 매출·영업이익·자본총계 **3개 중 2개 이상**이 나으면 ▲.
 * 🔴 기준선이 없으면 배지를 만들지 않는다. 없는 비교를 지어내지 않는다.
 */
export function compareToBaseline(latest, baseline) {
  if (!baseline || !latest) return null;
  const keys = ['revenue', 'operatingProfit', 'equity'];
  const cmp = keys
    .map(k => [k, num(latest[k]), num(baseline[k])])
    .filter(([, a, b]) => a !== null && b !== null);
  if (cmp.length < 2) return null;
  const better = cmp.filter(([, a, b]) => a > b).length;
  return {
    dir: better >= 2 ? 'up' : better <= cmp.length - 2 ? 'down' : 'flat',
    better, compared: cmp.length,
    detail: cmp.map(([k, a, b]) => ({ key: k, mine: b, theirs: a })),
  };
}

/**
 * 🔴 없는 위험을 지어내는 질문은 만들지 않는다. 다만 **미확인도 근거다** —
 *    "공시가 없다"는 사실 자체가 물어볼 거리이고, 그게 이 제품이 미확인을 버리지 않는 이유다.
 * @param g       gradeCompany() 결과
 * @param unknown 미확인 사유 (finance 단계의 note). 있으면 그 사유에 맞는 질문을 만든다
 */
export function interviewQuestions({ grade, reasons = [], year }, unknown = null) {
  if (grade === 'u') {
    const u = String(unknown ?? '');
    if (/동명|여러 곳|ambiguous/i.test(u)) return [];   // 회사를 특정 못 한 상태라 질문 자체가 성립하지 않는다
    if (/미등록|수록되지 않|보고서 없|추출하지 못/.test(u)) return [
      '공개된 재무 공시를 찾지 못했습니다. 최근 매출과 손익 추이를 알 수 있겠습니까?',
      '현재 현금 런웨이는 몇 개월이고, 다음 투자 유치 계획이 있습니까?',
    ];
    if (/(\d{4})년/.test(u)) return [
      `공개된 가장 최근 재무가 ${u.match(/(\d{4})년/)[1]}년입니다. 이후 실적은 어떻게 됩니까?`,
      '최근 회계연도 기준 영업손익과 자본총계를 알 수 있겠습니까?',
    ];
    return [];
  }
  if (!reasons.length) return [];
  const q = [];
  const has = re => reasons.some(r => re.test(r));

  if (has(/자본잠식/)) {
    q.push(`${year}년 기준 자본잠식 상태로 공시돼 있습니다. 해소 계획과 현재 진행 상황을 알 수 있겠습니까?`);
    q.push('최근 투자 유치나 유상증자 계획이 있습니까? 확정된 일정이 있습니까?');
  }
  if (has(/영업적자 2년 연속/)) {
    q.push('영업적자가 이어지고 있는데, 흑자 전환 목표 시점과 그 근거가 되는 지표는 무엇입니까?');
    q.push('현재 현금 런웨이는 몇 개월입니까?');
  }
  if (has(/부채비율/)) q.push('부채비율이 높게 잡혀 있습니다. 차입 구조와 상환 일정은 어떻게 됩니까?');
  if (has(/흑자전환/)) q.push(`${year}년 흑자 전환의 주된 요인이 무엇이었고, 그것이 이어질 수 있는 성격입니까?`);
  if (has(/매출은 .* 감소/)) q.push('매출이 줄었는데 원인이 무엇이고, 올해 계획은 어떻게 잡혀 있습니까?');
  if (!q.length && grade === 'g') q.push('성장이 이어지는 중인데, 이 조직에서 이 자리가 맡을 다음 과제는 무엇입니까?');
  return q.slice(0, 3);
}
