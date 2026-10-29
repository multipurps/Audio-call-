// Emysa's TikTok account, and the creator embed that shows its videos inside the app (for tutorials).
//
// TikTok's own embed code is a <blockquote class="tiktok-embed"> plus <script src=".../embed.js">.
// Loading that script on every start would send every visitor to TikTok, so it is loaded only when
// someone opens the TikTok page, and only once. If the script is blocked (offline, a content
// blocker), the blockquote still reads as a plain link to the account.

export const TIKTOK_HANDLE = 'emysacall';
export const TIKTOK_URL = `https://www.tiktok.com/@${TIKTOK_HANDLE}`;
export const TIKTOK_EMBED_SRC = 'https://www.tiktok.com/embed.js';

// The creator embed, exactly as TikTok issues it for this account.
export function creatorEmbedHtml(handle = TIKTOK_HANDLE) {
  const url = `https://www.tiktok.com/@${handle}`;
  return `<blockquote class="tiktok-embed" cite="${url}" data-unique-id="${handle}" data-embed-type="creator" style="max-width: 780px; min-width: 288px;"><section><a target="_blank" rel="noopener" href="${url}?refer=creator_embed">@${handle}</a></section></blockquote>`;
}

// Put the embed into `container` and load TikTok's script after it. Safe to call again: the
// second call changes nothing. Returns true when it set the embed up, false when it was already there.
export function mountCreatorEmbed(container, { handle = TIKTOK_HANDLE, doc = container.ownerDocument } = {}) {
  if (container.querySelector('blockquote.tiktok-embed')) return false;
  container.innerHTML = creatorEmbedHtml(handle);
  const script = doc.createElement('script');
  script.async = true;
  script.src = TIKTOK_EMBED_SRC;
  container.append(script);
  return true;
}
