import { useState } from 'react';
import { APP_NAME } from '../seasons';

/**
 * Share a player's PUBLIC profile link (`/profile/<username>`). Uses the native
 * share sheet where available (mobile / some desktops), else copies the URL to the
 * clipboard with transient "Copied!" feedback. Renders nothing without a username
 * (a legacy account that hasn't picked one has no public URL to share).
 */
export function ShareButton({
  username,
  label = 'Share',
}: {
  username: string | null | undefined;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!username) return null;

  const url =
    (typeof window !== 'undefined' ? window.location.origin : '') +
    `/profile/${encodeURIComponent(username)}`;

  const onClick = async (): Promise<void> => {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    // Prefer the native share sheet; fall back to clipboard. A user-cancelled
    // share (AbortError) is a no-op, not an error.
    if (nav && typeof nav.share === 'function') {
      try {
        await nav.share({ title: `@${username} · ${APP_NAME}`, url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // fall through to clipboard
      }
    }
    try {
      await nav?.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // last-ditch: select nothing, just surface the URL
      window.prompt('Copy this profile link:', url);
    }
  };

  return (
    <button className="ds-btn ghost ds-share" onClick={onClick} title={`Share @${username}`}>
      {copied ? 'Link copied ✓' : `${label} ↗`}
    </button>
  );
}
