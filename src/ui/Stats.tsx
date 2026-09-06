import { useCallback } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { fetchUserStats, fetchUserMatches, type MatchHistoryOpts } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { authEnabled, authClient } from '../lib/authClient';
import { CareerView } from './CareerView';
import { ShareButton } from './ShareButton';
import { StandingCard } from './StandingCard';
import { PracticeReplays } from './PracticeReplays';

export interface CareerNav {
  onWatch?: (replayId: string) => void;
  /** watch a replay this DEVICE holds (a local practice run) — handed over as the log itself,
   *  since there is no server id to fetch it by */
  onWatchLocal?: (replay: Replay) => void;
  onOpenProfile?: (username: string) => void;
  /** which game's boards to show (DECODE default) — its own periods/records */
  game?: GameId;
}

/**
 * My Stats — a signed-in player's competitive profile. A single Act/Season period
 * picker (in `CareerView`) drives both the stats panel and the match history, so a
 * player can review a PAST season's final standings and matches. Ranks are computed
 * server-side, so the client never pulls a full leaderboard. Auth is a stable
 * module constant, so the early return before hooks is safe.
 */
export function Stats(nav: CareerNav = {}) {
  if (!authEnabled) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Accounts are off in this build</div>
            Set <code>VITE_NEON_AUTH_URL</code> to sign in and track ELO, records, and match history.
          </div>
        </div>
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }
  return <StatsSignedIn nav={nav} />;
}

function StatsSignedIn({ nav }: { nav: CareerNav }) {
  const session = authClient!.useSession();
  const user = session.data?.user;
  const userId = user?.id;
  const configured = gameServerConfigured();

  const game = nav.game;
  const loadStats = useCallback(
    (season?: number) => fetchUserStats(userId!, season, game),
    [userId, game],
  );
  const fetchPage = useCallback(
    (opts: MatchHistoryOpts) => fetchUserMatches(userId!, { ...opts, game }),
    [userId, game],
  );

  if (session.isPending) {
    return (
      <div className="ds-panel">
        <div className="ds-loading">Loading…</div>
      </div>
    );
  }

  /**
   * SIGNED OUT STILL HAS PRACTICE REPLAYS, and they have to be reachable.
   *
   * Solo practice is the primary OFFLINE mode and keeps its runs on the device whether or not
   * anyone is signed in — so a Career page that showed nothing but a sign-in prompt would be
   * holding runs the player has no way to open. ELO and records genuinely need an account;
   * these do not.
   */
  if (!user) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Sign in to see your stats</div>
            Sign in from the top bar to track your ELO and records.
          </div>
        </div>
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }

  if (!configured) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Stats need the game server</div>
            Set <code>VITE_GAME_SERVER_URL</code>.
          </div>
        </div>
        {/* the local half needs no server either */}
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }

  const nameFallback = user.name ?? user.email ?? 'Player';
  return (
    <CareerView
      loadStats={loadStats}
      fetchPage={fetchPage}
      nameFallback={nameFallback}
      // ACCOUNT STANDING is self-only, so it hangs off THIS screen rather than the shared
      // CareerPanel, which also renders public profiles. Someone else's penalties are
      // between them and the moderators.
      head={() => (
        <>
          <StandingCard />
          {/* SELF-ONLY, same reasoning as StandingCard above: practice runs are offline and
              unverified, and on a public profile they would read as competitive history. */}
          <PracticeReplays
            signedIn
            game={nav.game}
            onWatchId={nav.onWatch}
            onWatchLocal={nav.onWatchLocal}
          />
        </>
      )}
      headerAction={(stats) =>
        stats?.username ? <ShareButton username={stats.username} label="Share my profile" /> : undefined
      }
      nav={nav}
    />
  );
}
