import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StaffRole } from '../net/protocol';

export type { StaffRole };

/**
 * The badge beside a player's name — supporter, admin, or owner.
 *
 * ONE component for all three, used everywhere a name appears (leaderboards,
 * public profiles, the lobby roster), so a badge cannot end up meaning slightly
 * different things in different places.
 *
 * EXACTLY ONE badge renders, in rank order: owner > admin > supporter. Staff are
 * entitled to supporter perks (the server folds the role into the supporter
 * predicate, so `supporter` arrives true for them), which means without this
 * precedence every admin would wear two badges saying overlapping things. The
 * staff badge is the more specific claim, so it wins.
 *
 * All three are deliberately SMALL and quiet. A badge that shouts makes the
 * leaderboard look pay-to-win, and the tier rests on the promise — stated in the
 * terms — that supporters get nothing affecting driving or scoring. Looking like
 * an advantage is nearly as bad as being one, and that goes double for a badge
 * that says the holder runs the place.
 *
 * Every prop is optional-tolerant: both arrive as `undefined` from a server older
 * than the feature, which must render exactly like "no badge" rather than like a
 * missing field somewhere upstream.
 */
export function SupporterBadge({
  supporter,
  role,
  size = 'sm',
}: {
  /** `null` is accepted alongside `undefined` because these come straight off a
   * SQL row, where "no role" is a NULL column rather than a missing key. */
  supporter?: boolean | null;
  role?: StaffRole | null;
  /** `sm` inline beside a name; `md` on a profile header. Rendered as
   * `sup-sm`/`sup-md`, NOT as bare `sm`/`md` — `.md` is already the
   * rendered-Markdown class (announcement bodies), and a bare `md` here silently
   * inherited its 13.5px font-size AND its `--ds-ink-dim` colour, which is why
   * the profile-header badge came out a third of its intended size. */
  size?: 'sm' | 'md';
}) {
  const kind = role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : supporter ? 'supporter' : null;
  const ref = useRef<HTMLSpanElement>(null);
  // viewport coords of the hovered badge; null = no tip on screen
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  // A tip anchored to a viewport position goes stale the moment anything scrolls,
  // and `.ds-app` — not the window — is the scroll container, so this listens in
  // the CAPTURE phase to catch scrolls on any ancestor. Only ever armed while a
  // tip is actually showing.
  useEffect(() => {
    if (!tip) return;
    const hide = (): void => setTip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [tip]);

  if (!kind) return null;
  const { label, title, glyph } = BADGES[kind];

  const show = (e: React.PointerEvent): void => {
    // Mouse only. On touch, `pointerenter` fires on tap and there is no matching
    // leave, so a tapped badge would leave its tip stranded on screen.
    if (e.pointerType !== 'mouse') return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ x: r.left + r.width / 2, y: r.top });
  };

  return (
    <>
      <span
        ref={ref}
        className={`sup-badge ${kind} sup-${size}`}
        aria-label={label}
        role="img"
        onPointerEnter={show}
        onPointerLeave={() => setTip(null)}
      >
        {glyph}
      </span>
      {tip &&
        createPortal(
          // PORTALLED to <body> and `position: fixed` because the badge lives
          // inside `.ds-panel`, which is `overflow: hidden` for its rounded
          // corners — a tip positioned within that subtree is simply clipped away
          // on the top row of every leaderboard. Fixed + portal escapes it.
          <span className="sup-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            {title}
          </span>,
          document.body,
        )}
    </>
  );
}

/**
 * Inline SVG, not text glyphs.
 *
 * The first cut used ♥ / ◆ / ★ characters and they were wrong in three ways at
 * once: the shape's size and its position inside the disc are decided by the
 * FONT's metrics (so the star sat high and the heart overflowed the circle), a
 * glyph is drawn on the text baseline rather than centred, and ◆ is not in every
 * font — a fallback would silently change the badge's look per platform.
 *
 * Each path is drawn in a 24×24 box centred on (12,12), so centring is geometry
 * rather than a per-glyph nudge, and the size is a fixed fraction of the disc.
 */
const BADGES = {
  owner: {
    label: 'Owner',
    title: 'Owner · builds and runs DSIM',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 4 L14 9.25 L19.61 9.53 L15.23 13.05 L16.7 18.47 L12 15.4 L7.3 18.47 L8.77 13.05 L4.39 9.53 L10 9.25 Z" />
      </svg>
    ),
  },
  admin: {
    label: 'Admin',
    title: 'Admin · helps run DSIM',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3.5 L20.5 12 L12 20.5 L3.5 12 Z" />
      </svg>
    ),
  },
  supporter: {
    label: 'Supporter',
    title: 'Supporter · helps pay for the servers',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 20.2 C12 20.2 3.6 14.6 3.6 9.3 C3.6 6.4 5.9 4.2 8.6 4.2 C10.2 4.2 11.4 5 12 5.9 C12.6 5 13.8 4.2 15.4 4.2 C18.1 4.2 20.4 6.4 20.4 9.3 C20.4 14.6 12 20.2 12 20.2 Z" />
      </svg>
    ),
  },
} as const;
