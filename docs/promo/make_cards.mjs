#!/usr/bin/env node
/**
 * Instagram 캐러셀 카드 생성기 (8장).
 *
 * 실행:
 *   node docs/promo/make_cards.mjs
 *   → docs/promo/cards/card-1.png … card-8.png  (1080×1350, 4:5)
 *   → docs/promo/cards/_2x/  (2160×2700 원본)  ·  _html/  (렌더 입력)
 *
 * 규격: 1080×1350 (4:5). Instagram 피드에서 점유 면적이 가장 큰 비율이다.
 * 톤: 다크 배경 #0B0E14 + 강조색 1개 #6EE7A7.
 *
 * 🔴 문구의 숫자는 전부 README 의 실측값이다. 임의로 올리지 말 것 —
 *    이 도구의 정체성이 "틀린 걸 안 보여주는 것"이라 홍보가 부풀리면 첫 장부터 자기모순이다.
 * 🔴 화면 캡처는 docs/images/ 의 것을 그대로 잘라 쓴다. 실제 렌더러 출력이고
 *    회사명·숫자는 가공한 예시 데이터다. 실제 회사를 "위험"으로 표시한 화면은 절대 싣지 않는다.
 *    캡처를 쓴 장에는 "화면은 예시 데이터" 를 남긴다.
 * 🔴 crop 좌표는 docs/images/ 원본의 픽셀 좌표다. 캡처를 다시 뜨면 좌표도 다시 맞춰야 한다.
 * 🔴 헤드리스 Chrome 은 CSS background-image 의 data URI 를 그리지 않는다(빈 프레임이 나온다).
 *    <img> 는 그린다. 그래서 crop 은 overflow:hidden 컨테이너 + 절대배치 <img> 로 한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG = path.join(ROOT, 'docs/images');
const OUT = path.join(ROOT, 'docs/promo/cards');
const WORK = path.join(OUT, '_html');
const OUT2X = path.join(OUT, '_2x');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const W = 1080, H = 1350;
const BG = '#0B0E14', ACCENT = '#6EE7A7', FG = '#E8ECF5', MUTED = '#8A94A8';

// ── 화면 캡처 crop — [파일, 원본폭, x, y, w, h] (원본 픽셀 좌표)
// blur: 회사명이 찍힌 사각형 [x, y, w, h] 목록. 예시 데이터라도 실제 법인과 이름이 겹칠 수 있어
//       홍보물에서는 전부 가린다. 자금등급 배지는 가리지 않는다 — 그게 보여 줄 것이다.
const SHOTS = {
  reportHead:  ['report-list.png',           2400,  100,   40, 1900,  500, []],
  reportCards: ['report-list.png',           2400,  110,  680, 1780,  610,
                 [[140, 718, 128, 57], [140, 1018, 210, 54]]],
  excluded:    ['report-excluded.png',       2400,  100,   15, 1350,  370,
                 [[112, 145, 113, 210]]],
  keywords:    ['onboarding-1-keywords.png', 1840,   40,  548, 1180,  222, []],
  serve:       ['serve.png',                 2880,  360,  810, 1700,  370,
                 [[380, 840, 135, 55]]],
};

const b64 = new Map();
function dataUri(file) {
  if (!b64.has(file)) {
    b64.set(file, `data:image/png;base64,${fs.readFileSync(path.join(IMG, file)).toString('base64')}`);
  }
  return b64.get(file);
}

/** crop 사각형을 targetW 폭으로 늘려 보여 주는 마크업. 회사명 자리는 같은 그림을 흐리게 겹쳐 가린다. */
function shot(key, targetW, cls = '') {
  const [file, natW, x, y, w, h, blur = []] = SHOTS[key];
  const s = targetW / w;
  const uri = dataUri(file);
  const img = (l, t, extra = '') =>
    `<img src="${uri}" style="width:${Math.round(natW * s)}px;`
    + `left:${Math.round(l)}px;top:${Math.round(t)}px;${extra}">`;
  // 흐림은 backdrop-filter 가 아니라 같은 <img> 복제본에 filter:blur 를 걸어 잘라 낸다.
  // 헤드리스 Chrome 에서 backdrop-filter 는 믿을 수 없고, 복제본 방식은 가장자리 번짐도 없다.
  const masks = blur.map(([bx, by, bw, bh]) =>
    `<div style="position:absolute;overflow:hidden;`
    + `left:${Math.round((bx - x) * s)}px;top:${Math.round((by - y) * s)}px;`
    + `width:${Math.round(bw * s)}px;height:${Math.round(bh * s)}px">`
    + img(-bx * s, -by * s, 'filter:blur(11px)') + '</div>').join('');
  return `<div class="shot ${cls}" style="width:${targetW}px;height:${Math.round(h * s)}px">`
    + img(-x * s, -y * s) + masks + '</div>';
}

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{
  background:${BG};color:${FG};
  font-family:Pretendard,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
  word-break:keep-all;
}
.card{position:relative;width:${W}px;height:${H}px;padding:78px 72px 64px;display:flex;flex-direction:column}
.card::after{content:'';position:absolute;left:0;top:0;width:100%;height:5px;background:${ACCENT};z-index:3}
.kicker{font-size:25px;font-weight:700;letter-spacing:.02em;color:${ACCENT};margin-bottom:26px}
h1{font-size:66px;line-height:1.26;font-weight:800;letter-spacing:-.022em}
h1.xl{font-size:86px;line-height:1.18}
h1.sm{font-size:54px;line-height:1.32}
h1 em{font-style:normal;color:${ACCENT}}
.sub{margin-top:26px;font-size:29px;line-height:1.62;color:#B6BECE;font-weight:500}
.sub b{color:${FG};font-weight:700}
.sub.dim{color:${MUTED};font-size:26px;line-height:1.6}
.grow{flex:1}
.shot{position:relative;overflow:hidden;border-radius:16px;
      border:1px solid rgba(255,255,255,.10);box-shadow:0 26px 70px rgba(0,0,0,.55)}
.shot img{position:absolute;max-width:none}
.shot.bleed{margin-left:-72px;border-radius:0;border-left:0;border-right:0}
.note{margin-top:18px;font-size:20px;color:#5E6779;font-weight:500}
.foot{position:relative;display:flex;align-items:baseline;justify-content:space-between;margin-top:32px;
      font-size:22px;color:#4E5768;font-weight:600;letter-spacing:.01em;z-index:2}
.foot b{color:#7B8497;font-weight:700}
.big{font-size:205px;font-weight:800;line-height:1;letter-spacing:-.045em;color:${ACCENT}}
.rows{margin-top:40px;border-top:1px solid rgba(255,255,255,.10)}
.row{display:flex;justify-content:space-between;align-items:baseline;
     padding:21px 2px;border-bottom:1px solid rgba(255,255,255,.10);font-size:26px;color:#B6BECE;font-weight:500}
.row b{font-size:30px;font-weight:700;color:${FG};font-variant-numeric:tabular-nums}
.nope{margin-top:8px}
.nope li{list-style:none;display:flex;gap:22px;align-items:center;
         padding:25px 2px;border-bottom:1px solid rgba(255,255,255,.10);font-size:38px;font-weight:600}
.nope li span{color:#4E5768;font-size:33px;width:26px;text-align:center}
.repo{margin-top:auto;padding-top:38px}
.repo .url{font-size:38px;font-weight:700;color:${ACCENT};letter-spacing:-.01em}
.repo .meta{margin-top:14px;font-size:24px;color:${MUTED};font-weight:500}
.peek{position:absolute;left:0;right:0;bottom:92px;height:300px;overflow:hidden;
      -webkit-mask-image:linear-gradient(to bottom,#000 0,#000 55%,transparent 100%)}
.peek .shot{border-radius:16px 16px 0 0;border-bottom:0;box-shadow:none}
`;

const CARDS = [
  // 1 — 후킹
  `<div class="kicker">채용공고가 답하지 않는 질문</div>
   <h1 class="xl">이 회사,<br>6개월 뒤에도<br><em>있습니까?</em></h1>
   <div class="sub">공고는 회사가 씁니다.<br>회사가 자기 재무 얘기를 할 리는 없습니다.</div>
   <div class="grow"></div>
   <div class="peek">${shot('reportCards', 1080)}</div>`,

  // 2 — 문제
  `<div class="kicker">문제</div>
   <h1 class="sm">공고를 모아 주는 서비스는 많습니다.<br><em>회사 재무를 붙여 주는 곳은 없었습니다.</em></h1>
   <div class="sub dim">&ldquo;매출 168억&rdquo;에서 끝내지 않습니다.
     자본잠식 · 연속 적자를 등급으로 판정하고,
     그 회사에 물어볼 면접 질문까지 만듭니다.</div>
   <div class="grow"></div>
   ${shot('reportHead', 1080, 'bleed')}
   <div class="note">화면은 예시 데이터입니다 · 실제 렌더러 출력</div>`,

  // 3 — 결과물
  `<div class="kicker">그래서 만든 것</div>
   <h1 class="sm">공고마다 <em>자금등급</em>이 붙습니다</h1>
   <div class="sub dim">판정 근거와 기준연도까지 함께 답니다</div>
   <div class="grow"></div>
   ${shot('reportCards', 1080, 'bleed')}
   <div class="note">화면은 예시 데이터입니다 · 실제 렌더러 출력</div>`,

  // 4 — 실측 숫자
  `<div class="kicker">실측</div>
   <div class="big">48.9%</div>
   <div class="sub">사람인에서 모은 <b>135개 회사</b> 중 재무를 붙인 비율입니다.</div>
   <div class="sub dim">나머지는 &ldquo;미확인&rdquo;으로 두고 추측하지 않습니다.
     대신 왜 미확인인지를 적습니다 &mdash; DART 미등록인지, 같은 이름 법인이 여러 곳이라
     안 붙인 건지는 전혀 다른 상황이니까요.</div>
   <div class="rows">
     <div class="row"><span>원티드 수집 30개 회사</span><b>50.0%</b></div>
     <div class="row"><span>사람인 수집 135개 회사</span><b>48.9%</b></div>
     <div class="row"><span>표본 98개 회사</span><b>62.2%</b></div>
   </div>
   <div class="grow"></div>
   <div class="note">2026-08 실측 · 표본에 따라 갈려서 한 숫자로 말하지 않습니다</div>`,

  // 5 — 버린 것도 보여준다
  `<div class="kicker">원칙</div>
   <h1 class="sm">버린 공고도 <em>전부</em> 보여 줍니다</h1>
   <div class="sub dim">회사 · 직무 · 제외 사유까지</div>
   <div class="grow"></div>
   ${shot('excluded', 1080, 'bleed')}
   <div class="note">화면은 예시 데이터입니다 · 실제 렌더러 출력</div>`,

  // 6 — 실화
  `<div class="kicker">실화</div>
   <h1 class="sm">PO 공고 <em>17건</em>이<br>아무 오류 없이<br>사라지고 있었습니다</h1>
   <div class="sub">제 프로필에 &ldquo;프로덕트 오너&rdquo; 다섯 글자가 없었습니다.<br>
     에러도 안 났습니다. 그냥 없었습니다.</div>
   <div class="grow"></div>
   ${shot('keywords', 1080, 'bleed')}
   <div class="note">그 뒤로 키워드는 수집 전에 반드시 확인받습니다</div>`,

  // 7 — 매일 쓰는 화면
  `<div class="kicker">매일 쓰는 화면</div>
   <h1 class="sm">상태 · 메모 · 숨김</h1>
   <div class="sub dim">기록은 브라우저가 아니라 파일에 남습니다.
     이력서 · 집주소 · 지원 이력은 이 컴퓨터를 벗어나지 않습니다.</div>
   <div class="grow"></div>
   ${shot('serve', 1080, 'bleed')}
   <div class="note">화면은 예시 데이터입니다 · 127.0.0.1 로컬 전용</div>`,

  // 8 — 안 만든 것 + CTA
  `<div class="kicker">안 만든 것</div>
   <ul class="nope">
     <li><span>&times;</span>궁합 점수</li>
     <li><span>&times;</span>합격 확률</li>
     <li><span>&times;</span>자동 지원</li>
     <li><span>&times;</span>추측으로 공고 버리기</li>
   </ul>
   <div class="sub dim">검증할 수 없는 숫자는 만들지 않습니다.
     판정이 불확실하면 버리는 대신 &ldquo;미확인&rdquo;에 남깁니다.</div>
   <div class="repo">
     <div class="url">github.com/jckproduct-ai/jd-search</div>
     <div class="meta">Node 20 · 의존성 0 · 필수 키 1개(무료) · AGPL-3.0</div>
   </div>`,
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT2X, { recursive: true });

CARDS.forEach((body, i) => {
  const n = i + 1;
  fs.writeFileSync(path.join(WORK, `card-${n}.html`),
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="card">
${body}
  <div class="foot"><b>jd-search</b><span>${n} / ${CARDS.length}</span></div>
</div></body></html>`);
});

for (let n = 1; n <= CARDS.length; n++) {
  const png2x = path.join(OUT2X, `card-${n}.png`);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--virtual-time-budget=4000', '--force-device-scale-factor=2',
    `--window-size=${W},${H}`, `--screenshot=${png2x}`,
    `file://${path.join(WORK, `card-${n}.html`)}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  // Instagram 은 1440px 를 넘겨도 다시 줄인다. 2x 로 찍고 1080 으로 내려 선명도를 챙긴다.
  execFileSync('sips', ['-z', String(H), String(W), png2x, '--out', path.join(OUT, `card-${n}.png`)],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  console.log(`card-${n}.png`);
}

console.log(`\n캐러셀 ${CARDS.length}장 → ${OUT}  (1080×1350, 원본 2x 는 _2x/)`);
