// 프로필 디렉터리 · 파이프라인 단계 간 JSON 주고받기.
//
// 각 단계는 JSON in/out이라 따로 돌리고 이어서 돌릴 수 있다. 중간에 실패해도 처음부터 다시 돌지 않는다.
// 🔴 이 디렉터리 안의 것은 개인정보다. 저장소로 새어 나가면 안 된다.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseYaml } from './yaml.mjs';

export const HOME_ROOT = process.env.JD_SEARCH_HOME || path.join(os.homedir(), '.jd-search');

export function profileDir(id = process.env.JD_SEARCH_PROFILE || 'default') {
  return path.join(HOME_ROOT, id);
}

export function loadProfile(id) {
  const dir = profileDir(id);
  const file = path.join(dir, 'profile.yml');
  if (!fs.existsSync(file)) {
    throw new Error(`프로필이 없습니다: ${file}\nSKILL.md "첫 실행 — 프로필 만들기"부터 진행해 주십시오.`);
  }
  const p = parseYaml(fs.readFileSync(file, 'utf8')) || {};
  // 아래 기본값은 profile.yml에 키가 없어도 파이프라인이 돌게 한다.
  p.target ??= {};
  p.location ??= {};
  p.sources ??= { wanted: 'api' };
  p.finance ??= { enabled: true, staleYears: 3 };
  p.watchlist ??= [];
  p.blocklist ??= [];
  p.dir = dir;
  return p;
}

// 🔴 이 디렉터리에는 이력서·자택주소·지원이력이 들어간다.
//    기본 umask면 755/644로 만들어져 **같은 컴퓨터의 다른 계정이 그대로 읽는다.**
//    🔴 새로 만들 때만 mode를 주면 부족하다 — 구버전에서 이미 755로 만들어진 디렉터리가
//       그대로 열려 있게 된다. **이미 있는 것도 매번 조인다.**
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

function ensure(d) {
  fs.mkdirSync(d, { recursive: true, mode: PRIVATE_DIR });
  try {
    if ((fs.statSync(d).mode & 0o777) !== PRIVATE_DIR) fs.chmodSync(d, PRIVATE_DIR);
  } catch { /* 권한 조정 실패가 본 작업을 막지는 않는다 */ }
  return d;
}

/**
 * 🔴 **파일이 없는 것과 파일이 깨진 것은 전혀 다른 상황이다.**
 *    둘 다 fallback으로 삼키면, 손상된 postings.json 을 빈 값으로 읽은 collect 가
 *    멀쩡한 얼굴로 덮어써 **그동안 모은 공고가 통째로 사라진다.** 사용자는 알 방법이 없다.
 *    없으면 fallback, 깨졌으면 멈춘다.
 */
export const readJson = (file, fallback = null) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file} 을 읽지 못했습니다: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${file} 이 손상됐습니다 (${e.message}).\n` +
      `🔴 이대로 진행하면 기존 데이터를 빈 값으로 덮어쓰게 되므로 멈춥니다.\n` +
      `   백업이 있는지 확인하시고(${file}.bak), 복구가 어려우면 파일을 지운 뒤 다시 수집해 주십시오.`);
  }
};

export function writeJson(file, data) {
  ensure(path.dirname(file));
  // 덮어쓰기 전 직전 상태를 한 벌 남긴다. 잘못된 실행 한 번에 이력이 날아가지 않게.
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); fs.chmodSync(`${file}.bak`, PRIVATE_FILE); } catch { /* 백업 실패가 본 작업을 막지는 않는다 */ }
  }
  // 임시 파일 → rename. 중간에 죽어도 반쯤 쓰인 JSON이 남지 않는다.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: PRIVATE_FILE });
  fs.renameSync(tmp, file);
  return file;
}

export const statePath = (p, name) => path.join(ensure(path.join(p.dir, 'state')), name);
export const cachePath = (p, name) => path.join(ensure(path.join(p.dir, 'cache')), name);
export const outPath = (p, name) => path.join(ensure(path.join(p.dir, 'out')), name);

/** 🔴 JD 원문 저장 — 공고는 마감되면 사라져 소급이 안 된다. 반드시 남긴다. */
export function saveJd(p, board, id, markdown) {
  const dir = ensure(path.join(p.dir, 'state', 'jd'));
  const file = path.join(dir, `${board}-${id}.md`);
  fs.writeFileSync(file, markdown, { mode: PRIVATE_FILE });
  return file;
}

/** 캐시는 "없으면 만들고 있으면 그대로" — 재실행해도 API를 다시 때리지 않는다. */
export function jsonCache(file) {
  const data = readJson(file, {});
  let dirty = false;
  return {
    get: k => data[k],
    has: k => Object.prototype.hasOwnProperty.call(data, k),
    set(k, v) { data[k] = v; dirty = true; return v; },
    async memo(k, fn) {
      if (this.has(k)) return data[k];
      return this.set(k, await fn());
    },
    flush() { if (dirty) { writeJson(file, data); dirty = false; } },
    size: () => Object.keys(data).length,
  };
}

/**
 * 보드별 수집 방식을 확인한다.
 *
 * 🔴 예전에는 `=== 'off'` 만 봤다. 그래서 `offf` 같은 오타가 **수집으로 흘러갔다** —
 *    사용자는 껐다고 믿는데 계속 긁는다. 아는 값만 통과시키고 나머지는 멈춘다.
 * 🔴 `api`(공식 API)와 `web`(공개 페이지 HTML 파싱)을 구분해 적는다.
 *    같은 이름으로 묶으면 이 도구가 무엇을 하고 있는지 문서가 흐려진다.
 */
export const SOURCE_MODES = ['api', 'web', 'browser', 'off'];

export function requireSourceEnabled(profile, board, fallback = 'api') {
  const mode = profile.sources?.[board] ?? fallback;
  if (!SOURCE_MODES.includes(mode)) {
    throw new Error(
      `profile.yml 의 sources.${board} 값이 "${mode}" 입니다. ` +
      `${SOURCE_MODES.join(' · ')} 중 하나여야 합니다.`);
  }
  if (mode === 'off') throw new Error(`profile.yml 의 sources.${board} 가 off 입니다.`);
  return mode;
}
