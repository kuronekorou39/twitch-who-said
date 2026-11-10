# twitch-who-said — Twitch チャット履歴ポップオーバー拡張 仕様書

## 実装との差分(2026-11-10 時点)

本書は当初仕様。実装時に実 DOM を確認して以下を変更した。詳細は README の「実装メモ」も参照。

| 項目 | 仕様 | 実装 |
|---|---|---|
| メッセージ ID | `data-a-msg-id` があれば採用 | 現行 Twitch は DOM に ID を出していないため常に内容ハッシュ。属性が復活したときのコードは残してある |
| 本文抽出 | フラグメントのクラスを列挙して連結 | 本文要素をツリー走査し、テキストノードと `img[alt]` を文書順に連結(未知のフラグメント種別に強い) |
| 近傍重複ウィンドウ | ±2 秒 | ±10 秒(VOD の日時は「uploadDate + 再生位置」の推定値でライブ取り込み時刻と数秒ずれる) |
| VOD 開始日時 | ページ内 ld+json → UI の日付表示 | 実行時 DOM に ld+json が無いため、同じ URL の SSR HTML を同一オリジンで fetch して `uploadDate` を読む。UI の日付表示は相対表記のみで使えない |
| VOD のチャンネル | チャット内リンク or ld+json author | 動画情報欄 `.metadata-layout__support` のチャンネルリンク href。フォールバックは ld+json の name 末尾 |
| Export / Import | SW の RPC(`ws:export` / `ws:import`) | 設定画面から直接 IndexedDB(拡張オリジンで共有)を読み書き。巨大データを `sendMessage` で往復させない。RPC は設けていない |
| 自分の除外 | 設定のみ | content script が `login` cookie を読み、取り込みバッチに `self` を添えて SW 側で除外 |
| SPA 遷移 | `history.pushState` を監視 | isolated world からはフックできないため Navigation API(`navigatesuccess`)+ popstate + 1 秒ポーリング。遷移直後は旧コンテナが残るため、別のコンテナ要素が現れるまで待つ。さらに 3 秒ごとにコンテナの生存を確認し、再マウントされていれば張り直す |
| 取り込み開始時の既存行 | 流れたメッセージのみ | 新しく現れたコンテナに既に表示されている行も 1 度取り込む(重複は SW が弾く) |
| セレクタ破損の自己診断 | 30 秒で 0 件なら警告 | 「行らしき要素があるのに 1 件も抽出できない」ときだけ警告(静かなチャットでは出さない)。結果を `chrome.storage.local` に保存し、設定画面にバッジ表示 |
| エモート画像 | 本バージョンではやらない(12 章) | 取り込み時に エモート名 → URL を `emotes` ストアに保存し、ポップオーバーで既知のものを画像表示(Twitch 公式エモートのみ。7TV 等は対象外) |
| ポップオーバーの位置 | 純正カードの隣に固定 | ドラッグで移動可。位置は localStorage に記憶、「↺」で自動配置に戻す |
| 一覧のチャンネル名 | 常に表示 | 「全チャンネル」のときだけ表示 |
| ライブの既存行の時刻 | 取り込み時刻 | タイムスタンプ表示 ON なら行の時刻、OFF なら既存行は取り込まない(新着行は取り込み時刻) |
| manifest | `manifest.json` | CRXJS の `manifest.config.ts`(version は package.json から) |
| ディレクトリ | `src/sw/db.ts` | DB 層は `src/db/`(SW と設定画面の両方から使う) |
| 埋め込みチャット | 対象外 | 他サイトに埋め込まれた `/embed/<channel>/chat`(マルチビューなど)も対象。純正カードが出るのでポップオーバーも同じ動作 |

---

## 0. 概要

Twitch のチャット欄でユーザー名をクリックすると、そのユーザーの過去コメント一覧をポップオーバーで表示するブラウザ拡張（Chrome / Manifest V3）。
モデレーター権限は不要。**自分が開いたライブチャット・VOD（アーカイブ）のチャットリプレイから流れたメッセージをすべてローカル（IndexedDB）に蓄積**し、そこから検索して表示する。

- 外部サーバーなし。データは端末のブラウザ内に閉じる。
- 見た目は Twitch 純正 UI に馴染ませる（Twitch の CSS 変数を参照、ダーク/ライト追従）。
- 「軽い」ことを最優先する。チャットの描画・スクロールに体感影響を出さない。

### 0.1 名称

- リポジトリ名: `twitch-who-said`
- 拡張表示名: **Who Said — Twitch Chat History**
- 内部プレフィックス: `ws-`（DOM id / class / message type）
- IndexedDB 名: `twitch-who-said`

### 0.2 スコープ外（やらない）

- BAN / タイムアウト履歴、モデレーターコメントの表示（モデレーター専用 API のため不可）
- Twitch 内部 GraphQL（`ViewerCardModLogs` 等）の呼び出し
- 外部ログサービス（rustlog / logs.ivr.fi 等）との連携 ※将来拡張の余地は残す
- 自分が開いていない時間帯のメッセージ取得
- Firefox 対応（初期は Chrome 系のみ。MV3 共通コードで書くが検証しない）

---

## 1. 要件

### 1.1 機能要件

| ID | 要件 |
|---|---|
| F-1 | ライブチャット（`twitch.tv/<channel>`、ポップアウトチャット `twitch.tv/popout/<channel>/chat`、他サイトに埋め込まれたチャット `twitch.tv/embed/<channel>/chat`）に流れるメッセージを取り込む |
| F-2 | VOD（`twitch.tv/videos/<id>`）のチャットリプレイに流れるメッセージを取り込む |
| F-3 | 同一メッセージは 1 件だけ保存する（重複排除） |
| F-4 | チャット内のユーザー名をクリックしたとき、そのユーザーの保存済みメッセージ一覧をポップオーバーで表示する |
| F-5 | ポップオーバー内で「このチャンネルのみ / 全チャンネル」を切り替えられる |
| F-6 | ポップオーバー内でキーワードによる絞り込みができる |
| F-7 | 一覧は新しい順。初期 50 件、スクロールで追加ロード |
| F-8 | 各メッセージに日時・チャンネル名・（VOD 由来なら）VOD へのリンク付きオフセットを表示 |
| F-9 | 保持ポリシー（期間 / ユーザーあたり上限 / 全体上限）を設定画面で変更でき、アイドル時に自動削除 |
| F-10 | 設定画面で統計（総件数・ユーザー数・推定使用容量）を表示 |
| F-11 | JSON でエクスポート / インポート（全削除も可） |
| F-12 | 自分のユーザー名を除外する / 特定ユーザー・ボットを除外するリスト |

### 1.2 非機能要件

| ID | 要件 |
|---|---|
| N-1 | コンテンツスクリプトはメッセージ 1 件あたりの処理を DOM 読み取りとキュー追加のみに限定。IndexedDB 書き込みは Service Worker 側でバッチ処理 |
| N-2 | 毎秒 100 メッセージ規模のチャットでも、メインスレッドの長タスク（50ms 超）を発生させない |
| N-3 | ポップオーバーの初回表示は 200ms 以内（インデックス検索のみ、全件スキャン禁止） |
| N-4 | `unlimitedStorage` 権限を使い、ブラウザによる自動削除（eviction）対象から外す |
| N-5 | Twitch の React ツリー（内部 state / props）に依存しない。DOM 属性とセレクタのみ使用し、セレクタは 1 ファイルに集約して差し替え可能にする |
| N-6 | 権限は最小限: `storage`, `unlimitedStorage`, `alarms`（削除スケジュール）, host は `https://www.twitch.tv/*` のみ |
| N-7 | 外部通信ゼロ（アナリティクス含む） |

---

## 2. アーキテクチャ

```
┌──────────────── twitch.tv タブ ────────────────┐
│ content script (capture.js)                   │
│  - MutationObserver でチャット行を監視         │
│  - 行から {msgId, user, text, ts, ...} 抽出     │
│  - キューに積み、300ms or 50件 でまとめて送信   │
│  - ユーザー名クリックをフック                   │
│                                               │
│ content script (popover.js)                   │
│  - Shadow DOM でポップオーバー描画              │
│  - SW へクエリ、結果を描画                      │
└───────────────┬───────────────────────────────┘
                │ chrome.runtime.sendMessage (batch)
┌───────────────▼───────────────────────────────┐
│ service worker (sw.js)                        │
│  - IndexedDB (idb ライブラリ) 書き込み/検索     │
│  - 重複排除、保持ポリシー適用                   │
│  - chrome.alarms で 1日1回 prune              │
└───────────────────────────────────────────────┘
          options page (options.html)
          - 保持ポリシー / 除外リスト / 統計 / Export,Import
```

### 2.1 技術スタック

- TypeScript、Vite + `@crxjs/vite-plugin`（MV3 ビルド）
- IndexedDB ラッパー: `idb`
- UI フレームワークなし（Shadow DOM + 素の DOM 操作。バンドルサイズと起動コスト優先）
- テスト: Vitest（抽出ロジック・重複キー生成・prune ロジックはユニットテスト対象）

### 2.2 ディレクトリ構成

```
twitch-who-said/
├── manifest.json
├── src/
│   ├── content/
│   │   ├── index.ts         # エントリ。ページ種別判定して capture/popover を起動
│   │   ├── selectors.ts     # Twitch DOM セレクタ定義（唯一の依存点）
│   │   ├── capture.ts       # MutationObserver + 抽出 + バッチ送信
│   │   ├── extract.ts       # 1 行 → ChatMessage 変換（純粋関数、テスト対象）
│   │   ├── vod.ts           # VOD の配信開始日時・オフセット解決
│   │   ├── popover.ts       # ポップオーバー UI
│   │   └── popover.css      # Shadow DOM 内スタイル
│   ├── sw/
│   │   ├── index.ts         # メッセージハンドラ
│   │   ├── db.ts            # スキーマ・CRUD・検索
│   │   └── prune.ts         # 保持ポリシー適用
│   ├── options/
│   │   ├── options.html
│   │   └── options.ts
│   └── shared/
│       ├── types.ts         # ChatMessage, Settings, RPC 型
│       ├── messages.ts      # content ↔ sw の RPC 定義
│       └── settings.ts      # デフォルト値・読み書き
├── test/
├── docs/SPEC.md             # 本書
└── README.md
```

---

## 3. データモデル

### 3.1 ChatMessage

```ts
interface ChatMessage {
  id: string;          // 一意キー（3.3 参照）
  user: string;        // login 名（小文字）。検索キー
  displayName: string; // 表示名（大文字小文字・日本語表示名）
  channel: string;     // チャンネル login 名（小文字）
  text: string;        // 本文（エモートは `:name:` 形式のプレーンテキストに正規化）
  ts: number;          // 発言日時 epoch ms（VOD は推定値。3.4 参照）
  source: 'live' | 'vod';
  vodId?: string;      // VOD 由来のとき
  offsetSec?: number;  // VOD 内オフセット秒
  badges?: string[];   // 'moderator','subscriber/12','vip' など。任意
  color?: string;      // ユーザー名色 (#rrggbb)
  capturedAt: number;  // 取り込み日時（prune の基準に使う）
}
```

### 3.2 IndexedDB スキーマ

DB 名: `twitch-who-said` / version 1

| store | keyPath | index |
|---|---|---|
| `messages` | `id` | `by_user_ts`: `[user, ts]`<br>`by_user_channel_ts`: `[user, channel, ts]`<br>`by_ts`: `ts`<br>`by_captured`: `capturedAt` |
| `users` | `user` | `by_count`: `count` ／ 値: `{ user, displayName, count, lastTs }`（統計・上限管理用の集計キャッシュ） |
| `meta` | `key` | — （`vodStart:<vodId>` などのキャッシュ） |

### 3.3 一意キー（重複排除）

1. ライブ: Twitch が行要素に付与するメッセージ ID（`data-a-msg-id` 等、selectors.ts で定義）が取れればそれを `id` にする
2. 取れない場合（VOD チャットリプレイ等）: `sha1(channel + '\n' + user + '\n' + text + '\n' + Math.round(ts/1000))` の先頭 20 文字を `id` にする
   - 同一 VOD を見返しても同じキーになり、二重登録されない
   - ライブで見た後に VOD で同じ箇所を見た場合、ライブ側は msg-id キー、VOD 側はハッシュキーで**別レコードになり得る**。これは「`by_user_ts` で前後 2 秒以内に同一 user/channel/text があればスキップ」という書き込み時の近傍チェックで抑止する

書き込みは `put`（上書き）で冪等。

### 3.4 VOD のタイムスタンプ

- VOD ページから配信開始日時（`createdAt` 相当）を取得する。取得方法は優先順に
  1. ページ内 `<script type="application/ld+json">` の `uploadDate`
  2. VOD 情報 UI の日付表示（相対表記は不可の場合がある）
  3. どちらも取れなければ `ts = capturedAt`、`source='vod'` と `offsetSec` のみ正確とする
- 取得した開始日時は `meta` に `vodStart:<vodId>` でキャッシュ
- 各行のオフセットは、リプレイ行のタイムスタンプ表示（`hh:mm:ss`）を解析して秒に変換。`ts = vodStart + offsetSec*1000`

---

## 4. 取り込み（capture）

### 4.1 対象ページ判定

| URL パターン | 種別 | channel の取り方 |
|---|---|---|
| `/<channel>` | live | パス先頭セグメント（除外: `videos`, `directory`, `settings`, `popout`, `u`, ほか予約語リスト） |
| `/popout/<channel>/chat` | live | パス 2 番目 |
| `/embed/<channel>/chat` | live | パス 2 番目（他サイトの iframe 内。content script は `all_frames` で注入） |
| `/videos/<id>` | vod | チャットリプレイ領域内のチャンネルリンク、または ld+json の `author` |
| `/moderator/<channel>` | live | パス 2 番目（Mod View。純正ユーザーカードがあるので履歴表示は任意） |

SPA 遷移（`history.pushState`）を監視し、URL 変更時に Observer を張り直す。

### 4.2 監視

- チャットコンテナ（selectors.ts: `chatContainer`）を `MutationObserver({ childList: true, subtree: false })` で監視。コンテナが遅れて出現する場合は 500ms ポーリング（最大 30 秒）で待つ
- 追加ノードのうちメッセージ行（`chatLine`）のみ処理。システムメッセージ・サブ通知・自分の送信直後の仮表示は除外
- 1 行の抽出は `extract.ts` の純粋関数で行い、失敗したら黙って捨てる（例外でチャットを壊さない）

### 4.3 セレクタ（初期値。実装時に実 DOM で確認して更新）

```ts
export const SELECTORS = {
  live: {
    chatContainer: '.chat-scrollable-area__message-container',
    chatLine:      '.chat-line__message',
    msgId:         '[data-a-msg-id]',             // 行自身 or 内包
    userLogin:     '[data-a-user]',               // 属性値 = login
    displayName:   '.chat-author__display-name',
    textFragments: '.text-fragment, .chat-line__message--emote', // 順に連結
    badges:        '.chat-badge',                  // alt / aria-label
    timestamp:     '.chat-line__timestamp',        // 設定でONの場合のみ
  },
  vod: {
    chatContainer: '.video-chat__message-list-wrapper ul',
    chatLine:      '.video-chat__message',
    userLogin:     '[data-a-user]',
    displayName:   '.video-chat__message-author',
    textFragments: '.text-fragment, [data-a-target="emote-name"]',
    timestamp:     '.video-chat__message-timestamp' // hh:mm:ss
  },
  usernameClickTarget: '.chat-author__display-name, .video-chat__message-author',
} as const;
```

### 4.4 バッチ送信

- キュー: 配列。`300ms` デバウンス or `50` 件到達でフラッシュ
- `chrome.runtime.sendMessage({ type: 'ws:ingest', items })`。応答は待たない（fire-and-forget）
- SW 停止中でも `sendMessage` は SW を起こすので再送不要。失敗時は次フラッシュに繰り越し（上限 1,000 件、超えたら古い順に捨てる）
- タブ非表示（`document.hidden`）時もキャプチャは継続する（音声だけ聞いているケースを想定）

### 4.5 SW 側の書き込み

- 1 バッチ = 1 トランザクション（`readwrite` on `messages`, `users`）
- 除外リスト（設定）に該当する user は捨てる
- 3.3 の近傍重複チェック → `put`
- `users` の `count`, `lastTs`, `displayName` を更新
- ユーザーあたり上限を超えた分は、このタイミングではなく prune に任せる（書き込みパスを軽く保つ）

---

## 5. ポップオーバー UI

### 5.1 起動

- `document` に `click` をキャプチャフェーズで 1 本登録。`usernameClickTarget` にマッチしたら対象行から `user`, `displayName`, `channel` を取り、ポップオーバーを開く
- Twitch 純正のビューワーカードは**そのまま開かせる**（止めない）。Who Said のポップオーバーは純正カードの右隣（画面右端に寄るなら左隣）に、同じ上端で表示する。純正カードが閉じられた（DOM から消えた）ことを検知したら Who Said も閉じる
- Esc / 外側クリックで閉じる。ポップオーバー内クリックは伝播を止める

### 5.2 レイアウト

```
┌──────────────────────────────────────┐
│ ◉ DisplayName          [このch ▾]  ✕ │  ← ヘッダ: 名前(ユーザー色), 件数, スコープ切替
│ 🔍 絞り込み...                        │
├──────────────────────────────────────┤
│ 11/09 21:34  #channel                │
│   本文本文本文本文                    │
│ 11/08 20:01  #other  ▶ VOD 1:23:45   │  ← VOD 由来は再生位置リンク
│   本文本文                            │
│ ...                                  │
│         （スクロールで追加ロード）      │
├──────────────────────────────────────┤
│ 全 1,234 件 · 初回 2026/07/01        │
└──────────────────────────────────────┘
```

- 幅 320px、最大高さ 480px、内部スクロール
- 本文はプレーンテキスト表示（エモート画像化はしない。`:emote:` のまま）
- 日時は端末ローカル。同日なら時刻のみ
- VOD リンク: `https://www.twitch.tv/videos/<vodId>?t=1h23m45s`

### 5.3 スタイル

- Shadow DOM（`mode: 'open'`）内に CSS を閉じ込め、Twitch 側 CSS の影響を受けない・与えない
- 色・角丸・影・フォントは **Twitch の CSS カスタムプロパティを `:host` 経由で参照**する（`--color-background-base`, `--color-background-alt`, `--color-text-base`, `--color-text-alt-2`, `--color-border-base`, `--border-radius-medium`, `--shadow-elevation-2`, `--font-base`）。これによりダーク/ライトテーマへ自動追従
- 変数が取れない場合のフォールバック値を定義（Twitch ダーク: `#18181b` / `#1f1f23` / `#efeff1`）
- ヘッダの名前色は `ChatMessage.color`（暗すぎる場合は Twitch と同様に明度補正）

### 5.4 データ取得

- `ws:query { user, channel?, keyword?, before?: ts, limit: 50 }` → SW が `by_user_channel_ts` または `by_user_ts` を `openCursor(range, 'prev')` で走査
- keyword は SW 側でカーソル走査中に `text.includes()` でフィルタ（インデックスなしで良い。ユーザー単位なので件数は小さい）
- `before` でページング

---

## 6. 保持ポリシー（prune）

設定（デフォルト）:

```ts
interface Settings {
  retentionDays: number;        // 365（0 = 無期限）
  maxPerUser: number;           // 2000（0 = 無制限）
  maxTotal: number;             // 2_000_000（0 = 無制限）
  excludeUsers: string[];       // []
  excludeSelf: boolean;         // false
  knownBotsPreset: boolean;     // true（nightbot, streamelements, fossabot, moobot, streamlabs 等）
  showOnModView: boolean;       // false
}
```

実行:

- `chrome.alarms` で 24 時間ごと + 拡張起動時（前回実行から 12 時間以上経過していれば）
- 手順: ① `by_captured` で `retentionDays` 超を削除 → ② `users` を走査し `count > maxPerUser` のユーザーについて `by_user_ts` 古い順で超過分削除 → ③ 総件数 > `maxTotal` なら `by_ts` 古い順に削除
- 1 トランザクションあたり最大 5,000 件で区切り、間に `setTimeout(0)` を挟む（SW のイベントループを占有しない）
- 削除後に `users.count` を再計算

容量の目安: 1 件 ≈ 200 B + インデックス ≈ 実質 400 B 前後。200 万件で約 800 MB。

---

## 7. 設定画面（options）

- 保持ポリシー各値の編集
- 除外ユーザー編集、ボットプリセット ON/OFF
- 統計: 総件数、ユーザー数、チャンネル数、最古/最新の `ts`、`navigator.storage.estimate()` による使用量
- エクスポート（JSON Lines、gzip なし。`chrome.downloads` を使わず `<a download>` で済ませ権限を増やさない）
- インポート（同形式。`put` で冪等）
- 「すべて削除」（確認ダイアログ付き）
- 「今すぐ prune 実行」

---

## 8. RPC 定義（content ↔ sw）

```ts
type Req =
  | { type: 'ws:ingest'; items: ChatMessage[] }
  | { type: 'ws:query'; user: string; channel?: string; keyword?: string; before?: number; limit: number }
  | { type: 'ws:userStats'; user: string }                 // 件数・初回日時
  | { type: 'ws:getVodStart'; vodId: string }
  | { type: 'ws:setVodStart'; vodId: string; ts: number }
  | { type: 'ws:stats' } | { type: 'ws:prune' } | { type: 'ws:clear' }
  | { type: 'ws:export' } | { type: 'ws:import'; lines: string[] }
  | { type: 'ws:getSettings' } | { type: 'ws:setSettings'; patch: Partial<Settings> };
```

---

## 9. テスト

- `extract.ts`: 実 DOM の HTML スナップショット（ライブ / VOD / エモート混在 / 返信 / 自分の送信）を `test/fixtures/` に保存し、期待値と比較
- `id` 生成: 同一入力で安定、`ts` が 1 秒ズレても同じ秒に丸まれば同一
- `prune.ts`: fake-indexeddb で 3 段階の削除順序を検証
- 手動: 高速チャット（カテゴリ Just Chatting 上位）で 10 分放置し、Performance パネルで長タスクが出ないことを確認

---

## 10. マイルストーン

1. **M1 取り込み**: manifest / ビルド環境 / ライブチャット取り込み / IndexedDB 保存 / 設定画面に件数表示
2. **M2 表示**: ユーザー名クリック → ポップオーバー（このch のみ）/ ページング / Twitch 風スタイル
3. **M3 VOD**: VOD リプレイ取り込み / 開始日時解決 / 近傍重複抑止 / VOD リンク表示
4. **M4 運用**: 全チャンネル切替 / キーワード絞り込み / prune / 除外リスト / Export,Import
5. **M5 仕上げ**: SPA 遷移の堅牢化 / セレクタ破損時の自己診断（コンソール警告 1 回のみ）/ README

---

## 11. 既知のリスクと対応

| リスク | 対応 |
|---|---|
| Twitch の DOM 変更でセレクタが壊れる | `selectors.ts` に集約。起動 30 秒以内に 1 件も取れなければ `console.warn` を 1 回出し、設定画面にも「取得できていない」バッジを出す |
| ライブと VOD で同一発言が二重登録 | 3.3 の近傍チェック（±2 秒、同 user/channel/text） |
| VOD 開始日時が取れない | `ts = capturedAt` にフォールバックし、UI 上で「VOD（日時推定不可）」表記 |
| 大量データで prune が重い | 5,000 件チャンク + yield。SW はユーザー操作をブロックしない |
| 他人の発言を長期保存することへの配慮 | 自分用ツールとして配布しない前提。README に目的と「外部送信なし」を明記 |

---

## 12. 将来拡張（本バージョンではやらない）

- 外部ログサーバー（rustlog 互換 API）との併用表示
- エモート画像の描画（7TV / FFZ / BTTV 含む）
- 「このユーザーの発言があったら通知」
- Firefox 対応
