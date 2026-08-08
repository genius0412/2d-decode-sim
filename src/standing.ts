/**
 * ACCOUNT STANDING — competitive integrity, kept separately from skill.
 *
 * The Glicko rating answers "how good are you". It cannot answer "are you someone the other
 * three people want in their match", and overloading it with that job is what the first cut
 * of this got wrong: charging rating for a dodge quietly says a dodger is a WORSE DRIVER,
 * which is not what happened, and it makes the ladder a worse measurement of the only thing
 * it exists to measure.
 *
 * So behaviour gets its own axis. Standing is a 0–100 score every account starts at 100 and
 * spends only by doing something to other players; it is shown to the player, it gates the
 * ranked queue, and — only at the bottom of the ladder — it starts costing rating too.
 *
 * THE ESCALATION IS THE POINT (the Valorant/LoL shape). One bad night should cost almost
 * nothing: a first dodge takes 5 points off a 100 and restricts nothing. A pattern should
 * hurt, quickly and visibly, and the cost should arrive in stages the player can see coming
 * — warning, then a queue cooldown, then a longer one, and only when someone has ignored all
 * of that does it touch their rating. A system whose first move is the harshest one has no
 * room left to escalate, and punishes accidents at the same rate as habits.
 *
 * SEVERITY IS PER EVENT, because the events are not comparable. Abandoning a pairing that
 * has not started costs the other players a requeue; going AFK for a live match costs them
 * the whole match, played a robot down, with no requeue and no refund. Those cannot be worth
 * the same number.
 *
 * WHAT IS DELIBERATELY NOT MODELLED: intent. From the server a pulled cable, a closed laptop
 * and a rage-quit are one event — a socket that stopped answering. Any rule that charged
 * less for "looked like a real disconnect" would just be publishing the cheap way to quit.
 * Repetition is the honest signal, and it is the one this module escalates on.
 */

/** the score every account starts on, and its ceiling */
export const STANDING_MAX = 100;

/**
 * Rolling window the repeat multiplier counts over. A day, not the dodge module's 12 hours:
 * standing is about a pattern of behaviour rather than one session's worth of queue-dodging,
 * and a player who does this every evening should still be treated as a repeat offender the
 * following evening.
 */
export const STANDING_WINDOW_HOURS = 24;

export type StandingEventKind =
  | 'dodge'
  | 'afk'
  | 'leave'
  | 'report'
  | 'reportUpheld';

/**
 * BASE COST of each event, in standing points.
 *
 * Ordered by what it actually cost the other players:
 *
 *   dodge  5  — the pairing died before it started. Everyone requeues; nobody lost a match.
 *               Cheapest on purpose: this is the event a genuine disconnect looks exactly
 *               like, and at 5 a player can have one a week forever without ever leaving
 *               good standing.
 *   report 3  — RAW, unreviewed, per distinct reporter and capped (see REPORT_CAP). It is
 *               the weakest evidence here — one person's opinion, filed in a temper as often
 *               as not — so it moves the number a little and nothing more.
 *   afk   12  — present, connected, not driving. Three people played a live match a robot
 *               down with no requeue and no refund. Costs more than twice a dodge because it
 *               destroys a match rather than postponing one.
 *   leave  15 — quit a live match. AFK plus taking the robot away.
 *   upheld 25 — a MODERATOR reviewed the reports and upheld them. The only event here backed
 *               by a human looking at the evidence, so it is the only one big enough to move
 *               a player two tiers on its own.
 */
export const STANDING_COST: Record<StandingEventKind, number> = {
  dodge: 5,
  report: 3,
  afk: 12,
  leave: 15,
  reportUpheld: 25,
};

/** how many distinct reporters can charge one player for a single match. Raw reports are
 *  unreviewed by definition, so an uncapped total is a licence for a stack of friends to
 *  bury someone they lost to; three of them is already a signal worth acting on, and the
 *  moderator queue is where the rest of it gets read. */
export const REPORT_CAP = 3;

/**
 * Repeat multiplier: the n-th offence of the SAME kind inside the window costs this much of
 * the base. Two in a day is a pattern, three is a habit, and the curve flattens after that
 * because the score is already collapsing on its own by then.
 */
export const REPEAT_MULT = [1, 1.5, 2] as const;

export const repeatMult = (n: number): number =>
  REPEAT_MULT[Math.min(Math.max(n, 1), REPEAT_MULT.length) - 1];

export type StandingTierKey = 'good' | 'warning' | 'restricted' | 'probation' | 'suspended';

export interface StandingTier {
  key: StandingTierKey;
  /** what the player is told they are */
  name: string;
  /** lowest score in this tier */
  floor: number;
  /** ranked-queue cooldown applied when an offence lands while in this tier, in MINUTES.
   *  0 ⇒ the tier restricts nothing. */
  cooldownMin: number;
  /** rating charged per offence in this tier — the LAST stage of the escalation, and zero
   *  for the top three tiers. A player only ever loses rating for behaviour after they have
   *  been warned, cooled down, and cooled down again. */
  ratingCharge: number;
  /** one line explaining the consequence, shown under the tier name */
  blurb: string;
}

/**
 * The ladder, best first.
 *
 * WARNING carries no restriction on purpose. It is the rung whose whole job is to be seen
 * before anything is taken away — a player who dodges twice should find out that the system
 * is watching while it is still free to correct.
 */
export const STANDING_TIERS: readonly StandingTier[] = [
  {
    key: 'good',
    name: 'Good standing',
    floor: 80,
    cooldownMin: 0,
    ratingCharge: 0,
    blurb: 'Everything is available. Nothing to do.',
  },
  {
    key: 'warning',
    name: 'Warning',
    floor: 60,
    cooldownMin: 0,
    ratingCharge: 0,
    blurb: 'Nothing is restricted yet — but the next one starts a queue cooldown.',
  },
  {
    key: 'restricted',
    name: 'Restricted',
    floor: 40,
    cooldownMin: 30,
    ratingCharge: 0,
    blurb: 'Leaving or sitting out a ranked match now locks the queue for 30 minutes.',
  },
  {
    key: 'probation',
    name: 'Probation',
    floor: 20,
    cooldownMin: 120,
    ratingCharge: 15,
    blurb: 'Two-hour queue locks, and offences now cost ranked rating as well.',
  },
  {
    key: 'suspended',
    name: 'Suspended',
    floor: 0,
    cooldownMin: 60 * 24,
    ratingCharge: 40,
    blurb: 'Ranked is locked for a day at a time, and every offence costs rating.',
  },
];

export const tierOf = (score: number): StandingTier =>
  STANDING_TIERS.find((t) => clampScore(score) >= t.floor) ?? STANDING_TIERS[STANDING_TIERS.length - 1];

export const clampScore = (n: number): number =>
  !Number.isFinite(n) ? STANDING_MAX : Math.max(0, Math.min(STANDING_MAX, Math.round(n)));

/**
 * RECOVERY. Standing is a debt you work off, not a mark that follows you forever — a system
 * you cannot climb out of is one a player stops trying to climb out of.
 *
 * Two routes, deliberately:
 *   - PLAYING WELL is the fast one (a clean, completed ranked match), because the behaviour
 *     being asked for is "finish your matches", and that is exactly what earns it back.
 *   - TIME is the slow one, so someone who steps away for a fortnight is not greeted by the
 *     same penalty on their return. It is slow enough that waiting out a suspension is
 *     strictly worse than playing out of one.
 */
export const HEAL_PER_CLEAN_MATCH = 2;
export const HEAL_PER_DAY = 3;

/** standing after `hoursIdle` of not offending (time-based healing only) */
export function healed(score: number, hoursIdle: number): number {
  if (!Number.isFinite(hoursIdle) || hoursIdle <= 0) return clampScore(score);
  return clampScore(clampScore(score) + Math.floor(hoursIdle / 24) * HEAL_PER_DAY);
}

/**
 * SITTING OUT vs WALKING AWAY, judged from what the server actually saw: how much of the
 * live match each robot issued a command on, and how much of it its driver was disconnected
 * for. Pure, so the thresholds are testable without a match.
 *
 * The bar for "drove" is deliberately low. This asks whether a PERSON WAS THERE, not whether
 * they played well — a driver who parks in their base and loses is not committing an
 * offence, and a system that cannot tell those apart will eventually charge someone for
 * being bad at the game.
 *
 * A SHORT match is never judged: an early cancellation, a restart, or a room that died in
 * its first seconds gives numbers too small to mean anything, and the failure mode of
 * guessing from them is charging an innocent player.
 */
export const AFK_DRIVE_FRACTION = 0.15;
export const LEAVE_AWAY_FRACTION = 0.25;
/** live ticks (60 Hz) a match must run before absence is judged at all — half a minute */
export const MIN_JUDGED_TICKS = 30 * 60;

export function judgeParticipation(p: {
  liveTicks: number;
  driveTicks: number;
  awayTicks: number;
}): 'afk' | 'leave' | null {
  if (!Number.isFinite(p.liveTicks) || p.liveTicks < MIN_JUDGED_TICKS) return null;
  // LEAVING outranks AFK: someone who walked out issued no commands either, and charging
  // both for one act would double-bill the same absence.
  if (p.awayTicks / p.liveTicks > LEAVE_AWAY_FRACTION) return 'leave';
  if (p.driveTicks / p.liveTicks < AFK_DRIVE_FRACTION) return 'afk';
  return null;
}

export interface StandingState {
  score: number;
  /** epoch ms the ranked queue reopens, or null */
  restrictedUntil: number | null;
}

/** what one offence did — everything the player is shown, and everything the server writes */
export interface StandingVerdict {
  kind: StandingEventKind;
  /** standing points actually deducted (after the repeat multiplier) */
  points: number;
  scoreBefore: number;
  scoreAfter: number;
  tierBefore: StandingTierKey;
  tierAfter: StandingTierKey;
  /** queue cooldown applied, in minutes (0 ⇒ none) */
  cooldownMin: number;
  restrictedUntil: number | null;
  /** ranked rating charged — 0 until the bottom two tiers */
  ratingCharge: number;
}

/**
 * Apply one offence.
 *
 * THE TIER THAT DECIDES THE CONSEQUENCE IS THE ONE YOU LAND IN, not the one you were in. A
 * player who arrives at Probation in a single stretch of bad behaviour should feel Probation
 * immediately; reading the consequence off the tier they were in when they started would let
 * a long run of offences be charged at the mildest rate they ever held.
 *
 * PURE — no clock, no database. `now` and `priorSameKind` come from the caller so the server
 * can compute a verdict and a test can assert one.
 */
export function applyStandingEvent(
  state: StandingState,
  kind: StandingEventKind,
  opts: { now: number; priorSameKind?: number; count?: number },
): StandingVerdict {
  const scoreBefore = clampScore(state.score);
  const tierBefore = tierOf(scoreBefore);
  const mult = repeatMult((opts.priorSameKind ?? 0) + 1);
  const units = kind === 'report' ? Math.max(1, Math.min(opts.count ?? 1, REPORT_CAP)) : 1;
  const points = Math.round(STANDING_COST[kind] * mult * units);
  const scoreAfter = clampScore(scoreBefore - points);
  const landed = tierOf(scoreAfter);

  // A REPORT never restricts the queue or charges rating on its own, whatever tier it drops
  // someone into. It is the one event here that no one has verified, and locking a player
  // out of the game on unreviewed accusations is precisely the abuse vector a report system
  // has to be built against. It still moves the score, which is what surfaces them to a
  // moderator — and a moderator upholding it is a `reportUpheld`, which does restrict.
  const enforced = kind !== 'report';
  const cooldownMin = enforced ? landed.cooldownMin : 0;
  const ratingCharge = enforced ? landed.ratingCharge : 0;
  const restrictedUntil = cooldownMin
    ? Math.max(state.restrictedUntil ?? 0, opts.now + cooldownMin * 60_000)
    : state.restrictedUntil ?? null;

  return {
    kind,
    points,
    scoreBefore,
    scoreAfter,
    tierBefore: tierBefore.key,
    tierAfter: landed.key,
    cooldownMin,
    restrictedUntil,
    ratingCharge,
  };
}

/** is the ranked queue closed to this account right now? */
export const queueLocked = (state: StandingState, now: number): boolean =>
  state.restrictedUntil !== null && state.restrictedUntil > now;

/** human-readable remaining lock, e.g. "27 minutes" / "2 hours" */
export function lockRemaining(until: number, now: number): string {
  const ms = Math.max(0, until - now);
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** what the player is told an offence WAS */
export const STANDING_EVENT_LABEL: Record<StandingEventKind, string> = {
  dodge: 'Abandoned a match that had already been found',
  afk: 'Did not drive for most of a match',
  leave: 'Left a match in progress',
  report: 'Reported by other players',
  reportUpheld: 'A moderator upheld reports against you',
};
