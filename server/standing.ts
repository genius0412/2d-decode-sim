/**
 * ACCOUNT STANDING — the server side of `src/standing.ts`.
 *
 * The pure module decides WHAT an offence costs; this decides WHEN one happened, reads the
 * escalation history, commits the result and — only at the bottom two tiers — charges the
 * rating. Everything that needs a clock or a database lives here so the rules themselves
 * stay testable without either.
 *
 * NOTHING HERE IS ALLOWED TO THROW INTO A ROOM. Standing is bookkeeping about a match, not
 * part of running one: a failed write must never delay a teardown, hold up a requeue, or
 * take a live match down with it. Every entry point catches and returns null, and a null is
 * reported honestly (the player is told nothing was charged, rather than shown a penalty
 * that was not actually stored).
 */
import { dbEnabled } from './db/pool';
import {
  chargeRatingForBehaviour,
  getStanding,
  healStandingForCleanMatch,
  lastRankedBoard,
  recentStandingCount,
  writeStandingEvent,
} from './db/repo';
import {
  WINDOW_HOURS,
  STANDING_MAX,
  tierOf,
  applyStandingEvent,
  queueLocked,
  type StandingEventKind,
  type StandingVerdict,
} from '../src/standing';
import { RATING_FLOOR } from '../src/config';
import type { GameId } from '../src/types';

export interface OffenceContext {
  game?: GameId;
  mode?: '1v1' | '2v2';
  roomCode?: string;
  /** distinct reporters, for the `report` kind only */
  count?: number;
  /**
   * An EXPLICIT point cost, overriding the ladder. Only a moderator sets this — it is how a
   * smite for a false report is sized to what the person actually did, since "filed a claim
   * that was wrong" and "filed a fabricated claim to bury an opponent" arrive as the same
   * row and only a human can tell them apart. Everything else about the event is unchanged:
   * it lands in the same ledger, on the same tier ladder, with the same cooldown rung.
   */
  points?: number;
}

/**
 * Charge one offence to one account.
 *
 * The repeat count is read per KIND: someone whose bad night was three dodges is not thereby
 * a repeat offender for going AFK, and blending the two would make the first AFK cost triple
 * for reasons the player could not possibly follow.
 */
export async function chargeStanding(
  userId: string,
  kind: StandingEventKind,
  ctx: OffenceContext = {},
): Promise<StandingVerdict | null> {
  if (!dbEnabled || !userId) return null;
  try {
    const state = await getStanding(userId);
    // RAW REPORTS DO NOT ESCALATE. The repeat multiplier exists to tell an accident from a
    // habit in things the SERVER witnessed; applying it to unreviewed accusations would mean
    // a second squad-mate's report costs half again as much as the first, which is a
    // brigading amplifier rather than a signal. Reports are priced per distinct reporter and
    // capped instead (see `applyStandingEvent`).
    const priorSameKind =
      kind === 'report' ? 0 : await recentStandingCount(userId, kind, WINDOW_HOURS[kind]);
    const verdict = applyStandingEvent(state, kind, {
      now: Date.now(),
      priorSameKind,
      count: ctx.count,
    });

    // RATING IS CHARGED ON A REAL BOARD OR NOT AT ALL. Most offences arrive with the mode
    // they happened in; a moderator upholding reports does not, so it lands on the board the
    // player most recently played — the one they would actually notice. With no board at
    // all (never played ranked), the charge is dropped and the verdict says 0, because
    // reporting a penalty that was not applied is worse than applying none.
    let charged = 0;
    if (verdict.ratingCharge > 0) {
      const board = ctx.mode
        ? { mode: ctx.mode, game: ctx.game, act: await actFor(ctx.game) }
        : await lastRankedBoard(userId);
      if (board) {
        const { before, after } = await chargeRatingForBehaviour(
          userId, board.mode, board.act, verdict.ratingCharge, RATING_FLOOR, board.game,
        );
        charged = before - after;
      }
    }
    const final: StandingVerdict = { ...verdict, ratingCharge: charged };
    if (ctx.points !== undefined && Number.isFinite(ctx.points)) {
      // the override re-derives what depends on it, so the ledger and the player's score can
      // never disagree about what the event cost
      const points = Math.max(0, Math.min(STANDING_MAX, Math.round(ctx.points)));
      final.points = points;
      final.scoreAfter = Math.max(0, Math.min(STANDING_MAX, final.scoreBefore - points));
      final.tierAfter = tierOf(final.scoreAfter).key;
    }
    await writeStandingEvent(userId, final, { game: ctx.game, mode: ctx.mode, roomCode: ctx.roomCode });
    console.log(
      `[standing] ${userId} ${kind}${ctx.count && ctx.count > 1 ? `x${ctx.count}` : ''} ` +
        `#${priorSameKind + 1}/${WINDOW_HOURS[kind]}h (rung ${final.rung}): ${final.scoreBefore} -> ${final.scoreAfter} ` +
        `(${final.tierAfter}${final.cooldownMin ? `, ${final.cooldownMin}min lock` : ''}` +
        `${charged ? `, -${charged} rating` : ''})`,
    );
    return final;
  } catch (e) {
    console.error('[standing] FAILED charging', kind, 'to', userId, e);
    return null;
  }
}

/** the act a game's ranked boards are currently on (the same resolution ranked itself uses) */
async function actFor(game?: GameId): Promise<number> {
  const { actForSeason, currentSeasonNumber } = await import('./db/repo');
  const { BALANCE_VERSION } = await import('../src/config');
  const season = await currentSeasonNumber(BALANCE_VERSION, game);
  return actForSeason(season, game);
}

/** is ranked closed to this account right now? Returns the lock, or null when they're free
 *  to queue. Fails OPEN: a database that cannot answer must not lock everyone out. */
export async function rankedLock(
  userId: string,
): Promise<{ until: number; score: number } | null> {
  if (!dbEnabled || !userId) return null;
  try {
    const s = await getStanding(userId);
    if (!queueLocked(s, Date.now())) return null;
    return { until: s.restrictedUntil as number, score: s.score };
  } catch (e) {
    console.error('[standing] lock check failed (allowing the queue):', e);
    return null;
  }
}

/** credit everybody who finished a ranked match without offending in it */
export async function creditCleanMatch(userIds: string[]): Promise<void> {
  if (!dbEnabled || !userIds.length) return;
  try {
    await healStandingForCleanMatch(userIds);
  } catch (e) {
    console.error('[standing] clean-match credit failed:', e);
  }
}
