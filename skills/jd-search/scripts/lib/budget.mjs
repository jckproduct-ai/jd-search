// 상세 조회 예산 — **보드가 공유하는 규칙**이다 (D23·D24, 2026-08-10 CEO 결정).
//
// 🔴 원래 `lib/saramin.mjs` 안에 있었는데, 점핏이 같은 규칙을 쓰게 되면서 여기로 뺐다.
//    보드마다 따로 두면 "첫 실행은 전량"이 한 보드에서만 지켜지고, 사용자는 어느 목록이
//    잘린 것인지 알 방법이 없다. 규칙이 하나면 어긋날 자리가 없다.

/**
 * 상세 조회 예산 계산. 🔴 스크립트 본문에 두면 테스트가 물지 못해 여기로 뺐다(#66 과 같은 이유).
 *
 * 규칙 셋:
 *  ① `--max` 를 사용자가 적었으면 그 값이 최우선이다.
 *  ② 안 적었고 **첫 실행이면 전량**이다 (CEO 결정 2026-08-10).
 *     처음 만들어진 목록이 5분의 1이면 사용자는 그 5분의 1을 자기 시장 전부로 읽는다.
 *     경고를 적어 둬도 첫 화면이 만드는 오해가 더 세다.
 *  ③ 안 적었고 재실행이면 200.
 *
 * 🔴 상한이 세는 것은 **실제로 받아야 하는 건수**다. 후보 건수가 아니다.
 *    이미 받아 둔 공고는 네트워크를 쓰지 않는데 그것까지 세면 목록 뒤쪽의 **새 공고가 영영 안 받아진다** —
 *    조용한 손실이 상한 뒤에 쌓인다.
 *
 * @param ids        이번에 본 공고 id 배열 (목록 순서)
 * @param needsFetch id → 상세를 받아야 하는가
 * @param maxFlag    `--max` 값. 없으면 null
 * @param firstRun   이 보드 공고를 하나도 보관하고 있지 않은가
 * @returns {{allowed:Set, cutOff:number, max:number, firstRunFull:boolean}}
 */
export function planDetailBudget(ids, needsFetch, { maxFlag = null, firstRun = false } = {}) {
  const explicit = maxFlag != null && maxFlag !== true && Number.isFinite(Number(maxFlag));
  const max = explicit ? Number(maxFlag) : (firstRun ? Infinity : 200);
  const toFetch = ids.filter(needsFetch);
  const budget = Number.isFinite(max) ? Math.max(0, max) : toFetch.length;
  const allowed = new Set(toFetch.slice(0, budget));
  return {
    allowed,
    cutOff: toFetch.length - allowed.size,
    max,
    firstRunFull: !explicit && firstRun,
  };
}
