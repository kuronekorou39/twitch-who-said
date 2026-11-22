// README 用のスクリーンショットを撮る。実在ユーザーのデータを写さないよう、
// 空のプロファイルに架空のデータを流し込み、Twitch のページも架空のチャット欄に差し替えて撮る。
//   npm run build && node scripts/screenshots.mjs

import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = resolve('dist');
const outDir = resolve('docs/images');
const chromePath =
  process.env.CHROME_PATH ??
  readdirSync('.cache/puppeteer/chrome')
    .filter((d) => d.startsWith('win64-'))
    .map((d) => resolve('.cache/puppeteer/chrome', d, 'chrome-win64/chrome.exe'))[0];
const CHANNEL = 'sample_streamer';
const FOCUS_USER = 'mochi_neko';

// ---- 架空のデータ ----
const USERS = [
  ['mochi_neko', 'もちねこ', '#ff7f50'],
  ['pixel_fox', 'pixel_fox', '#1e90ff'],
  ['tanuki_77', 'たぬき77', '#2e8b57'],
  ['night_owl', 'NightOwl', '#9acd32'],
  ['umi_sora', 'うみそら', '#daa520'],
  ['retro_gamer', 'RetroGamer', '#b22222'],
  ['kumo_kumo', 'くもくも', '#5f9ea0'],
  ['blue_lemon', 'blue_lemon', '#8a2be2'],
  ['shiba_dog', 'しばいぬ', '#d2691e'],
  ['coffee_time', 'coffee_time', '#00ff7f'],
];
const CHANNELS = [CHANNEL, 'game_night', 'cozy_cafe'];
const LINES = [
  'こんばんはー',
  '初見です！',
  'それな',
  'ナイス！',
  'wwww',
  'いまのうますぎる',
  '待ってました',
  'BGM いいね',
  'おつかれさまでした',
  'そこ右じゃない？',
  'GG',
  '今日も来ました',
  '888888',
  '声かわいい',
  'ボス戦きた',
  'がんばれー',
  'なるほど',
  'それは草',
  '次は何やるの？',
  '神回では',
  'lol',
  'nice play',
  'good morning',
  'さっきの見逃した…',
  'もう一回！',
];
const FOCUS_LINES = [
  'こんばんは！今日も楽しみにしてました',
  'さっきのジャンプ完璧だった',
  'それ前回も言ってたやつ笑',
  'おすすめのお茶ある？',
  'ボス戦がんばって！',
  '今日は何時まで？',
  'クリアおめでとう！！',
  '昨日の配信も見ました',
  'その曲すき',
  'おやすみなさい〜',
];

function seedItems() {
  const now = Date.now();
  const items = [];
  let r = 7;
  const rand = (n) => {
    r = (r * 1103515245 + 12345) % 2147483648;
    return r % n;
  };
  for (let i = 0; i < 400; i++) {
    const [user, displayName, color] = USERS[1 + rand(USERS.length - 1)];
    items.push({
      user,
      displayName,
      color,
      channel: CHANNELS[rand(3)],
      text: LINES[rand(LINES.length)],
      ts: now - (400 - i) * 30 * 60_000 - rand(60_000),
    });
  }
  for (const [i, text] of FOCUS_LINES.entries()) {
    items.push({
      user: FOCUS_USER,
      displayName: 'もちねこ',
      color: USERS[0][2],
      channel: CHANNELS[i % 3 === 2 ? 1 : 0],
      text,
      ts: now - (FOCUS_LINES.length - i) * 7 * 3600_000,
    });
  }
  return items.map((m) => ({ ...m, source: 'live', capturedAt: m.ts }));
}

// ---- 架空の Twitch ページ(チャット欄と純正カードの最小限の DOM) ----
function fakePage() {
  const now = new Date();
  const rows = USERS.slice(0, 9)
    .concat([USERS[0]])
    .map(([login, name, color], i) => {
      const text = i === 9 ? 'こんばんは！今日も楽しみにしてました' : LINES[(i * 7) % LINES.length];
      return `<div><div class="chat-line__message" data-a-target="chat-line-message" data-a-user="${login}">
        <span class="chat-author__display-name" data-a-target="chat-message-username" style="color:${color}">${name}</span><span>: </span>
        <span data-a-target="chat-line-message-body"><span class="text-fragment">${text}</span></span></div></div>`;
    })
    .join('');
  return `<!doctype html><html class="tw-root--theme-dark"><meta charset="utf-8"><title>${CHANNEL} - Twitch</title>
<style>
  body { margin:0; height:100vh; display:flex; background:#0e0e10; color:#efeff1; font:13px/1.5 Inter, "Helvetica Neue", Arial, sans-serif; }
  .video { flex:1; display:flex; align-items:center; justify-content:center; color:#53535f; font-size:18px; background:#000; }
  .chat { width:340px; background:#18181b; border-left:1px solid #2f2f35; display:flex; flex-direction:column; }
  .chat h2 { margin:0; padding:10px; font-size:12px; text-align:center; letter-spacing:.05em; border-bottom:1px solid #2f2f35; }
  .chat-scrollable-area__message-container { flex:1; display:flex; flex-direction:column; justify-content:flex-end; padding:8px 0; }
  .chat-line__message { padding:5px 20px; }
  .chat-author__display-name { font-weight:700; cursor:pointer; }
  .card { position:fixed; width:340px; height:260px; background:#18181b; border:1px solid #2f2f35; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,.5); }
  .card .banner { height:84px; background:linear-gradient(135deg,#3a2a5c,#1f2a44); border-radius:6px 6px 0 0; }
  .card .who { padding:12px 16px; font-size:16px; font-weight:700; }
  .card .sub { padding:0 16px; color:#adadb8; }
</style>
<div class="video">▶ (配信画面)</div>
<div class="chat"><h2>STREAM CHAT</h2><div class="chat-scrollable-area__message-container">${rows}</div></div>
<div data-a-target="chat-user-card"></div>
<script>
  document.addEventListener('click', (e) => {
    const n = e.target.closest('.chat-author__display-name');
    if (!n) return;
    document.querySelector('[data-a-target="chat-user-card"]').innerHTML =
      '<div data-a-target="viewer-card-position" class="card" style="left:300px;top:150px"><div data-a-target="viewer-card">' +
      '<div class="banner"></div><div class="who">' + n.textContent + '</div><div class="sub">(Twitch 純正のユーザーカード)</div></div></div>';
  });
</script><!-- ${now.toISOString()} -->`;
}

mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--window-size=1300,900'],
  defaultViewport: null,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const ext = (path) => `chrome-extension://${extId}/src/${path}`;

  // 架空データを取り込む
  const seeder = await browser.newPage();
  await seeder.goto(ext('options/options.html'), { waitUntil: 'load' });
  const items = seedItems();
  for (let i = 0; i < items.length; i += 100) {
    await seeder.evaluate((batch) => chrome.runtime.sendMessage({ type: 'ws:ingest', items: batch }), items.slice(i, i + 100));
  }
  await seeder.close();

  // 1. Twitch 上の吹き出し
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 640 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.url().startsWith('https://www.twitch.tv/')) {
      req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fakePage() });
    } else if (req.url().startsWith('https://')) req.abort();
    else req.continue();
  });
  await page.goto(`https://www.twitch.tv/${CHANNEL}`, { waitUntil: 'load' });
  await wait(2500);
  const names = await page.$$('.chat-author__display-name');
  await names.at(-1).click();
  await wait(2000);
  await page.screenshot({ path: `${outDir}/popover.png` });

  // 2. 履歴ビューア
  const viewer = await browser.newPage();
  await viewer.setViewport({ width: 1100, height: 640 });
  await viewer.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await viewer.goto(ext('viewer/viewer.html'), { waitUntil: 'load' });
  await wait(1500);
  await viewer.screenshot({ path: `${outDir}/viewer.png` });

  // 3. ツールバーのポップアップ(タブで開いて本体だけ撮る)
  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 600 });
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await popup.goto(ext('popup/popup.html'), { waitUntil: 'load' });
  await wait(1000);
  await (await popup.$('body')).screenshot({ path: `${outDir}/popup.png` });

  console.log('saved to', outDir);
} finally {
  await browser.close();
}
