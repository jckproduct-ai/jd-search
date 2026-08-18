// 캐시 재검증 규칙 — 🔴 순수 함수로 뺐다. 스크립트 본문에 두면 테스트가 못 문다(#66).
//
// 여기서 틀리면 증상이 조용하다. 낡은 값을 신선하다고 하면 **등급이 옛날 값에 묶인 채** 아무 경고도 안 뜬다.

/**
 * 지금 시점에 "나와 있어야 할" 최신 회계연도.
 * 한국은 12월 결산이 대다수이고 감사보고서·사업보고서가 이듬해 3~4월에 나온다.
 * → 5월이 지나면 전년도 재무가 있어야 정상이고, 그 전이면 전전년도까지가 정상이다.
 */
export function expectedFiscalYear(now = new Date()) {
  const y = now.getFullYear();
  return now.getMonth() + 1 >= 5 ? y - 1 : y - 2;
}

export const CACHE_TTL_MS = 7 * 864e5;   // 실패·투자 정보 재조회 주기

/**
 * 🔴 성공한 조회라도 **무기한 캐시하면 안 된다.**
 *    2024년 재무를 한 번 받아 두면, 2025년 감사보고서가 올라와도 평상시 실행은 조회하지 않아
 *    등급이 옛날 값에 영영 묶인다. 날짜 TTL은 공시 주기와 무관해 헛조회 또는 낡은 값을 만든다
 *    → **회계연도 기준으로 재검증한다.**
 *    실패도 영구 캐시하지 않는다 — 오늘 미등록이던 회사가 다음 달 감사보고서를 낸다.
 *
 * 🔴 투자 정보를 켠 동안에는 회계연도만으로 신선하다고 하면 안 된다.
 *    조달 공시는 **회계연도와 주기가 다르다** — 다음 달 유상증자가 올라와도 회계연도는 그대로다.
 *    그러면 새 조달이 영영 안 붙고 위험 등급이 그대로 굳는다.
 *
 * @param hit               캐시된 조회 결과
 * @param wantInvestment    투자 정보를 보는 중인가
 * @param now               기준 시각
 */
export function isCacheFresh(hit, { wantInvestment = false, now = Date.now() } = {}) {
  if (!hit) return false;
  const probedRecently = Boolean(hit.probedAt) && now - Date.parse(hit.probedAt) < CACHE_TTL_MS;
  // 필드 자체가 없으면 이 기능이 생기기 전에 만들어진 캐시다. 회계연도만 보면 영영 신선하다.
  if (wantInvestment && !Object.hasOwn(hit, 'investment')) return false;
  if (!hit.source) return probedRecently;                                  // 실패 → 7일 뒤 재조회
  const newest = Math.max(0, ...Object.keys(hit.byYear ?? {}).map(Number));
  if (newest >= expectedFiscalYear(new Date(now))) return wantInvestment ? probedRecently : true;
  return probedRecently;                                                   // 낡았다 → 7일에 한 번만
}
