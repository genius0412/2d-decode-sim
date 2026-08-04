import { type ReactNode } from 'react';
import { type UserStats } from '../net/api';
import { SupporterBadge } from './SupporterBadge';

/**
 * The competitive-stats panel shared by "My Stats" (own account) and the public
 * `/profile/<username>` page: overall 1v1/2v2 ELO + rank, solo/duo record bests +
 * rank, ranked W–L, and recent match history. Purely presentational — the caller
 * (a `CareerView`) fetches the `UserStats` for the selected period and passes the
 * resolved "Act X · Season Y" label. `name` is the chip shown in the panel header;
 * `archived` marks a PAST period, whose numbers are that season's FINAL standings.
 */
export function CareerPanel({
  stats,
  status,
  error,
  name,
  seasonLabel,
  archived,
  headerAction,
}: {
  stats: UserStats | null;
  status: 'loading' | 'ok' | 'error';
  error?: string;
  name: string;
  /** "Act X · Season Y" label for the selected period */
  seasonLabel: string;
  /** true when viewing a past period ⇒ these are the season's final stats */
  archived?: boolean;
  /** optional control rendered in the panel header (e.g. a Share button) */
  headerAction?: ReactNode;
}) {
  const elo1 = stats?.elo.find((e) => e.mode === '1v1');
  const elo2 = stats?.elo.find((e) => e.mode === '2v2');
  const solo = stats?.records.find((r) => r.mode === 'solo');
  const duo = stats?.records.find((r) => r.mode === 'duo');
  const rankTag = (rank: number | null): string => (rank ? `Rank #${rank}` : 'Unranked');
  const winPct =
    stats && stats.match.played > 0 ? Math.round((stats.match.wins / stats.match.played) * 100) : null;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">
          {seasonLabel} · {archived ? 'Final' : 'Overall'}
        </span>
        {archived && <span className="ds-dt lb-you-tag">FINAL</span>}
        <span className="ds-head-spacer" />
        {/* the name chip is the ONLY place "My Stats" prints who you are — the
            public profile has a header for it, Career does not — so this is where
            a player sees their own badge. `stats` may still be loading; the badge
            simply appears with the rest. */}
        <span className="ds-chip">
          <b>{name}</b>
          <SupporterBadge supporter={stats?.supporter} role={stats?.role} />
        </span>
        {headerAction}
      </div>

      {status === 'loading' && <div className="ds-loading">Loading…</div>}
      {status === 'error' && (
        <div className="ds-empty">
          <div className="big">Couldn’t load stats</div>
          {error}
        </div>
      )}

      {status === 'ok' && stats && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="ds-stats">
            <div className="ds-stat">
              <span className="sv">{elo1?.rating ?? 1000}</span>
              <span className="sl">1V1 ELO</span>
              <span className="sl">
                {rankTag(elo1?.rank ?? null)} · {elo1?.games ?? 0} games
              </span>
            </div>
            <div className="ds-stat">
              <span className="sv">{elo2?.rating ?? 1000}</span>
              <span className="sl">2V2 ELO</span>
              <span className="sl">
                {rankTag(elo2?.rank ?? null)} · {elo2?.games ?? 0} games
              </span>
            </div>
            <div className="ds-stat">
              <span className="sv">{solo?.best ?? '-'}</span>
              <span className="sl">Solo best</span>
              <span className="sl">{rankTag(solo?.rank ?? null)}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{duo?.best ?? '-'}</span>
              <span className="sl">Duo best</span>
              <span className="sl">{rankTag(duo?.rank ?? null)}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">
                {stats.match.wins}–{stats.match.losses}
              </span>
              <span className="sl">Ranked W–L</span>
              <span className="sl">{winPct != null ? `${winPct}% win` : 'no matches'}</span>
            </div>
          </div>

          {stats.match.played === 0 && solo?.best == null && duo?.best == null && (
            <p className="ds-hint">
              {archived ? 'No games were played this period.' : 'No games played yet this period.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
