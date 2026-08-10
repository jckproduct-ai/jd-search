#!/usr/bin/env node
/**
 * 동명이인 확인 — "이 회사가 어느 법인입니까?" 를 사람에게 묻고 **그 답을 기억한다.**
 *
 * 실행:
 *   node resolve_company.mjs                      대화형 (질문 → 번호 입력)
 *   node resolve_company.mjs --list               묻지 않고 후보만 보여준다
 *   node resolve_company.mjs --pick "미소=2"      비대화형 (여러 개면 쉼표로)
 *   node resolve_company.mjs --pick "미소=0"      0 = 모르겠음 → 다시 묻지 않고 미확인으로 둔다
 *   node resolve_company.mjs --reset "미소"       이전 결정을 지운다
 *
 * 출력: state/company_choices.json  (+ 해당 회사의 재무 캐시 무효화)
 *
 * 🔴 지금까지는 콘솔에 후보만 찍고 미확인으로 뒀다. 그래서 **같은 질문이 매 실행마다 반복**됐고
 *    사용자가 답을 알아도 반영할 방법이 없었다. 여기서 답을 받아 영구 저장한다.
 *
 * 🔴 **자동으로 고르지 않는다.** 후보가 여럿일 때 하나를 골라 주는 순간, 사용자는 잘못된 회사의
 *    재무를 보고 지원 결정을 내린다. 부분일치 5건 사고와 같은 종류의 손해다.
 *
 * 🔴 사용자가 고른 것도 틀릴 수 있다. 그래서 선택은 **되돌릴 수 있고**(`--reset`),
 *    리포트에는 "사용자가 확인함"으로 표시해 자동 판정과 구분한다.
 */
import { loadProfile, statePath, cachePath, readJson, writeJson } from './lib/io.mjs';
import { normCorp } from './lib/text.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
const choiceFile = statePath(profile, 'company_choices.json');
const choices = readJson(choiceFile, { updatedAt: null, choices: {} });

/** 🔴 선택을 저장해도 캐시에 옛 결과가 남아 있으면 다음 실행이 그걸 그대로 쓴다.
 *    (a) 판정 로직 (b) 저장 로직 (c) 기존 데이터 — 셋을 같이 고쳐야 실제로 반영된다. */
function invalidateCache(keys) {
  const file = cachePath(profile, 'finance.json');
  const cache = readJson(file, null);
  if (!cache) return 0;
  let n = 0;
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(cache, k)) { delete cache[k]; n++; }
  if (n) writeJson(file, cache);
  return n;
}

// ── --reset ─────────────────────────────────────────────────────────────────
const reset = flag('reset');
if (reset) {
  const key = normCorp(reset);
  if (!choices.choices[key]) {
    console.log(`"${reset}" 에 저장된 결정이 없습니다.`);
    process.exit(0);
  }
  delete choices.choices[key];
  choices.updatedAt = new Date().toISOString();
  writeJson(choiceFile, choices);
  invalidateCache([key]);
  console.log(`"${reset}" 의 결정을 지웠습니다. 다음 finance 실행에서 다시 판정합니다.`);
  process.exit(0);
}

// ── 후보 모으기 ─────────────────────────────────────────────────────────────
const fin = readJson(statePath(profile, 'finance.json'), null);
if (!fin) {
  console.error('finance.json 이 없습니다. 재무 단계를 먼저 돌려 주십시오:  node scripts/finance.mjs');
  process.exit(1);
}

const pending = Object.entries(fin.companies ?? {})
  .filter(([key, c]) => c.ambiguous?.candidates?.length && !choices.choices[key])
  .map(([key, c]) => ({ key, name: c.name, where: c.ambiguous.where, candidates: c.ambiguous.candidates }));

const decided = Object.entries(choices.choices ?? {});
if (decided.length) {
  console.log(`이미 확인한 회사 ${decided.length}곳:`);
  for (const [, v] of decided) {
    console.log(`  ${v.name} → ${v.skip ? '모르겠음(미확인 유지)' : `${v.corpNm} (법인번호 ${v.crno})`}`);
  }
  console.log('  되돌리려면:  node scripts/resolve_company.mjs --reset "회사명"\n');
}

if (!pending.length) {
  console.log('확인이 필요한 동명이인 회사가 없습니다.');
  process.exit(0);
}

const show = () => {
  for (const p of pending) {
    console.log(`\n"${p.name}" — 후보 ${p.candidates.length}곳 (출처: ${p.where})`);
    p.candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c.corpNm} — ${c.addr || '주소 없음'} · 법인번호 ${c.crno ?? '없음'}`));
    console.log('  0) 모르겠음 — 미확인으로 두고 다시 묻지 않습니다');
  }
};

if (argv.includes('--list')) {
  show();
  console.log(`\n고르려면:  node scripts/resolve_company.mjs --pick "${pending[0].name}=1"`);
  process.exit(0);
}

// ── --pick (비대화형) ───────────────────────────────────────────────────────
function apply(name, pickRaw) {
  const key = normCorp(name);
  const target = pending.find(p => normCorp(p.name) === key)
    ?? pending.find(p => normCorp(p.name).includes(key));
  if (!target) return `"${name}" 는 확인 대기 목록에 없습니다.`;

  const n = Number(pickRaw);
  if (!Number.isInteger(n) || n < 0 || n > target.candidates.length) {
    return `"${name}" 의 선택 "${pickRaw}" 가 범위를 벗어났습니다 (0~${target.candidates.length}).`;
  }
  const tkey = normCorp(target.name);
  if (n === 0) {
    // 🔴 "모르겠음"도 결정이다. 저장해 두지 않으면 매 실행마다 같은 질문이 반복된다.
    choices.choices[tkey] = { name: target.name, skip: true, decidedAt: new Date().toISOString() };
    return `"${target.name}" — 미확인으로 두었습니다. (--reset 으로 되돌릴 수 있습니다)`;
  }
  const c = target.candidates[n - 1];
  if (!c.crno) return `"${target.name}" 의 ${n}번 후보에는 법인등록번호가 없어 근거로 쓸 수 없습니다. 다른 번호를 골라 주십시오.`;
  choices.choices[tkey] = {
    name: target.name, corpNm: c.corpNm, crno: c.crno, addr: c.addr ?? null,
    source: 'user', decidedAt: new Date().toISOString(),
  };
  return `"${target.name}" → ${c.corpNm} (법인번호 ${c.crno})`;
}

const pick = flag('pick');
if (pick) {
  const msgs = [];
  for (const part of String(pick).split(',').map(s => s.trim()).filter(Boolean)) {
    const [name, val] = part.split('=').map(s => s.trim());
    msgs.push(apply(name, val));
  }
  choices.updatedAt = new Date().toISOString();
  writeJson(choiceFile, choices);
  const n = invalidateCache(Object.keys(choices.choices));
  for (const m of msgs) console.log(m);
  console.log(`\n캐시 ${n}건을 지웠습니다. 반영하려면 재무를 다시 돌려 주십시오:  node scripts/finance.mjs`);
  process.exit(0);
}

// ── 대화형 ──────────────────────────────────────────────────────────────────
// 🔴 파이프·스크립트로 실행하면 stdin 이 없어 그대로 멈춘다. 그때는 묻지 않고 방법을 알려 준다.
if (!process.stdin.isTTY) {
  show();
  console.log('\n⚠ 대화형 입력을 받을 수 없는 환경입니다(stdin 없음). 아래처럼 골라 주십시오:');
  console.log(`  node scripts/resolve_company.mjs --pick "${pending[0].name}=1"`);
  process.exit(0);
}

const { createInterface } = await import('node:readline/promises');
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`확인이 필요한 회사 ${pending.length}곳입니다.`);
console.log('같은 이름의 법인이 여러 곳이라 재무를 붙이지 않았습니다 — 자동으로 고르면 틀린 회사 재무가 붙습니다.\n');

let answered = 0;
for (const p of pending) {
  console.log(`\n"${p.name}" — 후보 ${p.candidates.length}곳 (출처: ${p.where})`);
  p.candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c.corpNm} — ${c.addr || '주소 없음'} · 법인번호 ${c.crno ?? '없음'}`));
  console.log('  0) 모르겠음 — 미확인으로 두고 다시 묻지 않습니다');
  console.log('  s) 이번엔 건너뛰기 — 다음 실행에서 다시 묻습니다');

  const ans = (await rl.question('  번호: ')).trim().toLowerCase();
  if (ans === 's' || ans === '') { console.log('  건너뜁니다.'); continue; }
  console.log('  ' + apply(p.name, ans));
  answered++;
}
rl.close();

choices.updatedAt = new Date().toISOString();
writeJson(choiceFile, choices);
const n = invalidateCache(Object.keys(choices.choices));
console.log(`\n${answered}곳을 확정했습니다. 캐시 ${n}건을 지웠습니다.`);
console.log('반영하려면 재무를 다시 돌려 주십시오:  node scripts/finance.mjs');
console.log(`→ ${choiceFile}`);
