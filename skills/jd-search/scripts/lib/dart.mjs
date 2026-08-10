// DART 전자공시 — 🔴 API 키가 필요 없다.
//
// 웹 공시검색이 공개돼 있고 필요한 게 전부 HTML에 있다. corpCode.xml(키 필요) 다운로드도 불필요하다.
//   dsab007/detailSearch.ax  (POST) → 보고서 목록 + corp_code(8자리) + rcpNo
//   dsae001/selectPopup.ax          → 법인등록번호·사업자번호·업종·설립일·주소
//   dsaf001/main.do → report/viewer.do → 재무제표 원문 표
//
// 구직자가 궁금해하는 회사 대부분은 비상장 외감이라 **사업보고서가 아니라 감사보고서만** 낸다.
// 정형 API만 붙이면 커버리지가 2%p밖에 안 오른다 — 감사보고서 원문 파싱이 실제 이득이다.

import { request, postForm, throttle } from './http.mjs';
import { extractFromDoc } from './dart_table.mjs';
import { nameVariants, normCorp } from './text.mjs';
import { resolveCorp } from './match.mjs';

const HOST = 'dart.fss.or.kr';
const REF = 'https://dart.fss.or.kr/dsab007/main.do';
throttle.set(HOST, 700);   // 🔴 공개 웹이다. 병렬로 붙지 않는다.

const digits = s => String(s ?? '').replace(/\D/g, '');

/** 공시검색 결과 HTML → [{corpCode, corpName, rcpNo, report, date}] (순수 함수 — 회귀 테스트 대상) */
export function parseSearchRows(html) {
  const rows = [];
  // 각 행: 회사 링크(corp_code) → 보고서 링크(rcpNo, title="<보고서명> 공시뷰어 새창") → 접수일자
  const re = /openCorpInfoNew\('(\d+)'[^)]*\)[^>]*title="([^"]*?)\s*기업개황 새창"[\s\S]*?rcpNo=(\d+)"[\s\S]*?title="([^"]*?)\s*공시뷰어 새창"[\s\S]*?<td>(\d{4}\.\d{2}\.\d{2})<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    rows.push({
      corpCode: m[1], corpName: m[2].trim(), rcpNo: m[3],
      report: m[4].replace(/\s+/g, ' ').trim(), date: m[5],
    });
  }
  return rows;
}

export async function searchDisclosures(name, { startDate = '20230101', endDate = '20301231', maxResults = 100 } = {}) {
  const html = await postForm(`https://${HOST}/dsab007/detailSearch.ax`, {
    currentPage: '1', maxResults: String(maxResults), textCrpNm: name, startDate, endDate,
  }, { referer: REF });
  return parseSearchRows(html);
}

/** 기업개황 팝업 — 🔴 여기 법인등록번호가 있다. 오매칭 가드의 근거다. */
export async function fetchCorpInfo(corpCode) {
  const html = await request(`https://${HOST}/dsae001/selectPopup.ax?selectKey=${corpCode}`, { referer: REF });
  const flat = html.replace(/<[^>]+>/g, '|').replace(/[\r\n\t]+/g, '').replace(/\|{2,}/g, '|');
  const pick = label => {
    const i = flat.indexOf(`|${label}|`);
    if (i < 0) return null;
    return flat.slice(i + label.length + 2).split('|')[0].trim() || null;
  };
  return {
    corpCode,
    corpNm: pick('회사이름'),
    corpCls: pick('법인구분'),
    stockCode: pick('종목코드'),
    crno: digits(pick('법인등록번호')) || null,
    bzno: digits(pick('사업자등록번호')) || null,
    addr: pick('주소'),
    industry: pick('업종명'),
    foundedAt: pick('설립일'),
  };
}

/**
 * 공시뷰어 프레임 → 하위 문서 목록.
 *
 * 🔴 목차는 `cnt['dcmNo'] = "…"` 형태의 **순차 할당**으로 뿌려진다.
 *    viewDoc('a','b',…) 작은따옴표 6인자로 가정했다가 20곳 전부 "파싱 실패"가 났다.
 *    데이터가 없어서가 아니라 파서가 틀렸던 것이다 — **데이터 부재와 파서 버그를 구분하라.**
 */
export function parseSubDocs(html, rcpNo = null) {
  const docs = [];
  const re = /\['dcmNo'\]\s*=\s*"(\d+)"[\s\S]{0,400}?\['eleId'\]\s*=\s*"(\d*)"[\s\S]{0,400}?\['offset'\]\s*=\s*"(\d*)"[\s\S]{0,400}?\['length'\]\s*=\s*"(\d*)"[\s\S]{0,400}?\['dtd'\]\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    docs.push({ rcpNo, dcmNo: m[1], eleId: m[2], offset: m[3], length: m[4], dtd: m[5], size: Number(m[4]) || 0 });
  }
  // 폴백: 인라인 viewDoc 호출 (따옴표 종류·인자 수 무관)
  if (!docs.length) {
    const re2 = /viewDoc\(\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']/g;
    let m2;
    while ((m2 = re2.exec(html))) {
      docs.push({ rcpNo: m2[1], dcmNo: m2[2], eleId: m2[3], offset: m2[4], length: m2[5], dtd: m2[6], size: Number(m2[5]) || 0 });
    }
  }
  docs.sort((a, b) => b.size - a.size);   // 재무제표 본문은 압도적으로 크다
  return { docs, titles: [...html.matchAll(/text:\s*"([^"]+)"/g)].map(x => x[1]) };
}

export async function listSubDocs(rcpNo) {
  const html = await request(`https://${HOST}/dsaf001/main.do?rcpNo=${rcpNo}`, { referer: REF });
  return parseSubDocs(html, rcpNo);
}

export const fetchDoc = d => request(
  `https://${HOST}/report/viewer.do?rcpNo=${d.rcpNo}&dcmNo=${d.dcmNo}&eleId=${d.eleId}&offset=${d.offset}&length=${d.length}&dtd=${encodeURIComponent(d.dtd)}`,
  { referer: `https://${HOST}/dsaf001/main.do?rcpNo=${d.rcpNo}` },
);

/** 회사명 → DART 법인 확정. 🔴 이름만으로 채택하지 않고 법인등록번호를 대조한다. */
export async function resolveDartCorp(name, hint = {}) {
  for (const variant of nameVariants(name)) {
    let rows;
    try { rows = await searchDisclosures(variant, { startDate: '20220101' }); }
    catch { continue; }
    if (!rows.length) continue;

    const byCode = new Map();
    for (const r of rows) {
      if (!byCode.has(r.corpCode)) byCode.set(r.corpCode, { corpCode: r.corpCode, corpNm: r.corpName, reports: [] });
      byCode.get(r.corpCode).reports.push(r);
    }
    // 후보가 많으면 이름이 가까운 순으로 잘라 개황 조회 횟수를 줄인다.
    const cands = [...byCode.values()]
      .sort((a, b) => Number(normCorp(b.corpNm) === normCorp(variant)) - Number(normCorp(a.corpNm) === normCorp(variant)))
      .slice(0, 8);

    const infos = [];
    for (const c of cands) {
      try { infos.push({ ...c, ...(await fetchCorpInfo(c.corpCode)) }); } catch { /* 개황 실패는 후보 탈락 */ }
    }
    if (!infos.length) continue;

    // 🔴 대조 기준은 **지금 검색한 변형**이지 원본 이름이 아니다.
    //    "럭스로보(LUXROBO)"로 대조하면 등기 상호 "럭스로보"와 완전일치가 나지 않아
    //    공시가 18건 있는 회사가 "DART 미등록"으로 떨어진다.
    const r = resolveCorp(infos, variant, hint);
    if (r.status === 'exact') return { ...r, via: variant, reports: byCode.get(r.corp.corpCode)?.reports ?? [] };
    if (r.status === 'ambiguous') return { ...r, via: variant };
  }
  return { status: 'none', reason: 'dart-not-found' };
}

/**
 * 보고서 목록 → 재무를 담고 있는 보고서 하나.
 *
 * 🔴 **최신 연도가 먼저다.** 보고서 종류를 먼저 보면 3년 전 사업보고서가 올해 감사보고서를 이긴다 —
 *    그러면 등급이 "3년 이상 낡음"으로 미확인 처리되어, 올해 공시가 버젓이 있는 회사가 사라진다.
 *    (상장 폐지·비상장 전환한 회사에서 정확히 이 일이 난다.)
 * 종류는 **같은 해 안에서만** 우선순위로 쓴다. 사업보고서 > 감사보고서 > 연결감사보고서.
 * 연결보다 별도를 앞에 두는 이유는 기준선이 별도면 별도끼리 비교해야 하기 때문이다.
 */
export function pickFinancialReport(reports = []) {
  const hasFinance = r => /사업보고서|감사보고서/.test(r.report);
  const year = r => Number(String(r.date ?? '').slice(0, 4)) || 0;
  const typeScore = r => (/사업보고서/.test(r.report) ? 2 : 1) - (/연결/.test(r.report) ? 0.5 : 0);
  const cands = reports.filter(hasFinance);
  cands.sort((a, b) => (year(b) - year(a)) || (typeScore(b) - typeScore(a)) || String(b.date).localeCompare(String(a.date)));
  return cands[0] ?? null;
}

/**
 * 확정된 법인 → 재무 3종. 감사보고서 원문 표를 파싱한다.
 * @returns {{ok, year, revenue, operatingProfit, equity, report, rcpNo}|null}
 */
export async function fetchDartFinance(reports, { maxDocs = 6 } = {}) {
  const rep = pickFinancialReport(reports);
  if (!rep) return null;

  const { docs } = await listSubDocs(rep.rcpNo);
  if (!docs.length) return { ok: false, why: 'no-subdoc', rcpNo: rep.rcpNo, report: rep.report };

  let best = null;
  for (const d of docs.slice(0, maxDocs)) {
    let body;
    try { body = await fetchDoc(d); } catch { continue; }
    const f = extractFromDoc(body, rep.date);   // 제출일(YYYY.MM.DD) — 회계연도 상한 계산에 쓴다
    const score = [f.revenue, f.operatingProfit, f.equity].filter(v => v !== null).length;
    if (!best || score > best.score) best = { ...f, score };
    if (score === 3) break;
  }
  if (!best) return { ok: false, why: 'no-doc', rcpNo: rep.rcpNo, report: rep.report };
  return {
    ok: best.score >= 2,
    year: best.fiscalYear ?? Number(rep.date.slice(0, 4)) - 1,
    revenue: best.revenue, operatingProfit: best.operatingProfit, equity: best.equity,
    report: rep.report, rcpNo: rep.rcpNo, date: rep.date, source: 'dart-audit',
  };
}
