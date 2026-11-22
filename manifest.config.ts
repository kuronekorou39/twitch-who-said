import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Who Said — Twitch Chat History',
  version: pkg.version,
  // 拡張 ID を固定する公開鍵。ID が変わると IndexedDB の履歴が見えなくなるので変更しないこと
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr0OQi3NQO7qGVpd3mmon7DTmuqgrobd2pEXAPEHUBpMdjBk3irDO7DjDGrRyJdL6S6hO5pNpWRfmDCArPCmNBRaAMw1ZfzC7xURUIUZAsfvvQUsUmQVoppYAyVjOuZ9Lmr8u+7vfJBHrdkmFlFRAkt026DoJjFSy1XCYYVpWJlrcbxSA1a3gHghrGuaZwhh1H7S2jQbAzmg9chVXRa7heUlJMhFIje4a05+XUwq6wZXNKkvZNA/dEssb+/xoXgFgr2OND6PsOVf6Es0hA1P0moDXf36pABN2ejWjROaf9MCLW6aSoEOioI2BhPsdm64fXM1t/xhPjpL0ptHVuGRCWQIDAQAB',
  // color-mix と scrollbar-color を使う
  minimum_chrome_version: '121',
  description: 'Twitch のチャットでユーザー名をクリックすると、そのユーザーの過去コメントを表示します。データは端末内にのみ保存されます。',
  permissions: ['storage', 'unlimitedStorage', 'alarms'],
  host_permissions: ['https://www.twitch.tv/*'],
  background: {
    service_worker: 'src/sw/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://www.twitch.tv/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      // 他サイトに埋め込まれたチャット(/embed/<channel>/chat)にも注入する
      all_frames: true,
    },
  ],
  // ツールバーのアイコンを押したときのポップアップ(統計と、履歴ビューア・設定への入口)
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Who Said — Twitch Chat History',
  },
  options_page: 'src/options/options.html',
  icons: {
    16: 'icon16.png',
    48: 'icon48.png',
    128: 'icon128.png',
  },
});
