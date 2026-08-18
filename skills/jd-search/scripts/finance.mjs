#!/usr/bin/env node
/**
 * 4단계 finance — 회사 → 공시 → 자금등급.
 *
 * 실행: node finance.mjs [--profile <id>] [--only "회사명"]
 *       공공데이터포털 키는 환경변수 DATA_GO_KR_KEY 로 받는다.
 *       키 없이도 돌아간다 — 공공데이터포털을 건너뛰고 DART만 쓴다 (커버리지는 내려간다).
 * 출력: state/finance.json · cache/finance.json
 *
 * 폴백 체인
 *   ① 공공데이터포털 기업개요  → 법인등록번호(crno)·등기주소·종업원수
 *   ② 공공데이터포털 기업재무  → 매출·영업이익·자본총계
 *      ↓ 없으면
 *   ③ DART 공시 (키 불필요)    → 정기보고서 우선, 없으면 **감사보고서 원문 파싱**
 *      ↓ 없으면
 *   u 미확인 + 면접 질문
 *
 * 투자 정보 (2026-08-18 CEO 요청)
 *   같은 DART 공시 목록에서 **조달 사건**(유상증자·전환사채·증권신고서)을 함께 뽑는다.
 *   🔴 목록은 재무를 찾느라 이미 받은 것이라 요청이 늘지 않는다. 단, 공공데이터포털만으로
 *      재무가 끝난 회사는 원래 DART를 아예 안 봤다 — 그런 회사도 투자 공시를 보려면
 *      DART 조회가 필요해서, 그때만 조회를 한 번 더 한다 (회사당 2요청 · 끄려면 finance.investment: false).
 *
 * 🔴 부분일치로 회사 재무를 붙이지 않는다. 후보가 여럿이면 ambiguous로 남기고 사람에게 묻는다.
 *    실측에서 부분일치 구제가 5건을 틀렸고, 그중 2건은 서로 다른 회사가 같은 법인에 붙었다.
 */
import { loadProfile, statePath, cachePath, readJson, writeJson, jsonCache } from './lib/io.mjs';
import { resolveCorpByName, fetchFinance, PubDataAuthError } from './lib/pubdata.mjs';
import { resolveDartCorp, fetchDartFinance } from './lib/dart.mjs';
import { gradeCompany, compareToBaseline, interviewQuestions, GRADE_LABEL } from './lib/grade.mjs';
import { investmentEvents, summarizeInvestment, investmentLine } from './lib/investment.mjs';
import { isCacheFresh } from './lib/freshness.mjs';
import { ambiguityPrompt } from './lib/match.mjs';
import { normCorp } from './lib/text.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
if (profile.finance?.enabled === false) {
  console.log('profile.yml 의 finance.enabled 가 false 입니다. 재무 단계를 건너뜁니다.');
  process.exit(0);
}
const hasKey = Boolean(process.env.DATA_GO_KR_KEY);
// 🔴 기본값은 켬. 끄면 조달 공시를 아예 보지 않는다 (요청은 줄고, 등급은 재무제표만으로 매겨진다).
const wantInvestment = profile.finance?.investment !== false;
if (!hasKey) {
  console.log('⚠ 공공데이터포털 인증키가 없습니다 — DART 공시만으로 진행합니다.');
  console.log('  키를 넣으면 확보율이 올라갑니다:  export DATA_GO_KR_KEY="발급받은키"\n');
}

const store = readJson(statePath(profile, 'postings.json'));
const gate = readJson(statePath(profile, 'gate.json'));
if (!store) { console.error('postings.json 이 없습니다. collect 단계를 먼저 돌려 주십시오.'); process.exit(1); }

// 🔴 게이트가 drop한 건은 조회하지 않는다. 이 절약이 게이트를 앞에 둔 이유다.
const targets = Object.entries(store.postings ?? {})
  .filter(([k]) => !gate || (gate.verdicts?.[k]?.verdict ?? 'pass') !== 'drop');

const only = flag('only');
const companies = new Map();
for (const [, p] of targets) {
  const name = p.company?.name?.trim();
  if (!name) continue;
  if (only && !normCorp(name).includes(normCorp(only))) continue;
  const key = normCorp(name);
  if (!companies.has(key)) companies.set(key, { name, region: p.location?.district ?? null, postings: [] });
  companies.get(key).postings.push(`${p.board}:${p.id}`);
}

const baselineName = profile.baseline?.company?.trim();
if (baselineName && !companies.has(normCorp(baselineName))) {
  companies.set(normCorp(baselineName), { name: baselineName, region: null, postings: [], isBaseline: true });
}

const cache = jsonCache(cachePath(profile, 'finance.json'));
const staleYears = profile.finance?.staleYears ?? 3;

// 🔴 사용자가 직접 확인한 동명이인 결정. **규칙보다 우선한다.**
//    이게 없으면 같은 질문이 매 실행마다 반복되고, 사용자가 답을 알아도 반영할 방법이 없다.
//    (`node resolve_company.mjs` 가 여기에 쓴다)
const userChoices = readJson(statePath(profile, 'company_choices.json'), { choices: {} }).choices ?? {};

/** 한 회사의 재무를 폴백 체인으로 확보한다. */
async function lookup({ name, region }) {
  const out = { name, source: null, corp: null, byYear: {}, note: null, ambiguous: null, investment: null };
  let financeDone = false;   // 재무는 이미 확보 — DART 는 조달 공시를 보려고만 본다

  const choice = userChoices[normCorp(name)];
  if (choice?.skip) {
    // 🔴 "모르겠음"도 사용자의 결정이다. 다시 묻지 않되, **왜 미확인인지는 그대로 적는다.**
    out.note = '같은 이름의 법인이 여러 곳이고, 어느 쪽인지 확인되지 않아 재무를 붙이지 않았습니다';
    out.userDecided = 'skip';
    return out;
  }
  // 사용자가 고른 법인등록번호는 **상호보다 강한 근거**다. match.mjs 가 이걸 최우선으로 본다.
  const hint = { region, ...(choice?.crno ? { crno: choice.crno } : {}) };
  if (choice?.crno) out.userDecided = choice.corpNm ?? choice.crno;

  // ①② 공공데이터포털
  if (hasKey) {
    try {
      const r = await resolveCorpByName(name, hint);
      if (r.status === 'ambiguous') {
        out.ambiguous = { where: 'data.go.kr', prompt: ambiguityPrompt(name, r), candidates: r.candidates };
      } else if (r.status === 'exact') {
        out.corp = r.corp;
        out.byYear = await fetchFinance(r.corp.crno);
        const newest = Math.max(0, ...Object.keys(out.byYear).map(Number));
        if (newest) {
          out.source = 'data.go.kr';
          // 🔴 낡은 자료를 확보로 치고 끝내면 안 된다. 공공데이터포털에 2023년치만 남아 있어도
          //    DART에는 올해 감사보고서가 올라와 있는 경우가 흔하다 — 여기서 멈추면 그걸 통째로 놓친다.
          // 🔴 재무는 여기서 끝났다. 그래도 **조달 공시를 보려면 DART를 봐야 한다** —
          //    옛 코드는 여기서 바로 돌아가서, 공공데이터포털로 해결된 회사는 투자 정보가 통째로 비었다.
          if (newest >= new Date().getFullYear() - 2) {
            if (!wantInvestment) return out;
            financeDone = true;
          }
          out.staleFrom = newest;   // 최종 사유는 DART 결과를 보고 정한다
        } else {
          out.note = '법인은 확인됐으나 공공데이터포털 재무 DB에 수록되지 않음';
        }
      }
    } catch (e) {
      if (e instanceof PubDataAuthError) throw e;
      out.note = `data.go.kr 조회 실패: ${e.message}`;
    }
  }

  // ③ DART — 🔴 키 불필요. 비상장 외감은 여기 감사보고서에만 있다.
  try {
    const d = await resolveDartCorp(name, { region, crno: out.corp?.crno ?? hint.crno });
    if (d.status === 'ambiguous') {
      out.ambiguous ??= { where: 'dart', prompt: ambiguityPrompt(name, d), candidates: d.candidates };
    } else if (d.status === 'exact') {
      out.dart = d.corp;
      out.corp ??= d.corp;
      // 🔴 조달 공시는 **재무 확보 여부와 무관하게** 뽑는다. 재무가 없어도 조달 사실은 사실이다.
      if (wantInvestment) {
        const ev = investmentEvents(d.reports);
        out.investment = ev.length ? summarizeInvestment(ev) : null;
      }
      if (financeDone) return out;
      const f = await fetchDartFinance(d.reports);
      if (f?.ok) {
        // 공공데이터포털에서 받은 과거 연도가 있으면 지우지 않고 합친다 — 연속 적자 판정에 쓰인다.
        out.byYear[f.year] = {
          revenue: f.revenue, operatingProfit: f.operatingProfit, equity: f.equity,
          basis: /연결/.test(f.report) ? '연결' : '별도',
          source: 'dart', report: f.report, rcpNo: f.rcpNo, reportDate: f.date,
        };
        out.source = out.source ? `${out.source}+dart-audit` : 'dart-audit';
        out.note = null;
        // 🔴 앞 단계에서 붙은 동명이인 플래그를 반드시 해제한다.
        //    공공데이터포털이 모호했더라도 DART가 법인등록번호까지 대조해 확정했으면 더는 모호하지 않다.
        //    안 지우면 **등급이 버젓이 붙어 있는데 "동명이인이라 재무를 안 붙였습니다"** 노트가 나가고,
        //    그 상태가 캐시에 영구히 굳는다.
        out.ambiguous = null;
        return out;
      }
      out.note = f ? `DART 감사보고서에서 재무를 추출하지 못함 (${f.why ?? '항목 부족'})` : 'DART에 재무 보고서 없음';
    } else {
      out.note = 'DART 미등록';
    }
  } catch (e) {
    out.note = `DART 조회 실패: ${e.message}`;
  }
  // 공공데이터포털에 낡은 연도만 있고 DART에도 더 최근 것이 없으면, 그 사실 자체가 사유다.
  if (out.staleFrom) out.note = `가장 최근 공시가 ${out.staleFrom}년 — 이후 재무 공시가 확인되지 않음 (${out.note})`;
  return out;
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const list = [...companies.values()];
console.log(`회사 ${list.length}곳 (공고 ${targets.length}건)\n`);

const results = {};
for (const [i, c] of list.entries()) {
  const key = normCorp(c.name);
  process.stdout.write(`[${i + 1}/${list.length}] ${c.name.slice(0, 20).padEnd(22)}`);
  let r;
  try {
    const hit = cache.get(key);
    r = (!argv.includes('--fresh') && isCacheFresh(hit, { wantInvestment }))
      ? hit
      : cache.set(key, { ...(await lookup(c)), probedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof PubDataAuthError) { console.log('\n\n' + e.message); process.exit(1); }
    r = { name: c.name, source: null, byYear: {}, note: `조회 실패: ${e.message}` };
  }
  const g = gradeCompany(r.byYear, { staleYears, investment: r.investment ?? null });
  results[key] = {
    ...r,
    postings: c.postings,
    grade: g.grade, gradeYear: g.year, gradeLabel: GRADE_LABEL[g.grade],
    reasons: g.reasons, stale: g.stale,
    // 🔴 등급이 투자 때문에 움직였으면 **움직이기 전 등급도 남긴다.** 근거 없이 바뀐 것처럼 보이면 안 된다.
    investment: g.investment ?? null, gradeBeforeInvestment: g.gradeBeforeInvestment ?? null,
    // 🔴 미확인도 근거다 — "공시가 없다"는 사실 자체가 물어볼 거리다.
    questions: profile.finance?.interviewQuestions === false ? [] : interviewQuestions(g, r.note),
  };
  const 억 = v => (v == null ? '—' : `${(v / 1e8).toFixed(0)}억`);
  const y = g.year ? r.byYear[g.year] : null;
  const invTail = g.investment?.latest ? `  · 조달 ${g.investment.latest.date} ${g.investment.latest.label}` : '';
  console.log(`${GRADE_LABEL[g.grade]}${g.year ? ` ${g.year}` : ''}  ${y ? `매출 ${억(y.revenue)} 영업익 ${억(y.operatingProfit)} 자본 ${억(y.equity)}` : (r.note ?? '')}${invTail}`.slice(0, 120));
  cache.flush();
}

// 기준선 대비 ▲▼ — 🔴 기준선이 없으면 배지를 만들지 않는다.
let baseline = null;
if (baselineName) {
  const b = results[normCorp(baselineName)];
  const yr = b?.gradeYear;
  if (yr && b.byYear[yr]) {
    baseline = { company: baselineName, year: yr, ...b.byYear[yr] };
    for (const [k, r] of Object.entries(results)) {
      if (k === normCorp(baselineName)) continue;
      const latest = r.gradeYear ? r.byYear[r.gradeYear] : null;
      r.vsBaseline = compareToBaseline(latest, baseline);
    }
  } else {
    console.log(`\n⚠ 기준선 "${baselineName}" 재무를 확보하지 못해 ▲▼ 배지를 만들지 않습니다.`);
  }
}

// 🔴 부분 실행(--only)이 나머지를 지우면 안 된다. 이번에 조회한 것만 기존 위에 덮는다.
//    실제로 `--only 카닥` 한 번에 finance.json 이 1곳짜리로 줄어드는 것을 겪었다 —
//    그 다음 render 는 조용히 "미확인 29곳"짜리 리포트를 만들어 낸다.
const prev = readJson(statePath(profile, 'finance.json'), null);
const merged = only ? { ...(prev?.companies ?? {}), ...results } : results;
writeJson(statePath(profile, 'finance.json'), {
  updatedAt: new Date().toISOString(),
  usedPubData: hasKey,
  baseline: baseline ?? (only ? prev?.baseline ?? null : null),
  companies: merged,
});

const tally = Object.values(results).reduce((a, r) => (a[r.grade] = (a[r.grade] ?? 0) + 1, a), {});
const known = list.length - (tally.u ?? 0);
console.log(`\n확보 ${known}/${list.length} (${(known / list.length * 100).toFixed(1)}%)`);
console.log('  ' + Object.entries(tally).map(([g, n]) => `${GRADE_LABEL[g]} ${n}`).join(' · '));

const confirmed = Object.values(results).filter(r => r.userDecided && r.userDecided !== 'skip');
if (confirmed.length) console.log(`\n사용자가 확인한 법인 ${confirmed.length}곳을 그대로 적용했습니다.`);

const amb = Object.values(results).filter(r => r.ambiguous);
if (amb.length) {
  console.log(`\n🔴 동명이인 ${amb.length}곳 — 자동 채택하지 않았습니다. 확인이 필요합니다:`);
  for (const a of amb) console.log('\n' + a.ambiguous.prompt);
  // 🔴 물어만 보고 끝내면 같은 질문이 매 실행마다 반복된다. 답을 저장할 방법을 알려 준다.
  console.log('\n답을 기억시키려면:  node scripts/resolve_company.mjs');
  console.log('  (비대화형이면:  node scripts/resolve_company.mjs --pick "회사명=번호")');
}
console.log(`\n→ ${statePath(profile, 'finance.json')}`);
