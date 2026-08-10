// 회사명 → 법인 매칭. 이 저장소에서 가장 조심해서 다뤄야 하는 코드다.
//
// 🔴 매칭 실패는 불편할 뿐이지만, **오매칭은 사용자가 잘못된 회사 재무를 보고 지원 결정을 내리게 한다.**
//    실측에서 부분일치 구제 로직이 5건을 틀렸다:
//      (주)골프존 → 아이에스지주 / (주)델레오코리아 → 아이에스지주  (서로 다른 회사가 같은 법인에)
//      미소(Miso) → (주)미소무역 / 대웅 → (주)대웅상사 / 유닛블랙 → 유닛블랙랩스
//    그래서 부분일치는 **구제하지 않는다.** 지역이 맞아떨어져도 채택하지 않는다.

import { normCorp } from './text.mjs';

const digits = s => String(s ?? '').replace(/\D/g, '');
const canon = s => String(s ?? '').replace(/\s/g, '');

/**
 * @param {Array} items      조회 결과. { corpNm, addr, crno, industry, foundedAt } 형태로 정규화해 넘긴다.
 * @param {string} name      찾는 회사명
 * @param {object} hint      { region, crno } — 있으면 동명이인 구분에 쓴다
 * @returns {{status:'exact'|'ambiguous'|'none', corp?, how?, reason?, candidates?}}
 *
 * status:
 *   exact     — 채택. 재무를 붙여도 된다
 *   ambiguous — 후보가 여럿이고 못 좁혔다. 🔴 사람에게 물어본다. 자동 채택 금지
 *   none      — 없거나 부분일치뿐. 미확인으로 둔다
 */
export function resolveCorp(items, name, hint = {}) {
  const list = dedupe(items);
  if (!list.length) return { status: 'none', reason: 'no-result' };

  // 법인등록번호를 이미 아는 경우 — 이름보다 강한 근거다.
  if (hint.crno) {
    const byCrno = list.filter(i => digits(i.crno) && digits(i.crno) === digits(hint.crno));
    if (byCrno.length === 1) return { status: 'exact', how: 'crno', corp: byCrno[0] };
    if (byCrno.length > 1) return { status: 'ambiguous', reason: 'crno-duplicated', candidates: brief(byCrno) };
    // 🔴 법인등록번호를 아는데 맞는 후보가 하나도 없으면, 이름이 같아도 **다른 법인**이다.
    //    여기서 이름 매칭으로 흘려보내면 강한 근거(번호)를 약한 근거(상호)로 덮어쓰게 된다.
    //    상호는 얼마든지 겹치지만 법인등록번호는 겹치지 않는다.
    if (list.some(i => digits(i.crno))) {
      return { status: 'none', reason: 'crno-mismatch', candidates: brief(list) };
    }
    // 후보 어느 쪽도 번호를 안 갖고 있으면 대조 자체가 불가능하다 → 이름 매칭으로 내려간다.
  }

  const target = normCorp(name);
  const exact = list.filter(i => normCorp(i.corpNm) === target);

  if (exact.length === 1) return { status: 'exact', how: 'name-exact', corp: exact[0] };

  if (exact.length > 1) {
    // 동명이인 — 등기주소로만 좁힌다. 정확히 하나로 좁혀질 때에만 채택한다.
    const byRegion = narrowByRegion(exact, hint.region);
    if (byRegion.length === 1) return { status: 'exact', how: 'name-exact+region', corp: byRegion[0] };
    return { status: 'ambiguous', reason: 'homonym', candidates: brief(exact) };
  }

  // 🔴 여기가 사고 지점이었다. 부분일치는 어떤 보조 근거로도 채택하지 않는다.
  const partial = list.filter(i => {
    const n = normCorp(i.corpNm);
    return n.includes(target) || target.includes(n);
  });
  if (partial.length) {
    return { status: 'none', reason: 'partial-only', candidates: brief(partial) };
  }
  return { status: 'none', reason: 'no-exact-match', candidates: brief(list) };
}

/** 같은 법인이 연도별로 중복 응답된다 — 법인번호 기준으로 접는다. */
function dedupe(items) {
  const out = new Map();
  for (const i of items ?? []) {
    if (!i) continue;
    const k = digits(i.crno) || `n:${normCorp(i.corpNm)}|${canon(i.addr).slice(0, 20)}`;
    if (!out.has(k)) out.set(k, i);
  }
  return [...out.values()];
}

function narrowByRegion(items, region) {
  const key = canon(region).replace(/(시|군|구)$/, '');
  if (!key) return items;
  const hits = items.filter(i => canon(i.addr).includes(key));
  return hits.length ? hits : items;
}

const brief = items => items.slice(0, 5).map(i => ({
  corpNm: i.corpNm, crno: i.crno, addr: String(i.addr ?? '').slice(0, 30),
}));

/** ambiguous를 사용자에게 물어볼 문장으로. 🔴 조용히 하나 고르지 않는다. */
export function ambiguityPrompt(name, r) {
  const lines = (r.candidates ?? []).map((c, i) => `  ${i + 1}) ${c.corpNm} — ${c.addr || '주소 없음'}`);
  return `"${name}" 후보가 ${r.candidates?.length ?? 0}곳입니다. 어느 쪽입니까?\n${lines.join('\n')}\n  0) 모르겠음 (미확인으로 둠)`;
}
