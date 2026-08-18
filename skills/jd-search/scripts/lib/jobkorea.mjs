// 잡코리아 공용 — **상세 전용**이다. 목록 수집기는 없다.
//
// 🔴 왜 목록이 없나 (2026-08-18 실측):
//    검색 결과가 React 로 그려져 **HTML 안에 없다.** 서버가 보내는 것은 광고·추천 공고뿐이고
//    (`m.jobkorea.co.kr` 모바일도 같다), 본 목록은 스크롤할 때 JS 가 받아 온다.
//    처음에 `GI_Read/<번호>` 링크 개수를 세고 "파싱 가능"이라고 적었던 것은 **그 광고 링크를 센 것**이었다.
//    → 목록은 사용자가 브라우저에서 열어 저장한 HTML 로 받는다 (`collect_saved.mjs`).
//      이 모듈은 거기서 나온 공고 주소로 **상세만** 읽는다.
//
// 🔴 상세는 CSS 클래스를 보지 않는다. 잡코리아는 schema.org **JSON-LD(JobPosting)** 를 심어 준다 —
//    표준 규격이라 화면을 갈아엎어도 살아남는다. 클래스 이름(`text-typo-b2-16` 류)은 빌드마다 바뀐다.
//
// 엔드포인트 (키 불필요)
//   상세  GET /Recruit/GI_Read/<id>
//         → <script type="application/ld+json"> JobPosting · og:title · og:description

import { request, HttpError, throttle } from './http.mjs';
import { saveJd } from './io.mjs';
import { stripTags } from './text.mjs';
import { parseRegion } from './region.mjs';

export const HOST = 'www.jobkorea.co.kr';
export const ORIGIN = `https://${HOST}`;
throttle.set(HOST, 1000);   // 🔴 공개 웹 요청 간 최소 1초. 병렬 순회 금지.

export const postingUrl = id => `${ORIGIN}/Recruit/GI_Read/${id}`;

const dec = s => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** 페이지 안의 JSON-LD 중 JobPosting 을 찾는다. 순수 함수. */
export function findJobPosting(html) {
  for (const m of String(html ?? '').matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (node && node['@type'] === 'JobPosting') return node;
      // @graph 로 감싸 오는 사이트가 있다. 한 겹만 더 본다.
      for (const g of node?.['@graph'] ?? []) if (g?.['@type'] === 'JobPosting') return g;
    }
  }
  return null;
}

/**
 * "경력 : 경력무관 , 학력 : 학력무관, 급여 : 연봉 3,400~3,600만원, 마감일 : 상시채용" → 항목별로 쪼갠다.
 *
 * 🔴 쉼표로 그냥 자르면 안 된다. **급여에 천 단위 쉼표가 들어 있어** `연봉 3` 에서 잘린다(실측).
 *    값은 "다음 `한글 :` 이 나오기 직전"까지다 — 자릿수 쉼표는 그 조건에 걸리지 않는다.
 */
export function parseMetaSummary(desc) {
  const out = {};
  for (const m of String(desc ?? '').matchAll(/([가-힣]+)\s*:\s*([^:]*?)(?=\s*,\s*[가-힣]+\s*:|$)/g)) {
    const v = m[2].trim();
    if (v) out[m[1]] = v;
  }
  return out;
}

/**
 * 상세 파싱.
 *
 * 🔴 **마감일이 지났다는 이유로 마감 처리하지 않는다** (다른 보드와 같은 규칙).
 *    잡코리아의 확실한 마감 신호는 아직 표본을 못 봤다 — 마감 안내 문구가 보일 때만 마감으로 두고,
 *    나머지는 `unverified` 로 남겨 check_alive 가 교차 확인하게 한다.
 */
export function parseDetail(html) {
  const h = String(html ?? '');
  const ld = findJobPosting(h) ?? {};
  const og = k => dec((h.match(new RegExp(`<meta[^>]+property="og:${k}"[^>]*content="([^"]*)"`)) ?? [])[1] ?? '');
  const summary = parseMetaSummary(og('description'));

  // og:title 은 "회사명 채용 - 공고제목 | 잡코리아" 모양이다.
  const ogTitle = og('title');
  const ogCompany = (ogTitle.match(/^(.*?)\s*채용\s*-\s*/) ?? [])[1] ?? null;
  const ogPosting = ogTitle.replace(/^.*?채용\s*-\s*/, '').replace(/\s*\|\s*잡코리아\s*$/, '').trim() || null;

  const address = ld.jobLocation?.address?.streetAddress
    ?? (Array.isArray(ld.jobLocation) ? ld.jobLocation[0]?.address?.streetAddress : null)
    ?? null;

  const dueLabel = summary['마감일'] ?? null;
  let dueKind = null;
  if (dueLabel && /상시/.test(dueLabel)) dueKind = 'always';
  else if (dueLabel && /채용시/.test(dueLabel)) dueKind = 'untilFilled';
  else if (ld.validThrough) dueKind = 'date';

  // 🔴 마감 안내가 화면에 떠 있을 때만 마감이다. 그 외에는 굳히지 않는다.
  const closed = /마감된\s*공고|채용이\s*마감|지원기간이\s*종료/.test(stripTags(h));

  return {
    title: ld.title ? dec(ld.title) : ogPosting,
    company: ld.hiringOrganization?.name ? dec(ld.hiringOrganization.name) : ogCompany,
    state: closed ? 'closed' : null,        // 🔴 null = 판정 보류 (추측하지 않는다)
    dueKind,
    dueLabel,
    dueTime: ld.validThrough ? String(ld.validThrough) : null,
    postedAt: ld.datePosted ?? null,
    areas: address ? [dec(address)] : [],
    careerLabel: summary['경력'] ?? (ld.experienceRequirements ? dec(ld.experienceRequirements) : null),
    educationLabel: summary['학력'] ?? (ld.educationRequirements ? dec(ld.educationRequirements) : null),
    employmentLabel: [].concat(ld.employmentType ?? []).join(', ') || null,
    salaryLabel: summary['급여'] ?? null,
    description: ld.description ? dec(ld.description) : null,
    hasJsonLd: Boolean(ld.title || ld.hiringOrganization?.name),
  };
}

/** 경력 표기 → 연차. 다른 보드와 같은 규칙. */
export function parseCareer(label) {
  const s = String(label ?? '').replace(/\s/g, '');
  if (!s) return { from: null, to: null };
  if (/무관/.test(s) || /^신입$/.test(s)) return { from: 0, to: null };
  const range = s.match(/(\d+)~(\d+)년/);
  if (range) return { from: Number(range[1]), to: Number(range[2]) };
  const up = s.match(/(\d+)년\s*(?:↑|이상)/);
  if (up) return { from: Number(up[1]), to: null };
  const down = s.match(/(\d+)년\s*(?:↓|이하)/);
  if (down) return { from: /신입/.test(s) ? 0 : null, to: Number(down[1]) };
  return { from: null, to: null };
}

/** 🔴 재택 여부는 추정이다. 확실할 때만 값을 넣는다. */
export function detectRemote(text) {
  const t = String(text ?? '');
  if (/풀\s?리모트|전면\s?재택|완전\s?재택|fully\s+remote|100%\s*remote|원격\s*근무\s*가능/i.test(t)) return 'full';
  if (/하이브리드|주\s*[1-4]\s*[회일]\s*(재택|출근)|재택\s*병행|hybrid/i.test(t)) return 'hybrid';
  return 'unknown';
}

export const jdMarkdown = (id, d) => [
  `# ${d.title ?? '(제목 없음)'}`,
  `- 회사: ${d.company ?? ''}`,
  `- 출처: ${postingUrl(id)}`,
  `- 근무지: ${d.areas.join(', ')}`,
  `- 경력: ${d.careerLabel ?? '?'}`,
  `- 학력: ${d.educationLabel ?? '?'}`,
  `- 고용형태: ${d.employmentLabel ?? '?'}`,
  `- 급여: ${d.salaryLabel ?? '?'}`,
  `- 마감: ${d.dueLabel ?? (d.dueTime ? String(d.dueTime).slice(0, 10) : '?')}`,
  `- 본문 형태: ${d.description ? '요약만' : '없음'}`,
  `- 수집: ${new Date().toISOString()}`,
  '',
  '## 상세요강',
  // 🔴 잡코리아 상세 본문은 대부분 이미지·iframe 이라 글자로 남길 수 있는 것은 JSON-LD 요약뿐이다.
  //    그 사실을 적어 둔다 — "받아 놨다"고 착각하면 공고가 내려간 뒤에야 빈 기록인 걸 알게 된다.
  d.description
    ? `${d.description}\n\n🔴 이것은 공고 원문이 아니라 잡코리아가 심어 둔 **요약**입니다. 원문은 위 주소에서 확인해 주십시오.`
    : '(본문을 글자로 받지 못했습니다. 위 주소에서 직접 확인해 주십시오.)',
].join('\n');

/** 목록이 없으므로 레코드는 상세 하나로 만든다. */
export function normalize(id, d, matched = []) {
  const career = parseCareer(d.careerLabel);
  const r = parseRegion(d.areas[0] ?? '');
  return {
    board: 'jobkorea',
    id: String(id),
    url: postingUrl(id),
    title: d.title,
    company: { name: d.company ?? '', industry: null, boardId: null },
    location: {
      label: r.sido ?? null,
      district: r.sigungu ?? null,
      full: d.areas[0] ?? null,
      lat: null, lng: null,          // 🔴 좌표를 주지 않는다. 지어내지 않는다.
      all: d.areas,
    },
    status: d.state === 'closed' ? 'closed' : 'active',
    // 🔴 마감 신호 표본을 아직 못 봤다 — 그 사실을 레코드에 남겨 check_alive 가 교차 확인하게 한다.
    aliveState: d.state ?? 'unverified',
    dueTime: d.dueTime ?? null,
    dueKind: d.dueKind,
    annualFrom: career.from,
    annualTo: career.to,
    jdKind: d.description ? 'summaryOnly' : 'empty',
    remote: detectRemote([d.title, d.description].filter(Boolean).join('\n')),
    tags: [],
    matchedKeywords: matched,
    collectedAt: new Date().toISOString(),
  };
}

/** 상세 조회. 🔴 네트워크 오류를 마감으로 굳히지 않는다. */
export async function fetchDetail(id) {
  try {
    const html = await request(postingUrl(id), { referer: `${ORIGIN}/` });
    const detail = parseDetail(html);
    if (!detail.title && !detail.company) return { unknown: true, error: '상세에서 공고 정보를 읽지 못함' };
    return { detail };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { gone: true };
    return { unknown: true, error: e.message };
  }
}

export async function toRecord(profile, id, matched) {
  const d = await fetchDetail(id);
  if (d.gone) return { gone: true };
  if (d.unknown) return { unknown: true, error: d.error };
  const rec = normalize(id, d.detail, matched);
  rec.jd = saveJd(profile, 'jobkorea', rec.id, jdMarkdown(id, d.detail));
  return { rec };
}
