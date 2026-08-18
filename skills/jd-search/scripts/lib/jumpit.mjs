// 점핏(jumpit) 공용 — 수집(collect)과 마감 재확인(check_alive)이 **같은 경로**를 쓰게 한다.
//   원티드는 `lib/wanted.mjs`, 사람인은 `lib/saramin.mjs`. 레코드 모양은 같지만
//   🔴 **마감 신호는 보드마다 다르다.** 하나의 규칙으로 묶으려 하지 말 것.
//
// 왜 세 번째 보드로 점핏인가 (2026-08-18 실측):
//   공개 JSON API 가 열려 있어 **키도 HTML 파싱도 필요 없다.** 사람인 어댑터의 5분의 1 노동이다.
//   그리고 개발 직군이 사람인·원티드와 다르게 모여 있어 목록이 실제로 넓어진다.
//
// 엔드포인트 (키 불필요, 2026-08-18 실측)
//   목록  GET https://jumpit-api.saramin.co.kr/api/positions?page=<0부터>&keyword=<kw>
//         → .result.totalCount · .result.positions[] (페이지당 16건) · .result.emptyPosition
//   상세  GET https://jumpit-api.saramin.co.kr/api/position/<id>
//         → .result (본문·근무지·마감·경력·학력)
//
// 🔴 없는 공고는 **404 가 아니라 400 + code "C003"("Entity Not Found")** 으로 온다.
//    상태 코드만 보고 판정하면 400 을 전부 마감으로 굳히게 된다 — code 까지 확인한다.

import { getJson, request, HttpError, throttle } from './http.mjs';
import { saveJd } from './io.mjs';
import { parseRegion } from './region.mjs';

export const HOST = 'jumpit.saramin.co.kr';
export const API_HOST = 'jumpit-api.saramin.co.kr';
export const ORIGIN = `https://${HOST}`;
export const API = `https://${API_HOST}`;
throttle.set(HOST, 1000);       // 🔴 공개 웹 요청 간 최소 1초. 병렬 순회 금지.
throttle.set(API_HOST, 1000);

export const postingUrl = id => `${ORIGIN}/position/${id}`;

const PAGE_SIZE = 16;           // 실측 고정값. 서버가 page 크기를 받지 않는다.

/**
 * 목록 제목에는 검색어가 `<span>` 으로 감싸여 온다. 그대로 저장하면 태그가 리포트에 실린다.
 *
 * 🔴 `lib/text.mjs` 의 `stripTags` 를 쓰면 안 된다 — 그쪽은 태그를 **공백으로** 바꾼다.
 *    점핏은 낱말 **가운데**를 감싸서(`IT <span>서비스기획</span>자`) 공백이 끼면
 *    `IT 서비스기획 자` 가 되고, 그 제목이 그대로 리포트와 JD 원문에 남는다.
 */
export const cleanTitle = s => String(s ?? '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

/**
 * 기술스택. 🔴 **목록과 상세가 같은 이름의 필드를 다른 모양으로 준다** (2026-08-18 실측).
 *    목록 `["Figma", …]` · 상세 `[{stack:"Figma", imagePath:…}, …]`
 *    한쪽만 보고 짜면 상세 경로에서 태그가 통째로 비고, 아무 오류도 나지 않는다.
 */
export const stacksOf = v => (Array.isArray(v) ? v : [])
  .map(t => (typeof t === 'string' ? t : t?.stack ?? t?.name))
  .filter(Boolean);

/** "2026-08-26 23:59:59" · "2026-08-26T23:59:59" → ISO(+09:00). 형식이 다르면 null. */
export function toIso(s) {
  const m = String(s ?? '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00` : null;
}

// ── 조회 ────────────────────────────────────────────────────────────────────

/**
 * 목록 조회.
 *
 * 🔴 **점핏 검색은 공백이 든 키워드를 사실상 무시한다** (2026-08-18 실측).
 *    `서비스기획` → 3건(전부 관련) · `서비스 기획` → 724건 · `프로덕트 매니저` → **똑같이 724건**.
 *    두 키워드의 totalCount 가 같다는 것은 키워드로 좁히지 않았다는 뜻이다.
 *    제목 매치율도 p0~p11 이 0~6% 였다. 사람인처럼 뒤로 갈수록 떨어지는 게 아니라 **처음부터 잡음**이다.
 *
 *    → 그래서 페이지 상한이 아니라 **매치율이 바닥나는 지점**에서 멈춘다. 400건을 받아 놓고
 *      "한도에서 잘렸다"고 경고하면, 사용자는 관련 공고를 놓친 줄 알고 상한을 올린다 —
 *      올려도 잡음만 더 받는다. **왜 안 나오는지**를 말해 줘야 한다(`keywordIgnored`).
 *
 * @param isRelevant  제목이 내 직군인지 판정하는 함수. 이게 정지 조건을 만든다.
 * @returns {{items, total, pages, stoppedBy, rates, keywordIgnored, truncated}}
 */
export async function listByQuery(q, isRelevant = () => true, { max = 400, maxPages = 30, floor = 0.1, dryRounds = 3 } = {}) {
  const found = new Map();
  const rates = [];
  let total = null, dry = 0, truncated = false, stoppedBy = 'exhausted';
  let seenItems = 0, seenHits = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = `${API}/api/positions?page=${page}&keyword=${encodeURIComponent(q)}`;
    const res = await getJson(url, { referer: `${ORIGIN}/positions?keyword=${encodeURIComponent(q)}` });
    const r = res?.result ?? {};
    const items = r.positions ?? [];
    if (total == null && typeof r.totalCount === 'number') total = r.totalCount;
    if (!items.length || r.emptyPosition) { stoppedBy = 'noMoreResults'; break; }

    const hits = items.filter(it => isRelevant(cleanTitle(it.title)));
    for (const it of hits) found.set(String(it.id), it);
    seenItems += items.length; seenHits += hits.length;
    const rate = hits.length / items.length;
    rates.push({ page, items: items.length, hits: hits.length, rate: Math.round(rate * 100) / 100 });

    if (found.size >= max) { truncated = true; stoppedBy = 'max'; break; }
    // 🔴 한 페이지만 보고 멈추지 않는다. 관련 공고가 뒤쪽에 몰려 있는 키워드가 있다.
    if (rate < floor) { if (++dry >= dryRounds) { stoppedBy = 'relevanceFloor'; break; } }
    else dry = 0;
    if (total != null && seenItems >= total) { stoppedBy = 'exhausted'; break; }
    if (items.length < PAGE_SIZE) { stoppedBy = 'exhausted'; break; }
    if (page === maxPages - 1) stoppedBy = 'maxPages';
  }

  return { items: [...found.values()], total, pages: rates.length, stoppedBy, rates, truncated,
    keywordIgnored: keywordIgnored(q, rates) };
}

/**
 * 🔴 "이 키워드는 점핏에서 안 먹는다"를 판정한다. 순수 함수라 테스트가 문다.
 *
 *    공백이 든 키워드로 여러 페이지를 봤는데 걸린 게 하나도 없으면, 결과가 없는 게 아니라
 *    **검색이 키워드를 무시한 것**이다. 사용자에게는 전혀 다른 안내가 필요하다 —
 *    "이 직군은 점핏에 공고가 없습니다"가 아니라 "붙여 쓴 표기를 함께 넣으십시오".
 */
export function keywordIgnored(q, rates = []) {
  if (!/\s/.test(String(q ?? ''))) return false;      // 붙여 쓴 키워드는 정상 동작한다
  if (rates.length < 2) return false;
  return rates.reduce((a, r) => a + r.hits, 0) === 0;
}

/**
 * 상세 조회.
 * @returns {{job}|{gone:true}|{unknown:true,error}}
 * 🔴 네트워크 오류를 "마감"으로 굳히지 않는다. 추측으로 공고를 버리지 않는다.
 */
export async function fetchDetail(id) {
  try {
    const res = await getJson(`${API}/api/position/${id}`, { referer: postingUrl(id) });
    return { job: res?.result ?? null };
  } catch (e) {
    if (e instanceof HttpError && isEntityNotFound(e)) return { gone: true };
    return { unknown: true, error: e.message };
  }
}

/**
 * 🔴 "없는 공고" 판정. 상태 코드만으로는 안 된다 —
 *    점핏은 400 을 잘못된 요청에도 쓰고 없는 공고에도 쓴다. code 가 갈라 주는 유일한 신호다.
 *    순수 함수로 빼 둔 것은 이 규칙이 테스트에 물려야 하기 때문이다.
 */
export function isEntityNotFound(err) {
  if (err?.status === 404) return true;
  if (err?.status !== 400) return false;
  return /"code"\s*:\s*"C003"/.test(String(err?.body ?? ''));
}

// ── 정규화 ──────────────────────────────────────────────────────────────────

/** 🔴 재택 여부는 추정이다. 확실할 때만 값을 넣는다. wanted·saramin 과 같은 규칙을 쓴다. */
export function detectRemote(text) {
  const t = String(text ?? '');
  if (/풀\s?리모트|전면\s?재택|완전\s?재택|fully\s+remote|100%\s*remote|원격\s*근무\s*가능/i.test(t)) return 'full';
  if (/하이브리드|주\s*[1-4]\s*[회일]\s*(재택|출근)|재택\s*병행|hybrid/i.test(t)) return 'hybrid';
  return 'unknown';
}

/**
 * 마감 판정.
 *
 * 🔴 **`closedAt` 이 지났다는 이유로 마감 처리하지 않는다.** 사람인에서 22%가 마감일 없는
 *    상시채용이었던 것과 같은 이유이고, 기간형도 연장이 흔하다.
 * 🔴 지금 확실한 신호는 `invisible` 하나다. **내려간 공고의 응답 표본을 아직 확보하지 못했다** —
 *    그래서 나머지는 `active` 로 두되 `aliveState` 는 그 사실을 그대로 적는다.
 *    표본이 잡히면 여기만 고치면 된다(호출부는 손대지 않아도 된다).
 */
export function judgeState(j) {
  if (j?.invisible === true) return { state: 'closed', dueKind: null };
  if (j?.alwaysOpen === true) return { state: 'active', dueKind: 'always' };
  if (j?.closedAt) return { state: 'active', dueKind: 'date' };
  return { state: 'active', dueKind: null };
}

/** 근무지. `workingPlaces[]` 가 본진이고 `location` 문자열은 그것이 비었을 때의 대비책이다. */
export function placesOf(j) {
  const places = (j?.workingPlaces ?? []).map(p => String(p?.address ?? '').trim()).filter(Boolean);
  if (places.length) return [...new Set(places)];
  const loc = String(j?.location ?? '').trim();
  return loc ? [loc] : [];
}

/** 목록 항목 + 상세 → 저장 레코드. 다른 보드와 **같은 모양**이어야 뒤 단계가 보드를 안 가린다. */
export function normalize(j, item = {}, matched = []) {
  const id = String(j?.id ?? item.id);
  const { state, dueKind } = judgeState(j ?? item);
  const places = placesOf(j).length ? placesOf(j) : (item.locations ?? []);
  const r = parseRegion(places[0] ?? '');
  const newcomer = (j?.newcomer ?? item.newcomer) === true;
  const minCareer = j?.minCareer ?? item.minCareer;
  const maxCareer = j?.maxCareer ?? item.maxCareer;
  const body = [j?.serviceInfo, j?.responsibility, j?.qualifications, j?.preferredRequirements, j?.welfares]
    .filter(Boolean).join('\n');

  return {
    board: 'jumpit',
    id,
    url: postingUrl(id),
    title: cleanTitle(j?.title ?? item.title),
    company: {
      name: String(j?.companyName ?? item.companyName ?? '').trim(),
      industry: null,
      // 🔴 점핏의 회사 식별자는 공고에 붙은 사람인 공고번호다. 회사 키가 아니라서 병합에 쓰지 않는다.
      boardId: null,
    },
    location: {
      label: r.sido ?? null,
      district: r.sigungu ?? null,
      full: places[0] ?? null,
      // 🔴 점핏은 좌표를 주지 않는다(원티드와 다르다). 없는 값을 지어내지 않는다.
      lat: null, lng: null,
      all: places,
    },
    status: state === 'closed' ? 'closed' : 'active',
    // 🔴 `unverified` — 마감 응답 표본을 아직 못 봤다는 사실을 레코드에 남긴다.
    //    check_alive 가 이 값을 보고 재검색으로 교차 확인한다.
    aliveState: state === 'closed' ? 'closed' : 'unverified',
    dueTime: toIso(j?.closedAt ?? item.closedAt),
    dueKind,
    annualFrom: newcomer ? 0 : (Number.isFinite(minCareer) ? minCareer : null),
    annualTo: Number.isFinite(maxCareer) && maxCareer > 0 ? maxCareer : null,
    jdKind: body.trim().length >= 60 ? 'text' : 'empty',
    remote: detectRemote([j?.title, body].filter(Boolean).join('\n')),
    tags: [
      ...stacksOf(j?.techStacks ?? item.techStacks),
      ...(j?.jobCategories ?? []).map(c => c?.name).filter(Boolean),
      ...(item.jobCategory ? [item.jobCategory] : []),
    ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i),
    matchedKeywords: matched,
    collectedAt: new Date().toISOString(),
  };
}

export const jdMarkdown = (j, url) => {
  const sections = [
    ['서비스 소개', j?.serviceInfo],
    ['주요 업무', j?.responsibility],
    ['자격 요건', j?.qualifications],
    ['우대 사항', j?.preferredRequirements],
    ['혜택 및 복지', j?.welfares],
    ['채용 절차', j?.recruitProcess],
  ].filter(([, v]) => String(v ?? '').trim());

  return [
    `# ${cleanTitle(j?.title)}`,
    `- 회사: ${j?.companyName ?? ''}`,
    `- 출처: ${url}`,
    `- 근무지: ${placesOf(j).join(', ')}`,
    `- 경력: ${j?.newcomer ? '신입 가능' : ''}${j?.minCareer ?? '?'}~${j?.maxCareer || '?'}년`,
    `- 학력: ${j?.educationName ?? '?'}`,
    `- 마감: ${j?.alwaysOpen ? '상시' : (j?.closedAt ?? '?')}`,
    `- 기술스택: ${stacksOf(j?.techStacks).join(', ')}`,
    `- 본문 형태: ${sections.length ? '글자' : '없음'}`,
    `- 수집: ${new Date().toISOString()}`,
    '',
    // 🔴 본문이 없으면 **없다고 적는다.** 빈 파일을 남기면 수집기가 원문 확보로 세어 다시 받지 않고,
    //    공고가 내려가는 순간 영구 손실이 된다 (사람인에서 겪은 것과 같은 실패다).
    ...(sections.length
      ? sections.flatMap(([h, v]) => [`## ${h}`, String(v).trim(), ''])
      : ['(상세 응답에 본문이 없었습니다. 공고 원문을 직접 확인해 주십시오.)']),
  ].join('\n');
};

/** 상세를 레코드로 만들고 JD 원문까지 저장한다. collect 와 check_alive 가 반드시 이걸 쓴다. */
export function toRecord(profile, j, item, matched) {
  const rec = normalize(j, item, matched);
  rec.jd = saveJd(profile, 'jumpit', rec.id, jdMarkdown(j, rec.url));
  return rec;
}
