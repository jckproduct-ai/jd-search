#!/usr/bin/env node
/**
 * 회귀 테스트 — 네트워크 없이 돈다.
 *
 * 실행: node test/run.mjs
 *
 * 여기 들어 있는 것은 **전부 실제로 값을 치른 사고**다. 새 기능을 넣다가 이 중 하나라도 깨지면,
 * 사용자는 잘못된 회사 재무를 보고 지원 결정을 내리거나(오매칭), 흑자·적자가 뒤집힌 등급을 본다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCorp } from '../lib/match.mjs';
import { nameVariants, normCorp, similarity, matchesAny } from '../lib/text.mjs';
import { parseSubDocs, parseSearchRows, pickFinancialReport } from '../lib/dart.mjs';
import { extractFromDoc } from '../lib/dart_table.mjs';
import { parseRegion, regionVerdict, regionVerdictAny, AMBIGUOUS_DISTRICTS } from '../lib/region.mjs';
import { parseList, parseDetail, parseBody, splitAreas, parseCareer, jdMarkdown as saraminJd, normalize as saraminNormalize, planDetailBudget } from '../lib/saramin.mjs';
import { parsePostingUrl } from '../lib/board_url.mjs';
import { isSamePosting, planMerge, pickPrimary, regionKeys, mergeVerdicts, normalizeTitle } from '../lib/merge.mjs';
import { gradeCompany, compareToBaseline, interviewQuestions } from '../lib/grade.mjs';
import { investmentEvents, summarizeInvestment, investmentLine, monthsSince } from '../lib/investment.mjs';
import { isCacheFresh, expectedFiscalYear } from '../lib/freshness.mjs';
import { parseYaml } from '../lib/yaml.mjs';
import { requireSourceEnabled, SOURCE_MODES } from '../lib/io.mjs';
import { experienceTags, EXPERIENCE_TAG_LABEL } from '../lib/experience.mjs';
import { mask, diagnose, kindOfStatus, HttpError, NetworkError } from '../lib/http.mjs';
import { summarizeRuns, runsOf, kindFromRecord } from '../lib/runstatus.mjs';
import { runIntegration } from './integration.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = f => fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8');

let pass = 0; const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fails.push(`${label}${extra ? `\n      ${extra}` : ''}`);
}
const eq = (a, b, label) => ok(a === b, label, `기대 ${JSON.stringify(b)} / 실제 ${JSON.stringify(a)}`);
function group(name, fn) { console.log(`\n── ${name}`); fn(); }

// ══ 1. 오매칭 5건 — 이 저장소에서 가장 중요한 테스트 ══════════════════════════
group('오매칭 가드 (실측 사고 5건)', () => {
  const data = JSON.parse(fx('mismatch-cases.json'));

  for (const c of data.cases) {
    // 🔴 실제 파이프라인은 원본 이름이 아니라 **검색에 쓴 변형**으로 대조한다.
    //    변형 하나라도 채택되면 그 회사 재무가 붙는다 — 전부 막혀야 한다.
    for (const variant of nameVariants(c.name)) {
      const r = resolveCorp(c.candidates, variant, { region: c.region });
      ok(r.status !== 'exact',
        `  ${c.name} (변형 "${variant}") 는 채택되지 않아야 한다 (실측 오매칭: ${c.wrongly_matched_to})`,
        `status=${r.status} corp=${r.corp?.corpNm ?? '-'}`);
      const r2 = resolveCorp(c.candidates, variant, {});
      ok(r2.status !== 'exact', `  ${c.name} (변형 "${variant}") — 지역 힌트 없이도 채택 금지`, `status=${r2.status}`);
    }
  }

  for (const c of data.must_match) {
    const r = resolveCorp(c.candidates, c.name, { region: c.region });
    eq(r.status, 'exact', `  ${c.name} 는 정상 채택돼야 한다 (가드가 지나치면 제품이 죽는다)`);
  }

  // 법인등록번호가 있으면 이름보다 강한 근거다.
  const byCrno = resolveCorp(
    [{ corpNm: '전혀 다른 상호', crno: '1101114525030', addr: '서울' }],
    '번개장터', { crno: '110111-4525030' });
  eq(byCrno.status, 'exact', '  법인등록번호 일치는 상호가 달라도 채택');

  // 🔴 반대 방향이 진짜 위험하다 — 번호를 아는데 불일치면 **상호가 같아도 다른 법인**이다.
  //    여기서 이름 매칭으로 흘려보내면 강한 근거(번호)를 약한 근거(상호)가 덮어쓴다.
  const crnoMismatch = resolveCorp(
    [{ corpNm: '동명회사', crno: '2222222222222', addr: '서울' }],
    '동명회사', { crno: '1111111111111' });
  eq(crnoMismatch.status, 'none', '  법인등록번호 불일치는 상호가 같아도 채택 금지');
  eq(crnoMismatch.reason, 'crno-mismatch', '  불일치 사유를 남긴다');

  // 후보 어느 쪽도 번호가 없으면 대조 자체가 불가능하다 → 이름 매칭으로 내려가야 한다.
  const noCrnoAnywhere = resolveCorp(
    [{ corpNm: '동명회사', addr: '서울' }], '동명회사', { crno: '1111111111111' });
  eq(noCrnoAnywhere.status, 'exact', '  후보에 번호가 아예 없으면 이름으로 판정');

  // 같은 법인이 연도별로 중복 응답돼도 동명이인으로 오판하지 않아야 한다.
  const dup = resolveCorp(
    [{ corpNm: '번개장터 주식회사', crno: '1101114525030', addr: 'A' },
     { corpNm: '번개장터 주식회사', crno: '1101114525030', addr: 'A' }],
    '번개장터');
  eq(dup.status, 'exact', '  crno가 같은 중복 응답은 한 건으로 접는다');
});

// ══ 2. 회사명 변형 — 오매칭의 발화점 ═════════════════════════════════════════
group('회사명 변형', () => {
  const v = nameVariants('(주)골프존');
  ok(!v.includes('주'), '  "(주)"의 "주"를 별칭으로 뽑지 않는다', JSON.stringify(v));
  ok(!v.some(x => /^주\s/.test(x)), '  "주 주식회사" 같은 변형을 만들지 않는다', JSON.stringify(v));
  ok(v.includes('골프존'), '  법인 형태를 뗀 "골프존"은 포함한다', JSON.stringify(v));

  const v2 = nameVariants('미소(Miso)');
  ok(v2.includes('Miso'), '  괄호 안 영문 별칭은 변형으로 인정', JSON.stringify(v2));
  ok(v2.includes('미소'), '  괄호를 뗀 이름도 포함', JSON.stringify(v2));

  // 🔴 사람인 실측 — 국문·영문을 슬래시로 병기한다. 그 이름의 법인은 어디에도 없다.
  const v3 = nameVariants('(주)아이클레이브 / iclave');
  ok(v3.includes('아이클레이브'), '  슬래시 병기: 국문 상호를 후보로 뽑는다', JSON.stringify(v3));
  ok(v3.includes('iclave'), '  슬래시 병기: 영문 상호도 후보로 뽑는다', JSON.stringify(v3));

  // 이름 안의 슬래시까지 쪼개면 **없는 회사**를 만들어 낸다 — 공백으로 둘러싸인 것만 본다.
  const v4 = nameVariants('에이/비스토어');
  ok(!v4.includes('에이'), '  이름 속 슬래시는 쪼개지 않는다', JSON.stringify(v4));

  eq(normCorp('주식회사 컬리'), '컬리', '  normCorp: 주식회사 제거');
  eq(normCorp('(주)컬리'), '컬리', '  normCorp: (주) 제거');
  eq(normCorp('㈜ 컬리'), '컬리', '  normCorp: ㈜ 제거');
  eq(normCorp('컬리 주식회사'), '컬리', '  normCorp: 후치 주식회사 제거');
  ok(normCorp('골프존') !== normCorp('골프존커머스'), '  다른 회사는 다르게 정규화된다');

  ok(similarity('서비스 기획자', '서비스기획자') > 0.8, '  유사도: 띄어쓰기 차이는 같은 제목으로 본다');
  ok(similarity('백엔드 개발자', '마케팅 매니저') < 0.3, '  유사도: 다른 직무는 낮게');

  // 🔴 재공고 연결(check_alive)의 임계값 0.8이 실제 제목에서 어떻게 갈리는지 못 박는다.
  //    느슨하면 남의 자리에 지원 이력이 승계되고, 빡빡하면 되찾기가 아예 안 된다.
  ok(similarity('서비스기획자 (경력 5년 이상)', '서비스기획자 (경력 5년이상)') >= 0.8,
    '  재공고 연결: 표기 차이뿐인 같은 자리는 이어진다');
  ok(similarity('서비스기획자 (경력 5년 이상)', 'Senior Backend Engineer (7년 이상)') < 0.8,
    '  🔴 재공고 연결: 같은 회사의 다른 직무는 이어지지 않는다');
  ok(similarity('프로덕트 매니저 (커머스)', '프로덕트 매니저 (물류)') < 0.8,
    '  재공고 연결: 같은 직군이라도 다른 자리는 자동 연결하지 않는다');

  // 영문 약어는 낱말 경계를 봐야 한다 — 안 그러면 PMO·POC가 전부 걸린다.
  ok(matchesAny('PM 채용', ['PM']).length === 1, '  키워드 PM 매칭');
  ok(matchesAny('PMO 담당자', ['PM']).length === 0, '  PMO는 PM에 걸리지 않는다');
  ok(matchesAny('서비스기획자 채용', ['서비스기획']).length === 1, '  한글 키워드는 부분일치');
});

// ══ 3. 파서 함정 3건 ════════════════════════════════════════════════════════
group('DART 파서 함정', () => {
  // 함정 1 — 뷰어 목차는 cnt['dcmNo'] = "…" 순차 할당이다.
  //          viewDoc('a','b',…) 6인자로 가정했다가 20곳 전부 "파싱 실패"가 났다.
  const { docs } = parseSubDocs(fx('dart-viewer-toc.html'), '20260409002808');
  ok(docs.length > 0, '  함정1: 뷰어 목차에서 하위 문서를 찾는다 (데이터 부재와 파서 버그를 구분하라)',
    `docs=${docs.length}`);
  ok(docs.every(d => d.dcmNo && d.length), '  함정1: dcmNo·length가 모두 채워진다');
  ok(docs[0].size >= (docs[docs.length - 1]?.size ?? 0), '  함정1: 큰 문서(재무제표 본문)가 앞에 온다');

  // 함정 1 폴백 — 옛 형식(viewDoc 인라인 호출)도 읽어야 한다.
  const legacy = parseSubDocs(`<a href="#" onclick="viewDoc('20260409002808','11299357','','0','178612','dart3.xsd')">재무제표</a>`);
  ok(legacy.docs.length === 1, '  함정1: viewDoc 인라인 폴백');

  // 함정 2 — 주석 컬럼("23,28")을 값으로 집으면 쿠팡 매출이 23.3억이 된다.
  const note = extractFromDoc(fx('note-column-table.html'), '2026.04.09');
  eq(note.revenue, 41898416 * 1e6, '  함정2: 주석 컬럼을 금액으로 집지 않는다 (매출 41.9조)');
  eq(note.equity, 1234567 * 1e6, '  함정2: 자본총계도 주석 컬럼을 건너뛴다');

  // 함정 3 — 적자면 계정명이 "영업손실"이 되고 값은 양수로 적힌다. 부호가 라벨에 실린다.
  eq(note.operatingProfit, -105239 * 1e6, '  함정3: "영업손실"은 음수로 뒤집는다');

  // 함정 4 — 회계연도를 문서 내 날짜 최댓값으로 잡으면 리스 만기(2029년)가 걸린다.
  eq(note.fiscalYear, 2025, '  함정4: 미래 날짜(리스 만기 2029년)를 회계연도로 잡지 않는다');

  // 실제 감사보고서 원문 (번개장터 2025) — 숫자를 원문과 육안 대조해 둔 값이다.
  const real = extractFromDoc(fx('dart-income-table.html'), '2026.04.09');
  eq(real.revenue, 58178348703, '  실물: 번개장터 매출 581.8억');
  eq(real.operatingProfit, -19883316582, '  실물: 번개장터 영업손실 -198.8억 (흑자로 뒤집히면 안 된다)');
  eq(real.fiscalYear, 2025, '  실물: 회계연도 2025 (제출 2026.04.09)');

  // 제출일이 12월 31일이 아니면 그 해는 회계연도가 될 수 없다.
  const capped = extractFromDoc('<p>2026년 12월 31일 현재</p><p>2025년 12월 31일 현재</p>', '2026.04.03');
  eq(capped.fiscalYear, 2025, '  함정4: 아직 오지 않은 결산일은 회계연도가 아니다');

  // 공시검색 행 파싱 + 보고서 선택 (별도 우선)
  const rows = parseSearchRows(
    `<td><a href="#" onclick="openCorpInfoNew('01554164','popup')" title="번개장터 기업개황 새창">번개장터</a></td>` +
    `<td><a href="/dsaf001/main.do?rcpNo=20260409002808" title="감사보고서 공시뷰어 새창">감사보고서</a></td><td>2026.04.09</td>`);
  eq(rows.length, 1, '  공시검색 행 파싱');
  eq(rows[0].corpCode, '01554164', '  corp_code 추출');
  eq(rows[0].rcpNo, '20260409002808', '  rcpNo 추출');

  const picked = pickFinancialReport([
    { report: '연결감사보고서', date: '2026.04.09', rcpNo: 'a' },
    { report: '감사보고서', date: '2026.04.09', rcpNo: 'b' },
    { report: '감사보고서', date: '2024.04.17', rcpNo: 'c' },
  ]);
  eq(picked.rcpNo, 'b', '  별도(비연결) 감사보고서를 우선하고 최신을 고른다');
  eq(pickFinancialReport([{ report: '주요사항보고서', date: '2026.01.01' }]), null, '  재무가 없는 공시는 고르지 않는다');

  // 🔴 종류와 날짜가 충돌할 때 — **최신 연도가 먼저다.**
  //    종류를 먼저 보면 3년 전 사업보고서가 올해 감사보고서를 이겨, 올해 공시가 있는 회사가
  //    "3년 이상 낡음 → 미확인"으로 사라진다. 상장 폐지·비상장 전환한 회사에서 정확히 이 일이 난다.
  eq(pickFinancialReport([
    { report: '사업보고서', date: '2023.03.01', rcpNo: 'old' },
    { report: '감사보고서', date: '2026.04.01', rcpNo: 'new' },
  ]).rcpNo, 'new', '  3년 전 사업보고서보다 올해 감사보고서가 먼저다');
  eq(pickFinancialReport([
    { report: '감사보고서', date: '2026.04.20', rcpNo: 'audit' },
    { report: '사업보고서', date: '2026.03.20', rcpNo: 'annual' },
  ]).rcpNo, 'annual', '  같은 해 안에서는 사업보고서를 우선한다');
});

// ══ 4. 지역 판정 ════════════════════════════════════════════════════════════
group('지역 판정', () => {
  eq(parseRegion('서울특별시 강남구 테헤란로 152').sigungu, '강남구', '  정식 표기');
  eq(parseRegion('서울시 중구 을지로 158').sigungu, '중구', '  축약 표기("서울시")도 구를 읽는다');
  eq(parseRegion('경기도 성남시 분당구 판교로 242').sigungu, '성남시 분당구', '  시 아래 구는 붙여서 구분한다');
  eq(parseRegion('경기 성남시 수정구 대왕판교로 815').sigungu, '성남시 수정구', '  분당구와 수정구를 섞지 않는다');
  eq(parseRegion('관악구 남부순환로 1832').sigungu, '관악구', '  시·도가 빠져도 구는 읽는다');
  eq(parseRegion('').sigungu, null, '  빈 주소');

  const want = { regions: ['강남구', '서초구', '성남시 분당구'] };
  eq(regionVerdict('서울 강남구 테헤란로 152', want).verdict, 'pass', '  희망 지역 안');
  eq(regionVerdict('서울 종로구 새문안로 76', want).verdict, 'out', '  희망 지역 밖');
  eq(regionVerdict('경기 성남시 수정구 대왕판교로 815', want).verdict, 'out', '  같은 시라도 다른 구는 밖');
  // 🔴 광역만 적힌 공고를 구 단위 조건과 비교할 수는 없다 → 버리지 말고 hold로 남긴다.
  eq(regionVerdict('서울', want).verdict, 'unknown', '  광역만 있으면 판정 불가(=hold)');
  eq(regionVerdict('디지털로31길 12, 8층', want).verdict, 'unknown', '  시·도·구가 없으면 판정 불가');
  eq(regionVerdict('', want).verdict, 'unknown', '  근무지 비공개는 판정 불가');
  eq(regionVerdict('서울 강남구', { regions: [] }).verdict, 'pass', '  조건이 없으면 전국');
  eq(regionVerdict('부산 해운대구', { regions: [], denyRegions: ['해운대구'] }).verdict, 'deny', '  제외 지역');
  // 도로명이 구 이름을 품어도 통과시키면 안 된다.
  eq(regionVerdict('서울 종로구 강남대로 1', want).verdict, 'out', '  도로명("강남대로")에 낚이지 않는다');

  // 🔴 전국 광역시에 같은 이름의 구가 있다. 사용자가 시·도를 명시했으면 반드시 지켜야 한다.
  //    `'서울중구'.includes('중구')` 가 참이라 부산 중구가 통과하던 사고를 막는다.
  eq(regionVerdict('부산광역시 중구 중앙대로 1', { regions: ['서울 중구'] }).verdict, 'out',
    '  "서울 중구"를 지정했으면 부산 중구는 범위 밖이다');
  eq(regionVerdict('서울특별시 중구 을지로 1', { regions: ['서울 중구'] }).verdict, 'pass',
    '  같은 조건에서 서울 중구는 통과');
  eq(regionVerdict('대구광역시 서구 국채보상로 1', { regions: ['서울 서구'] }).verdict, 'out',
    '  대구 서구도 마찬가지');
  eq(regionVerdict('서울 강남구 테헤란로 1', { regions: ['강남'] }).verdict, 'pass',
    '  단위(구)를 생략해 적은 것은 인정한다');
  // 시·도 없이 적은 이름은 여전히 전국이 걸린다 — 게이트가 이걸 경고한다.
  ok(AMBIGUOUS_DISTRICTS.includes('중구'), '  모호한 구 이름 목록에 중구가 있다 (게이트 경고용)');

  // 🔴 근무지가 여러 곳인 공고(사람인) — 하나라도 들면 통과다.
  const w = { regions: ['강남구'], denyRegions: ['해운대구'] };
  eq(regionVerdictAny(['서울 강남구', '대전 서구'], w).verdict, 'pass', '  다중 근무지: 하나만 들어도 통과');
  eq(regionVerdictAny(['부산 해운대구', '서울 강남구'], w).verdict, 'pass',
    '  🔴 다중 근무지: 제외 지역이 섞여 있어도 갈 수 있는 곳이 있으면 통과');
  eq(regionVerdictAny(['부산 해운대구'], w).verdict, 'deny', '  다중 근무지: 전부 제외 지역이면 제외');
  eq(regionVerdictAny(['대전 서구', '전북 김제시'], w).verdict, 'out', '  다중 근무지: 전부 범위 밖이면 밖');
  eq(regionVerdictAny(['서울', '대전 서구'], w).verdict, 'unknown',
    '  다중 근무지: 광역만 적힌 항목이 있으면 판정 불가(=hold)로 남긴다');
  eq(regionVerdictAny([], w).verdict, 'unknown', '  근무지가 아예 없으면 판정 불가');
});

// ══ 4-a2. 상세 조회 예산 — 첫 실행 전량 · 이후 상한 ═══════════════════════════
group('상세 조회 예산', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `p${i}`);
  const none = () => true;                       // 하나도 안 받아 둔 상태

  const first = planDetailBudget(ids, none, { firstRun: true });
  eq(first.allowed.size, 500, '  🔴 첫 실행은 전량 받는다 (상한 없음)');
  eq(first.cutOff, 0, '  첫 실행에는 잘린 건이 없다');
  ok(first.firstRunFull, '  첫 실행 전량임을 알린다 (안내 문구의 조건)');

  const again = planDetailBudget(ids, none, { firstRun: false });
  eq(again.allowed.size, 200, '  재실행은 기본 200건까지');
  eq(again.cutOff, 300, '  잘린 300건을 센다');
  ok(!again.firstRunFull, '  재실행에서는 전량 안내를 하지 않는다');

  // 🔴 사용자가 적은 값이 최우선이다 — 첫 실행이어도 그대로 따른다.
  const capped = planDetailBudget(ids, none, { maxFlag: '50', firstRun: true });
  eq(capped.allowed.size, 50, '  --max 를 적었으면 첫 실행이어도 그 값이 이긴다');
  eq(capped.cutOff, 450, '  그때도 잘린 건수를 센다');
  ok(!capped.firstRunFull, '  명시 상한이면 전량 안내를 하지 않는다');

  // 🔴 상한은 **받아야 하는 건수**를 센다. 이미 받아 둔 것까지 세면
  //    목록 뒤쪽의 새 공고가 영영 안 받아진다 — 조용한 손실이 상한 뒤에 쌓인다.
  const cachedFirst450 = id => Number(id.slice(1)) >= 450;   // 앞 450건은 이미 보유
  const smart = planDetailBudget(ids, cachedFirst450, { firstRun: false });
  eq(smart.allowed.size, 50, '  🔴 이미 받아 둔 건은 상한에서 세지 않는다');
  eq(smart.cutOff, 0, '  받아야 할 50건이 상한 안에 들어와 잘린 건이 없다');
  ok(smart.allowed.has('p499'), '  목록 뒤쪽의 새 공고도 상한 안에 들어온다');

  eq(planDetailBudget(ids, none, { maxFlag: '0', firstRun: false }).allowed.size, 0,
    '  --max 0 은 상세를 하나도 받지 않는다 (목록만 갱신)');
  eq(planDetailBudget(ids, none, { maxFlag: true, firstRun: true }).allowed.size, 500,
    '  값 없는 --max 는 무시하고 규칙대로 간다');
});

// ══ 4-b. 사람인 파싱 (실물 HTML fixture) ════════════════════════════════════
group('사람인 파싱', () => {
  const items = parseList(fx('saramin-list.html'));
  eq(items.length, 4, '  목록에서 공고 4건을 읽는다');

  const first = items.find(i => i.id === '53930400');
  eq(first.company, '(주)수산아이앤티', '  회사명');
  ok(first.title.includes('서비스기획'), '  제목은 title 속성에서 뽑는다 (검색어 <b> 태그가 섞이지 않는다)', first.title);
  ok(!/<b>|<\/b>/.test(first.title), '  🔴 제목에 HTML 태그가 남지 않는다', first.title);
  eq(first.sido, '서울', '  시·도');
  eq(first.district, '강남구', '  시·군·구');
  ok(first.csn && first.csn.length > 8, '  회사 식별자(csn)를 읽는다 — 회사 단위 재검색에 쓴다');
  eq(first.careerLabel, '신입·경력', '  경력 표기');
  ok(first.sectors.includes('사업기획'), '  직무 카테고리');

  // 🔴 목록의 마감 표기에는 연도가 없다. 그대로 날짜로 쓰면 안 된다.
  ok(/^~ \d{2}\/\d{2}/.test(first.dueLabel), '  목록 마감 표기는 연도가 없는 원문 그대로 둔다', first.dueLabel);
  eq(items.find(i => i.id === '54526680').dueLabel, '상시채용', '  상시채용 표기');
  eq(items.find(i => i.id === '54586091').dueLabel, '채용시', '  채용시 표기');

  // 🔴 마감 판정 4형태 — 상태 블록 하나로만 판정한다. 날짜 경과는 근거가 아니다.
  const active = parseDetail(fx('saramin-detail-active.html'));
  eq(active.state, 'active', '  info_timer = 진행중');
  eq(active.dueKind, 'date', '  기간형');
  eq(active.dueTime, '2026-09-20T23:59:00+09:00', '  마감일시를 ISO로');

  const closedD = parseDetail(fx('saramin-detail-closed.html'));
  eq(closedD.state, 'closed', '  "마감되었습니다" = 마감');

  const always = parseDetail(fx('saramin-detail-always.html'));
  eq(always.state, 'active', '  🔴 상시채용은 마감일이 없어도 진행중이다');
  eq(always.dueKind, 'always', '  상시채용 표시');
  eq(always.dueTime, null, '  상시채용은 마감일이 없다');

  const until = parseDetail(fx('saramin-detail-untilfilled.html'));
  eq(until.state, 'active', '  🔴 채용시 마감도 진행중이다 (날짜 경과로 죽이면 22%가 사라진다)');
  eq(until.dueKind, 'untilFilled', '  채용시 마감 표시');

  // 🔴 다중 근무지 — 목록은 첫 곳만 준다. 상세에서 전부 받아야 다닐 수 있는 자리를 안 버린다.
  ok(active.areas.includes('서울 강남구') && active.areas.includes('대전 서구'),
    '  다중 근무지를 전부 읽는다', JSON.stringify(active.areas));
  ok(active.areas.includes('서울 서초구'),
    '  🔴 시·도가 생략된 항목("서초구")은 앞 항목의 시·도를 물려받는다 — 전국의 서초구가 되면 안 된다',
    JSON.stringify(active.areas));
  eq(splitAreas('서울 강남구, 부산전체, 중구').join('|'), '서울 강남구|부산|부산 중구',
    '  🔴 시·도가 바뀌면 그 뒤 항목은 바뀐 시·도를 따른다 (부산 중구지 서울 중구가 아니다)');
  eq(splitAreas('').length, 0, '  빈 근무지');

  eq(active.careerLabel, '신입·경력', '  핵심 정보: 경력');
  eq(active.educationLabel, '대졸(4년제) 이상', '  핵심 정보: 학력');

  // 경력 표기 → 연차
  eq(parseCareer('경력 6년 ↑').from, 6, '  "경력 6년 ↑" → 하한 6');
  eq(parseCareer('경력10년↑').from, 10, '  띄어쓰기 없는 표기도 읽는다');
  eq(parseCareer('경력 3~5년').to, 5, '  "3~5년" → 상한 5');
  eq(parseCareer('경력무관').from, 0, '  경력무관 = 0');
  eq(parseCareer('신입·경력 3년 ↓').from, 0, '  "신입·경력 3년 ↓" 의 하한은 신입');
  eq(parseCareer('경력').from, null, '  연차를 안 적었으면 지어내지 않는다');

  // 상세에서도 제목·회사·csn 을 읽는다 — 주소만으로 추가할 때(add_posting) 유일한 출처다.
  ok(active.title?.includes('서비스기획'), '  상세에서 제목을 읽는다', String(active.title));
  eq(active.company, '(주)수산아이앤티', '  상세에서 회사명을 읽는다');
  ok(active.csn?.length > 8, '  상세에서 csn 을 읽는다');

  // 🔴 본문이 이미지뿐인 공고 — 실측 14건 중 3건. 빈 파일을 "원문 확보"로 세면 안 된다.
  const bodyText = parseBody(fx('saramin-body-text.html'));
  eq(bodyText.kind, 'text', '  글자 본문은 text');
  ok(bodyText.text.length > 200, '  본문 글자를 담는다', String(bodyText.text.length));

  const bodyImg = parseBody(fx('saramin-body-imageonly.html'));
  eq(bodyImg.kind, 'imageOnly', '  🔴 상세요강이 이미지뿐이면 imageOnly 로 구분한다');
  ok(bodyImg.images.length > 0, '  이미지 주소를 남긴다 (공고가 내려가기 전에 열어 볼 수 있게)', String(bodyImg.images.length));
  ok(bodyImg.text.length < 60, '  이미지형은 글자가 사실상 없다', JSON.stringify(bodyImg.text));

  eq(parseBody('<div></div>').kind, 'empty', '  이미지도 글자도 없으면 empty');

  // 🔴 없는 것을 있는 것처럼 저장하지 않는다.
  const md = saraminJd(first, active, bodyImg);
  ok(md.includes('이미지로만'), '  🔴 JD 원문에 "본문이 이미지뿐"이라고 적는다');
  ok(md.includes('본문 형태: 이미지만'), '  본문 형태를 머리말에 적는다');
  ok(bodyImg.images.every(u => md.includes(u)), '  이미지 주소를 전부 적는다');
  ok(saraminJd(first, active, null).includes('본문을 받지 못했습니다'),
    '  조회 실패는 "이미지뿐"과 다르게 적는다 (다음 실행에 다시 받아야 한다)');

  // 레코드 정규화 — 뒤 단계가 보드를 가리지 않아야 한다.
  const rec = saraminNormalize(first, active, ['서비스기획'], bodyText);
  eq(rec.board, 'saramin', '  레코드 board');
  eq(rec.status, 'active', '  레코드 status');
  eq(rec.location.lat, null, '  🔴 사람인은 좌표를 주지 않는다 — 없는 값을 지어내지 않는다');
  ok(rec.location.all.length > 1, '  다중 근무지를 location.all 에 담는다');
  eq(rec.company.boardId, first.csn, '  csn 을 boardId 로 넘긴다');
  eq(rec.jdKind, 'text', '  본문 형태를 레코드에 남긴다 (재수집 판단에 쓴다)');
  eq(saraminNormalize(first, active, [], bodyImg).jdKind, 'imageOnly', '  이미지형도 레코드에 남긴다');
  eq(saraminNormalize(first, active, [], null).jdKind, 'failed', '  조회 실패도 구분해 남긴다');
});

// ══ 4-d. 공고 주소 파싱 (수동 추가·serve) ═══════════════════════════════════
group('공고 주소 파싱', () => {
  eq(parsePostingUrl('https://www.wanted.co.kr/wd/123456')?.id, '123456', '  원티드 /wd/');
  eq(parsePostingUrl('https://www.wanted.co.kr/wd/123456?ref=x#a')?.board, 'wanted', '  쿼리·해시가 붙어도 읽는다');
  eq(parsePostingUrl('https://www.saramin.co.kr/zf_user/jobs/relay/view?view_type=search&rec_idx=54586091')?.id,
    '54586091', '  사람인 rec_idx');

  // 🔴 호스트를 정확히 본다. 문자열 포함 검사면 아래가 전부 통과한다.
  const evil = [
    'https://evil.example.com/?x=wanted.co.kr/wd/123',
    'https://wanted.co.kr.evil.com/wd/123',
    'https://notsaramin.co.kr/zf_user/jobs/relay/view?rec_idx=1',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '아무말',
  ];
  for (const u of evil) eq(parsePostingUrl(u), null, `  🔴 거부: ${u.slice(0, 42)}`);
  eq(parsePostingUrl('https://www.wanted.co.kr/company/123'), null, '  공고가 아닌 원티드 주소는 거부');
  eq(parsePostingUrl('https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=abc'), null, '  숫자가 아닌 rec_idx 는 거부');
});

// ══ 4-c. 교차 보드 병합 ═════════════════════════════════════════════════════
group('교차 보드 병합', () => {
  const W = (over = {}) => ({
    board: 'wanted', id: '1', title: '서비스기획자 (경력 5년 이상)',
    company: { name: '(주)위펀', boardId: 100 },
    location: { label: '서울', district: '강남구', full: '서울특별시 강남구 테헤란로 1', lat: 37.5, lng: 127 },
    status: 'active', collectedAt: '2026-08-10T00:00:00Z', jd: '/x.md', ...over,
  });
  const S = (over = {}) => ({
    board: 'saramin', id: '2', title: '서비스기획자 (경력 5년이상)',
    company: { name: '위펀', boardId: 'csn1' },
    location: { label: '서울', district: '강남구', full: '서울 강남구', lat: null, lng: null, all: ['서울 강남구'] },
    status: 'active', collectedAt: '2026-08-10T01:00:00Z', ...over,
  });

  ok(isSamePosting(W(), S()).same, '  회사·제목·지역이 맞으면 같은 자리로 본다');

  // ── 제목 정규화 — 보드마다 다르게 붙이는 수식어만 뗀다 ────────────────────
  // 🔴 실측 (2026-08-10): 같은 자리가 이렇게 갈려 유사도 0.64로 보류됐다.
  eq(normalizeTitle('서비스기획 팀원 (부산)'), '서비스기획 팀원', '  괄호 안 지역 표기는 뗀다');
  eq(normalizeTitle('서비스기획 팀원 (신입~5년 이하 / 부산)'), '서비스기획 팀원', '  경력+지역 표기도 뗀다');
  ok(similarity(normalizeTitle('서비스기획 팀원 (부산)'), normalizeTitle('서비스기획 팀원 (신입~5년 이하 / 부산)')) >= 0.8,
    '  🔴 실측 사례: 조건 표기를 떼면 같은 자리로 이어진다');
  // 🔴 그렇다고 괄호를 전부 떼면 다른 자리가 합쳐진다.
  eq(normalizeTitle('프로덕트 매니저 (커머스)'), '프로덕트 매니저 (커머스)', '  🔴 내용이 든 괄호는 떼지 않는다');
  ok(similarity(normalizeTitle('프로덕트 매니저 (커머스)'), normalizeTitle('프로덕트 매니저 (물류)')) < 0.8,
    '  🔴 커머스 PM 과 물류 PM 은 여전히 다른 자리다');
  eq(normalizeTitle('[위펀]서비스기획 / PO', '(주)위펀'), '서비스기획 / PO', '  제목 앞 회사명 대괄호는 뗀다');
  eq(normalizeTitle('[신입]서비스기획', '(주)위펀'), '서비스기획', '  회사명이 아닌 대괄호도 조건 표기면 뗀다');
  eq(normalizeTitle('[백엔드]서비스기획', '(주)위펀'), '[백엔드]서비스기획', '  🔴 조건이 아닌 대괄호는 그대로 둔다');
  eq(normalizeTitle('서비스기획자 (경력 5년 이상)'), '서비스기획자', '  "경력 5년 이상"은 조건이다');

  // 실측 사례 전체 판정
  const D1 = { board: 'saramin', id: 'a', title: '서비스기획 팀원 (부산)', company: { name: '(주)더블미디어' },
    location: { all: ['부산 해운대구'] }, status: 'active' };
  const D2 = { board: 'wanted', id: 'b', title: '서비스기획 팀원 (신입~5년 이하 / 부산)', company: { name: '더블미디어' },
    location: { full: '부산광역시 해운대구 센텀중앙로 90' }, status: 'active' };
  ok(isSamePosting(D1, D2).same, '  🔴 실측 교차 보드 중복(더블미디어)을 합친다', JSON.stringify(isSamePosting(D1, D2)));

  // 🔴 아래는 전부 "합치면 안 된다"는 검사다. **`same` 을 반드시 함께 본다** —
  //    사유(`why`)만 보면 판정이 뒤집혀도 통과한다(실제로 뮤테이션 검증에서 이 테스트가 안 물었다).
  const nope = (v, label, extra) => { ok(v.same === false, label, extra ?? `same=${v.same} why=${v.why}`); return v; };

  nope(isSamePosting(W(), W({ id: '9' })), '  같은 보드끼리는 병합하지 않는다 (id 로 이미 접힌다)');

  // 🔴 부분일치 5건 사고와 같은 원칙 — 회사명은 완전일치만.
  eq(nope(isSamePosting(W(), S({ company: { name: '위펀무역' } })),
    '  🔴 회사명 부분일치("위펀" ⊂ "위펀무역")로 합치지 않는다').why, 'company-differs', '  사유: 회사 불일치');

  eq(nope(isSamePosting(W(), S({ title: 'Senior Backend Engineer' })),
    '  같은 회사의 다른 직무는 합치지 않는다').why, 'title-below-threshold', '  사유: 제목 유사도 미달');

  // 🔴 지역을 모르면 합치지 않는다. 잘못 합치면 한 건이 조용히 사라진다.
  eq(nope(isSamePosting(W(), S({ location: { label: '서울', all: ['서울'] } })),
    '  🔴 한쪽 지역이 광역까지만이면 합치지 않고 보류한다').why, 'region-unknown', '  사유: 지역 판정 불가');
  eq(nope(isSamePosting(W(), S({ location: { all: ['부산 강남구'] } })),
    '  지역이 다르면 합치지 않는다').why, 'region-differs', '  사유: 지역 불일치');
  // 중·서·남·동·북·강서구 함정 — 시·도가 다르면 같은 구 이름이라도 다른 곳이다.
  eq(nope(isSamePosting(
    W({ location: { full: '서울특별시 중구 을지로 1' } }),
    S({ location: { all: ['부산 중구'] } })),
    '  🔴 서울 중구와 부산 중구를 한 건으로 합치지 않는다').why, 'region-differs', '  사유: 지역 불일치');

  ok(regionKeys(S()).has('서울강남구'), '  지역 키는 시·도까지 붙여 만든다');
  eq(regionKeys({ location: { all: ['중구'] } }).size, 0, '  시·도를 모르면 지역 키를 만들지 않는다');

  // 대표 선택 — 🔴 살아있는 쪽이 먼저다.
  eq(pickPrimary([W({ status: 'closed' }), S()]).board, 'saramin',
    '  🔴 한 보드에서 마감됐으면 살아있는 쪽을 대표로 (산 자리가 마감으로 보이면 안 된다)');
  eq(pickPrimary([W(), S()]).board, 'wanted', '  둘 다 살아있으면 좌표가 있는 쪽을 대표로');

  // 묶기
  const plan = planMerge([W(), S()]);
  eq(plan.groups.length, 1, '  한 묶음으로 합친다');
  eq(plan.groups[0].primary, 'wanted:1', '  대표 키');
  eq(plan.stats.merged, 1, '  중복 1건이 대표 아래로');

  // 🔴 비슷한 후보가 여럿이면 자동으로 잇지 않는다 (재공고 오연결과 같은 원칙).
  const many = planMerge([W(), S(), S({ id: '3', title: '서비스기획자 (경력 5년 이상자)' })]);
  eq(many.groups.length, 0, '  🔴 비슷한 후보가 여럿이면 아무것도 자동 병합하지 않는다');
  ok(many.candidates.length >= 2, '  대신 보류 후보로 남겨 사람이 보게 한다', String(many.candidates.length));

  // 사용자 결정은 규칙보다 우선한다.
  const forced = planMerge([W(), S({ title: '전혀 다른 제목' })], { 'saramin:2|wanted:1': 'merge' });
  eq(forced.groups.length, 1, '  사용자가 "합치기"로 정하면 규칙과 무관하게 합친다');
  const split = planMerge([W(), S()], { 'saramin:2|wanted:1': 'separate' });
  eq(split.groups.length, 0, '  사용자가 "따로 두기"로 정하면 규칙이 뒤집지 않는다');

  // 게이트 판정 합치기 — 가장 관대한 것.
  eq(mergeVerdicts([{ verdict: 'drop' }, { verdict: 'pass' }]).verdict, 'pass',
    '  🔴 묶음 안에서 하나라도 통과면 통과 (보드마다 근무지 표기가 달라 한쪽만 통과할 수 있다)');
  eq(mergeVerdicts([{ verdict: 'drop' }, { verdict: 'hold' }]).verdict, 'hold', '  drop 보다 hold 가 우선');
  eq(mergeVerdicts([]), null, '  판정이 없으면 null');
});

// ══ 4.5 투자 정보 ═══════════════════════════════════════════════════════════
// 🔴 재무제표는 작년 이야기다. 자본잠식으로 찍힌 회사가 올해 유상증자를 받았으면 상황이 다르다.
//    그런데 **자금이 들어온 공시와 나간 공시가 이름이 비슷하다.** 무상증자를 투자로 세면
//    회계 처리를 자금 유입으로 읽고, 자기주식 취득을 세면 **돈이 나간 회사가 받은 회사로 보인다.**
const REPORTS = [
  { report: '주요사항보고서(유상증자결정)', date: '2026.06.10', rcpNo: '111' },
  { report: '주요사항보고서(무상증자결정)', date: '2026.05.02', rcpNo: '112' },
  { report: '주요사항보고서(자기주식취득신탁계약체결결정)', date: '2026.04.01', rcpNo: '113' },
  { report: '주식소각결정', date: '2026.03.20', rcpNo: '114' },
  { report: '타법인주식및출자증권취득결정', date: '2026.03.02', rcpNo: '115' },
  { report: '주식등의대량보유상황보고서(일반)', date: '2026.02.11', rcpNo: '116' },
  { report: '주요사항보고서(전환사채권발행결정)', date: '2025.12.05', rcpNo: '117' },
  { report: '증권신고서(지분증권)', date: '2025.09.09', rcpNo: '118' },
  { report: '감사보고서제출', date: '2026.03.13', rcpNo: '119' },
];
const NOW = new Date(2026, 7, 18);   // 2026-08-18

group('투자 정보 — 자금이 들어온 것만 센다', () => {
  const ev = investmentEvents(REPORTS, { now: NOW });
  eq(ev.length, 3, '  조달성 공시 3건만 남는다');
  eq(ev.map(e => e.kind).join(','), 'paidInCapital,convertibleBond,securitiesEquity', '  최신순으로 정렬된다');

  const kinds = ev.map(e => e.title).join(' | ');
  ok(!/무상증자/.test(kinds), '  🔴 무상증자는 투자가 아니다 — 자금이 들어오지 않는다');
  ok(!/자기주식/.test(kinds), '  🔴 자기주식 취득은 자금이 나가는 것이다');
  ok(!/주식소각/.test(kinds), '  🔴 주식 소각도 자금이 나간다');
  ok(!/타법인/.test(kinds), '  🔴 타법인 주식 취득은 회사가 남에게 투자한 것이다');
  ok(!/대량보유/.test(kinds), '  🔴 대량보유 보고는 기존 주주끼리의 매매다');
  ok(!/감사보고서/.test(kinds), '  정기보고서는 조달이 아니다');

  eq(ev[0].date, '2026-06-10', '  날짜를 YYYY-MM-DD 로 정규화한다');
  eq(ev[0].url, 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=111', '  공시 원문 링크를 만든다 — 링크가 곧 근거다');
  eq(ev[0].equity, true, '  유상증자는 지분 조달');
  eq(ev[1].equity, false, '  🔴 전환사채는 부채로 들어온 돈이다 — 지분 조달이 아니다');

  eq(monthsSince('2026.06.10', NOW), 2, '  개월 수 계산');
  eq(monthsSince('2025.08.18', NOW), 12, '  1년 전은 12개월');
  eq(monthsSince('알 수 없음', NOW), null, '  🔴 못 읽으면 0 이 아니라 null 이다');

  const sum = summarizeInvestment(ev);
  eq(sum.count, 3, '  건수');
  eq(sum.recentEquity, true, '  최근 12개월 안의 지분 조달이 있다');
  ok(/금액은 공시 원문에서 확인/.test(investmentLine(sum)), '  🔴 금액을 모른다는 사실을 문구에서 빼지 않는다');

  // 전환사채만 있는 회사 — 부채다. 자본잠식 판정을 뒤집을 근거가 못 된다.
  const cbOnly = summarizeInvestment(investmentEvents(
    [{ report: '주요사항보고서(전환사채권발행결정)', date: '2026.07.01', rcpNo: '1' }], { now: NOW }));
  eq(cbOnly.recentEquity, false, '  🔴 전환사채만으로는 "최근 지분 조달"이 아니다');

  // 오래된 유상증자 — 창 밖이다.
  const old = summarizeInvestment(investmentEvents(
    [{ report: '주요사항보고서(유상증자결정)', date: '2025.06.01', rcpNo: '1' }], { now: NOW }));
  eq(old.recentEquity, false, '  14개월 전 증자는 등급을 움직이지 않는다');
  ok(old.latest !== null, '  그래도 사실로는 남긴다 — 사라지지 않는다');

  eq(summarizeInvestment([]).latest, null, '  공시가 없으면 없다고 한다');
});

// ══ 4.6 투자가 등급을 움직이는 유일한 경우 ═══════════════════════════════════
// 🔴 우리는 **금액을 모른다**(공시 제목만 본다). 그래서 올리는 폭을 한 단계로 묶는다.
//    금액을 모르는 채로 위험을 양호로 올리면, 5천만 원 증자가 자본잠식을 지운다.
group('투자 반영 등급', () => {
  const 억 = n => n * 1e8;
  const 잠식 = { 2025: { revenue: 억(96), operatingProfit: 억(-58), equity: 억(-12) } };
  const recentEquity = summarizeInvestment(investmentEvents(
    [{ report: '주요사항보고서(유상증자결정)', date: '2026.06.10', rcpNo: '9' }], { now: NOW }));
  const recentCb = summarizeInvestment(investmentEvents(
    [{ report: '주요사항보고서(전환사채권발행결정)', date: '2026.06.10', rcpNo: '9' }], { now: NOW }));

  eq(gradeCompany(잠식, { now: 2026 }).grade, 'r', '  투자 정보가 없으면 자본잠식은 위험 그대로');
  const lifted = gradeCompany(잠식, { now: 2026, investment: recentEquity });
  eq(lifted.grade, 'w', '  🔴 최근 지분 조달이 있으면 위험 → 경고 한 단계만');
  eq(lifted.gradeBeforeInvestment, 'r', '  움직이기 전 등급을 남긴다 — 근거 없이 바뀐 것처럼 보이면 안 된다');
  ok(lifted.reasons.some(r => /금액은 공시 원문에서 확인/.test(r)), '  🔴 금액을 모른다고 등급 근거에 적는다');
  ok(lifted.reasons.some(r => /자본총계.*완전자본잠식/.test(r)), '  자본잠식 사실 자체는 지우지 않는다');

  eq(gradeCompany(잠식, { now: 2026, investment: recentCb }).grade, 'r',
    '  🔴 전환사채로는 위험이 내려가지 않는다 — 부채로 들어온 돈이다');

  // 두 단계 이상은 절대 오르지 않는다.
  const 적자연속 = { 2025: { operatingProfit: 억(-14), equity: 억(33), revenue: 억(121) },
                     2024: { operatingProfit: 억(-9), equity: 억(40), revenue: 억(110) } };
  const w = gradeCompany(적자연속, { now: 2026, investment: recentEquity });
  eq(w.grade, 'w', '  🔴 경고는 투자가 있어도 경고다 — 돈이 들어온다고 적자가 흑자가 되지 않는다');
  eq(w.gradeBeforeInvestment, null, '  등급이 안 움직였으면 그렇게 남긴다');
  ok(w.reasons.some(r => /유상증자 결정/.test(r)), '  대신 사실은 근거에 실린다');

  // 재무가 아예 없어도 조달 사실은 사실이다.
  const none = gradeCompany({}, { now: 2026, investment: recentEquity });
  eq(none.grade, 'u', '  재무가 없으면 등급은 여전히 미확인');
  ok(none.reasons.some(r => /유상증자 결정/.test(r)), '  🔴 그래도 조달 사실은 적는다 — 미확인이 빈칸이 되지 않게');

  // 면접 질문이 달라진다.
  const q = interviewQuestions(lifted);
  ok(q.some(x => /규모와 투자자 구성/.test(x)), '  조달을 알면 "투자 받았습니까"가 아니라 규모·용처를 묻는다');
});

// ══ 4.7 외부 검증(codex 2026-08-18)에서 걸린 것 ═══════════════════════════════
// 🔴 전부 **등급이 실제로 틀려지는** 경로였다. 하나하나가 "돈이 안 들어왔는데 들어온 것으로 셈"이다.
group('투자 정보 — 외부 검증 지적 7건', () => {
  const ev = t => investmentEvents([{ report: t, date: '2026-06-10', rcpNo: '1' }], { now: NOW });

  // ① 채무 소액공모를 지분으로 세면 회사채 발행이 자본잠식을 지운다.
  eq(ev('소액공모공시서류(채무증권)')[0].equity, false, '  🔴 채무증권 소액공모는 지분 조달이 아니다');
  eq(ev('소액공모공시서류(지분증권)')[0].equity, true, '  지분증권 소액공모는 지분 조달');
  eq(ev('소액공모공시서류')[0].equity, false, '  🔴 종류가 안 적혔으면 지분으로 치지 않는다 — 모를 때는 등급을 안 움직인다');
  eq(ev('증권신고서(채무증권)')[0].equity, false, '  채무증권 신고서도 부채 조달');

  // ② 되돌린 결정·자회사 조달을 이 회사 돈으로 세면 안 된다.
  eq(ev('주요사항보고서(유상증자결정철회)').length, 0, '  🔴 철회된 증자는 돈이 들어오지 않았다');
  eq(ev('유상증자결정 취소').length, 0, '  취소도 마찬가지');
  eq(ev('유상증자결정(종속회사의 주요경영사항)').length, 0, '  🔴 자회사가 받은 돈은 이 회사 돈이 아니다');
  eq(ev('[기재정정]주요사항보고서(유상증자결정)').length, 1, '  기재정정은 같은 사건을 다시 낸 것 — 살려 둔다');

  // ③ 완화 근거가 엉뚱한 공시를 가리키면, 문서가 금지한 근거(전환사채)를 내미는 꼴이 된다.
  const mixed = summarizeInvestment(investmentEvents([
    { report: '주요사항보고서(전환사채권발행결정)', date: '2026.07.01', rcpNo: 'cb' },
    { report: '주요사항보고서(유상증자결정)', date: '2026.03.02', rcpNo: 'eq' },
  ], { now: NOW }));
  eq(mixed.latest.label, '전환사채 발행 결정', '  목록의 최신은 전환사채');
  eq(mixed.recentEquity, true, '  최근 12개월 안에 지분 조달이 있다');
  eq(mixed.recentEquityEvent.label, '유상증자 결정', '  🔴 완화의 근거가 된 공시를 따로 들고 다닌다');
  const g = gradeCompany({ 2025: { operatingProfit: -58e8, equity: -12e8, revenue: 96e8 } },
    { now: 2026, investment: mixed });
  eq(g.grade, 'w', '  지분 조달이 있으므로 위험 → 경고');
  ok(g.reasons.some(r => /유상증자 결정 공시 — 위험에서 경고로/.test(r)),
    '  🔴 완화 문구가 유상증자를 가리킨다 — 전환사채를 근거로 내밀지 않는다');
  ok(!g.reasons.some(r => /전환사채.*위험에서 경고로/.test(r)), '  전환사채가 완화 근거로 적히지 않는다');

  // ⑤ 미래 날짜가 자동으로 "최근"이 되면, 날짜 오독이 곧바로 등급 완화가 된다.
  const future = summarizeInvestment(investmentEvents(
    [{ report: '주요사항보고서(유상증자결정)', date: '2027.01.05', rcpNo: '1' }], { now: NOW }));
  ok(future.months < 0, '  미래 날짜는 음수 개월');
  eq(future.recentEquity, false, '  🔴 미래 날짜를 "최근 조달"로 세지 않는다');
  eq(future.recentEquityEvent, null, '  완화 근거도 만들지 않는다');
});

// ══ 4.8 캐시 재검증 ═════════════════════════════════════════════════════════
// 🔴 여기서 틀리면 증상이 조용하다. 낡은 값을 신선하다고 하면 등급이 옛날 값에 묶인 채 경고도 안 뜬다.
group('캐시 재검증', () => {
  const NOWMS = Date.parse('2026-08-18T00:00:00Z');
  const day = 864e5;
  const fresh = { source: 'dart', byYear: { 2025: {} }, investment: null, probedAt: new Date(NOWMS - 2 * day).toISOString() };
  const old = { source: 'dart', byYear: { 2025: {} }, investment: null, probedAt: new Date(NOWMS - 30 * day).toISOString() };

  eq(expectedFiscalYear(new Date(2026, 7, 1)), 2025, '  5월 이후면 전년도 재무가 있어야 정상');
  eq(expectedFiscalYear(new Date(2026, 1, 1)), 2024, '  5월 전이면 전전년도까지가 정상');

  eq(isCacheFresh(old, { wantInvestment: false, now: NOWMS }), true, '  투자 정보를 안 보면 최신 회계연도만으로 신선');
  eq(isCacheFresh(old, { wantInvestment: true, now: NOWMS }), false,
    '  🔴 투자 정보를 보면 회계연도만으로는 부족하다 — 조달 공시는 주기가 다르다');
  eq(isCacheFresh(fresh, { wantInvestment: true, now: NOWMS }), true, '  7일 안에 본 것은 다시 안 본다');

  // 기능이 생기기 전에 만들어진 캐시 — 필드 자체가 없다.
  const legacy = { source: 'dart', byYear: { 2025: {} }, probedAt: new Date(NOWMS - 2 * day).toISOString() };
  eq(isCacheFresh(legacy, { wantInvestment: true, now: NOWMS }), false,
    '  🔴 investment 필드가 없는 옛 캐시는 즉시 무효 — 아니면 조달 공시가 영영 안 붙는다');
  eq(isCacheFresh(legacy, { wantInvestment: false, now: NOWMS }), true, '  기능을 껐으면 옛 캐시도 그대로 쓴다');

  eq(isCacheFresh({ byYear: {}, investment: null, probedAt: new Date(NOWMS - 30 * day).toISOString() },
    { wantInvestment: true, now: NOWMS }), false, '  실패도 영구 캐시하지 않는다');
  eq(isCacheFresh(null, { now: NOWMS }), false, '  캐시가 없으면 신선할 리 없다');
});

// ══ 5. 자금등급 ═════════════════════════════════════════════════════════════
group('자금등급', () => {
  const Y = new Date().getFullYear();
  const g = (rows, opt) => gradeCompany(rows, { now: Y, ...opt }).grade;
  const 억 = n => n * 1e8;

  eq(g({ [Y - 1]: { equity: 억(-155), operatingProfit: 억(-30), revenue: 억(100) } }), 'r',
    '  완전자본잠식 + 적자 = 위험 (콜로세움코퍼레이션)');
  eq(g({ [Y - 2]: { operatingProfit: 억(-10) }, [Y - 1]: { equity: 억(-38), operatingProfit: 억(3) } }), 'w',
    '  자본잠식이나 흑자전환 = 경고');
  eq(g({ [Y - 2]: { operatingProfit: 억(-20), revenue: 억(50) }, [Y - 1]: { operatingProfit: 억(-25), revenue: 억(60), equity: 억(30) } }), 'w',
    '  영업적자 2년 연속 = 경고');
  eq(g({ [Y - 1]: { operatingProfit: 억(-28), equity: 억(35), revenue: 억(256) } }), 'w',
    '  적자인데 자본 완충이 3배 미만 = 경고 (미확인으로 내리지 않는다)');
  eq(g({ [Y - 1]: { operatingProfit: 억(-268), equity: 억(442), revenue: 억(462), liabilities: 억(100) } }), 'w',
    '  자본이 손실의 1.6배뿐이면 경고');
  eq(g({ [Y - 1]: { operatingProfit: 억(-30), equity: 억(120), revenue: 억(100) } }), 'o',
    '  적자지만 자본이 손실의 3배 이상 = 양호');
  eq(g({ [Y - 2]: { operatingProfit: 억(-5) }, [Y - 1]: { operatingProfit: 억(13), equity: 억(479), revenue: 억(321) } }), 'o',
    '  흑자전환 1년차 = 양호 (플러그링크)');
  eq(g({ [Y - 2]: { operatingProfit: 억(3), revenue: 억(200) }, [Y - 1]: { operatingProfit: 억(13), equity: 억(479), revenue: 억(321) } }), 'g',
    '  영업흑자 2년 연속 + 매출 성장 = 좋음');
  eq(g({ [Y - 2]: { operatingProfit: 억(30), revenue: 억(400) }, [Y - 1]: { operatingProfit: 억(13), equity: 억(479), revenue: 억(321) } }), 'o',
    '  흑자 2년이라도 매출이 줄면 좋음이 아니다');
  // 🔴 대규모 조달 기업 오탐 방지 — 토스가 자본 1조인데 강등된 적이 있다.
  eq(g({ [Y - 2]: { operatingProfit: 억(-1000) }, [Y - 1]: { operatingProfit: 억(-800), equity: 억(10000), revenue: 억(5000) } }), 'o',
    '  자본이 연간 적자의 10배 이상이면 강등하지 않는다 (토스형)');
  eq(g({ [Y - 1]: { equity: 억(10), liabilities: 억(500), operatingProfit: 억(5), revenue: 억(100) } }), 'w',
    '  부채비율 400% 초과 = 경고');
  eq(g({ [Y - 1]: { equity: 억(-10), liabilities: 억(500), operatingProfit: 억(-5) } }), 'r',
    '  자본총계 ≤ 0이면 부채비율을 계산하지 않는다 (분모 붕괴)');
  // 🔴 경계값 0 — 숫자가 있는데 어느 분기에도 안 걸려 미확인으로 빠지면 안 된다.
  eq(g({ [Y - 1]: { revenue: 억(100), equity: 억(100), operatingProfit: 0 } }), 'o',
    '  영업이익 정확히 0(손익분기)은 미확인이 아니다');
  eq(g({ [Y - 1]: { revenue: 억(100), equity: 0, operatingProfit: 억(-10) } }), 'r',
    '  자본총계 정확히 0은 완전자본잠식이다 (< 0 이 아니라 ≤ 0)');

  // 🔴 연도가 붙어 있지 않으면 "연속"이 아니다.
  //    2025·2022 두 해만 있는 회사가 사이 2년 자료가 없다는 이유로 "2년 연속 적자"를 먹는다.
  const gapped = gradeCompany({
    [Y - 4]: { operatingProfit: 억(-20), revenue: 억(50) },
    [Y - 1]: { operatingProfit: 억(-25), revenue: 억(60), equity: 억(200) },
  }, { now: Y });
  ok(!gapped.reasons.some(r => /2년 연속/.test(r)), '  중간 연도가 비면 연속 적자로 판정하지 않는다', gapped.reasons.join(' / '));
  ok(gapped.reasons.some(r => /직전연도.*자료가 없어/.test(r)), '  연도 공백을 사유에 밝힌다', gapped.reasons.join(' / '));

  // 🔴 연결과 별도를 한 시계열로 비교하면 회계 기준 변경이 "성장"으로 둔갑한다.
  const mixed = gradeCompany({
    [Y - 2]: { operatingProfit: 억(3), revenue: 억(200), basis: '별도' },
    [Y - 1]: { operatingProfit: 억(13), revenue: 억(321), equity: 억(479), basis: '연결' },
  }, { now: Y });
  ok(!mixed.reasons.some(r => /2년 연속/.test(r)), '  기준이 다르면 추세를 판정하지 않는다', mixed.reasons.join(' / '));
  ok(mixed.reasons.some(r => /기준이라/.test(r)), '  기준 불일치를 사유에 밝힌다', mixed.reasons.join(' / '));

  eq(g({}), 'u', '  데이터 없음 = 미확인');
  eq(g({ [Y - 4]: { operatingProfit: 억(10), equity: 억(100), revenue: 억(100) } }), 'u',
    '  최신 자료가 3년 이상 낡으면 미확인');

  const stale = gradeCompany({ [Y - 4]: { operatingProfit: 억(10), equity: 억(100) } }, { now: Y });
  ok(stale.stale === true && /낡아/.test(stale.reasons.join()), '  낡은 자료임을 사유에 밝힌다');

  // 🔴 등급에는 기준연도가 반드시 붙는다.
  const withYear = gradeCompany({ [Y - 1]: { operatingProfit: 억(13), equity: 억(479), revenue: 억(321) } }, { now: Y });
  eq(withYear.year, Y - 1, '  등급에 기준연도가 붙는다');

  // 기준선 대비 ▲▼
  const base = { revenue: 억(100), operatingProfit: 억(5), equity: 억(50) };
  eq(compareToBaseline({ revenue: 억(200), operatingProfit: 억(10), equity: 억(30) }, base).dir, 'up', '  3개 중 2개가 나으면 ▲');
  eq(compareToBaseline({ revenue: 억(50), operatingProfit: 억(1), equity: 억(10) }, base).dir, 'down', '  3개 중 2개가 못하면 ▼');
  eq(compareToBaseline({ revenue: 억(200) }, base), null, '  비교 가능한 항목이 2개 미만이면 배지를 만들지 않는다');
  eq(compareToBaseline({ revenue: 억(200) }, null), null, '  기준선이 없으면 배지를 만들지 않는다');

  // 🔴 근거가 없으면 면접 질문도 만들지 않는다.
  eq(interviewQuestions({ grade: 'u', reasons: [] }).length, 0, '  미확인이면 질문을 지어내지 않는다');
  ok(interviewQuestions(gradeCompany({ [Y - 1]: { equity: 억(-155), operatingProfit: 억(-30) } }, { now: Y })).length > 0,
    '  자본잠식이면 물어볼 것을 만든다');
});

// ══ 5.5 연차 분류 ═══════════════════════════════════════════════════════════
// 🔴 이 제품은 한동안 12년차 시니어를 기본값으로 깔고 있었다(2026-08-10 지적).
//    판정 로직은 상대 비교라 멀쩡했지만 기본값·태그 이름이 절대 연차였다.
//    신입이 이 도구를 켰을 때 목록이 통째로 "따로 모음"으로 빠지는 것이 여기서 막힌다.
group('연차 분류 (내 연차 대비 상대 판정)', () => {
  const tags = (t, a) => experienceTags(t, a).sort().join(',');

  // 하한 미설정 = 분류하지 않음. 이게 기본값이다.
  eq(tags({ years: 0 }, 0), '', '  신입 · 경력무관 공고 → 태그 없이 본 목록');
  eq(tags({ years: 0 }, 5), 'aboveMyLevel', '  신입 · 경력 5년↑ 공고 → 요구경력 높음');
  eq(tags({ years: 0 }, 1), 'aboveMyLevel', '  신입 · 경력 1년↑도 나보다 높다');

  eq(tags({ years: 4 }, 0), '', '  4년차 · 신입 공고 → 🔴 하한 미설정이면 태그를 붙이지 않는다');
  eq(tags({ years: 4 }, 3), '', '  4년차 · 경력 3년↑ → 내 범위 안');
  eq(tags({ years: 4 }, 7), 'aboveMyLevel', '  4년차 · 경력 7년↑ → 요구경력 높음');

  eq(tags({ years: 4, acceptExperienceFloor: 2 }, 0), 'belowMyLevel',
    '  4년차 · 하한 2를 켜면 신입 공고가 따로 모인다');
  eq(tags({ years: 4, acceptExperienceFloor: 2 }, 3), '', '  하한 2 · 경력 3년↑은 본 목록');

  eq(tags({ years: 12, acceptExperienceFloor: 8 }, 3), 'belowMyLevel', '  12년차 · 경력 3년↑ → 요구경력 낮음');
  eq(tags({ years: 12, acceptExperienceFloor: 8 }, 15), 'aboveMyLevel', '  12년차 · 경력 15년↑ → 요구경력 높음');
  eq(tags({ years: 12, acceptExperienceFloor: 8 }, 10), '', '  12년차 · 경력 10년↑ → 본 목록');

  // 🔴 공고가 연차를 안 적었으면 지어내지 않는다.
  eq(tags({ years: 12, acceptExperienceFloor: 8 }, null), '', '  공고에 연차가 없으면 판정하지 않는다');
  eq(tags({}, 5), '', '  프로필에 연차가 없으면 판정하지 않는다');

  // 🔴 태그 이름이 절대 연차로 되돌아가면 여기서 걸린다.
  ok(!JSON.stringify(EXPERIENCE_TAG_LABEL).includes('주니어'),
    '  라벨에 "주니어" 같은 절대 표현을 쓰지 않는다');
  eq(Object.keys(EXPERIENCE_TAG_LABEL).sort().join(','), 'aboveMyLevel,belowMyLevel',
    '  태그 키는 상대 표현 두 개뿐이다');
});

// ══ 5.6 수집 방식 가드 ══════════════════════════════════════════════════════
// 🔴 예전에는 `=== 'off'` 만 봐서 `offf` 같은 오타가 수집으로 흘러갔다.
//    사용자는 껐다고 믿는데 계속 긁는다 — 동의 없는 수집이 되는 지점이다.
group('수집 방식 가드', () => {
  const en = (v, board = 'saramin') => requireSourceEnabled({ sources: { [board]: v } }, board, 'web');
  const throws = (v, label) => {
    let threw = false;
    try { en(v); } catch { threw = true; }
    ok(threw, label);
  };

  eq(en('api'), 'api', '  api 는 통과');
  eq(en('web'), 'web', '  web(공개 페이지 파싱)은 api 와 구분해 통과');
  eq(en('browser'), 'browser', '  browser 는 통과 — 동의 절차는 호출부가 한다');
  throws('off', '  off 는 수집을 막는다');
  throws('offf', '  🔴 오타는 조용히 수집으로 흘러가지 않는다');
  throws('API', '  대문자 표기도 통과시키지 않는다');
  throws('', '  빈 문자열도 막는다');
  eq(requireSourceEnabled({}, 'saramin', 'web'), 'web', '  미설정이면 기본값을 쓴다');
  eq(SOURCE_MODES.join(','), 'api,web,browser,off', '  아는 값은 이 넷뿐이다');
});

// ══ 6. 설정·보안 ════════════════════════════════════════════════════════════
group('설정 · 보안', () => {
  const p = parseYaml(fs.readFileSync(path.join(HERE, '..', '..', 'references', 'profile.example.yml'), 'utf8'));
  eq(p.version, 1, '  profile.example.yml 파싱');
  ok(Array.isArray(p.target.roles) && p.target.roles.length > 0, '  블록 리스트를 읽는다');
  ok(p.location.maxCommuteMin === 60, '  숫자 스칼라');
  ok(p.location.precise === false, '  불리언 스칼라');
  ok(Array.isArray(p.location.denyRegions) && p.location.denyRegions.length === 0, '  인라인 빈 리스트');
  eq(p.sources.linkedin, 'off', '  🔴 LinkedIn 기본값은 off (제재가 개인 계정에 온다)');

  const presets = parseYaml(fs.readFileSync(path.join(HERE, '..', '..', 'references', 'role-presets.yml'), 'utf8'));
  ok(Object.keys(presets).length >= 5, '  role-presets.yml 파싱');
  ok(presets['product-manager'].roles.includes('프로덕트 매니저'), '  인라인 리스트 안의 한글 항목');

  // 🔴 인증키가 로그·에러에 찍히면 사용자가 스크린샷 한 장으로 키를 유출한다.
  ok(!mask('https://api?serviceKey=abcd1234&x=1').includes('abcd1234'), '  serviceKey 마스킹');
  ok(!mask('https://api?apiKey=SECRET').includes('SECRET'), '  apiKey 마스킹');
  ok(mask('https://api?serviceKey=abcd&pageNo=1').includes('pageNo=1'), '  마스킹이 다른 파라미터를 지우지 않는다');
});

// ══ 6.5 수집 실패 진단 ══════════════════════════════════════════════════════
// 🔴 실제로 값을 치른 사고다 (2026-08-18 사용자 제보). 사람인 접근이 막힌 사용자가
//    "추천 0건"만 받고 끝났다 — 도구는 차단 사실을 알고 있었는데 gate 가 사유 없이 멈췄고,
//    리포트는 "조회 실패" 넉 자로만 적어 사용자가 할 수 있는 일이 없었다.
//    차단·한도·네트워크는 대처가 서로 다르다. 뭉치면 안 된다.
group('수집 실패 진단', () => {
  eq(kindOfStatus(403), 'blocked', '  403 은 차단');
  eq(kindOfStatus(401), 'blocked', '  401 도 차단');
  eq(kindOfStatus(451), 'blocked', '  451 도 차단');
  eq(kindOfStatus(429), 'rateLimited', '  429 는 한도 초과 — 차단과 대처가 다르다');
  eq(kindOfStatus(404), 'notFound', '  404 는 주소 없음');
  eq(kindOfStatus(503), 'serverError', '  5xx 는 보드 서버 오류');
  eq(kindOfStatus(400), 'unknown', '  모르는 4xx 는 아는 척하지 않는다');

  const d403 = diagnose(new HttpError(403, 'https://www.saramin.co.kr/x', '<html>'));
  eq(d403.kind, 'blocked', '  HttpError 403 → 차단');
  eq(d403.label, '접근 차단(HTTP 403)', '  라벨에 상태 코드가 남는다');
  ok(/개인 컴퓨터에서 다시 실행/.test(d403.hint ?? ''), '  🔴 차단은 대처를 함께 준다');

  const net = diagnose(new NetworkError(new TypeError('fetch failed'), 'https://x'));
  eq(net.kind, 'network', '  fetch 실패는 네트워크 단절');
  ok(/클라우드 실행 환경/.test(net.hint ?? ''), '  🔴 외부 접속이 막힌 환경을 짚어 준다');

  eq(diagnose(new NetworkError({ name: 'TimeoutError' }, 'https://x')).kind, 'timeout', '  타임아웃은 따로 센다');

  // 🔴 fetch 는 진짜 원인을 cause 안쪽에 숨긴다. 겉면만 보면 전부 `fetch failed` 다 —
  //    타임아웃을 네트워크 단절로 적으면 "잠시 뒤 재시도" 대신 "인터넷을 확인하라"고 말하게 된다.
  const nested = new TypeError('fetch failed');
  nested.cause = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  eq(diagnose(new NetworkError(nested, 'https://x')).kind, 'timeout', '  🔴 cause 안쪽의 TimeoutError 도 타임아웃으로 읽는다');

  // 🔴 회사망·클라우드 방화벽은 CONNECT 를 403 으로 되받는다. fetch 는 그저 `fetch failed` 라고만 해서
  //    겉만 보면 "인터넷 끊김"으로 읽힌다 — 실제로는 **막힌 것**이고 대처가 정반대다.
  const proxyErr = new TypeError('fetch failed');
  proxyErr.cause = Object.assign(new Error('Request was cancelled.'), {
    cause: Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { name: 'AbortError', code: 'UND_ERR_ABORTED' }),
  });
  const proxied = diagnose(new NetworkError(proxyErr, 'https://www.saramin.co.kr/'));
  eq(proxied.kind, 'proxyBlocked', '  🔴 프록시 CONNECT 거부를 네트워크 단절로 뭉개지 않는다');
  eq(proxied.label, '중간 프록시 차단(HTTP 403)', '  프록시가 준 상태 코드를 살려서 보여 준다');
  ok(/개인 컴퓨터·개인 네트워크/.test(proxied.hint ?? ''), '  대처는 "연결 확인"이 아니라 "환경 바꾸기"다');
  ok(!/인터넷 연결을 확인/.test(proxied.hint ?? ''), '  🔴 막힌 사용자에게 인터넷을 확인하라고 하지 않는다');
  eq(diagnose(new NetworkError({ code: 'ENOTFOUND' }, 'https://x')).kind, 'network', '  DNS 실패도 네트워크');
  eq(diagnose(new HttpError(500, 'https://x')).kind, 'serverError', '  보드 서버 오류는 사용자 잘못이 아니다');

  // 🔴 인증키는 진단 문구에도 새면 안 된다.
  ok(!diagnose(new NetworkError(new Error('fail https://a?serviceKey=abcd1234'), 'https://a?serviceKey=abcd1234')).message.includes('abcd1234'),
    '  진단 메시지도 마스킹을 거친다');
});

// ══ 6.6 실행 기록 → 사용자 문구 ═════════════════════════════════════════════
// 🔴 render · serve · gate 가 각자 문구를 만들던 자리다. 한 곳만 고쳐져
//    콘솔은 "차단", 리포트는 "조회 실패"라고 말하던 것이 이 버그의 절반이었다.
group('실행 기록 → 사용자 문구', () => {
  const runs = {
    saramin: { complete: false, queries: [{ query: '서비스기획', ok: false, error: 'HTTP 403 — https://x', kind: 'blocked', status: 403, label: '접근 차단(HTTP 403)', hint: '개인 컴퓨터에서 다시 실행해 주십시오.' }] },
    wanted: { complete: false, queries: [{ query: 'PM', ok: true, truncated: true, found: 400 }] },
  };
  const r = summarizeRuns(runs);
  ok(r.everRan, '  기록이 있으면 everRan');
  ok(r.blocked, '  차단이 하나라도 있으면 blocked');
  ok(summarizeRuns({ w: { complete: false, queries: [{ query: 'a', ok: false, kind: 'proxyBlocked', status: 403, label: '중간 프록시 차단(HTTP 403)' }] } }).blocked,
    '  프록시 차단도 차단으로 센다');
  eq(r.failures.length, 1, '  실패 1건');
  eq(r.failures[0].text, '사람인 "서비스기획" — 접근 차단(HTTP 403)', '  🔴 보드 이름·키워드·사유가 한 줄에 다 있다');
  eq(r.truncations[0].text, '원티드 "PM" — 400건에서 잘림', '  잘림은 실패와 구분해 적는다');
  eq(r.hints.length, 1, '  대처는 중복 없이 한 번만');

  // 옛 기록에는 kind 가 없다. 문자열에서 되살리지 못하면 업데이트 직후 경고가 통째로 뭉개진다.
  eq(kindFromRecord({ error: 'HTTP 429 — https://x' }).kind, 'rateLimited', '  옛 기록도 상태 코드에서 종류를 되살린다');
  eq(kindFromRecord({ error: '알 수 없는 오류' }).kind, 'unknown', '  못 읽으면 아는 척하지 않는다');
  eq(summarizeRuns({ saramin: { complete: false, queries: [{ query: 'a', ok: false, error: 'HTTP 403 — https://x' }] } }).failures[0].label,
    '접근 차단(HTTP 403)', '  🔴 옛 기록도 새 문구로 표시된다');

  // 🔴 "수집을 아예 안 돌린 것"과 "돌렸는데 0건인 것"은 다르다. gate 의 분기가 여기에 걸려 있다.
  ok(!summarizeRuns({}).everRan, '  기록이 없으면 everRan 아님 — gate 는 이때만 멈춘다');
  ok(summarizeRuns({ saramin: { complete: true, queries: [{ query: 'a', ok: true, found: 0 }] } }).everRan,
    '  정상 종료도 실행 기록이다 — 0건이어도 멈추지 않는다');

  // lastRun 은 보드가 하나뿐이던 시절의 옛 필드다. 못 읽으면 옛 사용자의 경고가 사라진다.
  const legacy = runsOf({ lastRun: { board: 'wanted', complete: false, queries: [{ query: 'PM', ok: false, error: 'HTTP 403 — https://x' }] } });
  eq(summarizeRuns(legacy).failures[0].text, '원티드 "PM" — 접근 차단(HTTP 403)', '  lastRun(옛 필드)도 읽는다');

  const det = summarizeRuns({ saramin: { complete: false, queries: [], detailTruncated: { seen: 292, fetched: 200, pending: 92, max: 200 } } });
  ok(/못 받은 것이 92건/.test(det.truncations[0].text), '  상세 잘림은 남은 건수를 앞에 놓는다');
});

// ══ 7. 단계 간 계약 (통합) ══════════════════════════════════════════════════
console.log('\n── 단계 간 계약 — collect → merge → gate → render · serve');
await runIntegration(ok, eq);

// ── 결과 ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
if (fails.length) {
  console.log(`❌ 실패 ${fails.length} / 통과 ${pass}\n`);
  for (const f of fails) console.log(`  ✗ ${f.trim()}`);
  process.exit(1);
}
console.log(`✅ ${pass}건 전부 통과`);
