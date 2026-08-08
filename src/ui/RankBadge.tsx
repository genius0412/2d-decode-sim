import { standingFor, type Standing } from '../ranks';
import { PLACEMENT_GAMES } from '../config';

/**
 * The visible STANDING — a named tier, its division, and how far through it you are.
 *
 * One component in three sizes rather than three components, because the whole point is that
 * a player recognises their rank instantly wherever it appears: the same shield and the same
 * words on the results screen, the career panel and a public profile. Three lookalikes that
 * drifted apart would defeat it.
 *
 * The shield is drawn from the tier's own accent (`RankTier.varName`), so a tier is
 * identifiable by colour before the label is read — but the label is ALWAYS present. Colour
 * alone would leave the ladder unreadable to a colourblind player, and these six accents
 * include the red/green pair most likely to collide.
 */
export function RankBadge({
  rating,
  games,
  size = 'md',
  showProgress = true,
  className = '',
}: {
  rating: number;
  games: number;
  size?: 'sm' | 'md' | 'lg';
  /** hide the bar where there is no room for it (a table cell, an inline chip) */
  showProgress?: boolean;
  className?: string;
}) {
  const s = standingFor(rating, games);
  return (
    <div className={`ds-rank ${size} ${className}`} data-tier={s.tier.key}>
      <RankShield standing={s} />
      <div className="ds-rank-col">
        <span className="ds-rank-label">{s.label}</span>
        <span className="ds-rank-sub">{subtitle(s)}</span>
        {showProgress && (
          <span className="ds-rank-bar" aria-hidden>
            <span className="ds-rank-fill" style={{ width: `${Math.round(s.progress * 100)}%` }} />
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The tier mark on its own — for a table cell or a name row, where a full badge would not
 * fit. Still carries a `title`, so the tier is nameable on hover rather than being a
 * decoration only the initiated can read.
 */
export function RankPip({ rating, games }: { rating: number; games: number }) {
  const s = standingFor(rating, games);
  return (
    <span className={`ds-rank-pip`} data-tier={s.tier.key} title={s.label}>
      {s.tier.name.charAt(0)}
      {s.division > 0 ? <sub>{s.division}</sub> : null}
    </span>
  );
}

/**
 * What sits under the tier name.
 *
 * In PLACEMENTS it counts games, because games played is literally what stands between the
 * player and a rank — showing a rating there would be showing a number that is still moving
 * ±50–160 a match. Everywhere else it is the rating plus the gap to the next step, which is
 * the question a player on a ladder is actually asking.
 */
function subtitle(s: Standing): string {
  if (s.placement) {
    const left = Math.max(0, PLACEMENT_GAMES - s.played);
    return `${left} placement ${left === 1 ? 'match' : 'matches'} to go`;
  }
  if (s.toNext === null) return `${s.rating} · top tier`;
  return `${s.rating} · ${s.toNext} to next`;
}

/** the shield itself: a filled chevron carrying the tier initial + division pips. Inline SVG
 *  so it scales with the badge and inherits the tier accent through `currentColor`. */
function RankShield({ standing }: { standing: Standing }) {
  const { tier, division, placement } = standing;
  return (
    <svg className="ds-rank-shield" viewBox="0 0 32 36" role="img" aria-label={standing.label}>
      <path
        d="M16 1 L30 7 V19 C30 27 24 32 16 35 C8 32 2 27 2 19 V7 Z"
        className="ds-rank-shield-fill"
      />
      <path
        d="M16 1 L30 7 V19 C30 27 24 32 16 35 C8 32 2 27 2 19 V7 Z"
        className="ds-rank-shield-edge"
        fill="none"
      />
      <text x="16" y="21" textAnchor="middle" className="ds-rank-shield-ch">
        {placement ? '?' : tier.name.charAt(0)}
      </text>
      {/* division pips — I is one pip, III is three, so the division reads without the label */}
      {division > 0 &&
        Array.from({ length: division }, (_, i) => (
          <circle key={i} cx={16 + (i - (division - 1) / 2) * 5} cy={28} r={1.6} className="ds-rank-pipdot" />
        ))}
    </svg>
  );
}
