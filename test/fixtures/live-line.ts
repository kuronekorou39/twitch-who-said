/**
 * 2026-11 時点の Twitch ライブチャット行の HTML スナップショット(styled-components のハッシュクラスは除去)。
 * 実 DOM から構造だけを写したもの。
 */

/** プレーンテキストのみ */
export const LIVE_PLAIN = `
<div class="Layout-sc-1xcs6mc-0">
  <div class="chat-line__message" role="group" aria-label="someuser: こんばんは" tabindex="0" data-a-target="chat-line-message" data-a-user="someuser">
    <div class="Layout-sc-1xcs6mc-0">
      <div class="Layout-sc-1xcs6mc-0 chat-line__message-highlight"></div>
      <div class="Layout-sc-1xcs6mc-0 chat-line__message-container">
        <div class="Layout-sc-1xcs6mc-0"></div>
        <div class="Layout-sc-1xcs6mc-0">
          <div class="Layout-sc-1xcs6mc-0 chat-line__no-background">
            <div class="Layout-sc-1xcs6mc-0">
              <div class="Layout-sc-1xcs6mc-0 chat-line__username-container chat-line__username-container--hoverable">
                <span>
                  <div class="InjectLayout-sc-1i43xsx-0"><button data-a-target="chat-badge"><img class="chat-badge" alt="サブスクライバー" src="https://static-cdn.jtvnw.net/badges/v1/x/1"></button></div>
                </span>
                <span class="chat-line__username" role="button" tabindex="0">
                  <span>
                    <span class="chat-author__display-name" data-a-target="chat-message-username" data-a-user="someuser" data-test-selector="message-username" style="color: rgb(220, 0, 0);">SomeUser</span>
                  </span>
                </span>
              </div>
              <span aria-hidden="true">: </span>
              <span data-a-target="chat-line-message-body" dir="auto">
                <span class="text-fragment" data-a-target="chat-message-text">こんばんは</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;

/** エモート混在(テキスト → エモート → テキスト → エモート) */
export const LIVE_WITH_EMOTES = `
<div class="Layout-sc-1xcs6mc-0">
  <div class="chat-line__message" role="group" aria-label="sample_chatter: YappingDuck hello YappingDuck" tabindex="0" data-a-target="chat-line-message" data-a-user="sample_chatter">
    <div class="Layout-sc-1xcs6mc-0 chat-line__message-container">
      <div class="Layout-sc-1xcs6mc-0 chat-line__no-background">
        <div class="Layout-sc-1xcs6mc-0 chat-line__username-container chat-line__username-container--hoverable">
          <span class="chat-line__username" role="button" tabindex="0"><span><span class="chat-author__display-name" data-a-target="chat-message-username" data-a-user="sample_chatter" style="color: rgb(182, 66, 24);">sample_chatter</span></span></span>
        </div>
        <span aria-hidden="true">: </span>
        <span data-a-target="chat-line-message-body" dir="auto">
          <span class="chat-line__message--emote-button" data-test-selector="emote-button" data-a-target="emote-name">
            <div class="Layout-sc-1xcs6mc-0"><div class="Layout-sc-1xcs6mc-0"><button class="ScInteractableBase-sc-ofisyf-0"><div class="Layout-sc-1xcs6mc-0"><img class="image--MU1mU chat-line__message--emote" alt="YappingDuck" src="https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/1.0"></div></button></div></div>
          </span>
          <span class="text-fragment" data-a-target="chat-message-text"> hello </span>
          <span class="chat-line__message--emote-button" data-test-selector="emote-button" data-a-target="emote-name">
            <div class="Layout-sc-1xcs6mc-0"><button class="ScInteractableBase-sc-ofisyf-0"><img class="image--MU1mU chat-line__message--emote" alt="YappingDuck" src="https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/1.0"></button></div>
          </span>
        </span>
      </div>
    </div>
  </div>
</div>`;

/** メンション・リンクを含む(フラグメント種別が増えてもテキストノードで拾えることの確認) */
export const LIVE_WITH_MENTION_LINK = `
<div class="chat-line__message" role="group" tabindex="0" data-a-target="chat-line-message" data-a-user="replier">
  <div class="chat-line__message-container">
    <span class="chat-line__username" role="button"><span><span class="chat-author__display-name" data-a-target="chat-message-username" data-a-user="replier">Replier</span></span></span>
    <span aria-hidden="true">: </span>
    <span data-a-target="chat-line-message-body" dir="auto">
      <span class="mention-fragment mention-fragment--recipient">@SomeUser</span>
      <span class="text-fragment" data-a-target="chat-message-text"> see </span>
      <a class="link-fragment" href="https://example.com/x" target="_blank" rel="noreferrer">https://example.com/x</a>
    </span>
  </div>
</div>`;

/** data-a-user がない(システム行など)。抽出は null になるべき */
export const LIVE_NO_USER = `
<div class="chat-line__message" role="group" tabindex="0" data-a-target="chat-line-message">
  <span data-a-target="chat-line-message-body">system text</span>
</div>`;

/** 本文が空(エモート alt もなし) */
export const LIVE_EMPTY_BODY = `
<div class="chat-line__message" data-a-target="chat-line-message" data-a-user="empty">
  <span class="chat-author__display-name" data-a-target="chat-message-username">Empty</span>
  <span data-a-target="chat-line-message-body"><span class="text-fragment">   </span></span>
</div>`;

/** msg-id 属性が復活した場合の想定 */
export const LIVE_WITH_MSG_ID = `
<div class="chat-line__message" data-a-target="chat-line-message" data-a-user="withid" data-a-msg-id="abc-123">
  <span class="chat-author__display-name" data-a-target="chat-message-username">WithId</span>
  <span data-a-target="chat-line-message-body"><span class="text-fragment">hi</span></span>
</div>`;
