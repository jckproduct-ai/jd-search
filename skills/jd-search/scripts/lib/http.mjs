// 공용 HTTP — 속도 제한 · 재시도 · 🔴 인증키 마스킹.
//
// 🔴 serviceKey가 로그·에러 메시지에 찍히면 사용자가 스크린샷 한 장으로 키를 유출한다.
//    URL을 출력하는 경로가 여기 하나뿐이도록 모아 두고, 나가는 문자열은 전부 mask()를 거친다.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const SECRET_KEYS = /(serviceKey|apikey|api_key|appkey|authorization|key)=([^&\s]+)/gi;
export const mask = s => String(s ?? '').replace(SECRET_KEYS, (_, k) => `${k}=***`);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 호스트별 최소 간격. 🔴 공개 웹에 병렬로 붙지 않는다. */
class Throttle {
  #next = new Map();
  constructor(defaultMs = 1000) { this.defaultMs = defaultMs; this.perHost = new Map(); }
  set(host, ms) { this.perHost.set(host, ms); }
  async wait(host) {
    const gap = this.perHost.get(host) ?? this.defaultMs;
    const at = Math.max(Date.now(), this.#next.get(host) ?? 0);
    this.#next.set(host, at + gap);
    const delay = at - Date.now();
    if (delay > 0) await sleep(delay);
  }
}
export const throttle = new Throttle(1000);

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} — ${mask(url)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = mask(body ?? '').slice(0, 400);
  }
}

/** 연결 자체가 안 된 실패. 🔴 원인 코드를 잃지 않는다 — 마스킹만 하고 종류는 보존한다. */
export class NetworkError extends Error {
  constructor(cause, url) {
    super(mask(cause?.message ?? String(cause)));
    this.name = 'NetworkError';
    this.url = mask(url);
    const { kind, status } = networkKind(cause);
    this.kind = kind;
    this.status = status;
  }
}

const NET_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'EPROTO', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** fetch 는 진짜 원인을 `cause` 안쪽에 숨긴다. 겉면만 보면 전부 `fetch failed` 로 보인다. */
function causeChain(e) {
  const out = [];
  for (let c = e, i = 0; c && i < 5; c = c.cause, i++) out.push(c);
  return out;
}

function networkKind(e) {
  const chain = causeChain(e);

  // 🔴 회사망·클라우드 방화벽은 CONNECT 를 403 으로 되받는다. 그러면 fetch 는 그저 `fetch failed` 라고만 한다 —
  //    **사용자 입장에서는 인터넷이 끊긴 게 아니라 막힌 것**이라서 대처가 완전히 다르다.
  //    2026-08-18 사용자 제보가 정확히 이 모양이었을 가능성이 크다.
  for (const c of chain) {
    const m = /Proxy response \((\d{3})\)/.exec(c?.message ?? '');
    if (m) return { kind: 'proxyBlocked', status: Number(m[1]) };
  }

  // 🔴 이름도 **사슬 전체**에서 본다. `TypeError: fetch failed → cause: TimeoutError` 처럼
  //    진짜 원인이 안쪽에 있으면, 겉면만 보고 "네트워크 단절"로 적어 사용자에게
  //    "잠시 뒤 재시도" 대신 "인터넷 연결을 확인하라"는 엉뚱한 지시를 하게 된다.
  const aborted = chain.some(c => c?.code === 'UND_ERR_ABORTED');
  for (const c of chain) {
    const n = c?.name ?? '';
    if (n === 'TimeoutError') return { kind: 'timeout', status: null };
    if (n === 'AbortError' && !aborted) return { kind: 'timeout', status: null };
    if (TIMEOUT_CODES.has(c?.code)) return { kind: 'timeout', status: null };
    if (NET_CODES.has(c?.code)) return { kind: 'network', status: null };
  }
  const name = e?.name ?? '';
  // fetch 는 원인을 cause 에 넣고 자신은 TypeError('fetch failed') 로만 뜬다.
  if (name === 'TypeError' || e?.cause) return { kind: 'network', status: null };
  return { kind: 'unknown', status: null };
}

/**
 * 재시도는 429·5xx·네트워크 오류만. 4xx는 즉시 던진다 (재시도해도 같은 답이 온다).
 *
 * 🔴 `charset` — 인크루트처럼 **EUC-KR 로 내려주는 보드**가 있다. `res.text()` 는 UTF-8 로만 읽어서
 *    회사명·제목이 통째로 깨진 글자가 되고, 그 상태로 저장되면 리포트에도 깨진 채 남는다.
 *    깨진 글자는 오류를 내지 않아 **아무도 알아채지 못한 채 목록에 실린다** — 그래서 옵션으로 못 박는다.
 */
export async function request(url, { method = 'GET', headers = {}, body, referer, retries = 2, timeout = 20000, charset = null } = {}) {
  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    await throttle.wait(host);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}), ...headers },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      const text = charset
        ? new TextDecoder(charset).decode(new Uint8Array(await res.arrayBuffer()))
        : await res.text();
      if (res.ok) return text;
      if (res.status !== 429 && res.status < 500) throw new HttpError(res.status, url, text);
      lastErr = new HttpError(res.status, url, text);
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e instanceof HttpError ? e : new NetworkError(e, url);
    }
    if (attempt >= retries) throw lastErr;
    await sleep(800 * 2 ** attempt);
  }
}

export async function getJson(url, opts = {}) {
  const text = await request(url, { headers: { Accept: 'application/json' }, ...opts });
  try { return JSON.parse(text); } catch { throw new Error(`JSON이 아닌 응답 — ${mask(url)}`); }
}

export const postForm = (url, params, opts = {}) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  body: new URLSearchParams(params).toString(),
  ...opts,
});

/** 동시 실행 상한이 있는 map. 공개 웹(throttle)과 달리 공식 API에만 쓴다. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── 실패 진단 ────────────────────────────────────────────────────────────────
//
// 🔴 실패를 "조회 실패" 한 마디로 뭉치면 사용자가 할 수 있는 일이 없다.
//    차단·한도 초과·네트워크 단절은 대처가 서로 다르고, 그중 **차단만이 사용자 환경 문제**다
//    (클라우드·회사망에서 돌리면 보드가 거부한다). 어느 쪽인지 말해 주지 않으면
//    "추천 0건"이라는 결과만 남고 사용자는 도구가 고장 났다고 판단한다.

const KIND_LABEL = {
  blocked: '접근 차단',
  proxyBlocked: '중간 프록시 차단',
  rateLimited: '요청 한도 초과',
  notFound: '주소 없음',
  serverError: '보드 서버 오류',
  timeout: '응답 시간 초과',
  network: '네트워크 연결 실패',
  unknown: '조회 실패',
};

const KIND_HINT = {
  blocked: '보드가 이 컴퓨터의 접근을 거부했습니다. 브라우저에서 같은 주소가 열리는지 먼저 확인해 주십시오. '
    + '클라우드·회사망·VPN에서 돌리고 있다면 개인 컴퓨터에서 다시 실행해 주십시오.',
  proxyBlocked: '회사망·클라우드 방화벽 같은 중간 프록시가 보드 접근을 막았습니다. 인터넷이 끊긴 것이 아닙니다 — '
    + '개인 컴퓨터·개인 네트워크에서 다시 실행해 주십시오.',
  rateLimited: '요청이 너무 잦아 보드가 잠시 막았습니다. 10분 이상 두었다가 다시 실행해 주십시오.',
  notFound: '보드가 주소를 바꿨을 수 있습니다. 스킬을 최신으로 올린 뒤 다시 실행해 주십시오.',
  serverError: '보드 쪽 오류입니다. 잠시 뒤 다시 실행해 주십시오 — 수집한 공고는 그대로 남아 있습니다.',
  timeout: '응답이 오지 않아 끊었습니다. 잠시 뒤 다시 실행해 주십시오.',
  network: '보드에 연결하지 못했습니다. 인터넷 연결을 확인해 주십시오. '
    + '외부 접속이 막힌 클라우드 실행 환경에서는 이 스킬이 돌지 않습니다.',
  unknown: null,
};

/** 상태 코드 → 종류. 순수 함수라 테스트가 문다. */
export function kindOfStatus(status) {
  if ([401, 403, 407, 451].includes(status)) return 'blocked';
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'notFound';
  if (status >= 500) return 'serverError';
  return 'unknown';
}

/**
 * 실패 하나 → 사용자 언어. 리포트 경고와 콘솔이 **같은 문구**를 쓰게 한다.
 * @returns {{kind:string, status:number|null, label:string, hint:string|null, message:string}}
 */
export function diagnose(err) {
  const message = mask(err?.message ?? String(err ?? ''));
  let kind = 'unknown', status = null;
  // 🔴 순서가 중요하다. 프록시 차단은 상태 코드(403)를 갖지만 **보드가 거부한 것이 아니다** —
  //    상태 코드부터 보면 둘이 같은 실패로 뭉쳐져 사용자가 엉뚱한 곳을 확인하게 된다.
  if (err?.kind) {
    kind = err.kind;
    status = err.status ?? null;   // 프록시가 되돌려준 상태 코드가 있으면 그것도 보여 준다
  } else if (err instanceof HttpError || typeof err?.status === 'number') {
    status = err.status;
    kind = kindOfStatus(status);
  }
  const label = status ? `${KIND_LABEL[kind]}(HTTP ${status})` : KIND_LABEL[kind];
  return { kind, status, label, hint: KIND_HINT[kind] ?? null, message };
}
