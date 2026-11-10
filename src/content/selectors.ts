/**
 * Twitch DOM セレクタ定義。拡張全体で Twitch の DOM 構造に依存する箇所はここだけ。
 * Twitch 側の変更で壊れたらこのファイルだけ直す。
 *
 * 2026-11 時点の実 DOM で確認済み。
 *
 * ライブ:
 * - 行:   div.chat-line__message[data-a-target="chat-line-message"][data-a-user="<login>"]
 *          ※ 行はクラスなしの div でラップされてコンテナ直下に追加される
 * - 名前: span.chat-author__display-name[data-a-target="chat-message-username"] (style="color: ...")
 * - 本文: [data-a-target="chat-line-message-body"] 配下。テキストは span.text-fragment、
 *          エモートは img.chat-line__message--emote[alt="<emote名>"]
 * - メッセージ ID: DOM 上に存在しない(data-a-msg-id 等は 0 件) → 内容ハッシュで代替
 *
 * VOD(チャットリプレイ):
 * - コンテナ: .video-chat__message-list-wrapper ul(シークしても同じ要素が使い回される)
 * - 行:   li > .vod-message。ヘッダ .vod-message__header に再生位置(m:ss / h:mm:ss)
 * - 名前: span.chat-author__display-name[data-a-user="<login>"](a[href="/<login>"] の中)
 * - 本文: .video-chat__message。先頭に区切りの ":" だけの span がある
 * - 配信開始日時: 実行時の DOM には ld+json が無い。SSR の HTML(同じ URL を fetch)には
 *   VideoObject.uploadDate がある
 * - チャンネル: プレイヤー下の .metadata-layout__support 内のチャンネルリンク href
 *
 * 純正ビューワーカード: [data-a-target="chat-user-card"] レイヤー内に [data-a-target="viewer-card"](幅 340px)。
 * ドラッグ可能で、位置は [data-a-target="viewer-card-position"] の style(top/left)で決まる
 */
export const SELECTORS = {
  live: {
    chatContainer: '.chat-scrollable-area__message-container',
    chatLine: '.chat-line__message[data-a-user]',
    /** 行自身 or 内包要素の属性名。現状の Twitch では存在しないが、復活に備えて残す */
    msgIdAttr: 'data-a-msg-id',
    userLoginAttr: 'data-a-user',
    displayName: '.chat-author__display-name',
    body: '[data-a-target="chat-line-message-body"]',
    emoteImg: 'img.chat-line__message--emote',
    badgeImg: 'img.chat-badge',
    timestamp: '.chat-line__timestamp',
    /** 「ようこそ」などのシステム行。自己診断でチャット行に数えない */
    statusLine: '.chat-line__status',
  },
  vod: {
    chatContainer: '.video-chat__message-list-wrapper ul',
    chatLine: '.vod-message',
    /** login は名前 span の属性にある(行要素には無い) */
    userLoginAttr: 'data-a-user',
    displayName: '.chat-author__display-name',
    body: '.video-chat__message',
    /** VOD のエモート画像クラスは未確認のため alt 付き img を広く拾う */
    emoteImg: 'img[alt]',
    badgeImg: 'img.chat-badge',
    /** この要素のテキストから m:ss / h:mm:ss を読む */
    timestamp: '.vod-message__header',
    /** 動画情報欄のチャンネルリンク */
    channelLink: '.metadata-layout__display-name-spacing a[href^="/"], .metadata-layout__support a[href^="/"]',
    ldJson: 'script[type="application/ld+json"]',
  },
  usernameClickTarget: '.chat-author__display-name',
  /** Twitch 純正のビューワーカード。ポップオーバーの位置合わせと閉じる検知に使う */
  viewerCard: {
    /** カードが挿入される常設のレイヤー(カードが閉じていても存在する) */
    layer: '[data-a-target="chat-user-card"], .viewer-card-layer',
    /** カード本体。閉じると DOM から消える */
    card: '[data-a-target="viewer-card"]',
    /** ドラッグで top/left の style が変わる要素 */
    draggable: '[data-a-target="viewer-card-position"]',
  },
} as const;

export type LiveSelectors = typeof SELECTORS.live;
export type VodSelectors = typeof SELECTORS.vod;
