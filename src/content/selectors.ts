/**
 * Twitch DOM セレクタ定義。拡張全体で Twitch の DOM 構造に依存する箇所はここだけ。
 * Twitch 側の変更で壊れたらこのファイルだけ直す。
 *
 * 2026-11 時点の実 DOM で確認済み(ライブ)。
 * - 行:   div.chat-line__message[data-a-target="chat-line-message"][data-a-user="<login>"]
 *          ※ 行はクラスなしの div でラップされてコンテナ直下に追加される
 * - 名前: span.chat-author__display-name[data-a-target="chat-message-username"] (style="color: ...")
 * - 本文: [data-a-target="chat-line-message-body"] 配下。テキストは span.text-fragment、
 *          エモートは img.chat-line__message--emote[alt="<emote名>"]
 * - メッセージ ID: DOM 上に存在しない(data-a-msg-id 等は 0 件) → 内容ハッシュで代替
 * - 純正ビューワーカード: [data-a-target="chat-user-card"] レイヤー内に [data-a-target="viewer-card"](幅 340px)。
 *   ドラッグ可能で、位置は [data-a-target="viewer-card-position"] の style(top/left)で決まる
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
  },
  vod: {
    chatContainer: '.video-chat__message-list-wrapper ul',
    chatLine: '.video-chat__message',
    userLoginAttr: 'data-a-user',
    displayName: '.video-chat__message-author',
    body: '[data-a-target="chat-line-message-body"]',
    emoteImg: 'img.chat-line__message--emote, img.chat-image',
    badgeImg: 'img.chat-badge',
    timestamp: '.video-chat__message-timestamp',
  },
  usernameClickTarget: '.chat-author__display-name, .video-chat__message-author',
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
