#!/usr/bin/env node
/**
 * README 온보딩 화면 생성기.
 *
 * 실행:
 *   node docs/demo/make_onboarding.mjs /tmp/jd-onboarding
 *   → /tmp/jd-onboarding/onboarding-1-keywords.html · -2-location.html · -3-console.html
 *   그 뒤 브라우저나 Playwright로 `.shot` 요소만 찍어 docs/images/ 에 넣는다.
 *
 * 🔴 1·2번은 **대화 재현**이다. 실제로는 각자가 쓰는 에이전트 화면 안에서 진행된다.
 *    대사는 지어낸 것이 아니라 skills/jd-search/SKILL.md "첫 실행 — 프로필 만들기"가
 *    지시하는 문구를 그대로 옮긴 것이다. 이력서·주소·연차만 가공이다.
 *    스킬의 대사를 고치면 이 파일도 같이 고쳐야 한다 — 문서가 코드에 대해 거짓말하는 것을 막는다.
 * 🔴 `install-1-prepare` 의 버전 출력은 **실제 실행 결과**다(2026-08-18 측정). `install-2-plugin` 과
 *    `key-1-datagokr` 는 절차 안내라서 재현이다 — 실행하면 읽는 사람의 환경이 바뀌는 명령이라 찍지 않았다.
 * 🔴 3·4번은 재현이 아니라 **실제 실행 출력**이다. 임의로 손대지 말 것.
 *    4번(수집 차단)은 로컬 프록시가 CONNECT 를 403 으로 되받게 해서 회사망 차단을 그대로 재현한 뒤,
 *    collect → gate → render 를 실제로 돌려 받은 출력이다 (2026-08-18).
 *    되살리려면: JD_SEARCH_HOME=/tmp/jd-demo node docs/demo/make_demo.mjs
 *                 → render.mjs --profile demo → serve.mjs --profile demo
 *    serve 의 토큰만 마스킹했다(매 실행 바뀌는 값이라 화면에 남길 이유가 없다).
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT) {
  console.error('출력 디렉터리를 지정해 주십시오.  예: node docs/demo/make_onboarding.mjs /tmp/jd-onboarding');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// ─────────────────────────────────────────────────────────────
// 줄 종류
//   u  사용자가 입력한 줄
//   a  에이전트 대사
//   r  에이전트 대사 중 🔴 로 시작하는 경고
//   d  흐린 보조 설명
//   k  강조 (키워드·값)
//   c  셸 명령
//   o  명령의 출력
//   ''  빈 줄
// ─────────────────────────────────────────────────────────────

const SCREENS = [
  {
    file: 'install-1-prepare.html',
    title: '0단계 — 있는지부터 확인합니다 (없으면 아래에 받는 법이 있습니다)',
    mono: true,
    lines: [
      ['d', '# 필요한 것은 딱 둘입니다. 터미널에 그대로 붙여 넣으십시오.'],
      ['c', '$ node -v'],
      ['o', 'v24.18.0'],
      ['ok', '  ✅ v20 이상이면 됩니다. `command not found` 가 뜨면 Node 를 먼저 받으십시오.'],
      ['', ''],
      ['c', '$ claude --version'],
      ['o', '2.1.234 (Claude Code)'],
      ['ok', '  ✅ 버전이 찍히면 됩니다.'],
      ['', ''],
      ['d', '# 없을 때 받는 법'],
      ['k', '  Node       https://nodejs.org  →  LTS 버튼 (macOS·Windows 공통)'],
      ['k', '  Claude Code  npm install -g @anthropic-ai/claude-code'],
      ['', ''],
      ['r', '🔴 회사 노트북·클라우드 개발환경에서는 채용 사이트 접근이 막히는 일이 있습니다.'],
      ['d', '   가능하면 개인 컴퓨터·개인 네트워크에서 쓰십시오. 막히면 화면이 그렇게 말해 줍니다.'],
    ],
  },
  {
    file: 'install-2-plugin.html',
    title: '1단계 — 설치는 두 줄, 그다음 재시작',
    mono: true,
    lines: [
      ['d', '# 터미널에 두 줄을 그대로 붙여 넣습니다.'],
      ['c', '$ claude plugin marketplace add jckproduct-ai/jd-search'],
      ['c', '$ claude plugin install jd-search@jd-search'],
      ['', ''],
      ['r', '🔴 여기서 Claude Code 를 껐다 켜십시오. 스킬은 시작할 때 읽힙니다.'],
      ['', ''],
      ['d', '# 잘 됐는지 확인 — 그냥 말해 보면 됩니다.'],
      ['u', '내 조건에 맞는 공고 좀 모아줘'],
      ['a', '프로필이 아직 없습니다. 이력서를 주십시오.'],
      ['ok', '  ✅ 이렇게 되물으면 설치가 끝난 것입니다.'],
      ['', ''],
      ['d', '# 터미널에서 쓰는 방법도 있습니다 (Codex · Cursor · Gemini CLI 도 같은 방식).'],
      ['c', '$ git clone https://github.com/jckproduct-ai/jd-search.git'],
      ['c', '$ cd jd-search && node skills/jd-search/scripts/test/run.mjs'],
      ['o', '✅ 442건 전부 통과'],
    ],
  },
  {
    file: 'key-1-datagokr.html',
    title: '2단계 — 키 1개 (없으면 건너뛰어도 됩니다)',
    mono: true,
    lines: [
      ['d', '# 채용 공고 수집에는 키가 필요 없습니다. 회사 재무를 붙일 때만 씁니다.'],
      ['', ''],
      ['k', '  1  www.data.go.kr  가입 (공공데이터포털 · 무료)'],
      ['k', '  2  검색창에  기업개요   → [활용신청]'],
      ['k', '  3  검색창에  기업재무   → [활용신청]'],
      ['k', '  4  마이페이지 → 오픈API → 인증키 복사'],
      ['d', '     계정당 키는 1개이고 모든 서비스가 같이 씁니다.'],
      ['r', '  🔴 승인 직후에는 10분~1시간 뒤에야 실제로 동작합니다. 바로 안 되면 기다려 보십시오.'],
      ['', ''],
      ['d', '# 복사한 키를 이렇게 넣습니다 (한 번만).'],
      ['c', '# macOS · Linux'],
      ['c', '$ echo \'export DATA_GO_KR_KEY="붙여넣기"\' >> ~/.zshrc && source ~/.zshrc'],
      ['c', '# Windows PowerShell'],
      ['c', '> setx DATA_GO_KR_KEY "붙여넣기"'],
      ['', ''],
      ['d', '# 들어갔는지 확인'],
      ['c', '$ echo $DATA_GO_KR_KEY'],
      ['ok', '  ✅ 키가 찍히면 됩니다. 안 찍히면 터미널을 새로 여십시오.'],
      ['', ''],
      ['r', '🔴 키가 없어도 그냥 3단계로 가십시오.'],
      ['d', '   수집·지역 필터·중복 병합·마감 재확인·리포트는 키 없이 전부 됩니다.'],
      ['d', '   DART 공시는 원래 키가 필요 없어서, 재무가 붙는 회사만 줄어듭니다.'],
    ],
  },
  {
    file: 'onboarding-1-keywords.html',
    title: '첫 대화 — 이력서를 읽고, 읽은 내용을 확인받는다',
    lines: [
      ['u', '내 조건에 맞는 공고 좀 모아줘'],
      ['', ''],
      ['a', '프로필이 아직 없습니다. 이력서를 주십시오.'],
      ['a', '경력기술서·포트폴리오가 있으면 함께 주시면 키워드가 정확해집니다.'],
      ['d', '파일 경로를 알려 주시거나 내용을 붙여 넣어 주셔도 됩니다.'],
      ['', ''],
      ['u', '~/Documents/이력서.pdf'],
      ['', ''],
      ['a', '읽었습니다.'],
      ['k', '  경력 5년 · 직군 서비스기획/PM · 도메인 커머스·B2B SaaS'],
      ['', ''],
      ['a', '이 키워드로 찾습니다.'],
      ['k', '  서비스기획 · 프로덕트 매니저 · 프로덕트 오너 · UX 기획'],
      ['a', '빼거나 더할 것이 있습니까?'],
      ['d', '한국 잡보드는 같은 자리를 한글로도 영어로도 올립니다. 둘 다 넣어야 안 놓칩니다.'],
      ['', ''],
      ['u', '"전략기획"은 빼줘. 자꾸 딸려 오더라'],
      ['', ''],
      ['a', '제외 키워드에 넣었습니다.'],
      ['r', '🔴 제외한 공고는 사라지지 않습니다 — 회사·직무·사유까지 리포트 하단에 실립니다.'],
      ['d', '   조용히 잘라 내면 자기 직군 공고를 잃은 줄도 모르게 됩니다.'],
      ['', ''],
      ['a', '이력서에 연차가 5년으로 나옵니다. 맞습니까?'],
      ['d', '연차는 공고를 버리는 데 쓰지 않고 목록을 나누는 데만 씁니다.'],
      ['d', '요구경력이 낮은 공고까지 따로 모으고 싶으면 하한을 정해 주십시오. 안 정하면 전부 같이 봅니다.'],
    ],
  },
  {
    file: 'onboarding-2-location.html',
    title: '첫 대화 — 위치를 받고, 아직 안 되는 것은 그 자리에서 말한다',
    lines: [
      ['a', '자택 주소를 알려 주십시오. 동·읍·면까지면 충분하고 상세주소는 필요 없습니다.'],
      ['r', '🔴 주소는 이 컴퓨터의 프로필 파일에만 남습니다. 리포트에는 주소도 좌표도 나가지 않습니다.'],
      ['', ''],
      ['u', '서울 마포구 ○○동'],
      ['', ''],
      ['a', '가고 싶은 지역을 골라 주십시오. 시·군·구로, 여러 곳 가능합니다.'],
      ['r', '🔴 지금 공고를 실제로 거르는 것은 이것뿐입니다.'],
      ['', ''],
      ['u', '강남구, 서초구, 마포구, 분당'],
      ['', ''],
      ['a', '"분당"은 성남시 분당구로 잡았습니다.'],
      ['d', '중구·서구·남구처럼 여러 광역시에 같은 이름이 있는 곳은 시·도까지 확인합니다.'],
      ['', ''],
      ['a', '편도 통근 상한도 받아 둘까요? 지금은 기록만 되고 공고를 거르지는 않습니다'],
      ['a', '— 통근 시간 실측이 아직 없어서, 실제로 거르는 건 위에서 고른 지역뿐입니다.'],
      ['', ''],
      ['u', '그럼 안 받을게'],
      ['', ''],
      ['a', '비워 두겠습니다. 프로필을 저장했습니다.'],
      ['k', '  ~/.jd-search/default/profile.yml    디렉터리 0700 · 파일 0600'],
      ['d', '  이 파일 하나만 바꾸면 조건이 전부 바뀝니다. 다시 물어보지 않습니다.'],
      ['', ''],
      ['r', '🔴 첫 실행은 상한 없이 전부 받습니다.'],
      ['a', '  원티드   키워드 4개 · 약 2분'],
      ['a', '  사람인   목록에서 훑고 상세 전량 · 20~35분'],
      ['d', '  처음 만들어진 목록이 5분의 1이면 그 5분의 1을 자기 시장 전부로 읽게 됩니다.'],
      ['d', '  두 번째 실행부터는 기본 200건이고, 그 상한은 새로 받아야 하는 것만 셉니다.'],
      ['', ''],
      ['a', '시작할까요?   [ 예 / 건수를 정해서 / 원티드만 ]'],
    ],
  },
  {
    file: 'onboarding-4-blocked.html',
    title: '수집이 막혔을 때 — 0건으로 끝내지 않고, 왜 0건인지 말한다',
    mono: true,
    lines: [
      ['d', '# 회사망·클라우드에서 돌리면 보드 접근이 막히는 일이 있습니다.'],
      ['d', '# 그때 화면에 무엇이 뜨는지가 이 도구에서 가장 중요한 부분입니다.'],
      ['c', '$ node skills/jd-search/scripts/collect_saramin.mjs'],
      ['o', '검색 "서비스기획" … ✖ 중간 프록시 차단(HTTP 403)'],
      ['o', ''],
      ['o', '⚠ 이번 수집은 완전하지 않습니다 — 서비스기획 — 중간 프록시 차단(HTTP 403)'],
      ['o', '  리포트 상단에도 같은 경고가 표시됩니다. 이 결과를 "전수"로 읽지 마십시오.'],
      ['ok', '  → 회사망·클라우드 방화벽 같은 중간 프록시가 보드 접근을 막았습니다.'],
      ['ok', '    인터넷이 끊긴 것이 아닙니다 — 개인 컴퓨터·개인 네트워크에서 다시 실행해 주십시오.'],
      ['', ''],
      ['d', '# 0건이어도 멈추지 않습니다. 사유를 들고 다음 단계로 넘어갑니다.'],
      ['c', '$ node skills/jd-search/scripts/gate.mjs'],
      ['o', '수집된 공고가 0건입니다 — 이번 실행에서 아래가 막혔습니다.'],
      ['o', '  ✖ 사람인 "서비스기획" — 중간 프록시 차단(HTTP 403)'],
      ['o', '  → 회사망·클라우드 방화벽 같은 중간 프록시가 보드 접근을 막았습니다. …'],
      ['o', ''],
      ['o', '빈 결과로 다음 단계에 넘깁니다 — 리포트 상단에 같은 사유가 실립니다.'],
      ['', ''],
      ['c', '$ node skills/jd-search/scripts/render.mjs'],
      ['o', '공고 0건 · 회사 0곳 · 자금등급 확보 0/0'],
      ['o', '→ ~/.jd-search/default/out/report.html'],
      ['', ''],
      ['r', '🔴 그동안 모아 둔 공고는 지워지지 않습니다. 리포트는 그대로 만들어집니다.'],
    ],
  },
  {
    file: 'onboarding-3-console.html',
    title: '실제 실행 출력 — 받아졌는지 확인하고, 리포트를 만든다',
    mono: true,
    lines: [
      ['d', '# 받아진 게 성한지부터 봅니다. 네트워크도 키도 필요 없습니다.'],
      ['c', '$ node skills/jd-search/scripts/test/run.mjs'],
      ['o', '── DART 파서 함정'],
      ['o', '── 지역 판정'],
      ['o', '── 사람인 파싱'],
      ['o', '── 교차 보드 병합'],
      ['o', '── 자금등급'],
      ['o', '── 단계 간 계약 — collect → merge → gate → render · serve'],
      ['o', '────────────────────────────────────────────────────────────'],
      ['ok', '✅ 442건 전부 통과'],
      ['', ''],
      ['d', '# 수집이 끝나면 리포트 한 장으로 만듭니다.'],
      ['c', '$ node skills/jd-search/scripts/render.mjs'],
      ['o', '공고 10건 · 회사 10곳 · 자금등급 확보 8/10'],
      ['o', '제외 5건은 리포트 하단 펼침에 사유와 함께 실렸습니다.'],
      ['o', '→ ~/.jd-search/demo/out/report.html'],
      ['', ''],
      ['d', '# 상태를 바꾸고 메모를 남기는 건 이쪽 화면입니다.'],
      ['c', '$ node skills/jd-search/scripts/serve.mjs'],
      ['o', 'jd-search serve — 이 컴퓨터에서만 열립니다 (127.0.0.1 전용, 매 실행 새 토큰)'],
      ['o', ''],
      ['o', '  http://127.0.0.1:52060/?t=••••••••••••••••••••••••••••••••'],
      ['o', ''],
      ['r', '  🔴 이 주소에는 지원 이력이 그대로 보입니다. 화면을 공유할 때 주의해 주십시오.'],
      ['r', '  🔴 브라우저는 자동으로 열지 않습니다. 위 주소를 직접 열어 주십시오.'],
      ['o', '  공유용 파일이 필요하면:  node scripts/render.mjs   (지원 이력은 빠집니다)'],
      ['o', ''],
      ['o', '  종료: Ctrl+C'],
    ],
  },
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0d12;padding:28px;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
.shot{width:920px;background:#14171f;border:1px solid #262b38;border-radius:12px;overflow:hidden;
      box-shadow:0 18px 48px rgba(0,0,0,.55)}
.bar{display:flex;align-items:center;gap:8px;padding:11px 15px;background:#1b1f2a;border-bottom:1px solid #262b38}
.dot{width:11px;height:11px;border-radius:50%}
.bar .t{margin-left:9px;color:#8b93a7;font-size:12.5px;letter-spacing:.2px}
.body{padding:20px 24px 24px}
.l{font-size:14px;line-height:1.85;white-space:pre-wrap;word-break:break-word;
   font-family:ui-monospace,SFMono-Regular,Menlo,"Apple SD Gothic Neo","Noto Sans KR",monospace}
.mono .l{font-size:13.5px;line-height:1.75}
.u{color:#e8ecf5}
.u b{color:#7aa2f7;font-weight:600;margin-right:8px}
.a{color:#c3cbdb}
.r{color:#ef8a7a}
.d{color:#707a90}
.k{color:#8fd6a9}
.c{color:#e8ecf5;font-weight:600}
.o{color:#a8b1c4}
.ok{color:#7fd18f;font-weight:600}
.sp{height:9px}
`;

for (const s of SCREENS) {
  const rows = s.lines.map(([kind, text]) => {
    if (!kind) return '<div class="sp"></div>';
    if (kind === 'u') return `<div class="l u"><b>&rsaquo;</b>${esc(text)}</div>`;
    return `<div class="l ${kind}">${esc(text)}</div>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(s.title)}</title><style>${CSS}</style></head>
<body>
<div class="shot${s.mono ? ' mono' : ''}">
  <div class="bar">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="t">${esc(s.title)}</span>
  </div>
  <div class="body">
${rows}
  </div>
</div>
</body></html>`;
  fs.writeFileSync(path.join(OUT, s.file), html);
}

console.log(`온보딩 화면 ${SCREENS.length}장 작성 완료 → ${OUT}`);
console.log('각 파일의 .shot 요소만 찍어 docs/images/ 에 같은 이름의 .png 로 넣으십시오.');
