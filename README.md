# Who Said — Twitch Chat History

Twitch のチャット欄でユーザー名をクリックすると、そのユーザーの過去コメント一覧をポップオーバーで表示する Chrome 拡張(Manifest V3)です。

- モデレーター権限不要。**自分が開いたライブチャット / VOD チャットリプレイに流れたメッセージ**をローカル(IndexedDB)に蓄積し、そこから検索します
- **外部サーバーなし・外部通信ゼロ**。データは端末のブラウザ内に閉じます
- Twitch の描画・スクロールに体感影響を出さない「軽さ」を最優先に設計しています

仕様の詳細は [docs/SPEC.md](docs/SPEC.md) を参照してください。

## 現在の状態

| マイルストーン | 状態 |
|---|---|
| M1 取り込み(ビルド環境 / ライブチャット取り込み / IndexedDB 保存 / 設定画面の統計表示) | 完了 |
| M2 表示(ユーザー名クリック → ポップオーバー / スコープ切替 / 絞り込み / ページング) | 完了 |
| M3 VOD リプレイ取り込み(開始日時解決 / 近傍重複抑止 / VOD リンク) | 完了 |
| M4 運用(prune / 除外 / 自分の除外 / Export, Import) | 完了 |
| M5 仕上げ | 未着手 |

## インストール(開発ビルド)

```sh
npm install
npm run build
```

Chrome の `chrome://extensions` で「デベロッパーモード」を ON にし、「パッケージ化されていない拡張機能を読み込む」から `dist/` を選択します。

## 開発

```sh
npm run dev        # Vite + CRXJS の HMR 付きビルド(dist/ を読み込んだ拡張がリロードされる)
npm test           # ユニットテスト(Vitest)
npm run typecheck  # 型チェック
npm run smoke      # 実際の Twitch チャットで取り込みを確認(下記)
```

### スモークテスト

`scripts/smoke.mjs` はビルド済みの拡張を Chrome に読み込み、実際のチャットでメッセージが保存されることを確認します。
Google 製 Chrome 137 以降は `--load-extension` が無効化されているため、Chrome for Testing を使います。

```sh
npx @puppeteer/browsers install chrome@stable --path .cache/puppeteer
npm run build
node scripts/smoke.mjs <channel> [seconds]   # 例: node scripts/smoke.mjs somechannel 40
POPOUT=0 node scripts/smoke.mjs <channel>   # ポップアウトではなく通常のチャンネルページで確認
THEME=dark node scripts/smoke.mjs <channel>  # Twitch のテーマを固定(dark | light)
VOD=<videoId> node scripts/smoke.mjs         # VOD ページ(10 分地点)でチャットリプレイの取り込みを確認
SHOT_DIR=<dir> node scripts/smoke.mjs ...    # ポップオーバーのスクリーンショット保存先(既定 .cache/)
```

## ディレクトリ構成

```
├── manifest.config.ts     # MV3 マニフェスト(CRXJS)
├── vite.config.ts
├── src/
│   ├── content/           # Twitch ページ上で動く content script
│   │   ├── index.ts       #   エントリ。ページ種別判定・SPA 遷移監視・自己診断
│   │   ├── selectors.ts   #   Twitch DOM セレクタ(DOM 依存はここだけ)
│   │   ├── page.ts        #   URL → ページ種別 / チャンネル判定
│   │   ├── extract.ts     #   1 行 → メッセージ変換(純粋関数)
│   │   ├── capture.ts     #   MutationObserver + バッチ送信(ライブ / VOD 共通)
│   │   ├── vod.ts         #   VOD の配信開始日時・チャンネル解決
│   ├── sw/                # Service Worker
│   │   └── index.ts       #   RPC ハンドラ、chrome.alarms による定期 prune
│   ├── db/                # IndexedDB 層(SW と設定画面の両方から使う)
│   │   ├── db.ts          #   スキーマ・取り込み・検索・統計
│   │   ├── prune.ts       #   保持ポリシー適用(5,000 件チャンク + yield)
│   │   └── export.ts      #   JSON Lines のエクスポート / インポート
│   ├── options/           # 設定画面
│   └── shared/            # 型・RPC 定義・設定・ID 生成
├── test/                  # Vitest(fixtures/ に実 DOM のスナップショット)
├── scripts/               # アイコン生成・スモークテスト
└── docs/SPEC.md           # 仕様書
```

## 実装メモ

- 現行の Twitch はメッセージ ID を DOM に出していないため、ID は `sha1(channel, user, text, 秒単位の ts)` の先頭 20 文字です。ライブと VOD で同じ発言が別 ID になる場合は、書き込み時に ±10 秒以内の同一 user / channel / text をスキップして抑止します(仕様書の ±2 秒から広げました。VOD の日時は「配信開始日時 + 再生位置」の推定値で、ライブ取り込み時刻と数秒ずれるため)
- エクスポート / インポートは Service Worker を経由せず、設定画面から直接 IndexedDB(拡張オリジンで共有)を読み書きします。数百万件を `sendMessage` で往復させないためです。仕様書の `ws:export` / `ws:import` RPC は設けていません
- 自分の発言の除外は、Twitch がログイン時に設定する `login` cookie を content script が読み、取り込みバッチに添えて Service Worker 側で除外します(`cookies` 権限は不要)
- VOD の配信開始日時は、実行時の DOM には無い ld+json を SSR の HTML(同じ URL を同一オリジンで fetch)から読みます。取得できたら Service Worker 側にキャッシュします。チャンネルは動画情報欄のチャンネルリンクから判定します
- エモートは `img[alt]` から `:EmoteName:` 形式のプレーンテキストに正規化して保存します
- content script の isolated world からは `history.pushState` をフックできないため、SPA 遷移は URL のポーリング(1 秒)で検知します
- ポップオーバーは Twitch 純正のビューワーカード(`[data-a-target="viewer-card"]`)を止めずに、その右隣(画面右端に寄る場合は左隣)へ同じ上端で表示します。カードのドラッグには MutationObserver で追従し、カードが DOM から消えたら一緒に閉じます

## プライバシー

自分用ツールとして配布しない前提です。取り込んだチャットは端末内の IndexedDB にのみ保存され、どこにも送信しません。

## ライセンス

MIT © rou39
