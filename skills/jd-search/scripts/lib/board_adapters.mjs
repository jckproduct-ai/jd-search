// 공고 주소(보드 + id) 하나 → 저장 레코드. **보드를 가리는 자리는 여기 하나뿐이다.**
//
// 🔴 이 파일이 있는 이유: `add_posting`(주소 붙여넣기) 과 `collect_saved`(저장본에서 주소만 추출) 이
//    각자 보드 분기를 들고 있으면, 보드를 하나 추가할 때 한쪽만 고쳐진다.
//    그때 생기는 증상이 최악이다 — 예를 들어 `parsePostingUrl` 이 점핏 주소를 읽게 됐는데
//    `add_posting` 의 else 가지가 그걸 **사람인으로 조회**해 엉뚱한 공고를 넣는다.

import * as wanted from './wanted.mjs';
import * as saramin from './saramin.mjs';
import * as jumpit from './jumpit.mjs';
import * as incruit from './incruit.mjs';
import * as jobkorea from './jobkorea.mjs';

const ADAPTERS = {
  wanted: async (profile, id, matched) => {
    const d = await wanted.fetchDetail(id);
    if (d.gone) return { gone: true };
    if (d.unknown || !d.job) return { unknown: true, error: d.error ?? '상세를 읽지 못함' };
    return { rec: wanted.toRecord(profile, d.job, {}, matched) };
  },
  jumpit: async (profile, id, matched) => {
    const d = await jumpit.fetchDetail(id);
    if (d.gone) return { gone: true };
    if (d.unknown || !d.job) return { unknown: true, error: d.error ?? '상세를 읽지 못함' };
    return { rec: jumpit.toRecord(profile, d.job, {}, matched) };
  },
  saramin: (profile, id, matched) => saramin.toRecordById(profile, id, matched),
  incruit: (profile, id, matched) => incruit.toRecordById(profile, id, matched),
  jobkorea: (profile, id, matched) => jobkorea.toRecord(profile, id, matched),
};

/** 주소로 넣을 수 있는 보드 목록. 안내 문구가 이 값을 쓴다 — 손으로 적은 목록과 어긋나지 않게. */
export const ADDABLE_BOARDS = Object.keys(ADAPTERS);
export const canAdd = board => Object.hasOwn(ADAPTERS, board);

/**
 * @returns {{rec}|{gone:true}|{unknown:true,error}}
 * 🔴 모르는 보드는 조용히 다른 보드로 흘려보내지 않고 unknown 으로 돌려준다.
 */
export function recordFromId(profile, board, id, matched = []) {
  const fn = ADAPTERS[board];
  if (!fn) return Promise.resolve({ unknown: true, error: `지원하지 않는 보드: ${board}` });
  return fn(profile, String(id), matched);
}
