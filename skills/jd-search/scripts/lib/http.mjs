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
    this.status = status;
    this.body = mask(body ?? '').slice(0, 400);
  }
}

/**
 * 재시도는 429·5xx·네트워크 오류만. 4xx는 즉시 던진다 (재시도해도 같은 답이 온다).
 */
export async function request(url, { method = 'GET', headers = {}, body, referer, retries = 2, timeout = 20000 } = {}) {
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
      const text = await res.text();
      if (res.ok) return text;
      if (res.status !== 429 && res.status < 500) throw new HttpError(res.status, url, text);
      lastErr = new HttpError(res.status, url, text);
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e instanceof HttpError ? e : new Error(mask(e.message));
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
