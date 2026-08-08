import { dbEnabled } from './db/pool';
import {
  currentSeasonNumber,
  ensureProfile,
  ensureSeason,
  personalBest,
  recentStandingCount,
  recordRank,
  saveReplay,
  submitRecord,
} from './db/repo';
import { chargeStanding, creditCleanMatch } from './standing';
import { persistVersusMatch } from './ranked';
import { recordScore } from '../src/sim/replay';
import { simModuleFor } from '../src/games/sim';
import type { BehaviourReport, DodgeReport, MatchOutcome, PersistOutcome } from './room';
import { type DodgeVerdict } from '../src/dodge';
import { STANDING_WINDOW_HOURS } from '../src/standing';

/**
 * Persist a finished match (off the hot path — called at phase 'post'). The
 * SERVER is the only trusted writer; scores come from the authoritative sim.
 * Requires ≥1 AUTHED participant (else the run is anonymous and dropped). Never
 * throws into the caller. No-ops when the DB is disabled.
 *
 * - RECORD room → leaderboard row (solo = 1 player, duo = primary + partner).
 * - VERSUS room → ranked ELO + match history.
 * Both save the recorded replay first (public, watchable, re-simulatable).
 */
export async function persistMatch(o: MatchOutcome): Promise<PersistOutcome> {
  const authed = o.participants.filter((p) => p.userId);
  const label = o.config.kind === 'record' ? `record/${o.config.record ?? 'solo'}` : 'versus';
  console.log(
    `[persist] match end: ${label} participants=${o.participants.length} authed=${authed.length} dbEnabled=${dbEnabled}`,
  );
  // UNSCORED games never touch ELO/records/history (a 0-0 result would pollute the
  // boards). Both DECODE and Chain Reaction are scored; the boards/periods are keyed
  // PER GAME (`o.game`), so each game's ranked/records stay fully separate.
  const game = o.game ?? 'decode';
  if (!simModuleFor(game).scored) {
    console.log(`[persist] SKIP — unscored game (${game})`);
    return {};
  }
  if (!dbEnabled) {
    console.log('[persist] SKIP — DATABASE_URL unset (no DB)');
    return {};
  }
  if (authed.length === 0) {
    console.log('[persist] SKIP — no authed participants (run is anonymous, dropped)');
    return {};
  }
  try {
    // Season = the DB-controlled current season (>= the replay's balance version),
    // so an admin-started season stamps new results without a redeploy. Records +
    // matches key off it, per-game (Chain Reaction seeds Act 1 · Season 1). The
    // replay row is ALSO stamped with the season (its `balance_version` column, for
    // purge-by-season) but keeps its real sim-code version in `sim_version` — the
    // playback gate compares CODE-vs-CODE, so a season bump must NOT make the replay
    // read as "recorded on an older version". Hence we do NOT overwrite
    // o.replay.balanceVersion here; saveReplay takes the season (and game) separately.
    const bv = await currentSeasonNumber(o.replay.balanceVersion, game);
    await ensureSeason(bv, game, game === 'chain' ? 1 : 0);
    for (const p of authed) await ensureProfile(p.userId!, p.handle ?? 'Player');
    const replayId = await saveReplay(o.replay, bv, game);

    if (o.config.kind === 'record') {
      const primary = authed[0];
      const partner = authed[1];
      const mode = o.config.record ?? 'solo';
      // RECORD boards ARE split by drivetrain. A duo whose two robots ran DIFFERENT
      // drivetrains keys the 'overall' bucket (cross-drivetrain board only); solo
      // runs and shared-drivetrain duos key their real drivetrain. Uses ALL
      // participants (incl. an unauthed partner) so the mix is judged on the robots
      // that actually played. (Ranked ELO, by contrast, is no longer split.)
      const drivetrains = new Set(o.participants.map((p) => p.drivetrain));
      const drivetrain = drivetrains.size > 1 ? 'overall' : primary.drivetrain;
      // NET score: the alliance's earned total minus the penalty points it handed
      // the (empty) opposing alliance — i.e. the fouls the player(s) committed.
      const score = recordScore(o.result, primary.alliance);
      const prevBest = await personalBest(primary.userId!, mode, drivetrain, bv, game);
      const id = await submitRecord({
        userId: primary.userId!,
        partnerId: partner?.userId,
        mode,
        drivetrain,
        score,
        balanceVersion: bv,
        replayId,
        game,
        // each driver brings their OWN robot; a duo stores both so the board can
        // show both drivetrains (partner absent ⇒ solo run)
        config: { spec: primary.spec, assists: primary.assists, partnerSpec: partner?.spec },
      });
      const { rank, total } = await recordRank(primary.userId!, mode, drivetrain, bv, game);
      const info = {
        mode,
        drivetrain,
        score,
        rank,
        total,
        isPB: prevBest === null || score > prevBest,
        isWR: rank === 1,
      };
      console.log(
        `[persist] WROTE record ${id}: user=${primary.userId} score=${score} dt=${drivetrain} rank=${rank}/${total} pb=${info.isPB} wr=${info.isWR} season=${bv}`,
      );
      return { record: info };
    } else {
      const elo = await persistVersusMatch(authed, o, bv, replayId, o.ranked, game);
      console.log(
        `[persist] WROTE versus match (ranked=${o.ranked}) — ${elo.length} ratings updated` +
          (elo.length === 0 && o.ranked ? ' (not a two-sided match)' : ''),
      );
      return { elo };
    }
  } catch (e) {
    console.error('[persist] FAILED writing to DB:', e);
  }
  return {};
}

/**
 * Charge a cancelled ranked pairing to whoever caused it.
 *
 * Runs OFF the cancel path (the room fires and forgets), so a slow or failing database can
 * never delay tearing the room down or stop the innocent players from requeueing. A failed
 * write means a dodge goes uncharged, which is the right way to fail: the alternative is a
 * player stuck staring at a dead room while a transaction retries.
 *
 * The escalation is counted PER PLAYER over a rolling window, and the count is read fresh
 * for each culprit rather than shared — two people dodging the same match are not each
 * other's repeat offence.
 */
export async function persistDodges(d: DodgeReport): Promise<DodgeVerdict[]> {
  if (!dbEnabled || !d.culprits.length) return [];
  try {
    const verdicts: DodgeVerdict[] = [];
    // de-duplicate: one player can be named by two rules at once (absent AND unready), and
    // one abandoned match must never be billed twice
    const seen = new Set<string>();
    for (const c of d.culprits) {
      if (seen.has(c.userId)) continue;
      seen.add(c.userId);
      // STANDING, not rating: a dodge says nothing about how well someone drives (see
      // src/dodge.ts). Rating only enters this at the bottom of the standing ladder, and
      // `chargeStanding` is what decides that — not this call site.
      const standing = await chargeStanding(c.userId, 'dodge', {
        game: d.game,
        mode: d.mode,
        roomCode: d.roomCode,
      });
      const count = await recentStandingCount(c.userId, 'dodge', STANDING_WINDOW_HOURS);
      verdicts.push({ userId: c.userId, kind: c.kind, standing, count });
    }
    // the INNOCENT get a verdict too, with nothing charged — "this wasn't billed to you" is
    // the difference between a system that reads as fair and one that reads as arbitrary
    for (const userId of d.rosterUserIds) {
      if (seen.has(userId)) continue;
      verdicts.push({ userId, kind: null, standing: null, count: 0 });
    }
    return verdicts;
  } catch (e) {
    console.error('[dodge] FAILED charging standing:', e);
    return [];
  }
}

/**
 * Charge (and credit) what a finished ranked match showed about its players.
 *
 * Fire-and-forget, like the dodge path: standing is bookkeeping ABOUT a match, and a slow
 * write must never hold up the results screen or the room teardown.
 *
 * The CLEAN CREDIT is the other half of the design and is easy to forget — a system that
 * only ever subtracts is one nobody can climb out of, so finishing a match you played is
 * how the debt actually comes off.
 */
export async function persistBehaviour(b: BehaviourReport): Promise<void> {
  if (!dbEnabled) return;
  try {
    for (const o of b.offenders) {
      await chargeStanding(o.userId, o.kind, { game: b.game, mode: b.mode, roomCode: b.roomCode });
    }
    await creditCleanMatch(b.cleanUserIds);
  } catch (e) {
    console.error('[standing] FAILED recording match behaviour:', e);
  }
}
