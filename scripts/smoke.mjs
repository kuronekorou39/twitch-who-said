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
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--mute-audio', '--window-size=1400,900'],
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
  // THEME=dark|light で Twitch のテーマを固定(twilight.theme: 1 = ダーク, 0 = ライト)
  if (process.env.THEME) {
    const v = process.env.THEME === 'dark' ? '1' : '0';
    await page.evaluateOnNewDocument((theme) => localStorage.setItem('twilight.theme', theme), v);
  }
  await page.goto(popout ? `https://www.twitch.tv/popout/${channel}/chat` : `https://www.twitch.tv/${channel}`, { waitUntil: 'domcontentloaded' });
  console.log(`watching chat for ${waitSec}s ...`);
  await new Promise((r) => setTimeout(r, waitSec * 1000));

  // --- ポップオーバー: 最新行のユーザー名をクリックし、純正カードの隣に出ることを確認 ---
  const shotDir = process.env.SHOT_DIR ?? '.cache';
  const popoverInfo = await (async () => {
    const names = await page.$$('.chat-line__message[data-a-user] .chat-author__display-name');
    if (names.length === 0) return { error: 'no chat lines' };
    const target = names[names.length - 1];
    await target.scrollIntoView();
    await target.click();
    await new Promise((r) => setTimeout(r, 2500));
    const info = await page.evaluate(() => {
      const host = document.getElementById('ws-popover');
      const card = document.querySelector('[data-a-target="viewer-card"]');
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const root = host?.shadowRoot;
      return {
        viewport: { w: innerWidth, h: innerHeight },
        hostHidden: host?.hidden ?? null,
        host: rect(host),
        card: rect(card),
        name: root?.querySelector('.name')?.textContent,
        nameColor: root?.querySelector('.name')?.style.color,
        count: root?.querySelector('.count')?.textContent,
        scopeOptions: [...(root?.querySelectorAll('.scope option') ?? [])].map((o) => o.value),
        items: root?.querySelectorAll('.item').length,
        firstItem: root?.querySelector('.item')?.textContent?.trim().slice(0, 80),
        status: root?.querySelector('.status')?.textContent,
        footer: root?.querySelector('.footer')?.textContent,
      };
    });
    await page.screenshot({ path: `${shotDir}/popover-${popout ? 'popout' : 'channel'}.png` });
    // ポップオーバー内をクリックしても純正カードが閉じないこと
    const hostEl = await page.$('#ws-popover');
    const box = hostEl ? await hostEl.boundingBox() : null;
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 500));
    const isOpen = () =>
      page.evaluate(() => ({
        card: !!document.querySelector('[data-a-target="viewer-card"]'),
        host: !document.getElementById('ws-popover')?.hidden,
      }));
    const afterInnerClick = await isOpen();
    // Esc で両方閉じること
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 500));
    const afterEsc = await isOpen();
    return { ...info, afterInnerClick, afterEsc };
  })();
  console.log('popover:', JSON.stringify(popoverInfo, null, 1));

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
