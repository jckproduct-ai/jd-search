#!/usr/bin/env node
/**
 * 화면 캡처 — **문서용 이미지를 손이 아니라 명령으로 다시 뽑기 위한 도구**.
 *
 * 실행:
 *   node docs/demo/shot.mjs <주소> <선택자> <출력.png> [--width 1200] [--dsf 2]
 *                            [--prep "<페이지에서 실행할 JS>"] [--max-height 2000] [--wait 400]
 *
 * 왜 있나:
 *   `docs/images/` 의 그림들이 손으로 찍혀 있어서, 코드가 바뀌어도 그림은 옛날 값을 들고 남았다
 *   (실측: README 본문은 회귀 테스트 562건인데 실행 화면 그림은 442건이었다 — 개선 대장 #92).
 *   문서가 그림에 대해 거짓말하는 것을 막으려면 **다시 찍는 일이 한 줄이어야 한다.**
 *
 * 🔴 요소만 정확히 잘라 찍는다. 창 크기로 어림잡으면 여백이 붙거나 잘려서 매번 다른 그림이 된다.
 *    그래서 CDP(Page.captureScreenshot 의 clip)를 쓴다 — 외부 패키지는 쓰지 않는다(의존성 0 유지).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const [target, selector, out] = process.argv.slice(2);
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
if (!target || !selector || !out) {
  console.error('사용법: node docs/demo/shot.mjs <주소> <선택자> <출력.png> [--width 1200] [--dsf 2] [--prep "js"]');
  process.exit(1);
}
const WIDTH = Number(flag('width', 1200));
const DSF = Number(flag('dsf', 2));
const MAX_H = Number(flag('max-height', 0));
const WAIT = Number(flag('wait', 400));
const PREP = flag('prep', null);
// 🔴 색 구성표를 고정한다. 안 고정하면 찍는 사람의 시스템 설정에 따라 같은 화면이
//    밝게도 어둡게도 나와서, 문서 안에서 그림끼리 어긋난다.
const SCHEME = flag('scheme', 'light');
const PORT = 9222 + (process.pid % 500);

const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--window-size=${WIDTH},1400`,
  '--user-data-dir=' + fs.mkdtempSync('/tmp/jd-shot-'),
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 디버깅 포트가 열릴 때까지 기다린다. */
async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 아직 안 떴다 */ }
    await sleep(200);
  }
  throw new Error('Chrome 디버깅 포트가 열리지 않았습니다.');
}

const ws = new WebSocket(await wsUrl());
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });

let id = 0;
const pending = new Map();
const events = new Map();
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, no } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
  } else if (msg.method && events.has(msg.method)) {
    events.get(msg.method)();
    events.delete(msg.method);
  }
};
const send = (method, params = {}) => new Promise((ok, no) => {
  const n = ++id;
  pending.set(n, { ok, no });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const once = method => new Promise(ok => events.set(method, ok));

const url = /^https?:|^file:/.test(target) ? target : `file://${path.resolve(target)}`;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: WIDTH, height: 1400, deviceScaleFactor: DSF, mobile: false });
await send('Emulation.setEmulatedMedia',
  { features: [{ name: 'prefers-color-scheme', value: SCHEME }] });
const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url });
await loaded;
await sleep(WAIT);

// 🔴 준비 스크립트는 캡처 **전에** 돈다. `<details>` 를 펼치거나 필터를 눌러 두는 용도다.
if (PREP) await send('Runtime.evaluate', { expression: PREP, awaitPromise: true });
await sleep(120);

const rect = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  })()`,
  returnByValue: true,
});
const box = rect.result.value;
if (!box) { console.error(`선택자를 찾지 못했습니다: ${selector}`); process.exit(1); }

const clip = {
  x: Math.round(box.x), y: Math.round(box.y),
  width: Math.round(box.width),
  height: Math.round(MAX_H ? Math.min(box.height, MAX_H) : box.height),
  // 🔴 배율은 여기서 다시 곱하지 않는다. `setDeviceMetricsOverride` 의 deviceScaleFactor 가
  //    이미 적용돼 있어서 여기 DSF 를 또 주면 **4배**로 찍힌다 (실측: 2240 을 기대했는데 4480 이 나왔다).
  scale: 1,
};
const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`${path.basename(out)}  ${clip.width * DSF}×${clip.height * DSF}`);

ws.close();
chrome.kill();
process.exit(0);
