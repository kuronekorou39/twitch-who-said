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

// EMBED=1 のときだけ立てるローカルサーバー(finally で閉じる)
let server = null;

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
  // VOD=<id> なら VOD ページ(10 分地点から再生)で確認する
  const vodId = process.env.VOD;
  // EMBED=1: 他サイトに埋め込まれたチャット(/embed/<channel>/chat)で確認する。
  // parent= は埋め込み元のホスト名でなければならないので、localhost に小さなページを立てて中に iframe を置く
  const embed = process.env.EMBED === '1';
  if (embed) {
    const { createServer } = await import('node:http');
    const html = `<!doctype html><meta charset="utf-8"><title>embed smoke</title>
<style>body{margin:0;display:flex;height:100vh;background:#333}iframe{width:400px;height:100%;border:0}div{flex:1;color:#ccc;padding:16px}</style>
<iframe src="https://www.twitch.tv/embed/${channel}/chat?darkpopout&parent=localhost"></iframe><div>(video area)</div>`;
    server = createServer((_, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    });
    await new Promise((r) => server.listen(0, r));
  }
  const url = embed
    ? `http://localhost:${server.address().port}/`
    : vodId
    ? `https://www.twitch.tv/videos/${vodId}?t=0h10m0s`
    : popout
      ? `https://www.twitch.tv/popout/${channel}/chat`
      : `https://www.twitch.tv/${channel}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // 埋め込みでは DOM 操作の相手が iframe になる(iframe は左上に置いてあるので座標は page と一致する)
  const doc = embed ? await page.waitForFrame((f) => f.url().includes('/embed/'), { timeout: 30_000 }) : page;
  console.log(`watching chat for ${waitSec}s ...`);
  await new Promise((r) => setTimeout(r, waitSec * 1000));

  // --- SPA=1: サイドバーの別チャンネルへページ内遷移し、取り込みが追従することを確認 ---
  if (process.env.SPA === '1' && !popout && !vodId) {
    // サイドバーのリンクはログイン状態で変わるため、pushState + popstate で Twitch のルーターに遷移させる
    const to = process.env.SPA_TO ?? 'sample_streamer';
    const href = `/${to}`;
    {
      await page.evaluate((path) => {
        history.pushState({}, '', path);
        dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      }, href);
      console.log(`SPA navigate → ${href}, watching 35s ...`);
      await new Promise((r) => setTimeout(r, 35_000));
      console.log('url now', page.url());
      console.log(
        'dom after SPA:',
        await page.evaluate(() => ({
          containers: document.querySelectorAll('.chat-scrollable-area__message-container').length,
          rows: document.querySelector('.chat-scrollable-area__message-container')?.childElementCount,
          lines: document.querySelectorAll('.chat-line__message[data-a-user]').length,
          firstRowClasses: document.querySelector('.chat-scrollable-area__message-container > *')?.className?.slice(0, 80),
          firstLineUser: document.querySelector('.chat-line__message')?.getAttribute('data-a-user'),
          bodyFound: !!document.querySelector('[data-a-target="chat-line-message-body"]'),
        })),
      );
    }
  }

  // --- ポップオーバー: 最新行のユーザー名をクリックし、純正カードの隣に出ることを確認 ---
  const shotDir = process.env.SHOT_DIR ?? '.cache';
  const popoverInfo = await (async () => {
    // エモートを含む行があればそのユーザーを優先(エモート表示の確認のため)
    const withEmote = await doc.$$(
      '.chat-line__message[data-a-user]:has(img.chat-line__message--emote) .chat-author__display-name, .vod-message:has(.video-chat__message img[alt]) .chat-author__display-name',
    );
    const names = withEmote.length
      ? withEmote
      : await doc.$$('.chat-line__message[data-a-user] .chat-author__display-name, .vod-message .chat-author__display-name');
    if (names.length === 0) return { error: 'no chat lines' };
    const target = names[names.length - 1];
    await target.scrollIntoView();
    await target.click();
    await new Promise((r) => setTimeout(r, 2500));
    const info = await doc.evaluate(() => {
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
        emoteImgs: root?.querySelectorAll('.item img.emote').length,
        emoteSrc: root?.querySelector('.item img.emote')?.getAttribute('src'),
        channelHidden: root?.querySelector('.item .channel') ? getComputedStyle(root.querySelector('.item .channel')).display === 'none' : null,
        firstItem: root?.querySelector('.item')?.textContent?.trim().slice(0, 80),
        status: root?.querySelector('.status')?.textContent,
        footer: root?.querySelector('.footer')?.textContent,
      };
    });
    await page.screenshot({ path: `${shotDir}/popover-${embed ? 'embed' : vodId ? 'vod' : popout ? 'popout' : 'channel'}.png` });
    // ポップオーバー内をクリックしても純正カードが閉じないこと
    const hostEl = await doc.$('#ws-popover');
    const box = hostEl ? await hostEl.boundingBox() : null;
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 500));
    // ヘッダをドラッグして移動できること(ヘッダ左端付近をつかむ)
    let dragged = null;
    if (box) {
      await page.mouse.move(box.x + 40, box.y + 14);
      await page.mouse.down();
      await page.mouse.move(box.x + 40 + 120, box.y + 14 + 80, { steps: 8 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 300));
      const after = await hostEl.boundingBox();
      dragged = { from: { x: Math.round(box.x), y: Math.round(box.y) }, to: { x: Math.round(after.x), y: Math.round(after.y) } };
      await page.screenshot({ path: `${shotDir}/popover-dragged.png` });
      // 「位置を戻す」ボタン(移動後だけ表示)で元の位置に戻す
      const btn = await doc.evaluate(() => {
        const b = document.getElementById('ws-popover')?.shadowRoot?.querySelector('.reset');
        if (!b || b.hidden) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      dragged.resetButtonShown = !!btn;
      if (btn) await page.mouse.click(btn.x, btn.y);
      await new Promise((r) => setTimeout(r, 300));
      const reset = await hostEl.boundingBox();
      dragged.reset = { x: Math.round(reset.x), y: Math.round(reset.y) };
      dragged.storedAfterReset = await doc.evaluate(() => localStorage.getItem('ws-popover-position'));
    }
    const isOpen = () =>
      doc.evaluate(() => ({
        card: !!document.querySelector('[data-a-target="viewer-card"]'),
        host: !document.getElementById('ws-popover')?.hidden,
      }));
    const afterInnerClick = await isOpen();
    // Esc で両方閉じること
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 500));
    const afterEsc = await isOpen();
    return { ...info, afterInnerClick, dragged, afterEsc };
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
  console.log('diag:', await opts.evaluate(() => chrome.storage.local.get('diag').then((r) => r.diag ?? null)));
  await opts.screenshot({ path: `${shotDir}/options.png`, fullPage: true });

  // SW 経由で直接クエリしてサンプルを表示
  const sample = await opts.evaluate(async () => {
    const st = await chrome.runtime.sendMessage({ type: 'ws:stats' });
    const db = await new Promise((res, rej) => { const r = indexedDB.open('twitch-who-said'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const users = await new Promise((res) => { const r = db.transaction('users').objectStore('users').index('by_count').openCursor(null, 'prev'); const out = []; r.onsuccess = () => { const c = r.result; if (c && out.length < 3) { out.push(c.value); c.continue(); } else res(out); }; });
    const q = await chrome.runtime.sendMessage({ type: 'ws:query', user: users[0]?.user ?? '', limit: 5 });
    // 同じ user/text が複数チャンネルに保存されていないか(SPA 遷移時の取り違え検知)
    const all = await new Promise((res) => { const r = db.transaction('messages').objectStore('messages').getAll(); r.onsuccess = () => res(r.result); });
    const byKey = new Map();
    for (const m of all) { const k = m.user + '\n' + m.text; (byKey.get(k) ?? byKey.set(k, new Set()).get(k)).add(m.channel); }
    const crossChannelDups = [...byKey.entries()].filter(([, chs]) => chs.size > 1).map(([k, chs]) => k.replace('\n', ': ') + ' → ' + [...chs].join(','));
    const perChannel = {}; for (const m of all) perChannel[m.channel] = (perChannel[m.channel] ?? 0) + 1;
    st.perChannel = perChannel; st.crossChannelDups = crossChannelDups;
    const fmt = (m) => `[${m.channel}] ${m.source}${m.vodId ? ' vod=' + m.vodId + ' @' + m.offsetSec + 's' : ''} ${new Date(m.ts).toISOString()} ${m.displayName}: ${m.text}${m.badges ? ' badges=' + m.badges.join('|') : ''} color=${m.color}`;
    return { st, topUsers: users.map((u) => `${u.user}(${u.displayName}) x${u.count}`), sample: q.items.map(fmt) };
  });
  console.log(JSON.stringify(sample, null, 1));

  // --- 設定画面の操作: prune → エクスポート → 全削除 → インポートで復元 ---
  const readStats = () =>
    opts.evaluate(() => ({ messages: document.getElementById('st-messages')?.textContent, users: document.getElementById('st-users')?.textContent }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await opts.click('#btn-prune');
  await wait(1500);
  console.log('prune:', await opts.$eval('#prune-status', (e) => e.textContent));

  const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dlDir = mkdtempSync(join(tmpdir(), 'ws-export-'));
  const cdp = await opts.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
  await opts.click('#btn-export');
  let exported = null;
  for (let i = 0; i < 20 && !exported; i++) {
    await wait(500);
    exported = readdirSync(dlDir).find((f) => f.endsWith('.jsonl'));
  }
  const exportPath = exported ? join(dlDir, exported) : null;
  const exportedLines = exportPath ? readFileSync(exportPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  console.log('export:', exported, 'lines:', exportedLines, '|', await opts.$eval('#export-status', (e) => e.textContent));

  opts.on('dialog', (d) => void d.accept());
  await opts.click('#btn-clear');
  await wait(1000);
  console.log('after clear:', await readStats());

  if (exportPath) {
    const input = await opts.$('#file-import');
    await input.uploadFile(exportPath);
    await wait(3000);
    console.log('import:', await opts.$eval('#import-status', (e) => e.textContent));
    console.log('after import:', await readStats());
  }
} finally {
  await browser.close();
  server?.close();
}
