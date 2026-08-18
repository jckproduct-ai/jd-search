/**
 * fit — 이력서와 JD 원문을 같은 사전으로 훑어 **겹침**과 **공백**을 낸다.
 *
 * 🔴 점수를 만들지 않는다. "이 공고가 당신과 87% 맞습니다" 는 검증할 수 없다
 *    (SKILL.md 「절대 하지 말 것」 1번 · README 의 공개 약속).
 *    여기서 내는 것은 셀 수 있는 사실뿐이다 — 그 낱말이 JD 에 있었는가, 이력서에 있었는가.
 *
 * 🔴 **대조하지 못한 공고를 "겹침 0" 으로 적지 않는다.** 못 읽은 것과 안 맞는 것은 다르다.
 *    사람인·인크루트에는 본문이 이미지 한 장뿐인 공고가 흔하다. 이 둘을 뭉개면
 *    그 공고들이 전부 최하위로 밀려 목록에서 조용히 사라진다 — 사용자는 알아챌 방법이 없다.
 *    그래서 판정은 세 갈래다: `ok` · `thin`(본문은 읽었으나 사전에 걸린 낱말이 없음) · `unknown`(못 읽음).
 *
 * 🔴 이력서와 JD 를 **같은 함수**로 훑는다(`termsFromText`). 한쪽만 다른 규칙으로 뽑으면
 *    겹침이 규칙 차이 때문에 생기거나 사라지고, 그건 근거가 아니라 잡음이다.
 *
 * 🔴 근무조건(재택·유연근무·스톡옵션)은 겹침·공백에서 뺀다. 이력서에 적을 것이 아니라
 *    회사가 주는 조건이다. "재택 공백" 같은 문장은 사실이 아니라 오해다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DICT = path.join(HERE, '..', '..', 'references', 'jd-terms.yml');

/** 겹침·공백 판정에 쓰는 분류. `condition` 은 일부러 뺀다 (위 주석 참고). */
export const MATCH_CATEGORIES = ['domain', 'skill', 'tool'];

/**
 * 본문이 이보다 짧으면 대조하지 않는다.
 * 🔴 잡코리아 요약(summaryOnly)은 200자 아래가 흔하다. 짧은 본문에서 낱말이 안 나온 것을
 *    "이 사람과 겹치는 게 없다" 로 읽으면 안 된다.
 */
export const MIN_BODY_CHARS = 120;

/** 분류마다 이만큼은 있어야 사전으로 친다. 뼈대만 남은 파일을 거르는 값이다. */
export const MIN_TERMS_PER_CATEGORY = 3;

/**
 * 사전을 읽어 평평한 배열로 만든다. `{ category, term, needles[] }`
 *
 * 🔴 **비었거나 분류가 없으면 멈춘다.** 사전이 0건이면 모든 정상 공고가 `thin` 이 되는데,
 *    그건 "이 직군 낱말이 사전에 없다" 는 뜻이라 사용자는 사전을 늘리려 든다.
 *    실제로는 사전 파일이 깨진 것이다 — 읽을 수 없는 사전을 조용히 "사전 밖 공고" 로 바꾸면 안 된다.
 */
export function loadDictionary(file = DEFAULT_DICT) {
  const raw = parseYaml(fs.readFileSync(file, 'utf8'));
  const dict = flattenDictionary(raw);
  if (!dict.length) {
    throw new Error(`사전이 비었습니다: ${file}\n  YAML 이 깨졌거나 항목이 없습니다. 이대로 두면 모든 공고가 "사전 밖"으로 찍힙니다.`);
  }
  // 🔴 "분류가 있기만 하면 통과" 로는 부족하다. 분류마다 한 줄씩만 남은 뼈대 파일도
  //    통과해 전 공고를 thin 으로 만든다 — 막으려던 침묵 실패가 그대로 되돌아온다.
  //    쓸모 있는 사전인지까지는 코드가 알 수 없으므로, **뼈대인지**만 건수로 거른다.
  const thin = MATCH_CATEGORIES.filter(c => dict.filter(d => d.category === c).length < MIN_TERMS_PER_CATEGORY);
  if (thin.length) {
    throw new Error(
      `사전의 분류가 너무 얕습니다: ${thin.join(', ')} (${file})\n` +
      `  분류마다 최소 ${MIN_TERMS_PER_CATEGORY}개는 있어야 합니다. 지금 상태로는 대부분의 공고가 "사전 밖"으로 찍힙니다.`);
  }
  return dict;
}

/**
 * 🔴 사용자가 손으로 고치는 파일이다. 한 줄 실수로 fit 단계 전체가 죽지 않게 받아 준다.
 *    `aliases: QA` 처럼 배열 대신 스칼라를 적는 것은 흔한 실수라 단일 별칭으로 읽는다.
 *    다만 **조용히 버리지는 않는다** — 항목 모양이 아예 아니면 건너뛰고, 그 결과 사전이 비면 위에서 멈춘다.
 */
export function flattenDictionary(raw) {
  const out = [];
  for (const [category, entries] of Object.entries(raw ?? {})) {
    if (!Array.isArray(entries)) continue;             // version: 1 같은 스칼라 칸은 건너뛴다
    for (const e of entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      // 🔴 String() 으로 뭉개지 않는다. `term: {bad: 1}` 이 "[object Object]" 가 되어
      //    비어 있지 않은 낱말로 통과하면, 분류는 다 있는데 아무것도 안 걸려 전 공고가 thin 이 된다.
      //    바로 이 침묵 실패를 막으려고 사전 검증을 넣었는데 그 검증을 우회하던 자리다.
      const term = scalarText(e.term);
      if (!term) continue;
      const aliases = toList(e.aliases).map(scalarText).filter(Boolean);
      out.push({ category, term, needles: [term, ...aliases] });
    }
  }
  return out;
}

/** 스칼라 하나를 1개짜리 목록으로 받아 준다. null·undefined 는 빈 목록. */
function toList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 문자열·숫자만 낱말로 받는다. 객체·배열은 버린다 — 뭉개면 "[object Object]" 가 낱말이 된다. */
function scalarText(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * 한 낱말이 본문에 있는가.
 *
 * 🔴 **영문·숫자로만 된 낱말은 길이와 무관하게 낱말 경계로 본다.**
 *    처음에는 2~4글자(PM·QA·SQL)에만 걸었는데, 그러면 `React` 가 `Reactive programming` 에,
 *    `Jira` 가 `Jirachi` 에 걸린다. 있지도 않은 겹침은 사용자가 틀렸다는 것을 알 방법이 없다.
 * 🔴 정규식 특수문자를 이스케이프한다 — `Node.js` 의 `.` 이 아무 글자나 받으면 `NodeXjs` 가 걸린다.
 * 🔴 한글은 낱말 경계가 없어 부분일치로 둔다. 대신 **사전에서 애매한 별칭을 빼는 것**으로 막는다
 *    (`인사` 가 `인사드립니다` 에 걸리던 자리다).
 */
export function needleHit(haystack, needle) {
  const h = String(haystack ?? '').toLowerCase();
  const n = String(needle ?? '').trim().toLowerCase();
  if (!n) return false;
  // 🔴 낱말 **전체**가 아니라 **양끝을 각각** 본다.
  //    "ASCII 로만 된 낱말" 을 조건으로 걸었더니 `0→1 출시` 처럼 유니코드 화살표가 섞인 낱말이
  //    통째로 부분일치로 떨어져 `10→1 출시` 안에서 걸렸다. 앞뒤를 따로 보면 그런 낱말도
  //    앞쪽 경계만은 지킬 수 있다 — 한글로 끝나는 쪽은 경계가 없으니 그대로 둔다.
  const head = /^[a-z0-9]/.test(n) ? '(^|[^a-z0-9])' : '';
  const tail = /[a-z0-9]$/.test(n) ? '([^a-z0-9]|$)' : '';
  if (!head && !tail) return h.includes(n);
  return new RegExp(`${head}${n.replace(RE_ESCAPE, '\\$&')}${tail}`, 'i').test(h);
}

/** 본문에서 사전에 걸린 term 목록을 뽑는다. 이력서에도 JD 에도 **같은 함수**를 쓴다. */
export function termsFromText(text, dictionary, categories = MATCH_CATEGORIES) {
  const body = String(text ?? '');
  const wanted = new Set(categories);
  const found = [];
  for (const entry of dictionary) {
    if (!wanted.has(entry.category)) continue;
    const needle = entry.needles.find(n => needleHit(body, n));
    if (needle) found.push({ category: entry.category, term: entry.term, matched: needle });
  }
  return found;
}

/**
 * 한 공고를 판정한다.
 *
 * @param jdText   저장해 둔 JD 원문 (state/jd/<보드>-<id>.md)
 * @param jdKind   text | summaryOnly | imageOnly | empty | failed
 * @param myTerms  이력서에서 뽑은 term 이름 배열 (profile.fit.terms)
 * @returns { verdict, overlap[], gap[], conditions[], reason }
 */
/**
 * 내 낱말도 **JD·이력서와 똑같이** 사전으로 훑는다.
 *
 * 🔴 이 함수가 따로 매칭 규칙을 갖지 않는 것이 핵심이다. 예전에는 여기서
 *    별칭→대표이름 Map 을 따로 만들었는데, 그 순간 낱말을 찾는 길이 둘이 되어
 *    한쪽만 고쳐질 때마다 새 버그가 났다 — `React` 를 적으면 겹치는데도 공백으로 뒤집히고,
 *    대소문자가 갈리고, 같은 별칭을 두 항목이 나눠 가지면 하나만 잡혔다.
 *    셋 다 같은 뿌리다. 길을 하나로 두면 그 부류가 통째로 사라진다.
 *
 * 🔴 사전에 없는 낱말은 영영 안 걸린다. 조용히 두지 말고 돌려준다.
 */
export function normalizeTerms(myTerms, dictionary = []) {
  const terms = new Set();
  const unknown = [];
  for (const raw of myTerms ?? []) {
    const t = String(raw ?? '').trim();
    if (!t) continue;
    const hits = termsFromText(t, dictionary);
    if (hits.length) for (const h of hits) terms.add(h.term);
    else unknown.push(t);
  }
  return { terms, unknown };
}

export function judgeFit({ jdText, jdKind, myTerms = [], dictionary }) {
  // 🔴 `terms: SQL` 처럼 대괄호를 빼고 적는 실수가 흔하다. 문자열에는 .map 이 없어
  //    파이프라인이 TypeError 로 죽는데, 그 메시지로는 무엇을 고쳐야 하는지 알 수 없다.
  if (!Array.isArray(myTerms)) {
    throw new Error(`fit.terms 가 목록이 아닙니다 (${typeof myTerms}). profile.yml 에서 "- 낱말" 형태의 목록으로 적어 주십시오.`);
  }
  const mine = normalizeTerms(myTerms, dictionary ?? []).terms;

  // ── 1. 읽을 수 있는 본문인가 ──────────────────────────────────────
  if (jdKind === 'imageOnly') {
    return unknown('본문이 이미지뿐이라 대조하지 못했습니다');
  }
  const body = String(jdText ?? '');
  if (!body.trim() || jdKind === 'empty' || jdKind === 'failed') {
    return unknown('JD 원문을 받지 못해 대조하지 못했습니다');
  }
  if (body.trim().length < MIN_BODY_CHARS) {
    return unknown(`본문이 ${body.trim().length}자뿐이라 대조하지 못했습니다`);
  }

  // ── 2. 같은 사전으로 훑는다 ──────────────────────────────────────
  const jdTerms = termsFromText(body, dictionary);
  const conditions = termsFromText(body, dictionary, ['condition']).map(t => t.term);

  // 🔴 본문은 읽었는데 사전에 하나도 안 걸린 경우. "겹침 0" 이 아니라 "사전 밖" 이다.
  //    사전이 못 따라간 직군일 수 있으므로 사용자에게 그렇게 말한다.
  if (!jdTerms.length) {
    return {
      verdict: 'thin', overlap: [], gap: [], conditions,
      reason: '사전에 걸린 낱말이 본문에 없습니다 — 이 직군의 낱말을 jd-terms.yml 에 더해 주십시오',
    };
  }

  const overlap = jdTerms.filter(t => mine.has(t.term)).map(t => t.term);
  const gap = jdTerms.filter(t => !mine.has(t.term)).map(t => t.term);
  return { verdict: 'ok', overlap, gap, conditions, reason: null };

  function unknown(reason) {
    return { verdict: 'unknown', overlap: [], gap: [], conditions: [], reason };
  }
}

/**
 * 목록 정렬용 키.
 * 🔴 `unknown` 을 맨 아래로 보내지 않는다. 못 읽은 공고가 목록 끝으로 밀리면
 *    본문이 이미지인 공고를 사용자가 영영 안 보게 된다. 겹침을 센 것 다음, 공백 앞에 둔다.
 */
export const FIT_SORT_RANK = { ok: 0, unknown: 1, thin: 2 };

export function fitSortKey(fit) {
  if (!fit) return [3, 0];
  return [FIT_SORT_RANK[fit.verdict] ?? 3, -(fit.overlap?.length ?? 0)];
}

/** 화면에 찍을 한 줄. 숫자는 **센 것**만 쓴다 — 비율·점수로 바꾸지 않는다. */
export function fitSummary(fit) {
  if (!fit) return null;
  if (fit.verdict !== 'ok') return fit.reason;
  const parts = [];
  if (fit.overlap.length) parts.push(`겹침 ${fit.overlap.length}`);
  if (fit.gap.length) parts.push(`공백 ${fit.gap.length}`);
  return parts.join(' · ') || '겹치는 낱말이 없습니다';
}
