#!/usr/bin/env node
/**
 * fit — 이력서와 JD 원문을 맞대어 **겹침·공백**을 낸다.
 *
 * 실행:
 *   node fit.mjs --terms [--profile <id>]     이력서를 훑어 낱말 목록만 출력한다 (온보딩용)
 *   node fit.mjs [--profile <id>]             전 공고를 판정해 state/fit.json 을 쓴다
 *
 * 출력: ~/.jd-search/<프로필>/state/fit.json
 *
 * 🔴 점수를 만들지 않는다. 내는 것은 겹친 낱말·공백 낱말·못 읽은 사유뿐이다
 *    (SKILL.md 「절대 하지 말 것」 1번).
 * 🔴 **이력서 원문은 이 스크립트 밖으로 나가지 않는다.** 사전에 걸린 낱말 이름만 state 에 남는다.
 *    report.html 에 실을지는 render 가 `--with-fit` 으로 따로 정한다 — 공유될 수 있는 파일이라서다.
 * 🔴 `fit.terms` 가 비어 있으면 **멈춘다.** 이력서에서 자동으로 뽑아 그대로 쓰면
 *    사용자가 확인하지 않은 낱말로 목록이 정렬된다. 확인은 온보딩에서 한 번 받는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, statePath, readJson, writeJson } from './lib/io.mjs';
import { loadDictionary, termsFromText, judgeFit, normalizeTerms, MATCH_CATEGORIES } from './lib/fit.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);

// 🔴 사전을 읽기 **전에** 껐는지 본다. 꺼 둔 사용자가 사전이 깨졌다는 이유로
//    "대조하지 않습니다" 대신 오류로 멈추면, 자기가 안 쓰는 기능 때문에 파이프라인이 선다.
if (profile.fit?.enabled === false) {
  console.log('profile.yml 의 fit.enabled 가 false 입니다. 대조하지 않습니다.');
  process.exit(0);
}

// 🔴 사전 오류는 스택 트레이스가 아니라 문장으로 낸다. 사용자가 고쳐야 하는 것은 YAML 파일이지
//    Node 호출 스택이 아니다 — 이 저장소는 실패할 때 무엇을 하라고 말하기로 되어 있다.
let dictionary;
try {
  dictionary = loadDictionary(flag('dict') || undefined);
} catch (e) {
  console.error(`${e.message}\n  사전을 고치기 전까지는 fit 단계를 건너뛰셔도 됩니다 (profile.yml 의 fit.enabled: false).`);
  process.exit(1);
}

// 🔴 profile.yml 은 사람이 손으로 적는다. 타입이 어긋나면 Node 기본 오류가 아니라
//    **무엇을 고쳐야 하는지 적힌 문장**으로 멈춘다 — 스택 트레이스로는 고칠 수 없다.
const docPath = (key) => {
  const v = profile.documents?.[key];
  if (v == null) return null;
  if (typeof v !== 'string') {
    console.error(`profile.yml 의 documents.${key} 가 경로 문자열이 아닙니다 (${typeof v}). 예: ${key}: docs/${key}.md`);
    process.exit(1);
  }
  return path.resolve(profile.dir, v);
};
const resumeFile = docPath('resume');

// ── --terms · 온보딩 · 이력서에서 낱말만 뽑아 보여 준다 ──────────────────
if (argv.includes('--terms')) {
  if (!resumeFile || !fs.existsSync(resumeFile)) {
    console.error(
      '이력서를 찾지 못했습니다.\n' +
      `  profile.yml 의 documents.resume 에 경로를 적고, 그 파일을 ${profile.dir} 아래에 두십시오.\n` +
      '  이력서가 없으면 references/role-presets.yml 에서 직군을 골라 fit.terms 를 직접 채우셔도 됩니다.');
    process.exit(1);
  }
  const text = fs.readFileSync(resumeFile, 'utf8');
  const extra = [docPath('career'), docPath('portfolio')]
    .filter(f => f && fs.existsSync(f))
    .map(f => fs.readFileSync(f, 'utf8'));
  const found = termsFromText([text, ...extra].join('\n'), dictionary);

  console.log(`이력서에서 찾은 낱말 ${found.length}개입니다. 확인 후 profile.yml 의 fit.terms 에 넣어 주십시오.\n`);
  for (const cat of MATCH_CATEGORIES) {
    const list = found.filter(f => f.category === cat);
    if (!list.length) continue;
    console.log(`  [${cat}] ${list.map(f => f.term).join(' · ')}`);
  }
  console.log('\nfit:\n  enabled: true\n  terms:');
  for (const f of found) console.log(`    - ${f.term}`);
  console.log('\n🔴 이 목록은 사전(references/jd-terms.yml)에 있는 낱말만 찾은 것입니다.');
  console.log('   빠진 것이 있으면 사전에 낱말을 더하고 다시 돌리십시오 — 사전이 곧 시야의 한계입니다.');
  process.exit(0);
}

// ── 본 판정 ────────────────────────────────────────────────────────────
const myTerms = profile.fit?.terms ?? [];
// 🔴 `terms: SQL` 처럼 대괄호를 빼는 실수가 흔하다. 문자열도 .length 가 있어 위 검사를 통과한 뒤
//    한참 뒤 .map 에서 TypeError 로 죽는다 — 그 메시지로는 profile.yml 을 의심하지 못한다.
if (!Array.isArray(myTerms)) {
  console.error(`profile.yml 의 fit.terms 가 목록이 아닙니다 (${typeof myTerms}).\n  "- 낱말" 형태의 목록으로 적어 주십시오. \`node fit.mjs --terms\` 출력을 그대로 붙이면 됩니다.`);
  process.exit(1);
}
if (!myTerms.length) {
  console.error(
    'profile.yml 에 fit.terms 가 없습니다.\n' +
    '  먼저 `node fit.mjs --terms` 로 이력서에서 낱말을 뽑아 **확인한 뒤** 넣어 주십시오.\n' +
    '  확인 없이 자동으로 채우면 사용자가 본 적 없는 낱말로 목록이 정렬됩니다.');
  process.exit(1);
}

const store = readJson(statePath(profile, 'postings.json'));
if (!store) { console.error('postings.json 이 없습니다. collect 단계를 먼저 돌려 주십시오.'); process.exit(1); }
// 🔴 render 와 **같은 키**로 적는다. 여기서 p.id 를 쓰면 병합·저장본 공고에서 키가 어긋나
//    겹침이 엉뚱한 카드에 붙는다 — 사용자는 그게 틀렸다는 것을 알 방법이 없다.
const entries = Object.entries(store.postings ?? {});
if (!entries.length) {
  console.error('공고가 없습니다. 먼저 수집을 돌려 주십시오.');
  process.exit(1);
}

// 🔴 사전에 없는 낱말은 영영 안 걸린다. 사용자는 자기가 적은 낱말이 왜 한 번도
//    안 나오는지 알 방법이 없다 — 적은 그 자리에서 말해 준다.
const { unknown: unknownTerms } = normalizeTerms(myTerms, dictionary);
if (unknownTerms.length) {
  console.log(`⚠ 사전에 없는 낱말 ${unknownTerms.length}개는 겹침으로도 공백으로도 나오지 않습니다: ${unknownTerms.join(' · ')}`);
  console.log('  references/jd-terms.yml 에 더하거나, fit.terms 에서 빼 주십시오.');
}

const out = {};
const tally = { ok: 0, thin: 0, unknown: 0 };
for (const [key, p] of entries) {
  const jdText = p.jd && fs.existsSync(p.jd) ? fs.readFileSync(p.jd, 'utf8') : '';
  const fit = judgeFit({ jdText, jdKind: p.jdKind, myTerms, dictionary });
  tally[fit.verdict] = (tally[fit.verdict] ?? 0) + 1;
  out[key] = fit;
}

writeJson(statePath(profile, 'fit.json'), { updatedAt: new Date().toISOString(), byId: out });

console.log(`대조 ${entries.length}건 · 판정 ${tally.ok} · 사전 밖 ${tally.thin} · 못 읽음 ${tally.unknown}`);
if (tally.unknown) {
  console.log('🔴 못 읽은 공고는 목록에서 빼지 않습니다. 본문이 이미지뿐인 공고가 여기 들어갑니다.');
}
// 🔴 사전이 규격은 맞는데 **내 직군을 못 따라가는** 경우가 있다. 코드는 그걸 알 수 없다.
//    대신 비율로 말한다 — 읽은 공고 대부분이 사전 밖이면 문제는 공고가 아니라 사전이다.
//    이 말을 안 해 주면 사용자는 "내 조건에 맞는 자리가 없구나" 로 읽는다.
const readable = tally.ok + tally.thin;
// 🔴 표본이 적으면 비율은 말이 안 된다. 1건 중 1건이 사전 밖이라고 "사전이 문제" 라고 하면
//    맞을 수도 있고 그냥 그 공고 하나가 특이한 것일 수도 있다. 단정할 근거가 없다.
const MIN_SAMPLE = 5;
if (readable >= MIN_SAMPLE && tally.thin / readable >= 0.6) {
  console.log(
    `🔴 읽은 공고 ${readable}건 중 ${tally.thin}건이 사전 밖입니다.\n` +
    '   공고가 안 맞는 게 아니라 사전이 이 직군을 못 따라가고 있을 가능성이 큽니다.\n' +
    '   references/jd-terms.yml 에 이 직군에서 실제로 쓰는 낱말을 더해 주십시오.');
} else if (tally.thin) {
  console.log('사전 밖으로 빠진 공고가 있습니다 — references/jd-terms.yml 에 그 직군 낱말을 더하면 줄어듭니다.');
}
