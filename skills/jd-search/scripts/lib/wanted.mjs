// 원티드 공용 — 수집(collect)과 마감 재확인(check_alive)이 **같은 경로**를 쓰게 한다.
//
// 🔴 재공고로 새로 찾은 공고도 수집과 똑같이 상세 조회 → 정규화 → JD 원문 저장을 거쳐야 한다.
//    이 로직이 collect 안에 갇혀 있으면 alive가 찾은 공고만 반쪽짜리 레코드가 되고,
//    그 차이는 리포트에서 "본문 없는 공고"로 드러난다.
//
// 엔드포인트 (토큰 불필요, 2026-08-10 실측):
//   목록 GET /api/v4/jobs?country=kr&query=<kw>&…&limit&offset  → .data[] · .links.next
//   상세 GET /api/v4/jobs/<id>  → .job (404 = 내려간 공고)

import { getJson, HttpError, throttle } from './http.mjs';
import { saveJd } from './io.mjs';

export const HOST = 'www.wanted.co.kr';
export const ORIGIN = `https://${HOST}`;
throttle.set(HOST, 1000);   // 🔴 공개 웹 요청 간 최소 1초. 병렬 순회 금지.

/**
 * 목록 조회. 🔴 한도에 걸려 멈췄으면 **멈췄다는 사실을 반드시 돌려준다.**
 * 401건 중 400건만 담고 조용히 정상 종료하면 사용자는 그게 전부인 줄 안다.
 */
export async function listByQuery(q, { max = 400 } = {}) {
  const found = new Map();
  let url = `${ORIGIN}/api/v4/jobs?country=kr&query=${encodeURIComponent(q)}`
    + `&job_sort=job.latest_order&years=-1&locations=all&limit=100&offset=0`;
  let truncated = false;
  while (url) {
    const res = await getJson(url, { referer: `${ORIGIN}/search?query=${encodeURIComponent(q)}&tab=position` });
    for (const it of res.data ?? []) found.set(String(it.id), it);
    if (!res.data?.length) break;
    url = res.links?.next ? ORIGIN + res.links.next : null;
    if (url && found.size >= max) { truncated = true; break; }
  }
  return { items: [...found.values()], truncated };
}

/**
 * 상세 조회.
 * @returns {{job}|{gone:true}|{unknown:true, error}}
 * 🔴 네트워크 오류를 "마감"으로 굳히면 안 된다. 추측으로 공고를 버리지 않는다 → unknown으로 돌려준다.
 */
export async function fetchDetail(id) {
  try {
    const res = await getJson(`${ORIGIN}/api/v4/jobs/${id}`, { referer: `${ORIGIN}/wd/${id}` });
    return { job: res.job ?? null };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { gone: true };
    return { unknown: true, error: e.message };
  }
}

/** 🔴 재택 여부는 추정이다. 확실할 때만 값을 넣고 나머지는 unknown으로 둔다. */
export function detectRemote(text) {
  const t = String(text ?? '');
  if (/풀\s?리모트|전면\s?재택|완전\s?재택|fully\s+remote|100%\s*remote|원격\s*근무\s*가능/i.test(t)) return 'full';
  if (/하이브리드|주\s*[1-4]\s*[회일]\s*(재택|출근)|재택\s*병행|hybrid/i.test(t)) return 'hybrid';
  return 'unknown';
}

export const jdMarkdown = (j, url) => [
  `# ${j.position}`,
  `- 회사: ${j.company?.name ?? ''}`,
  `- 출처: ${url}`,
  `- 근무지: ${j.address?.full_location ?? j.address?.location ?? ''}`,
  `- 경력: ${j.annual_from ?? '?'}~${j.annual_to ?? '?'}년`,
  `- 마감: ${j.due_time ?? '상시'}`,
  `- 수집: ${new Date().toISOString()}`,
  '',
  ...['intro', 'main_tasks', 'requirements', 'preferred_points', 'benefits'].flatMap(k => {
    const v = j.detail?.[k];
    return v ? [`## ${k}`, String(v), ''] : [];
  }),
].join('\n');

/** 상세(+목록 항목) → 저장 레코드. 목록 항목이 없어도(재공고 발견 경로) 동작해야 한다. */
export function normalize(j, item = {}, matched = []) {
  const geo = j?.address?.geo_location?.location ?? {};
  const id = String(j?.id ?? item.id);
  return {
    board: 'wanted',
    id,
    url: `${ORIGIN}/wd/${id}`,
    title: j?.position ?? item.position,
    company: {
      name: j?.company?.name ?? item.company?.name ?? '',
      industry: j?.company?.industry_name ?? item.company?.industry_name ?? null,
      boardId: j?.company?.id ?? item.company?.id ?? null,
    },
    location: {
      label: item.address?.location ?? j?.address?.location ?? null,
      district: item.address?.district ?? null,
      full: j?.address?.full_location ?? null,
      // 🔴 원티드는 좌표를 그대로 준다 — 지오코딩 키 없이 거리 판단이 된다.
      lat: typeof geo.lat === 'number' ? geo.lat : null,
      lng: typeof geo.lng === 'number' ? geo.lng : null,
    },
    status: (j?.status ?? item.status) === 'active' ? 'active' : 'closed',
    dueTime: j?.due_time ?? item.due_time ?? null,
    annualFrom: j?.annual_from ?? item.annual_from ?? null,
    annualTo: j?.annual_to ?? item.annual_to ?? null,
    remote: detectRemote([j?.position, j?.detail?.intro, j?.detail?.main_tasks, j?.detail?.benefits, j?.detail?.requirements].join('\n')),
    tags: (j?.skill_tags ?? []).map(t => t.title ?? t.name).filter(Boolean),
    matchedKeywords: matched,
    collectedAt: new Date().toISOString(),
  };
}

/** 상세를 레코드로 만들고 JD 원문까지 저장한다. 두 스크립트가 반드시 이걸 쓴다. */
export function toRecord(profile, j, item, matched) {
  const rec = normalize(j, item, matched);
  rec.jd = saveJd(profile, 'wanted', rec.id, jdMarkdown(j, rec.url));
  return rec;
}
