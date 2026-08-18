// 사람인 공용 — 수집(collect)과 마감 재확인(check_alive)이 **같은 경로**를 쓰게 한다.
//   원티드는 `lib/wanted.mjs`. 두 모듈은 같은 모양의 레코드를 돌려주지만
//   🔴 **판정 신호는 전혀 다르다.** 하나의 규칙으로 묶으려 하지 말 것.
//
// 왜 공개 웹 목록인가 (2026-08-10 CEO 확정):
//   오픈API `oapi.saramin.co.kr/job-search` 는 access-key를 요구한다. 그 키를 받으면
//   "필수 키 1개"라는 첫인상 약속이 깨진다 — commute를 착수하지 않기로 한 것과 같은 기준이다.
//   공개 검색 페이지는 키 없이 같은 정보를 준다.
//
// 엔드포인트 (키 불필요, 2026-08-10 실측)
//   목록  GET /zf_user/search/recruit?searchword=&recruitPage=&recruitPageCount=100[&loc_mcd=]
//   상세  GET /zf_user/jobs/relay/view-ajax?rec_idx=<id>   → 상태·마감일·근무지역·핵심정보 (74KB)
//   본문  GET /zf_user/jobs/relay/view-detail?rec_idx=<id>&rec_seq=0  → 상세요강 (35KB)
//         ※ `/zf_user/jobs/relay/view` 는 382KB인데 같은 정보뿐이다. 쓰지 않는다.
//
// 🔴 robots.txt 확인 (2026-08-10): 위 세 경로는 어느 Disallow에도 걸리지 않는다.
//    다만 사람인은 `GPTBot`·`Bytespider`를 전면 차단한다 — **자동 수집 자체를 반기지 않는다는 뜻**이다.
//    그래서 이 모듈은 사용자가 직접 열어볼 수 있는 페이지만, 요청 간 1초로, 본인 구직 목적에만 쓴다.
//    병렬 순회·백그라운드 상주·타인 대량 수집은 만들지 않는다.

import { request, HttpError, throttle } from './http.mjs';
import { saveJd } from './io.mjs';
import { stripTags } from './text.mjs';

export const HOST = 'www.saramin.co.kr';
export const ORIGIN = `https://${HOST}`;
throttle.set(HOST, 1000);   // 🔴 공개 웹 요청 간 최소 1초. 병렬 순회 금지.

export const postingUrl = id => `${ORIGIN}/zf_user/jobs/relay/view?rec_idx=${id}`;

const SEARCH = `${ORIGIN}/zf_user/search/recruit`;
const searchUrl = (q, page, { count = 100, locMcd = null } = {}) => `${SEARCH}?` + new URLSearchParams({
  search_area: 'main', search_done: 'y', search_optional_item: 'n',
  searchType: 'search', recruitSort: 'relation',
  searchword: q, recruitPage: String(page), recruitPageCount: String(count),
  ...(locMcd ? { loc_mcd: locMcd } : {}),
}).toString();

const dec = s => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// ── 목록 파싱 ────────────────────────────────────────────────────────────────

/**
 * 검색 결과 HTML → 항목 배열. 순수 함수 (fixture로 테스트한다).
 *
 * 🔴 목록의 마감 표기(`~ 09/20`)에는 **연도가 없다.** 여기서 연도를 추정하면
 *    12월→1월을 넘길 때 통째로 틀린다. 마감일은 상세에서 받은 것만 쓰고,
 *    목록 값은 `dueLabel`(상시채용·채용시 구분용)로만 남긴다.
 */
export function parseList(html) {
  const out = [];
  const blocks = String(html ?? '').split(/(?=<div class="item_recruit" value=")/).slice(1);
  for (const b of blocks) {
    const id = (b.match(/^<div class="item_recruit" value="(\d+)"/) ?? [])[1];
    if (!id) continue;

    // 제목은 `title=` 속성에서 뽑는다. 본문 <span> 쪽은 검색어가 <b>로 감싸여 들어온다.
    const title = dec((b.match(/<h2 class="job_tit">\s*<a[^>]*?\stitle="([^"]*)"/) ?? [])[1]);

    const corpBlock = (b.match(/<strong class="corp_name">([\s\S]*?)<\/strong>/) ?? [])[1] ?? '';
    const company = dec(stripTags(corpBlock));
    // csn = 사람인 회사 식별자(암호화 문자열). 회사 단위 재검색·병합에 쓴다.
    const csn = (b.match(/csn=([A-Za-z0-9%+/=]+)/) ?? [])[1] ?? null;

    // job_condition 의 첫 span 은 지역 링크(시·도 / 구), 나머지는 경력·학력·고용형태.
    const cond = (b.match(/<div class="job_condition">([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
    const spans = [...cond.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => dec(stripTags(m[1])));
    const areas = [...cond.matchAll(/area-recruit\/area-list\/area\/\d+[^>]*>([^<]+)<\/a>/g)].map(m => dec(m[1]));

    const dueLabel = dec((b.match(/<span class="date">([^<]*)<\/span>/) ?? [])[1]) || null;
    const sectors = [...b.matchAll(/job-category\?cat_kewd=\d+"[^>]*>([^<]+)<\/a>/g)].map(m => dec(m[1]));

    out.push({
      id, title, company, csn,
      // 첫 항목이 시·도, 둘째가 시·군·구다. 목록은 **대표 1곳만** 준다 — 다중 근무지는 상세에서 온다.
      sido: areas[0] ?? null,
      district: areas[1] ?? null,
      careerLabel: spans.find(s => /신입|경력|무관/.test(s)) ?? null,
      dueLabel, sectors,
      url: postingUrl(id),
    });
  }
  return out;
}

// ── 상세 파싱 ────────────────────────────────────────────────────────────────

/**
 * 🔴 마감 판정은 `<div class="status">` 블록 하나로만 한다. 실측 4형태:
 *      info_timer                 → 진행중 (마감일 있음)
 *      copy once "상시 채용"       → 진행중 (마감일 없음)
 *      copy once "채용시 마감"     → 진행중 (마감일 없음)
 *      copy end  "마감되었습니다"  → 마감
 *
 * 🔴 **날짜 경과로 마감을 판정하지 않는다.** 실측 목록 40건 중 9건(22%)이 상시채용·채용시라
 *    마감일 자체가 없고, 기간형도 연장이 흔하다. 원티드에서 `dueTime` 경과를 근거로
 *    쓰지 않기로 한 것과 같은 이유다.
 *
 * 🔴 신호가 서로 어긋나면(상태 블록은 진행인데 버튼은 접수마감) **unknown 으로 둔다.**
 *    추측으로 공고를 죽이지 않는다.
 */
export function parseDetail(html) {
  const h = String(html ?? '');
  const statusBlock = (h.match(/<div class="status">([\s\S]*?)<dl class="info_period">/) ?? [])[1] ?? '';

  let state = null, dueKind = null;
  if (/class="copy end"/.test(statusBlock) || /마감되었습니다/.test(statusBlock)) state = 'closed';
  else if (/class="info_timer"/.test(statusBlock)) { state = 'active'; dueKind = 'date'; }
  else if (/상시\s*채용/.test(statusBlock)) { state = 'active'; dueKind = 'always'; }
  else if (/채용시\s*마감/.test(statusBlock)) { state = 'active'; dueKind = 'untilFilled'; }

  // 지원 버튼으로 교차 확인. 어긋나면 판정을 포기한다.
  const expired = h.includes('sri_btn_expired_apply');
  const openBtn = h.includes('sri_btn_immediately');
  if (state === 'closed' && openBtn && !expired) state = null;
  if (state === 'active' && expired && !openBtn) state = null;

  const period = (h.match(/<dl class="info_period">([\s\S]*?)<\/dl>/) ?? [])[1] ?? '';
  const dueRaw = (period.match(/<dt[^>]*>\s*마감일\s*<\/dt>\s*<dd>([^<]*)<\/dd>/) ?? [])[1];
  const openRaw = (period.match(/<dt[^>]*>\s*시작일\s*<\/dt>\s*<dd>([^<]*)<\/dd>/) ?? [])[1];

  const dl = (label) => {
    const m = h.match(new RegExp(`<dt>\\s*${label}\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>`));
    return m ? dec(stripTags(m[1])) : null;
  };
  // 근무지역 <dd> 안에는 "지도보기" 버튼이 붙어 있다. 버튼 앞 텍스트만 쓴다.
  const areaRaw = (h.match(/<dt>\s*근무지역\s*<\/dt>\s*<dd>\s*([^<]*)/) ?? [])[1];

  // 상세에도 제목·회사·회사식별자가 있다. 목록 없이 주소만으로 추가할 때(add_posting) 이게 유일한 출처다.
  const title = dec(stripTags((h.match(/<h1 class="tit_job">([\s\S]*?)<\/h1>/) ?? [])[1] ?? '')) || null;
  const company = dec((h.match(/class="company"[^>]*>\s*([^<]+?)\s*</) ?? [])[1]
    ?? (h.match(/<a[^>]*\stitle="([^"]*)"[^>]*class="company"/) ?? [])[1] ?? '') || null;
  const csn = (h.match(/company-info\/view\?csn=([A-Za-z0-9%+/=]+)/) ?? [])[1] ?? null;

  return {
    title, company, csn,
    state,                                     // 'active' | 'closed' | null(판정 불가)
    dueKind,                                   // 'date' | 'always' | 'untilFilled' | null
    dueTime: toIso(dueRaw),
    openTime: toIso(openRaw),
    // 🔴 사람인은 근무지를 여러 곳 적을 수 있다("서울 강남구, 서초구, 대전 서구").
    //    목록은 첫 곳만 보여 준다 — 그것만 믿으면 다닐 수 있는 자리를 범위 밖으로 버린다.
    areas: splitAreas(areaRaw),
    careerLabel: dl('경력'),
    educationLabel: dl('학력'),
    employmentLabel: dl('근무형태'),
    salaryLabel: dl('급여'),
  };
}

/** "2026.09.20 23:59" → ISO. 형식이 다르면 원문을 버리지 않고 null 을 준다. */
function toIso(s) {
  const m = String(s ?? '').match(/(\d{4})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mm = '00'] = m;
  return `${y}-${mo}-${d}T${hh}:${mm}:00+09:00`;
}

/**
 * "서울 강남구, 서울전체, 서초구, 대전전체, 대전 서구" 를 시·도가 붙은 형태로 편다.
 * 🔴 `서초구`처럼 시·도가 생략된 항목은 **바로 앞 항목의 시·도를 물려받는다.**
 *    안 물려받으면 지역 판정이 "전국의 모든 서초구"가 되고, 하필 중·서·남·동·북·강서구가 그 함정이다.
 */
export function splitAreas(raw) {
  const SIDO = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
    '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
  const out = [];
  let cur = null;
  for (const part of String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const sido = SIDO.find(s => part === s || part.startsWith(`${s} `) || part === `${s}전체`);
    if (sido) {
      cur = sido;
      const rest = part.replace(new RegExp(`^${sido}\\s*`), '').replace(/^전체$/, '').trim();
      out.push(rest ? `${sido} ${rest}` : sido);
    } else if (cur) {
      out.push(`${cur} ${part}`);
    } else {
      out.push(part);                       // 시·도를 끝내 못 찾으면 원문 그대로 (판정은 unknown 이 된다)
    }
  }
  return [...new Set(out)];
}

/** 경력 표기 → 연차. "경력 5년 ↑" · "경력 3~5년" · "신입·경력" · "경력무관" */
export function parseCareer(label) {
  const s = String(label ?? '').replace(/\s/g, '');
  if (!s) return { from: null, to: null };
  if (/무관/.test(s) || /^신입$/.test(s)) return { from: 0, to: null };
  const range = s.match(/(\d+)~(\d+)년/);
  if (range) return { from: Number(range[1]), to: Number(range[2]) };
  const up = s.match(/(\d+)년\s*(?:↑|이상)/);
  if (up) return { from: Number(up[1]), to: null };
  const down = s.match(/(\d+)년\s*(?:↓|이하)/);
  // "신입·경력 3년 ↓" — 하한은 신입이다. 상한만 안다.
  if (down) return { from: /신입/.test(s) ? 0 : null, to: Number(down[1]) };
  if (/^신입·?경력/.test(s)) return { from: 0, to: null };
  return { from: null, to: null };
}

// ── 조회 ────────────────────────────────────────────────────────────────────

// 상세 조회 예산 규칙(D23·D24)은 보드가 공유한다 → `lib/budget.mjs`.
// 🔴 여기서 다시 내보내는 것은 이 모듈을 import 하던 자리(테스트 포함)를 깨지 않기 위해서다.
export { planDetailBudget } from './budget.mjs';

/**
 * 목록 조회. 🔴 사람인 검색은 형태소를 쪼개 확장해서 **"서비스기획" 한 단어에 10,685건**이 나온다.
 *    (따옴표 정확검색도 무효였다 — 실측 동일 건수)
 *    그래서 페이지 수 상한이 아니라 **제목 매치율이 바닥나는 지점**에서 멈춘다.
 *
 *    실측 감쇠 (2026-08-10, "서비스기획"):
 *      p1 95% · p2 95% · p3 88% · p4 31% · p5 2% · p6 0% · p7 4% · p8 13%
 *    → 4페이지째부터 잡음이고 5~6페이지에서 바닥을 친다. 그 뒤 몇 %는 영문 제목의 우연 일치다.
 *
 * @param isRelevant  제목이 내 직군인지 판정하는 함수. 이게 정지 조건을 만든다.
 * @returns {{items, pages, stoppedBy, rates}}  🔴 어디서 왜 멈췄는지 반드시 돌려준다.
 */
export async function listByQuery(q, isRelevant, { maxPages = 12, floor = 0.1, dryRounds = 2, count = 100, locMcd = null } = {}) {
  const found = new Map();
  const rates = [];
  let dry = 0, page = 0, stoppedBy = 'exhausted';

  for (page = 1; page <= maxPages; page++) {
    const html = await request(searchUrl(q, page, { count, locMcd }), { referer: SEARCH });
    const items = parseList(html);
    if (!items.length) { stoppedBy = 'noMoreResults'; break; }

    const hits = items.filter(it => isRelevant(it.title));
    for (const it of hits) if (!found.has(it.id)) found.set(it.id, it);
    const rate = hits.length / items.length;
    rates.push({ page, items: items.length, hits: hits.length, rate: Math.round(rate * 100) / 100 });

    // 🔴 관련도 바닥 = 정지 조건. 한 페이지만 보고 멈추면 목차 광고 한 장에 조기 종료한다.
    if (rate < floor) { if (++dry >= dryRounds) { stoppedBy = 'relevanceFloor'; break; } }
    else dry = 0;
    if (page === maxPages) stoppedBy = 'maxPages';
  }
  return { items: [...found.values()], pages: rates.length, stoppedBy, rates };
}

/**
 * 상세 조회.
 * @returns {{detail}|{gone:true}|{unknown:true,error}}
 * 🔴 네트워크 오류를 마감으로 굳히지 않는다.
 */
export async function fetchDetail(id) {
  try {
    const html = await request(`${ORIGIN}/zf_user/jobs/relay/view-ajax?rec_idx=${id}`, { referer: postingUrl(id) });
    const detail = parseDetail(html);
    // 사람인은 내려간 공고에도 200을 주는 일이 있다. 상태 블록 자체가 없으면 판정하지 않는다.
    if (!detail.state && !detail.dueTime && !detail.areas.length) return { unknown: true, error: '상세 응답에서 상태를 읽지 못함' };
    return { detail };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { gone: true };
    return { unknown: true, error: e.message };
  }
}

/**
 * 상세요강 본문 파싱. 순수 함수.
 *
 * 🔴 **사람인 공고의 상당수는 본문이 이미지 한 장이다.** 실측 4건 중 2건(50%)이
 *    글자가 "채용공고 상세" 7자뿐이었다. 그걸 그대로 저장하면 **내용이 있는 것처럼 보이는 빈 파일**이
 *    남고, 수집기는 "JD 원문이 있다"고 판단해 다시 받지도 않는다. 공고가 내려가면 그대로 영구 손실이다.
 *    → 글자가 없으면 **없다고 적고, 최소한 이미지 주소라도 남긴다.**
 */
export function parseBody(html) {
  const h = String(html ?? '');
  const text = stripTags(h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '))
    .replace(/^채용공고 상세\s*/, '').trim();
  const images = [...h.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
    .map(m => m[1].startsWith('//') ? `https:${m[1]}` : m[1])
    .filter(u => /^https?:/.test(u) && !/blank|spacer|icon|btn_/i.test(u));
  // 60자는 실측 경계다 — 글자 본문은 1,200자 이상이었고 이미지형은 7자였다.
  if (text.length >= 60) return { kind: 'text', text, images };
  if (images.length) return { kind: 'imageOnly', text, images };
  return { kind: 'empty', text, images };
}

/** 상세요강 본문. 🔴 공고는 마감되면 사라진다 — 받은 자리에서 저장한다. */
export async function fetchBody(id) {
  try {
    const html = await request(`${ORIGIN}/zf_user/jobs/relay/view-detail?rec_idx=${id}&rec_seq=0`, { referer: postingUrl(id) });
    return parseBody(html);
  } catch {
    return null;   // 조회 실패는 "본문이 이미지"와 다르다. null 로 구분해 다음 실행에 다시 받는다.
  }
}

/**
 * 🔴 본문이 없을 때 **없다고 적는다.** 빈 파일을 남기면 "내용이 있는 것처럼 보이는 기록"이 되고,
 *    수집기가 그걸 원문 확보로 세어 다시 받지 않는다.
 */
export const jdMarkdown = (item, d, body) => {
  const kind = body?.kind ?? 'failed';
  const tail = {
    text: [body?.text ?? ''],
    imageOnly: [
      '🔴 이 공고의 상세요강은 **이미지로만** 되어 있어 글자로 남길 수 없습니다.',
      '   공고가 내려가면 아래 이미지도 함께 사라질 수 있으니, 필요하면 지금 열어서 저장해 두십시오.',
      '',
      ...(body?.images ?? []).map((u, i) => `${i + 1}. ${u}`),
    ],
    empty: ['(상세요강 영역이 비어 있었습니다. 공고 본문이 원래 없거나 형식이 바뀌었을 수 있습니다.)'],
    failed: ['(본문을 받지 못했습니다 — 다음 실행에서 다시 시도합니다.)'],
  }[kind];

  return [
    `# ${item.title}`,
    `- 회사: ${item.company}`,
    `- 출처: ${item.url}`,
    `- 근무지: ${(d?.areas ?? []).join(', ') || [item.sido, item.district].filter(Boolean).join(' ')}`,
    `- 경력: ${d?.careerLabel ?? item.careerLabel ?? '?'}`,
    `- 학력: ${d?.educationLabel ?? '?'}`,
    `- 근무형태: ${d?.employmentLabel ?? '?'}`,
    `- 급여: ${d?.salaryLabel ?? '?'}`,
    `- 마감: ${d?.dueTime ? d.dueTime.slice(0, 10) : (item.dueLabel ?? '?')}`,
    `- 본문 형태: ${{ text: '글자', imageOnly: '이미지만', empty: '없음', failed: '조회 실패' }[kind]}`,
    `- 수집: ${new Date().toISOString()}`,
    '',
    '## 상세요강',
    ...tail,
  ].join('\n');
};

/** 🔴 재택 여부는 추정이다. 확실할 때만 값을 넣는다. wanted.mjs 와 같은 규칙을 쓴다. */
export function detectRemote(text) {
  const t = String(text ?? '');
  if (/풀\s?리모트|전면\s?재택|완전\s?재택|fully\s+remote|100%\s*remote|원격\s*근무\s*가능/i.test(t)) return 'full';
  if (/하이브리드|주\s*[1-4]\s*[회일]\s*(재택|출근)|재택\s*병행|hybrid/i.test(t)) return 'hybrid';
  return 'unknown';
}

/** 목록 항목 + 상세 → 저장 레코드. wanted.normalize 와 같은 모양이어야 뒤 단계가 보드를 안 가린다. */
export function normalize(item, d = {}, matched = [], body = null) {
  const career = parseCareer(d.careerLabel ?? item.careerLabel);
  const areas = d.areas?.length ? d.areas : [[item.sido, item.district].filter(Boolean).join(' ')].filter(Boolean);
  return {
    board: 'saramin',
    id: String(item.id),
    url: item.url,
    title: item.title,
    company: { name: item.company, industry: null, boardId: item.csn ?? null },
    location: {
      label: item.sido ?? null,
      district: item.district ?? null,
      full: areas[0] ?? null,
      // 🔴 사람인은 좌표를 주지 않는다(원티드와 다르다). 없는 값을 지어내지 않는다.
      lat: null, lng: null,
      // 🔴 다중 근무지는 여기에 전부 남긴다. 게이트가 하나라도 걸리면 통과시킨다.
      all: areas,
    },
    status: d.state === 'closed' ? 'closed' : 'active',
    aliveState: d.state ?? 'unknown',
    dueTime: d.dueTime ?? null,
    dueKind: d.dueKind ?? null,
    annualFrom: career.from,
    annualTo: career.to,
    // 🔴 본문이 이미지뿐이면 재택 여부를 판단할 글자가 없다. 없는 근거로 추정하지 않는다.
    jdKind: body?.kind ?? 'failed',
    remote: detectRemote([item.title, d.employmentLabel, body?.text].filter(Boolean).join('\n')),
    tags: item.sectors ?? [],
    matchedKeywords: matched,
    collectedAt: new Date().toISOString(),
  };
}

/** 상세·본문까지 받아 레코드로 만들고 JD 원문을 저장한다. collect와 check_alive가 반드시 이걸 쓴다. */
export async function toRecord(profile, item, matched) {
  const d = await fetchDetail(item.id);
  if (d.gone) return { gone: true };
  if (d.unknown) return { unknown: true, error: d.error };
  const body = await fetchBody(item.id);
  const rec = normalize(item, d.detail, matched, body);
  rec.jd = saveJd(profile, 'saramin', rec.id, jdMarkdown(item, d.detail, body));
  return { rec };
}

/**
 * 🔴 **목록 항목 없이 id 만으로** 레코드를 만든다 (손으로 주소를 넣을 때·저장본에서 주소만 뽑았을 때).
 *    상세에서 읽히는 것만 채우고 **모르는 값은 비워 둔다.** 지어내지 않는다.
 *
 *    add_posting 과 collect_saved 가 각자 이 조립을 하고 있으면, 한쪽만 고쳐졌을 때
 *    같은 공고가 경로에 따라 다른 모양으로 저장된다. 그래서 여기 하나로 모은다.
 */
export async function toRecordById(profile, id, matched = []) {
  const d = await fetchDetail(id);
  if (d.gone) return { gone: true };
  if (d.unknown) return { unknown: true, error: d.error };
  const item = {
    id: String(id), url: postingUrl(id),
    title: d.detail.title ?? `(제목 미상) ${id}`,
    company: d.detail.company ?? '', csn: d.detail.csn ?? null,
    sido: null, district: null, careerLabel: d.detail.careerLabel, dueLabel: null, sectors: [],
  };
  const body = await fetchBody(id);
  const rec = normalize(item, d.detail, matched, body);
  rec.jd = saveJd(profile, 'saramin', rec.id, jdMarkdown(item, d.detail, body));
  return { rec };
}
