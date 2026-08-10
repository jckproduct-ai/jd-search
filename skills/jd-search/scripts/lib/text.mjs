// 회사명·직무명 문자열 처리.

/** 법인 형태 표기. 🔴 이름의 일부가 아니다 — 별칭으로 오해하면 사고가 난다. */
const LEGAL_FORMS = ['주식회사', '유한책임회사', '유한회사', '합자회사', '합명회사', '사단법인', '재단법인', '의료법인', '학교법인'];
const LEGAL_PAREN = /[(（]\s*(주|유|재|사|합|자|주식회사|유한회사)\s*[)）]/g;
const LEGAL_SYMBOL = /[㈜㈐]/g;

/** 비교용 정규화. "주식회사 컬리" · "(주)컬리" · "컬리 주식회사" → "컬리" */
export function normCorp(s) {
  let v = String(s ?? '').replace(LEGAL_PAREN, '').replace(LEGAL_SYMBOL, '');
  for (const f of LEGAL_FORMS) v = v.split(f).join('');
  return v.replace(/[\s.,·・…\-–—'"“”‘’]/g, '').toLowerCase();
}

/**
 * 검색에 쓸 회사명 후보. 조회 실패를 줄이려고 넓히되, **틀린 후보는 만들지 않는다.**
 *
 * 🔴 "(주)골프존"에서 괄호 안 "주"를 별칭으로 뽑아 "주 주식회사"로 조회했더니
 *    전혀 다른 법인(아이에스지주)이 붙었다. 괄호 안이 법인 형태 표기면 별칭이 아니다.
 *    같은 사고가 "(주)델레오코리아"에서도 났다 — 서로 다른 두 회사가 같은 법인번호를 물었다.
 */
export function nameVariants(name) {
  const raw = String(name ?? '').trim();
  const out = new Set();
  const add = v => { const t = String(v ?? '').trim(); if (t.length >= 2) out.add(t); };

  const bare = raw.replace(LEGAL_PAREN, '').replace(LEGAL_SYMBOL, '')
    .replace(/[(（][^)）]*[)）]/g, ' ').replace(/\s+/g, ' ').trim();
  add(raw);
  add(bare);

  // 🔴 사람인은 국문·영문 상호를 슬래시로 병기한다("(주)아이클레이브 / iclave").
  //    괄호 병기는 이미 쪼개면서 슬래시는 안 쪼갰다 — 그 이름의 법인은 **어디에도 없어서**
  //    모든 후보가 빗나가고 조용히 "미확인"이 된다.
  //    공백으로 둘러싸인 슬래시만 본다. "A/B스토어" 같은 이름 속 슬래시를 쪼개면 없는 회사를 만든다.
  if (/\s[/／]\s/.test(bare || raw)) {
    for (const part of (bare || raw).split(/\s[/／]\s/)) add(part);
  }

  // 괄호 안 별칭 — 법인 형태 표기·"구 ○○"·"주식회사"류는 제외한다.
  for (const m of raw.matchAll(/[(（]([^)）]+)[)）]/g)) {
    const inner = m[1].trim();
    if (LEGAL_FORMS.includes(inner)) continue;
    if (/^(주|유|재|사|합|자)$/.test(inner)) continue;
    if (/^(구|전|舊)\s/.test(inner)) continue;
    add(inner);
  }

  // 법인 형태를 붙인 형태 — 공공데이터포털은 등기 상호로만 잡힌다.
  for (const base of [bare || raw]) {
    add(`주식회사 ${base}`);
    add(`${base} 주식회사`);
    add(`(주)${base}`);
  }
  return [...out];
}

/** 두 문자열의 bigram Dice 계수. 교차 보드 중복 병합의 제목 유사도에 쓴다. */
export function similarity(a, b) {
  const grams = s => {
    const t = String(s ?? '').replace(/\s+/g, '').toLowerCase();
    if (t.length < 2) return new Set(t ? [t] : []);
    return new Set(Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2)));
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/** 공고 제목·본문에 키워드가 걸리는가. 한글은 어절 경계가 약해 부분일치로 본다. */
export function matchesAny(haystack, keywords = []) {
  const h = String(haystack ?? '').toLowerCase();
  return keywords.filter(k => {
    const kw = String(k ?? '').trim().toLowerCase();
    if (!kw) return false;
    // 영문 약어(PM·PO·QA)는 부분일치하면 "PMO"·"POC"까지 걸린다 → 낱말 경계를 본다.
    if (/^[a-z]{2,4}$/.test(kw)) return new RegExp(`(^|[^a-z])${kw}([^a-z]|$)`, 'i').test(h);
    return h.includes(kw);
  });
}

export const stripTags = s => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

export const escapeHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
