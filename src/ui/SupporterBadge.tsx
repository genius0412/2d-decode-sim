import type { StaffRole } from '../net/protocol';

export type { StaffRole };

/**
 * The badge beside a player's name — supporter, admin, or owner.
 *
 * ONE component for all three, used everywhere a name appears (leaderboards,
 * public profiles, the lobby roster, in-match labels), so a badge cannot end up
 * meaning slightly different things in different places.
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
  supporter?: boolean;
  role?: StaffRole;
  /** `sm` inline beside a name; `md` on a profile header */
  size?: 'sm' | 'md';
}) {
  const kind = role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : supporter ? 'supporter' : null;
  if (!kind) return null;
  // The title carries the meaning for a mouse; screen readers get `aria-label`.
  // `aria-hidden` on the glyph keeps it from being read as a bare symbol with no
  // context.
  const { glyph, label, title } = BADGES[kind];
  return (
    <span className={`sup-badge ${kind} ${size}`} title={title} aria-label={label} role="img">
      <span aria-hidden="true">{glyph}</span>
    </span>
  );
}

/** Glyphs are plain text, never emoji: an emoji carries its own colour, which
 *  would ignore the themed fill and break the contrast pair the audit checks. */
const BADGES = {
  owner: { glyph: '★', label: 'Owner', title: 'Owner - builds and runs DSIM' },
  admin: { glyph: '◆', label: 'Admin', title: 'Admin - helps run DSIM' },
  supporter: { glyph: '♥', label: 'Supporter', title: 'Supporter - helps pay for the servers' },
} as const;
