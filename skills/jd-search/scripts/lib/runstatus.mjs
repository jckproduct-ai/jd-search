// 실행 기록(`postings.json` 의 `runs`) → 사람이 읽는 실패 요약.
//
// 🔴 gate 와 render 가 **같은 문구**를 쓰게 하려고 여기 하나로 모았다.
//    둘이 따로 만들면 콘솔은 "차단"이라 하고 리포트는 "조회 실패"라고 하는 일이 생긴다.
//
// 🔴 순수 함수만 둔다. #66 에서 "스크립트 본문의 console.log 는 테스트가 못 문다"고 적어 놓고
//    같은 자리에 규칙을 또 둘 수는 없다 — 판정 규칙은 전부 테스트가 무는 자리에 있어야 한다.

import { kindOfStatus, diagnose } from './http.mjs';

export const BOARD_LABEL = {
  wanted: '원티드', saramin: '사람인', jumpit: '점핏', incruit: '인크루트',
  jobkorea: '잡코리아', saved: '저장본',
};
export const boardLabel = b => BOARD_LABEL[b] ?? b;

/**
 * 🔴 **수집기가 실제로 있는 보드.** render·serve 가 각자 배열 리터럴을 들고 있다가
 *    보드를 하나 추가하면 한 화면에서만 "아직 수집하지 않았습니다"가 뜨는 자리였다.
 *    `profile.yml` 의 sources 에는 아직 수집기가 없는 보드도 적혀 있어서 그대로 쓰면 안 된다.
 */
// 🔴 잡코리아는 여기 없다 — **목록 수집기가 없기 때문이다**(검색 결과가 JS 로 그려져 HTML 에 없다).
//    주소를 알면 상세는 읽는다(`add_posting` · `collect_saved`). 여기에 넣으면
//    "아직 수집하지 않았습니다" 경고가 영원히 떠 있게 된다 — 돌릴 수집기가 없으니 지울 방법이 없다.
export const IMPLEMENTED_BOARDS = ['wanted', 'saramin', 'jumpit', 'incruit'];

/**
 * 🔴 보드별 실행 기록을 꺼내는 자리도 하나로 모은다.
 *    `lastRun` 은 보드가 하나뿐이던 시절의 옛 필드다 — 세 스크립트가 각자 풀어 쓰다
 *    한 곳만 고쳐지면 어떤 화면에서는 경고가 통째로 사라진다.
 */
export const runsOf = store => ({
  ...(store?.runs ?? {}),
  ...(store?.lastRun ? { [store.lastRun.board ?? 'wanted']: store.lastRun } : {}),
});

/** 옛 기록에는 kind 가 없다. 남아 있는 것은 `HTTP 403 — …` 같은 문자열뿐이라 거기서 되살린다. */
export function kindFromRecord(q) {
  if (q?.kind) return { kind: q.kind, status: q.status ?? null };
  const m = /HTTP (\d{3})/.exec(String(q?.error ?? ''));
  if (m) { const status = Number(m[1]); return { kind: kindOfStatus(status), status }; }
  return { kind: 'unknown', status: null };
}

/**
 * @param {object} runs   보드별 실행 기록 { saramin: manifest, wanted: manifest }
 * @param {(board:string)=>string} labelOf
 * @returns {{everRan:boolean, failures:Array, truncations:Array, hints:string[], blocked:boolean}}
 */
export function summarizeRuns(runs, labelOf = boardLabel) {
  const failures = [], truncations = [], hints = [];
  let everRan = false;

  for (const [board, run] of Object.entries(runs ?? {})) {
    if (!run) continue;
    everRan = true;
    for (const q of run.queries ?? []) {
      if (q.ok && !q.truncated) continue;
      if (q.ok) {
        truncations.push({ board, query: q.query, found: q.found ?? 0,
          text: `${labelOf(board)} "${q.query}" — ${q.found ?? 0}건에서 잘림` });
        continue;
      }
      const { kind, status } = kindFromRecord(q);
      const label = q.label ?? diagnose({ status, kind, message: q.error }).label;
      const hint = q.hint ?? diagnose({ status, kind, message: q.error }).hint;
      failures.push({ board, query: q.query, kind, status, label,
        text: `${labelOf(board)} "${q.query}" — ${label}` });
      if (hint && !hints.includes(hint)) hints.push(hint);
    }
    const t = run.detailTruncated;
    if (t) {
      // 🔴 "못 받은 건수"를 앞에 놓는다. 사용자가 알아야 하는 것은 받은 양이 아니라 **남은 양**이다.
      //    pending 이 없는 옛 기록은 seen-fetched 로 대신한다(그때는 캐시분을 구분하지 않았다).
      const pending = t.pending ?? Math.max(0, t.seen - t.fetched);
      truncations.push({ board, detail: true, pending,
        text: `${labelOf(board)} — 목록 ${t.seen}건 중 상세를 못 받은 것이 ${pending}건 남았습니다`
          + ` (이번에 ${t.fetched}건 받음, --max ${t.max})` });
    }
  }

  return { everRan, failures, truncations, hints, blocked: failures.some(f => f.kind === 'blocked' || f.kind === 'proxyBlocked') };
}
