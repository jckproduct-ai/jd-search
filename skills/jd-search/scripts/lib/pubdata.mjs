// 공공데이터포털 기업개요·기업재무.
//
// 계정당 인증키 **1개**를 모든 서비스가 공유한다. 서비스별 키는 없다.
// 🔴 401과 403은 원인이 전혀 다르다 — 구분해서 안내하지 않으면 사용자가 멀쩡한 키를 지운다.
//      401 = 키가 틀림
//      403 = 키는 맞고 **그 서비스 활용신청 승인이 아직 반영 안 됨** (승인 직후 10분~1시간)
// 이용허락범위 제한이 없어 재배포 제약이 없다 — 이 성질이 오픈소스화의 전제다.

import { getJson, HttpError, throttle, mask } from './http.mjs';
import { resolveCorp } from './match.mjs';
import { nameVariants } from './text.mjs';

const BASE = 'https://apis.data.go.kr/1160100/service';
const OUTLINE = `${BASE}/GetCorpBasicInfoService_V2/getCorpOutline_V2`;
const FINSTAT = `${BASE}/GetFinaStatInfoService_V2/getSummFinaStat_V2`;

throttle.set('apis.data.go.kr', 120);   // 공식 API — 10,000건/일. 웹 크롤링보다 여유가 있다.

export class PubDataAuthError extends Error {}

/** 🔴 URL 파라미터 마스킹만으로는 부족하다 — 응답 본문에 키가 통째로 실려 오는 경우가 있다. */
const scrub = s => {
  const key = process.env.DATA_GO_KR_KEY;
  let out = mask(String(s ?? ''));
  if (key && key.length >= 8) {
    out = out.split(key).join('***');
    // URL 인코딩된 형태로 반향되는 경우까지 막는다.
    try { out = out.split(encodeURIComponent(key)).join('***'); } catch { /* noop */ }
  }
  return out;
};

export function requireKey() {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) {
    throw new PubDataAuthError(
      '공공데이터포털 인증키가 없습니다. 환경변수 DATA_GO_KR_KEY 로 넣어 주십시오.\n' +
      '  발급:  https://www.data.go.kr — 기업개요·기업재무 두 서비스에 활용신청\n' +
      '  적용:  export DATA_GO_KR_KEY="발급받은키"\n' +
      '키 없이 돌리려면 profile.yml 의 finance.enabled 를 false 로 두십시오 (수집·게이트만 동작).');
  }
  return key;
}

async function call(url, params) {
  const qs = new URLSearchParams({
    serviceKey: requireKey(), resultType: 'json', pageNo: '1', numOfRows: '50', ...params,
  });
  let json;
  try {
    json = await getJson(`${url}?${qs}`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      throw new PubDataAuthError('공공데이터포털 401 — 인증키가 올바르지 않습니다. 키를 다시 확인해 주십시오.');
    }
    if (e instanceof HttpError && e.status === 403) {
      throw new PubDataAuthError(
        '공공데이터포털 403 — 키는 맞지만 이 서비스의 활용신청 승인이 아직 반영되지 않았습니다.\n' +
        '  기업기본정보·기업재무정보 두 서비스를 각각 신청했는지 확인하시고, 승인 직후면 10분~1시간 뒤 다시 시도해 주십시오.');
    }
    // HttpError의 body에는 서버 응답 원문이 담긴다 — 키가 반향돼 있을 수 있으므로 여기서도 지운다.
    throw new Error(scrub(e.message) + (e.body ? ` (${scrub(e.body).slice(0, 200)})` : ''));
  }
  const code = json?.response?.header?.resultCode;
  if (code && code !== '00') {
    // 🔴 서버 오류 메시지가 요청 키를 그대로 반향하는 경우가 있다.
    //    바깥으로 나가는 모든 외부 문자열은 mask()를 거친 뒤에만 출력한다.
    const msg = scrub(json?.response?.header?.resultMsg ?? '');
    if (/SERVICE.?KEY|DEADLINE|ACCESS/i.test(msg)) throw new PubDataAuthError(`공공데이터포털: ${msg}`);
    return { items: [], total: 0, resultCode: code, resultMsg: msg };
  }
  const body = json?.response?.body;
  const items = body?.items?.item ?? body?.items ?? [];
  return { items: Array.isArray(items) ? items : [items].filter(Boolean), total: body?.totalCount ?? 0 };
}

const num = v => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};

const toCorp = i => ({
  crno: i.crno, corpNm: i.corpNm, bzno: i.bzno, addr: i.enpBsadr,
  empeCnt: num(i.enpEmpeCnt), avgSalary: num(i.enpPn1AvgSlryAmt),
  foundedAt: i.enpEstbDt, smenpYn: i.smenpYn, market: i.corpRegMrktDcdNm,
});

/**
 * 회사명 → 법인. 🔴 API는 부분일치로 응답한다("컬리" → "컬리넌홀딩스").
 *    그대로 첫 건을 쓰면 엉뚱한 회사 재무가 붙는다. 판정은 match.mjs가 한다.
 */
export async function resolveCorpByName(name, hint = {}) {
  let seen = [];
  for (const variant of nameVariants(name)) {
    const r = await call(OUTLINE, { corpNm: variant });
    if (!r.items.length) continue;
    const corps = r.items.map(toCorp);
    seen = corps;
    // 🔴 대조 기준은 **지금 검색한 변형**이다. 원본이 "럭스로보(LUXROBO)"처럼 별칭을 달고 있으면
    //    등기 상호와 완전일치가 나지 않아 멀쩡한 회사가 미확인으로 떨어진다.
    const res = resolveCorp(corps, variant, hint);
    if (res.status !== 'none') return { ...res, via: variant };
  }
  return { status: 'none', reason: seen.length ? 'partial-only' : 'no-result', candidates: seen.slice(0, 5) };
}

/** 법인등록번호 → 연도별 재무. 별도(120) 우선 — 기준선이 별도면 별도끼리 비교해야 한다. */
export async function fetchFinance(crno, years) {
  const list = years ?? (() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2, y - 3]; })();
  const out = {};
  for (const y of list) {
    let r;
    try { r = await call(FINSTAT, { crno, bizYear: String(y) }); } catch (e) {
      if (e instanceof PubDataAuthError) throw e;
      continue;
    }
    if (!r.items.length) continue;
    const it = r.items.find(x => x.fnclDcd === '120') ?? r.items[0];
    const row = {
      basis: it.fnclDcdNm ?? (it.fnclDcd === '110' ? '연결' : '별도'),
      revenue: num(it.enpSaleAmt),
      operatingProfit: num(it.enpBzopPft),
      netIncome: num(it.enpCrtmNpf),
      assets: num(it.enpTastAmt),
      liabilities: num(it.enpTdbtAmt),
      equity: num(it.enpTcptAmt),
      source: 'data.go.kr',
    };
    if (row.revenue !== null || row.operatingProfit !== null || row.equity !== null) out[y] = row;
  }
  return out;
}
