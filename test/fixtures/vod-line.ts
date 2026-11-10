/** 2026-11 時点の VOD チャットリプレイ行(li)の HTML スナップショット。ハッシュクラスは除去 */

export const VOD_PLAIN = `
<li>
  <div class="vod-message">
    <div class="vod-message__header">
      <div><div><button><div><p class="CoreText-sc-1txzju1-0">10:19</p></div></button></div></div>
    </div>
    <div>
      <div>
        <div>
          <span></span>
          <a class="tw-link" data-tt_content="tab_videos" data-tt_medium="video-message-author" href="/sample_viewer">
            <span><span class="chat-author__display-name" data-a-target="chat-message-username" data-a-user="sample_viewer" data-test-selector="message-username" style="color: rgb(0, 128, 0);">sample_viewer</span></span>
          </a>
          <div class="video-chat__message">
            <span>:</span>
            <span><span class="text-fragment" data-a-target="chat-message-text">これはテスト用のコメントです</span></span>
          </div>
        </div>
        <div class="video-chat__message-menu"><div><div><button aria-label="その他のオプション"></button></div></div></div>
      </div>
    </div>
  </div>
</li>`;

export const VOD_WITH_EMOTE_AND_HOURS = `
<li>
  <div class="vod-message">
    <div class="vod-message__header"><div><div><button><div><p>1:02:05</p></div></button></div></div></div>
    <div><div><div>
      <span></span>
      <a class="tw-link" href="/someone">
        <span><span class="chat-author__display-name" data-a-user="someone">Someone</span><span class="chat-author__intl-login"> (someone)</span></span>
      </a>
      <div class="video-chat__message">
        <span>:</span>
        <span>
          <span class="text-fragment" data-a-target="chat-message-text">gg </span>
          <span data-a-target="emote-name"><img class="chat-image chat-line__message--emote" alt="Kappa" src="https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0"></span>
        </span>
      </div>
    </div></div></div>
  </div>
</li>`;

/** 本文が ":" だけ(区切りの後に何も無い) */
export const VOD_EMPTY = `
<li><div class="vod-message">
  <div class="vod-message__header"><p>0:05</p></div>
  <span class="chat-author__display-name" data-a-user="x">x</span>
  <div class="video-chat__message"><span>:</span><span></span></div>
</div></li>`;

/** SSR HTML に含まれる ld+json(実物を短縮) */
export const VOD_SSR_HTML = `<!DOCTYPE html><html><head><title>x</title>
<script type="application/ld+json">{"@context":"http://schema.org","@graph":[{"@type":"VideoObject","description":"sample_streamerさんがTwitchで配信を開始しました。","embedUrl":"https://www.twitch.tv/videos/1234567890","name":"Twitchで配信中のサンプル配信タイトル - sample_streamer","thumbnailUrl":["https://example.invalid/thumb0.jpg"],"uploadDate":"2026-11-08T01:00:40Z","duration":"PT9581S"}]}</script>
</head><body></body></html>`;
