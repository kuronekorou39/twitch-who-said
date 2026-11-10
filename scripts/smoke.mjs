// 開発用スモークテスト: ビルド済み拡張を Chrome に読み込み、実際の Twitch チャットで
// メッセージが IndexedDB に保存されることを確認する。
//   node scripts/smoke.mjs [channel] [seconds]
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';

const channel = process.argv[2] ?? 'indegnasen0706';
const popout = process.env.POPOUT !== '0';
const waitSec = Number(process.argv[3] ?? 40);
const dist = resolve('dist');
// Google 製 Chrome 137+ は --load-extension を無効化しているため Chrome for Testing を使う
//   npx @puppeteer/browsers install chrome@stable --path .cache/puppeteer
const chromePath =
  process.env.CHROME_PATH ??
  (await import('node:fs')).readdirSync('.cache/puppeteer/chrome').filter((d) => d.startsWith('win64-')).map((d) => resolve('.cache/puppeteer/chrome', d, 'chrome-win64/chrome.exe'))[0];

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--mute-audio', '--window-size=1000,900'],
  defaultViewport: null,
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  console.log('extension id:', extId);

  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[Who Said]')) console.log('[page console]', t);
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(popout ? `https://www.twitch.tv/popout/${channel}/chat` : `https://www.twitch.tv/${channel}`, { waitUntil: 'domcontentloaded' });
  console.log(`watching chat for ${waitSec}s ...`);
  await new Promise((r) => setTimeout(r, waitSec * 1000));

  const opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1500));
  const stats = await opts.evaluate(() => {
    const g = (id) => document.getElementById(id)?.textContent;
    return {
      messages: g('st-messages'),
      users: g('st-users'),
      channels: g('st-channels'),
      newest: g('st-newest'),
      lastIngest: g('st-last-ingest'),
      usage: g('st-usage'),
      noDataBadgeHidden: document.getElementById('ws-no-data')?.hidden,
    };
  });
  console.log('options stats:', stats);

  // SW 経由で直接クエリしてサンプルを表示
  const sample = await opts.evaluate(async () => {
    const st = await chrome.runtime.sendMessage({ type: 'ws:stats' });
    const db = await new Promise((res, rej) => { const r = indexedDB.open('twitch-who-said'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const users = await new Promise((res) => { const r = db.transaction('users').objectStore('users').index('by_count').openCursor(null, 'prev'); const out = []; r.onsuccess = () => { const c = r.result; if (c && out.length < 3) { out.push(c.value); c.continue(); } else res(out); }; });
    const q = await chrome.runtime.sendMessage({ type: 'ws:query', user: users[0]?.user ?? '', limit: 5 });
    return { st, topUsers: users.map((u) => `${u.user}(${u.displayName}) x${u.count}`), sample: q.items.map((m) => `[${m.channel}] ${m.displayName}: ${m.text}${m.badges ? ' badges=' + m.badges.join('|') : ''} color=${m.color}`) };
  });
  console.log(JSON.stringify(sample, null, 1));
} finally {
  await browser.close();
}
