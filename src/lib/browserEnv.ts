/**
 * Embedded / in-app browser detection.
 *
 * Google's OAuth ("Use secure browsers" policy) refuses to run inside an embedded
 * webview and returns `Error 403: disallowed_useragent`. That is what social-app
 * in-app browsers are — when a user opens our link from inside the LinkedIn,
 * Instagram, Facebook, etc. apps, the page runs in a flagged webview and the
 * "Continue with Google" button dead-ends on Google's block screen. Real
 * Safari/Chrome/Firefox (desktop OR mobile) are unaffected, which is why this only
 * bites "some people on mobile".
 *
 * We can't make Google allow it, so we detect the situation and steer the user to
 * open the page in a real browser (or use email sign-in, which still works). This
 * is deliberately conservative: a false positive only downgrades the Google button
 * to a hint, and email sign-in is always available.
 */

/** Named in-app webview tokens (lowercased user-agent substrings). */
const IN_APP_TOKENS = [
  'fban',
  'fbav',
  'fb_iab',
  'fbios', // Facebook / Messenger
  'instagram',
  'linkedinapp',
  'linkedin',
  'threads',
  'tiktok',
  'musical_ly',
  'bytedance', // TikTok
  'snapchat',
  'pinterest',
  'micromessenger', // WeChat
  'line/', // LINE
  'twitter', // X / Twitter in-app
  'kakaotalk',
];

/**
 * True when the current page is running inside an embedded / in-app webview where
 * Google OAuth is blocked. Pass an explicit UA for testing; defaults to the live
 * `navigator.userAgent`.
 */
export function isEmbeddedBrowser(ua?: string): boolean {
  const raw = ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const s = raw.toLowerCase();
  if (!s) return false;

  if (IN_APP_TOKENS.some((t) => s.includes(t))) return true;

  // Android System WebView carries a bare "; wv" token.
  if (/;\s*wv\b/.test(s) || /\bwv\)/.test(s)) return true;

  // iOS in-app webviews (WKWebView) look like Safari's engine but lack the
  // "Safari" product token that real Mobile Safari always includes; the branded
  // third-party iOS browsers (Chrome/Firefox/Edge) carry their own tokens.
  const ios = /iphone|ipad|ipod/.test(s);
  if (ios && !/safari/.test(s) && !/crios|fxios|edgios|opios/.test(s)) return true;

  return false;
}
