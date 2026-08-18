// 사용자가 브라우저에서 **직접 열어 저장한 검색 결과 HTML** 에서 공고 주소만 뽑아낸다.
//
// 왜 이 경로가 있나:
//   잡코리아·잡플래닛·로켓펀치는 목록이 JS 로 그려져 서버 HTML 에 없고, 링크드인은 도구가 접속하면
//   🔴 **제재가 사용자 개인 계정에 온다.** 셋 다 "도구가 긁는다"로는 못 여는 보드다.
//   대신 사용자가 평소처럼 열어 본 페이지를 저장해 넣으면, 도구는 그 파일만 읽는다.
//
// 🔴 이 모듈은 **주소만** 뽑는다. 회사명·제목·마감은 저장본에서 긁지 않고
//    각 보드의 검증된 상세 파서가 다시 읽는다. 저장본의 화면 글자를 그대로 믿으면
//    보드가 화면을 바꾸는 순간 엉뚱한 값이 조용히 들어온다 — 그건 이 도구가 가장 경계하는 실패다.

import { parsePostingUrl } from './board_url.mjs';

/** 저장된 HTML 의 기준 주소. 상대 경로 링크를 절대 주소로 펴는 데 쓴다. */
export function baseUrlOf(html) {
  const h = String(html ?? '');
  const pick = re => (h.match(re) ?? [])[1] ?? null;
  const cand = pick(/<base[^>]+href=["']([^"']+)["']/i)
    ?? pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    ?? pick(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
    ?? pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
  try { return cand ? new URL(cand).origin + new URL(cand).pathname : null; } catch { return null; }
}

/**
 * 저장본 → 공고 주소 목록.
 *
 * 🔴 호스트 검사는 `board_url.mjs` 하나에서만 한다. 여기서 문자열 포함으로 다시 판단하면
 *    `evil.example.com/?x=wanted.co.kr/wd/1` 같은 주소가 통과한다 —
 *    사용자가 넣는 파일이 그대로 조회 대상이 되므로 그 검사를 우회할 수 없게 둔다.
 * 🔴 상대 경로는 **기준 주소를 알 때만** 편다. 모르면 버린다 — 호스트를 추측해 남의 공고를 받는 것보다 낫다.
 */
export function extractPostings(html) {
  const h = String(html ?? '');
  const base = baseUrlOf(h);
  const out = new Map();
  const skipped = { relativeNoBase: 0, unknownBoard: 0 };

  for (const m of h.matchAll(/<a[^>]+href=["']([^"'\s]+)["']/gi)) {
    const raw = m[1].replace(/&amp;/g, '&');
    let abs = raw;
    if (/^\/\//.test(raw)) abs = `https:${raw}`;
    else if (/^\//.test(raw)) {
      if (!base) { skipped.relativeNoBase++; continue; }
      try { abs = new URL(raw, base).href; } catch { continue; }
    } else if (!/^https?:/i.test(raw)) continue;

    const hit = parsePostingUrl(abs);
    if (!hit) { skipped.unknownBoard++; continue; }
    const key = `${hit.board}:${hit.id}`;
    if (!out.has(key)) out.set(key, { ...hit, url: abs });
  }
  return { postings: [...out.values()], base, skipped };
}

/**
 * 저장본이 어느 사이트인지 사람에게 보여 줄 한 줄. 판정에는 쓰지 않는다 —
 * 무엇을 수집할지는 언제나 주소(`parsePostingUrl`)가 정한다.
 */
export function describeSaved(html) {
  const h = String(html ?? '');
  const site = (h.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i) ?? [])[1]
    ?? (h.match(/<title[^>]*>([^<]{0,80})/i) ?? [])[1] ?? '';
  return site.replace(/\s+/g, ' ').trim();
}

/**
 * 🔴 링크드인이 들어 있는지. 들어 있으면 **수집하지 않고 그 이유를 말한다.**
 *    링크드인 공고 주소를 알아도 도구가 그 페이지를 받으면 안 되고(제재가 사용자 계정에 온다),
 *    저장본의 화면 글자만으로 레코드를 만들면 검증되지 않은 파서가 된다.
 *    → 지금은 "못 한다"고 말하는 것이 지어내는 것보다 낫다.
 */
export const hasLinkedIn = html => /linkedin\.com\/jobs\/view\/\d+/i.test(String(html ?? ''));
