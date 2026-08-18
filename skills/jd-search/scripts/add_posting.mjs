#!/usr/bin/env node
/**
 * 공고 하나를 주소로 추가한다.
 *
 * 실행: node add_posting.mjs --url "https://www.wanted.co.kr/wd/123456"
 *       node add_posting.mjs --url "https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=53930400"
 *
 * 검색으로는 안 잡히는 공고가 있다 — 지인이 보내 준 링크, 자사 채용페이지를 거쳐 온 것,
 * 키워드 표기가 어긋난 것. 그걸 손으로 넣을 수 있어야 목록이 실제 구직 상황과 맞는다.
 *
 * 🔴 수집과 **같은 경로**를 쓴다(상세 → 정규화 → JD 원문 저장). 여기서만 따로 만들면
 *    손으로 넣은 공고만 본문 없는 반쪽 레코드가 되고, 그 차이는 마감된 뒤에야 드러난다.
 * 🔴 이미 있는 공고면 덮어쓰지 않고 최신 상태만 갱신한다.
 */
import { loadProfile, statePath, readJson, writeJson } from './lib/io.mjs';
import { parsePostingUrl } from './lib/board_url.mjs';
import { recordFromId } from './lib/board_adapters.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const profile = loadProfile(flag('profile') || undefined);
const raw = flag('url');
if (!raw) {
  console.error('주소가 없습니다.  node add_posting.mjs --url "<공고 주소>"');
  process.exit(1);
}

const parsed = parsePostingUrl(raw);
if (!parsed) {
  console.error('아직 읽을 수 없는 주소입니다. 지금 지원하는 형태:');
  console.error('  https://www.wanted.co.kr/wd/<번호>');
  console.error('  https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=<번호>');
  console.error('  https://jumpit.saramin.co.kr/position/<번호>');
  console.error('  https://job.incruit.com/jobdb_info/jobpost.asp?job=<번호>');
  console.error('  https://www.jobkorea.co.kr/Recruit/GI_Read/<번호>');
  process.exit(1);
}

const file = statePath(profile, 'postings.json');
const store = readJson(file, { updatedAt: null, postings: {} });
const key = `${parsed.board}:${parsed.id}`;
const existed = Boolean(store.postings[key]);

// 🔴 보드 분기는 `lib/board_adapters.mjs` 하나에만 둔다. 여기에 else 가지를 두면
//    보드가 늘어날 때(점핏·인크루트·잡코리아) **모르는 보드가 사람인으로 조회돼** 남의 공고가 들어온다.
const r = await recordFromId(profile, parsed.board, parsed.id, ['수동 추가']);
if (r.gone) { console.error('이미 내려간 공고입니다.'); process.exit(1); }
if (r.unknown) { console.error(`조회하지 못했습니다: ${r.error}`); process.exit(1); }
const rec = r.rec;

rec.discoveredVia = 'manual';
rec.seenRunId = new Date().toISOString();
// 🔴 손으로 넣은 공고를 stale 로 지우지 않는다. 검색 조건 밖이라서 손으로 넣은 것이기 때문이다.
rec.pinned = true;

store.postings[key] = existed ? { ...store.postings[key], ...rec } : rec;
store.updatedAt = new Date().toISOString();
writeJson(file, store);

console.log(`${existed ? '갱신' : '추가'}: ${rec.company?.name || '(회사 미상)'} — ${rec.title} [${rec.status}]`);
