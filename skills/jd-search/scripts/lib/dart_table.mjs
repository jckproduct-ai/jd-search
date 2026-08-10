// DART 공시문서 재무제표 표 파서.
//
// 🔴 텍스트 평탄화 + 정규식은 실패한다. 1차 시도에서 16/20이 "추출 성공"으로 찍혔지만
//    쿠팡 매출이 23.3억(실제 41.9조), 여기어때가 279조로 나왔다.
//    원인: 계정과목 옆 **주석 컬럼**("23,28")을 값으로 집었다.
//    → 반드시 <tr>/<td> 구조를 살려 "주석" 헤더 컬럼을 배제하고 읽어야 한다.

// 🔴 숫자 엔티티(&#40; = 여는 괄호)를 안 풀면 **괄호 음수 표기가 통째로 사라진다.**
//    값이 틀리는 게 아니라 null이 되어 "항목 부족 → 미확인"으로 조용히 빠진다.
const decodeEntities = s => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const stripTags = s => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function parseTables(html) {
  const tables = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[0];
    const rows = [];
    for (const tr of raw.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push({ rows, at: m.index });
  }
  return tables;
}

// 표 직전 텍스트에서 "(단위: 백만원)" 을 찾는다. 표 안에 있는 경우도 본다.
export function detectUnit(html, tableAt, rowsFlat) {
  const before = html.slice(Math.max(0, tableAt - 3000), tableAt);
  const hay = stripTags(before) + ' ' + rowsFlat;
  if (/단위\s*[:：]?\s*백만\s*원/.test(hay)) return 1_000_000;
  if (/단위\s*[:：]?\s*천\s*원/.test(hay)) return 1_000;
  if (/단위\s*[:：]?\s*원/.test(hay)) return 1;
  return null;
}

const NUM_RE = /^[(\-−△▲]?\s*[\d,]+\s*\)?$/;

function toNum(s) {
  if (!s || !NUM_RE.test(s)) return null;
  const neg = /^\(/.test(s.trim()) || /^[-−△▲]/.test(s.trim());
  const d = s.replace(/[^\d]/g, '');
  if (!d) return null;
  return neg ? -Number(d) : Number(d);
}

// 헤더 행에서 "주석" 컬럼 인덱스를 찾는다. 없으면 -1.
function noteColumn(rows) {
  for (const r of rows.slice(0, 5)) {
    const i = r.findIndex(c => /^주\s*석$/.test(c));
    if (i >= 0) return i;
  }
  return -1;
}

const norm = s => s.replace(/\s/g, '');

// 계정과목 라벨 → 당기 금액. 로마숫자/번호 접두("I. ", "1. ")를 허용한다.
//
// 🔴 부호는 숫자가 아니라 **라벨**에 실린다.
//    한국 손익계산서 관행상 적자면 계정명이 "영업손실"로 바뀌고 값은 양수로 적힌다.
//    부릉(영업수익 3,278억 / 영업비용 3,471억)이 +192.6억으로 읽혀 흑자로 뒤집혔다.
//    자금등급이 정반대가 되는 오류라 오매칭보다 위험하다.
function findRow(rows, matchers, noteIdx) {
  for (const r of rows) {
    const rawLabel = norm(r[0] || '').replace(/^[IVXⅠ-Ⅹ0-9]+[.)]\s*/, '');
    if (!matchers.some(fn => fn(rawLabel))) continue;
    // 주석 컬럼을 뺀 나머지에서 첫 숫자 = 당기
    const vals = r.map((c, i) => (i === 0 || i === noteIdx ? null : toNum(c))).filter(v => v !== null);
    if (!vals.length) continue;
    let v = vals[0];
    // "영업손실"·"당기순손실"처럼 손실 단독 표기면 음수로 뒤집는다.
    // "영업이익(손실)" 병기형은 괄호·△로 부호가 이미 실려 있으므로 건드리지 않는다.
    const lossOnly = /손실$/.test(rawLabel) && !/\(손실\)|\(이익\)/.test(rawLabel);
    if (lossOnly && v > 0) v = -v;
    return v;
  }
  return null;
}

const eq = (...ws) => l => ws.some(w => l === norm(w));
const has = (...ws) => l => ws.some(w => l.includes(norm(w)));

/**
 * 문서 HTML → { fiscalYear, unit, revenue, operatingProfit, equity, source }
 * 표를 하나씩 보며 손익계산서(매출·영업이익)와 재무상태표(자본총계)를 각각 채운다.
 */
/**
 * 회계연도 상한. 🔴 제출연도를 그대로 상한으로 걸면 부족하다.
 *   2026-04-03 제출 문서에서 "2026년 12월 31일"(리스 만기·차입금 상환일정)이 잡혀
 *   회계연도가 2026으로 찍혔다. 아직 오지 않은 결산일은 회계연도가 될 수 없다.
 * → **제출일 기준으로 이미 지나간 마지막 12월 31일**까지만 인정한다.
 */
function fiscalCap(submittedAt) {
  if (submittedAt == null) return new Date().getFullYear() - 1;
  const s = String(submittedAt);
  const m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    return (mo === 12 && d === 31) ? y : y - 1;
  }
  const y = Number(s.slice(0, 4));
  return Number.isFinite(y) ? y - 1 : new Date().getFullYear() - 1;
}

export function extractFromDoc(html, submittedAt = null) {
  const tables = parseTables(html);
  const out = { fiscalYear: null, unit: null, revenue: null, operatingProfit: null, equity: null, tables: tables.length };

  const plain = stripTags(html);
  // 🔴 단순 최댓값을 쓰면 안 된다 — 리스 만기·차입금 상환일정 같은 **미래 날짜**가 섞여
  //    쿠팡 문서에서 2027년이 회계연도로 잡혔다.
  const cap = fiscalCap(submittedAt);
  const years = [...plain.matchAll(/(20\d{2})\s*년\s*12\s*월\s*31\s*일/g)]
    .map(x => Number(x[1])).filter(y => y <= cap);
  if (years.length) out.fiscalYear = Math.max(...years);

  for (const t of tables) {
    const flat = t.rows.map(r => r.join(' ')).join(' ');
    const noteIdx = noteColumn(t.rows);
    const unit = detectUnit(html, t.at, flat);

    // 재무상태표 — 자본총계
    if (out.equity === null && /자\s*본\s*총\s*계|자\s*본\s*총\s*액/.test(flat)) {
      const v = findRow(t.rows, [eq('자본총계', '자본총액'), has('자본총계')], noteIdx);
      if (v !== null && unit) { out.equity = v * unit; out.unit = unit; }
    }
    // 손익계산서 — 매출액 / 영업수익
    if (out.revenue === null && /매\s*출\s*액|영\s*업\s*수\s*익/.test(flat)) {
      const v = findRow(t.rows, [eq('매출액', '영업수익', '수익(매출액)', '매출'), has('매출액', '영업수익')], noteIdx);
      if (v !== null && unit) { out.revenue = v * unit; out.unit = out.unit ?? unit; }
    }
    // 손익계산서 — 영업이익
    if (out.operatingProfit === null && /영\s*업\s*이\s*익|영\s*업\s*손\s*실/.test(flat)) {
      const v = findRow(t.rows, [eq('영업이익', '영업이익(손실)', '영업손실', '영업손익', '영업이익또는손실'), has('영업이익', '영업손실')], noteIdx);
      if (v !== null && unit) { out.operatingProfit = v * unit; out.unit = out.unit ?? unit; }
    }
    if (out.revenue !== null && out.operatingProfit !== null && out.equity !== null) break;
  }
  return out;
}
