import { crx } from '@crxjs/vite-plugin';
import { defineConfig } from 'vitest/config';
import manifest from './manifest.config.ts';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'es2022',
    // 拡張は Twitch ページ上で動くため、起動コストを抑える目的で分割を最小限にする
    rollupOptions: {
      // manifest から参照されない拡張ページ(ポップアップ・設定から新しいタブで開く)
      input: { viewer: 'src/viewer/viewer.html' },
      output: { chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
