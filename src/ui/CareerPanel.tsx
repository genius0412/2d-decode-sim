import { type ReactNode } from 'react';
import { type UserStats } from '../net/api';
import { SupporterBadge } from './SupporterBadge';
import { averageMatch, playtimeLong, playtimeText } from '../playtime';

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
        <div className="ds-panel-body stack">
          {/* PLAYTIME + GAMES PLAYED. Lifetime, not season-scoped like the tiles below —
              "how much have I played" is a question about the account, and an answer that
              reset every season would be meaningless exactly when it got interesting. Hidden
              entirely on a server that doesn't track it yet, rather than printing zeros. */}
          {stats.activity && (
            <div className="ds-stats">
              <div className="ds-stat">
                <span className="sv">{stats.activity.games}</span>
                <span className="sl">GAMES PLAYED</span>
                <span className="sl" title={playtimeLong({ games: stats.activity.allGames, seconds: stats.activity.allSeconds })}>
                  {stats.activity.allGames !== stats.activity.games
                    ? `${stats.activity.allGames} across all games`
                    : 'all time'}
                </span>
              </div>
              <div className="ds-stat">
                <span className="sv">{playtimeText(stats.activity.seconds)}</span>
                <span className="sl">PLAYTIME</span>
                <span className="sl">
                  {stats.activity.games > 0
                    ? `~${playtimeText(averageMatch({ games: stats.activity.games, seconds: stats.activity.seconds }))} a match`
                    : ''}
                </span>
              </div>
            </div>
          )}
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
              <span className="sl">{winPct != null ? `${winPct}% win` : ''}</span>
            </div>
          </div>
        </div>
      )}

      {/* the panel's EMPTY state, in the same anatomy as the five other lists on
          these screens (`.ds-empty` + a `.big` headline) rather than as a stray
          hint paragraph. A sibling of the body, not a child of it, so it is inset
          by its own padding instead of by the body's as well. */}
      {status === 'ok' && stats && stats.match.played === 0 && solo?.best == null && duo?.best == null && (
        <div className="ds-empty">
          <div className="big">
            {archived ? 'No games were played this period' : 'No games played yet this period'}
          </div>
        </div>
      )}
    </div>
  );
}
