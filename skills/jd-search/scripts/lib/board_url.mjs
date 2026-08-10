// 공고 주소 → 보드·ID.
//
// 🔴 **호스트를 정확히 본다.** `url.includes('wanted')` 같은 검사는
//    `https://evil.example.com/?x=wanted.co.kr/wd/123` 을 통과시킨다.
//    사용자가 붙여 넣는 값이 그대로 조회 대상이 되므로 여기서 막아야 한다.
// 🔴 못 읽으면 지어내지 않고 null 을 돌려준다. 틀린 ID로 조회하면 남의 공고가 목록에 들어온다.

const HOSTS = [
  {
    board: 'wanted',
    test: h => h === 'wanted.co.kr' || h.endsWith('.wanted.co.kr'),
    // /wd/123 · /jobs/123 · 쿼리스트링·해시가 붙어 있어도 읽는다
    id: u => (u.pathname.match(/\/(?:wd|jobs)\/(\d+)/) ?? [])[1] ?? null,
  },
  {
    board: 'saramin',
    test: h => h === 'saramin.co.kr' || h.endsWith('.saramin.co.kr'),
    // 상세 주소는 형태가 여럿이지만 식별자는 언제나 rec_idx 다
    id: u => {
      const q = u.searchParams.get('rec_idx');
      if (q && /^\d+$/.test(q)) return q;
      return (u.pathname.match(/\/rec_idx\/(\d+)/) ?? [])[1] ?? null;
    },
  },
];

export function parsePostingUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  for (const h of HOSTS) {
    if (!h.test(host)) continue;
    const id = h.id(u);
    return id ? { board: h.board, id } : null;
  }
  return null;
}

export const SUPPORTED_BOARDS = HOSTS.map(h => h.board);
