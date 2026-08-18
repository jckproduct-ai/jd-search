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
    // 🔴 **사람인보다 먼저 본다.** 점핏 호스트는 `jumpit.saramin.co.kr` 이라
    //    사람인 규칙(`.saramin.co.kr` 로 끝남)에 먼저 걸린다. 순서가 곧 판정이다.
    board: 'jumpit',
    test: h => h === 'jumpit.saramin.co.kr',
    id: u => (u.pathname.match(/\/position\/(\d+)/) ?? [])[1] ?? null,
  },
  {
    board: 'saramin',
    // 🔴 점핏 호스트를 여기서도 한 번 더 막는다. 위 순서에 기대기만 하면
    //    누군가 배열을 정렬하는 순간 점핏 주소가 사람인으로 읽힌다.
    test: h => h !== 'jumpit.saramin.co.kr' && (h === 'saramin.co.kr' || h.endsWith('.saramin.co.kr')),
    // 상세 주소는 형태가 여럿이지만 식별자는 언제나 rec_idx 다
    id: u => {
      const q = u.searchParams.get('rec_idx');
      if (q && /^\d+$/.test(q)) return q;
      return (u.pathname.match(/\/rec_idx\/(\d+)/) ?? [])[1] ?? null;
    },
  },
  {
    board: 'jobkorea',
    test: h => h === 'jobkorea.co.kr' || h.endsWith('.jobkorea.co.kr'),
    // PC·모바일 모두 /Recruit/GI_Read/<번호> 를 쓴다
    id: u => (u.pathname.match(/\/Recruit\/GI_Read\/(\d+)/i) ?? [])[1] ?? null,
  },
  {
    board: 'incruit',
    test: h => h === 'incruit.com' || h.endsWith('.incruit.com'),
    // 상세 주소의 식별자는 언제나 job 파라미터다
    id: u => {
      const q = u.searchParams.get('job');
      return q && /^\d+$/.test(q) ? q : null;
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
