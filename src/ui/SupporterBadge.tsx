/**
 * The supporter badge — the visible half of the membership.
 *
 * One component, used everywhere a player's name appears (leaderboards, public
 * profiles, the lobby roster, in-match labels), so the badge cannot end up
 * meaning slightly different things in different places.
 *
 * It is deliberately SMALL and quiet. A paid badge that shouts is a badge that
 * makes the leaderboard look pay-to-win, and the whole tier rests on the promise
 * — stated in the terms — that supporters get nothing that affects driving or
 * scoring. Looking like an advantage is nearly as bad as being one.
 *
 * Every prop is optional-tolerant: `supporter` arrives as `undefined` from a
 * server older than the perk, which must render exactly like `false` rather than
 * like a missing field somewhere upstream.
 */
export function SupporterBadge({
  supporter,
  size = 'sm',
}: {
  supporter?: boolean;
  /** `sm` inline beside a name; `md` on a profile header */
  size?: 'sm' | 'md';
}) {
  if (!supporter) return null;
  return (
    <span
      className={`sup-badge ${size}`}
      title="Supporter — helps pay for the servers"
      // The title carries the meaning for a mouse; screen readers get the same
      // sentence as text. `aria-hidden` on the glyph keeps it from being read as
      // a bare heart with no context.
      aria-label="Supporter"
      role="img"
    >
      <span aria-hidden="true">♥</span>
    </span>
  );
}
