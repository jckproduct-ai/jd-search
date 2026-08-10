// 연차 분류 — 공고를 **버리지 않고 목록만 나눈다**.
//
// 🔴 태그 이름은 내 연차 기준의 **상대 표현**이어야 한다.
//    `junior`/`senior` 같은 절대 표현을 쓰면 2년차에게 신입 공고가 "주니어 공고"로 찍힌다 —
//    그 사람에게는 그냥 맞는 공고다. belowMyLevel/aboveMyLevel 은 누가 쓰든 같은 뜻이 된다.
//
// 🔴 요구경력 하한(floor)에 기본값을 두지 않는다. 안 정한 사람에게는 아무 태그도 붙이지 않는다.
//    기본값을 두면 신입이 템플릿을 복사했을 때 목록의 대부분이 "따로 모음"으로 빠져
//    정작 봐야 할 공고가 안 보인다. 시니어 한 명을 기준으로 만든 도구가 되는 지점이 여기다.

/** 표시용 한글 라벨. 이미 상대 표현이라 그대로 쓴다. */
export const EXPERIENCE_TAG_LABEL = {
  belowMyLevel: '요구경력 낮음',
  aboveMyLevel: '요구경력 높음',
};

/**
 * @param {{years?: number|null, acceptExperienceFloor?: number|null}} target 내 프로필
 * @param {number|null} annualFrom 공고가 요구하는 경력 하한(년). 경력무관·신입이면 0.
 * @returns {string[]} 붙일 태그. 해당 없으면 빈 배열.
 */
export function experienceTags(target = {}, annualFrom) {
  const tags = [];
  if (annualFrom == null) return tags;   // 공고가 연차를 안 적었으면 판정하지 않는다
  const { years, acceptExperienceFloor: floor } = target;
  if (floor != null && annualFrom < floor) tags.push('belowMyLevel');
  if (years != null && annualFrom > years) tags.push('aboveMyLevel');
  return tags;
}
