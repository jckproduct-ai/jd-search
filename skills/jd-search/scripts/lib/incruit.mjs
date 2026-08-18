// 인크루트 공용 — 수집(collect)과 마감 재확인(check_alive)이 **같은 경로**를 쓰게 한다.
//   원티드 `lib/wanted.mjs` · 사람인 `lib/saramin.mjs` · 점핏 `lib/jumpit.mjs`.
//   레코드 모양은 같지만 🔴 **마감 신호는 보드마다 다르다.** 하나의 규칙으로 묶지 말 것.
//
// 🔴 **인크루트는 EUC-KR 로 내려준다** (2026-08-18 실측). UTF-8 로 읽으면 회사명·제목이
//    통째로 깨진 글자가 되는데, **아무 오류도 나지 않아** 그대로 저장되고 리포트에 실린다.
//    그래서 이 모듈의 모든 요청은 `charset: 'euc-kr'` 을 붙인다.
//
// 엔드포인트 (키 불필요, 2026-08-18 실측)
//   목록  GET /jobdb_list/searchjob.asp?kw=<kw>&page=<n>&articlecount=60
//         → <ul class="c_row" jobno="..."> 블록. 한 페이지 60건.
//   상세  GET /jobdb_info/jobpost.asp?job=<jobno>
//         → <strong class="dday ing"> 진행 표시 · <ul class="jc_list"> 핵심정보 · meta description 접수기간

import { request, HttpError, throttle } from './http.mjs';
import { saveJd } from './io.mjs';
import { stripTags } from './text.mjs';
import { parseRegion } from './region.mjs';

export const HOST = 'job.incruit.com';
export const ORIGIN = `https://${HOST}`;
throttle.set(HOST, 1000);   // 🔴 공개 웹 요청 간 최소 1초. 병렬 순회 금지.

export const postingUrl = id => `${ORIGIN}/jobdb_info/jobpost.asp?job=${id}`;
const SEARCH = `${ORIGIN}/jobdb_list/searchjob.asp`;
const searchUrl = (q, page, { count = 60 } = {}) => `${SEARCH}?` + new URLSearchParams({
  kw: q, page: String(page), articlecount: String(count), ty: '1',
}).toString();

const dec = s => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const get = (url, opts = {}) => request(url, { charset: 'euc-kr', ...opts });

// ── 목록 파싱 ────────────────────────────────────────────────────────────────

/**
 * 검색 결과 HTML → 항목 배열. 순수 함수 (fixture 로 테스트한다).
 *
 * 🔴 광고·추천 블록(`cPrdlists_*`)은 **본 목록이 아니다.** 잡코리아를 "파싱 가능"으로 잘못 적었던 것이
 *    정확히 이 착각이었다 — 광고 링크를 세고 목록이 있다고 판단했다.
 *    그래서 여기서는 `<ul class="c_row" jobno="…">` 만 본다. 광고 블록에는 이 구조가 없다.
 */
export function parseList(html) {
  const out = [];
  const blocks = String(html ?? '').split(/(?=<ul class="c_row"\s)/).slice(1);
  for (const b of blocks) {
    const id = (b.match(/^<ul class="c_row"\s+jobno="(\d+)"/) ?? [])[1];
    if (!id) continue;

    const companyA = b.match(/<a href="https?:\/\/www\.incruit\.com\/company\/(\d+)"[^>]*class="cpname"[^>]*>([\s\S]*?)<\/a>/);
    const titleA = b.match(/<a[^>]+href="[^"]*jobpost\.asp\?job=\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/);

    const mid = (b.match(/<div class="cell_mid">([\s\S]*?)<div class="cell_last">/) ?? [])[1] ?? b;
    const cond = (mid.match(/<div class="cl_md">([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
    const spans = [...cond.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => dec(stripTags(m[1]))).filter(Boolean);
    const sectorBlock = (mid.match(/<div class="cl_btm[^"]*">([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
    const sectors = [...sectorBlock.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)]
      .map(m => dec(stripTags(m[1])).replace(/,$/, '')).filter(Boolean);

    const last = (b.match(/<div class="cell_last">([\s\S]*?)<\/ul>/) ?? [])[1] ?? '';
    const lastSpans = [...last.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => dec(stripTags(m[1]))).filter(Boolean);

    out.push({
      id,
      title: dec(stripTags(titleA?.[1] ?? '')),
      company: dec(stripTags(companyA?.[2] ?? '')),
      // 인크루트 회사 식별자 = /company/<번호>. 회사 단위 재검색·병합에 쓴다.
      companyId: companyA?.[1] ?? null,
      // 🔴 첫 span 이 지역이라는 보장은 없다. 모양으로 골라낸다 —
      //    자리로 집으면 학력이 빠진 공고에서 한 칸씩 밀린다.
      areaLabel: spans.find(s => /(특별시|광역시|도|시|군|구)\b|^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(s)) ?? null,
      careerLabel: spans.find(s => /신입|경력|무관/.test(s)) ?? null,
      educationLabel: spans.find(s => /졸|학력/.test(s)) ?? null,
      employmentLabel: spans.find(s => /정규직|계약직|인턴|파견|프리랜서|아르바이트/.test(s)) ?? null,
      sectors,
      // 🔴 목록의 마감 표기에는 연도가 없다(`~08.29`). 연도를 추정하면 12월→1월에서 통째로 틀린다.
      //    상시·채용시 구분에만 쓰고, 날짜는 상세에서 받은 것만 쓴다.
      dueLabel: lastSpans[0] ?? null,
      url: postingUrl(id),
    });
  }
  return out;
}

// ── 상세 파싱 ────────────────────────────────────────────────────────────────

/**
 * 🔴 마감 판정은 `<strong class="dday …">` 의 **클래스**로 한다. 실측에서 진행중은 `dday ing` 였다.
 *    🔴 **마감 표본을 아직 확보하지 못했다.** 그래서 `ing` 가 아니면 마감으로 굳히지 않고
 *    `null`(판정 불가)로 둔다 — 추측으로 공고를 죽이지 않는다. 대신 지원 버튼으로 교차 확인한다.
 * 🔴 접수기간 날짜가 지났다는 이유로도 마감 처리하지 않는다(사람인·점핏과 같은 규칙).
 */
export function parseDetail(html) {
  const h = String(html ?? '');
  const dday = h.match(/<strong class="dday\s*([^"]*)">([\s\S]*?)<\/strong>/);
  const ddayClass = dec(dday?.[1] ?? '');
  const ddayText = dec(stripTags(dday?.[2] ?? ''));
  const hasApply = /id="btnLayerApply"|class="[^"]*btn_jobapp/.test(h);

  let state = null, dueKind = null;
  if (/\bing\b/.test(ddayClass)) state = 'active';
  else if (/\b(end|close|closed|finish)\b/.test(ddayClass)) state = 'closed';
  if (state === 'active' && /채용시/.test(ddayText)) dueKind = 'untilFilled';
  else if (state === 'active' && /상시/.test(ddayText)) dueKind = 'always';
  else if (state === 'active') dueKind = 'date';
  // 신호가 어긋나면 판정을 포기한다.
  if (state === 'active' && !hasApply) state = null;

  // 접수기간은 meta description 에 "접수기간: 2026.08.11 ~ 2026.09.10" 으로 들어 있다.
  const period = h.match(/접수기간:\s*(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{4})\.(\d{2})\.(\d{2})/);

  // 🔴 `<ul class="jc_list">…</ul>` 를 통째로 잘라 쓰면 안 된다. 근무지역 칸 안에 **중첩된 `<ul>`**
  //    (여러 근무지를 담는 `layer_more`)이 있어서 비탐욕 매칭이 거기서 끝나고,
  //    그 뒤에 오는 학력·급여가 통째로 null 이 된다 — 오류는 안 나고 값만 조용히 빈다(실측 확인).
  //    그래서 문서 전체에서 `tt`/`txt` 구조를 그대로 요구해 찾는다.
  const field = label => {
    const m = h.match(new RegExp(
      `<div class="tt">\\s*<em>\\s*${label}\\s*</em>\\s*</div>\\s*<div class="txt">([\\s\\S]*?)</div>`));
    return m ? dec(stripTags(m[1])) : null;
  };

  // 🔴 근무지가 여러 곳이면 `layer_more` 안에 전부 들어 있다. 대표 한 곳만 보면
  //    다닐 수 있는 자리를 범위 밖으로 버린다(사람인에서 겪은 것과 같은 실패다).
  const more = (h.match(/근무지역[\s\S]*?<div class="layer_more">([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
  const areas = [...more.matchAll(/<li>([\s\S]*?)(?:<\/li>|<li>|$)/g)]
    .map(m => dec(stripTags(m[1])).replace(/\s*>\s*/g, ' ').trim()).filter(Boolean);
  const areaOne = (field('근무지역') ?? '').replace(/\s*>\s*/g, ' ').trim();

  const ogTitle = dec((h.match(/<meta[^>]+property="og:title"[^>]*content="([^"]*)"/) ?? [])[1] ?? '');
  const [companyPart, ...rest] = ogTitle.split(',');
  const title = rest.join(',').replace(/\s*:\s*인크루트 채용\s*$/, '').trim() || null;

  return {
    title: title || dec(stripTags((h.match(/<h1>([\s\S]*?)<\/h1>/) ?? [])[1] ?? '')) || null,
    company: companyPart?.trim() || null,
    // 🔴 첫 `company/<번호>` 를 집으면 **다른 회사가 붙는다.** 상세 페이지에는 광고·추천 회사 링크가
    //    앞쪽에 먼저 나온다(실측: 목록은 1000000001 인데 첫 매칭은 9000000001 이었다).
    //    회사 식별자는 재무 조회·회사 단위 재검색의 키라서 틀리면 남의 회사 재무가 붙는다.
    //    → 공고 머리의 기업명 링크(`공고명상단 기업명`)로 자리를 못 박는다.
    companyId: (h.match(/<a[^>]+company\/(\d+)[^>]*공고명상단[^>]*>/) ?? [])[1] ?? null,
    state,                                    // 'active' | 'closed' | null(판정 불가)
    dueKind,                                  // 'date' | 'always' | 'untilFilled' | null
    dueLabel: ddayText || null,
    dueTime: period ? `${period[4]}-${period[5]}-${period[6]}T23:59:00+09:00` : null,
    openTime: period ? `${period[1]}-${period[2]}-${period[3]}T00:00:00+09:00` : null,
    areas: [...new Set(areas.length ? areas : (areaOne ? [areaOne] : []))],
    careerLabel: field('경력'),
    educationLabel: field('학력'),
    employmentLabel: field('고용형태'),
    salaryLabel: field('급여'),
  };
}

/**
 * 상세요강 본문. 🔴 인크루트도 본문이 이미지 한 장인 공고가 있다.
 *    글자가 없는데 원문 파일을 만들면 "내용이 있는 것처럼 보이는 빈 기록"이 되고,
 *    수집기가 그걸 원문 확보로 세어 다시 받지 않는다 — 공고가 내려가면 영구 손실이다.
 */
export function parseBody(html) {
  const h = String(html ?? '');
  const area = (h.match(/<div[^>]+id="[^"]*(?:jobpost_contents|detailContents|contentsArea)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i) ?? [])[1]
    ?? (h.match(/<div class="jobpost_cont[^"]*">([\s\S]*?)<div class="jobpost_bottom/i) ?? [])[1]
    ?? h;
  const text = stripTags(area.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')).trim();
  const images = [...area.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
    .map(m => (m[1].startsWith('//') ? `https:${m[1]}` : m[1]))
    .filter(u => /^https?:/.test(u) && !/blank|spacer|icon|btn_|logo/i.test(u));
  if (text.length >= 60) return { kind: 'text', text, images };
  if (images.length) return { kind: 'imageOnly', text, images };
  return { kind: 'empty', text, images };
}

/** 경력 표기 → 연차. "경력 8년↑" · "경력 3~5년" · "신입·경력" · "경력무관" */
export function parseCareer(label) {
  const s = String(label ?? '').replace(/\s|&nbsp;/g, '');
  if (!s) return { from: null, to: null };
  if (/무관/.test(s) || /^신입$/.test(s)) return { from: 0, to: null };
  const range = s.match(/(\d+)~(\d+)년/);
  if (range) return { from: Number(range[1]), to: Number(range[2]) };
  const up = s.match(/(\d+)년\s*(?:↑|이상)/);
  if (up) return { from: Number(up[1]), to: null };
  const down = s.match(/(\d+)년\s*(?:↓|이하)/);
  if (down) return { from: /신입/.test(s) ? 0 : null, to: Number(down[1]) };
  if (/^신입·?경력/.test(s)) return { from: 0, to: null };
  return { from: null, to: null };
}

// ── 조회 ────────────────────────────────────────────────────────────────────

/**
 * 목록 조회. 🔴 인크루트 검색도 넓게 잡는다 — 사람인과 같은 방식으로
 *    **제목 매치율이 바닥나는 지점**에서 멈추고, 어디서 왜 멈췄는지 돌려준다.
 */
export async function listByQuery(q, isRelevant = () => true, { maxPages = 10, floor = 0.1, dryRounds = 2, count = 60 } = {}) {
  const found = new Map();
  const rates = [];
  let dry = 0, stoppedBy = 'exhausted';

  for (let page = 1; page <= maxPages; page++) {
    const html = await get(searchUrl(q, page, { count }), { referer: SEARCH });
    const items = parseList(html);
    if (!items.length) { stoppedBy = 'noMoreResults'; break; }

    const hits = items.filter(it => isRelevant(it.title));
    for (const it of hits) if (!found.has(it.id)) found.set(it.id, it);
    const rate = hits.length / items.length;
    rates.push({ page, items: items.length, hits: hits.length, rate: Math.round(rate * 100) / 100 });

    if (rate < floor) { if (++dry >= dryRounds) { stoppedBy = 'relevanceFloor'; break; } }
    else dry = 0;
    if (items.length < count) { stoppedBy = 'exhausted'; break; }
    if (page === maxPages) stoppedBy = 'maxPages';
  }
  return { items: [...found.values()], pages: rates.length, stoppedBy, rates };
}

/** 상세 조회. 🔴 네트워크 오류를 마감으로 굳히지 않는다. */
export async function fetchDetail(id) {
  try {
    const html = await get(postingUrl(id), { referer: SEARCH });
    const detail = parseDetail(html);
    if (!detail.state && !detail.dueTime && !detail.areas.length) {
      return { unknown: true, error: '상세 응답에서 상태를 읽지 못함' };
    }
    return { detail, html };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { gone: true };
    return { unknown: true, error: e.message };
  }
}

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
    `# ${d?.title ?? item.title}`,
    `- 회사: ${d?.company ?? item.company}`,
    `- 출처: ${item.url}`,
    `- 근무지: ${(d?.areas ?? []).join(', ') || (item.areaLabel ?? '')}`,
    `- 경력: ${d?.careerLabel ?? item.careerLabel ?? '?'}`,
    `- 학력: ${d?.educationLabel ?? item.educationLabel ?? '?'}`,
    `- 고용형태: ${d?.employmentLabel ?? item.employmentLabel ?? '?'}`,
    `- 급여: ${d?.salaryLabel ?? '?'}`,
    `- 마감: ${d?.dueTime ? d.dueTime.slice(0, 10) : (d?.dueLabel ?? item.dueLabel ?? '?')}`,
    `- 본문 형태: ${{ text: '글자', imageOnly: '이미지만', empty: '없음', failed: '조회 실패' }[kind]}`,
    `- 수집: ${new Date().toISOString()}`,
    '',
    '## 상세요강',
    ...tail,
  ].join('\n');
};

/** 🔴 재택 여부는 추정이다. 확실할 때만 값을 넣는다. 다른 보드와 같은 규칙을 쓴다. */
export function detectRemote(text) {
  const t = String(text ?? '');
  if (/풀\s?리모트|전면\s?재택|완전\s?재택|fully\s+remote|100%\s*remote|원격\s*근무\s*가능/i.test(t)) return 'full';
  if (/하이브리드|주\s*[1-4]\s*[회일]\s*(재택|출근)|재택\s*병행|hybrid/i.test(t)) return 'hybrid';
  return 'unknown';
}

/** 목록 항목 + 상세 → 저장 레코드. 다른 보드와 **같은 모양**이어야 뒤 단계가 보드를 안 가린다. */
export function normalize(item, d = {}, matched = [], body = null) {
  const career = parseCareer(d.careerLabel ?? item.careerLabel);
  const areas = d.areas?.length ? d.areas : (item.areaLabel ? [item.areaLabel] : []);
  const r = parseRegion(areas[0] ?? '');
  return {
    board: 'incruit',
    id: String(item.id),
    url: item.url ?? postingUrl(item.id),
    title: d.title ?? item.title,
    // 🔴 회사 식별자는 **목록 쪽을 먼저 믿는다.** 목록 행은 그 공고의 회사 링크만 들고 있어서
    //    광고가 섞일 자리가 없다. 상세는 위 주석의 함정을 한 번 통과한 값이라 대비책으로만 쓴다.
    company: { name: d.company ?? item.company, industry: null, boardId: item.companyId ?? d.companyId ?? null },
    location: {
      label: r.sido ?? null,
      district: r.sigungu ?? null,
      full: areas[0] ?? null,
      // 🔴 인크루트는 좌표를 주지 않는다. 없는 값을 지어내지 않는다.
      lat: null, lng: null,
      all: areas,
    },
    status: d.state === 'closed' ? 'closed' : 'active',
    aliveState: d.state ?? 'unknown',
    dueTime: d.dueTime ?? null,
    dueKind: d.dueKind ?? null,
    annualFrom: career.from,
    annualTo: career.to,
    jdKind: body?.kind ?? 'failed',
    remote: detectRemote([item.title, d.employmentLabel, body?.text].filter(Boolean).join('\n')),
    tags: item.sectors ?? [],
    matchedKeywords: matched,
    collectedAt: new Date().toISOString(),
  };
}

/** 상세·본문까지 받아 레코드로 만들고 JD 원문을 저장한다. collect 와 check_alive 가 반드시 이걸 쓴다. */
export async function toRecord(profile, item, matched) {
  const d = await fetchDetail(item.id);
  if (d.gone) return { gone: true };
  if (d.unknown) return { unknown: true, error: d.error };
  // 🔴 상세와 본문이 **같은 페이지**다. 두 번 받지 않는다 (사람인은 나뉘어 있어 두 번 받는다).
  const body = parseBody(d.html);
  const rec = normalize(item, d.detail, matched, body);
  rec.jd = saveJd(profile, 'incruit', rec.id, jdMarkdown(item, d.detail, body));
  return { rec };
}

/** 🔴 목록 항목 없이 id 만으로. 상세에 회사명·제목이 다 있어서 목록 없이도 온전한 레코드가 된다. */
export async function toRecordById(profile, id, matched = []) {
  const d = await fetchDetail(id);
  if (d.gone) return { gone: true };
  if (d.unknown) return { unknown: true, error: d.error };
  const item = {
    id: String(id), url: postingUrl(id),
    title: d.detail.title ?? `(제목 미상) ${id}`,
    company: d.detail.company ?? '', companyId: d.detail.companyId ?? null,
    areaLabel: null, careerLabel: d.detail.careerLabel, educationLabel: d.detail.educationLabel,
    employmentLabel: d.detail.employmentLabel, sectors: [], dueLabel: d.detail.dueLabel,
  };
  const body = parseBody(d.html);
  const rec = normalize(item, d.detail, matched, body);
  rec.jd = saveJd(profile, 'incruit', rec.id, jdMarkdown(item, d.detail, body));
  return { rec };
}
