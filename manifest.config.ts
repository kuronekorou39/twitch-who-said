import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Who Said — Twitch Chat History',
  version: pkg.version,
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
