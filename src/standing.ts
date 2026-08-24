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
 * Rolling window each KIND's escalation counts over — and it is per-kind on purpose.
 *
 * Both reference systems decay a penalty tier slowly, and slower for the serious offences:
 * a pre-match dodge is a same-session mistake, whereas abandoning live matches is a habit
 * that should still be remembered next weekend. So dodges reset in a day, walking out of
 * matches takes a week, and a moderator's upheld verdict is remembered for a month.
 */
export const WINDOW_HOURS: Record<StandingEventKind, number> = {
  dodge: 24,
  report: 24,
  afk: 24 * 7,
  leave: 24 * 7,
  reportUpheld: 24 * 30,
  // remembered as long as an upheld verdict is: both are a moderator's finding about a
  // person rather than a bad night, and the repeat multiplier should still see the last one
  falseReport: 24 * 30,
  // a week, like walking out of matches: one card is a bad match, cards on two weekends
  // running is how someone plays
  card: 24 * 7,
};

export type StandingEventKind =
  | 'dodge'
  | 'afk'
  | 'leave'
  | 'report'
  | 'reportUpheld'
  /**
   * A report a moderator read and found to be FALSE — the mirror of `reportUpheld`.
   *
   * Every other event here is charged to someone who did something in a match. This one is
   * charged to someone who used the moderation queue as a weapon: filing a misscore claim
   * that a human then checked against the replay and found had nothing in it. It is the
   * heaviest event in the table on purpose, and it is the only one that can only ever be
   * issued by hand — nothing automatic can tell an honest mistake from a malicious one, and
   * a rule that guessed would either punish confusion or license brigading.
   */
  | 'falseReport'
  /**
   * A CARD issued by the head referee inside a match.
   *
   * Every other automatic event here is the server noticing an absence — a dodge, an AFK, a
   * walk-out. A card is the sim's referee finding that someone broke a RULE hard enough to be
   * sanctioned for it (excessive over-possession, a second offence escalating to red), and
   * that is a behaviour finding with evidence attached: it is in the match record, on the
   * results screen, and in the replay. "Getting a yellow card in a game should decrease
   * someone's account standing."
   */
  | 'card';

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
 *   afk   12  — present, connected, not driving. The others played a live match a robot down
 *               with no requeue and no refund. Costs more than twice a dodge because it
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
  /**
   * upheld 25 / FALSE 40 — the heaviest, and heavier than being upheld against.
   *
   * A player reported for throwing cost three other people one match. Someone filing a
   * fabricated misscore claim costs a moderator's time and, if it were ever acted on, the
   * result of a match that was played correctly — and unlike every other line in this table
   * there is nothing accidental about it: a human read it and found it empty. "If they
   * maliciously report, I should be able to smite them by taking off a ton of account
   * standing points."
   */
  falseReport: 40,
  /**
   * card 20 — between an AFK (12) and a walk-out (15) at the low end and an upheld report
   * (25) at the top, and that is the right neighbourhood: it is worse than wasting one
   * match's worth of other people's time, because a carded robot has usually been taking
   * artifacts out of the game or interfering with someone, and it is not as heavy as a
   * moderator's verdict, because no human has looked at it. A RED costs more than a yellow —
   * the caller passes the amount, since the sim decides which colour it was.
   */
  card: 20,
};

/** how many distinct reporters can charge one player for a single match. Raw reports are
 *  unreviewed by definition, so an uncapped total is a licence for a stack of friends to
 *  bury someone they lost to; three of them is already a signal worth acting on, and the
 *  moderator queue is where the rest of it gets read. */
export const REPORT_CAP = 3;

/**
 * Repeat multiplier: the n-th offence of the SAME kind inside the window costs this much of
 * the base. Two is a pattern, three is a habit, and the curve flattens after that because
 * the score is already collapsing on its own by then.
 */
export const REPEAT_MULT = [1, 1.5, 2] as const;

export const repeatMult = (n: number): number =>
  REPEAT_MULT[Math.min(Math.max(n, 1), REPEAT_MULT.length) - 1];

/* ---------------------------------------------------------------------------
   THE PENALTY LADDERS — the part patterned on Valorant and Brawl Stars.
   ---------------------------------------------------------------------------

   Both games escalate on the OFFENCE COUNT, not on where a hidden number sits: your
   second abandon is worse than your first because it is your second, and the ban clock
   roughly multiplies each time (minutes → hours → a day → longer). The score in this
   module is what a player SEES; these ladders are what they FEEL, and the count is what
   drives them.

   The other thing both systems get right is that the two failures are not the same event:

     - DODGING a match that has not started is the light track. It costs the others a
       requeue, and the first one is free because a genuine disconnect is indistinguishable
       from a rage-quit at this point. Escalation is minutes, and it never touches rating
       until it is plainly chronic.
     - ABANDONING a LIVE match is the heavy track, and it bites IMMEDIATELY — a lock and a
       rating charge on the very first one. Three people just lost a match they were
       playing; there is no requeue that fixes that, and a first-offence freebie here would
       mean every match has one free quit in it.
     - GOING AFK sits between them: a WARNING first (both systems warn before they ban for
       it), then it escalates like abandoning.

   Numbers are ours, chosen to fit a ~2-minute match rather than a 40-minute one. The SHAPE
   is theirs. */

/** ranked-queue lock, in MINUTES, for the n-th offence of a kind (index = offence − 1) */
export const COOLDOWN_LADDER: Record<StandingEventKind, readonly number[]> = {
  //           1st  2nd  3rd  4th   5th+
  dodge:      [0,   5,   15,  30,   120],
  afk:        [0,   30,  120, 1440],
  leave:      [30,  120, 1440, 1440 * 7],
  // a raw, unreviewed report NEVER locks anyone out of anything (see applyStandingEvent)
  report:     [0],
  // four rungs, not three, deliberately: the tier bump can add up to 3, and on a short
  // ladder that meant one upheld verdict against an already-poor account jumped straight to
  // the week. A moderator's first action should not be the harshest one available.
  reportUpheld: [120, 1440, 1440 * 3, 1440 * 7],
  // the same ladder as an upheld verdict: a moderator has looked at it either way
  falseReport: [120, 1440, 1440 * 3, 1440 * 7],
  // NO cooldown for a first card. It happened inside a match that has already been played
  // and scored — the card itself cost the alliance the game — so the standing hit is the
  // point and locking someone out for one is a second punishment for one act. A repeat is
  // where it starts to bite.
  card: [0, 60, 240, 1440],
};

/** ranked rating charged for the n-th offence of a kind. Zero everywhere it should be. */
export const RATING_LADDER: Record<StandingEventKind, readonly number[]> = {
  // a dodge costs NO rating until it is a habit — dodging is not bad driving
  dodge:      [0,   0,   0,   10,   20],
  afk:        [0,   5,   15,  30],
  // abandoning a live match costs rating from the first one (Valorant's RR loss for a
  // leaver), because the match it wrecked was a real, rated match
  leave:      [10,  20,  40,  60],
  report:     [0],
  reportUpheld: [20, 40, 60, 80],
  // it costs rating too, at the same rungs as an upheld verdict: filing a false claim is a
  // competitive act, not a driving one, and the ladder is where that is already expressed
  falseReport: [0, 10, 20, 30],
  // a card is a match-conduct finding, not a driving one, so rating only enters on repeats
  card: [0, 0, 10, 20],
};

/**
 * The rung an offence lands on: how many of that kind came before it, pushed up by the tier
 * the player is already in (see `StandingTier.bump`), and saturating at the top.
 *
 * THE BUMP CANNOT REACH THE TOP RUNG BY ITSELF. The harshest penalty on a ladder — a
 * week out of ranked — has to be EARNED BY REPETITION, not arrived at because a score
 * happened to be low when an offence landed. Without this cap the two escalations
 * compound: a player at Restricted with one prior abandon was being quoted a 7-day lock
 * for their second, which is a jump nobody could see coming and does not match the
 * "roughly multiplies each time" shape this is patterned on. The raw count still gets
 * there — that is what the top rung is for.
 */
export function ladderRung(priorSameKind: number, bump: number, ladderLength: number): number {
  const top = Math.max(0, ladderLength - 1);
  const byCount = Math.min(top, Math.max(0, Math.floor(priorSameKind)));
  const bumpCeiling = Math.max(0, ladderLength - 2);
  const bumped = Math.min(byCount + Math.max(0, bump), bumpCeiling);
  return Math.min(top, Math.max(byCount, bumped));
}

const rungValue = (ladder: readonly number[], rung: number): number =>
  ladder[Math.max(0, Math.min(ladder.length - 1, rung))] ?? 0;

export type StandingTierKey = 'good' | 'warning' | 'restricted' | 'probation' | 'suspended';

export interface StandingTier {
  key: StandingTierKey;
  /** what the player is told they are */
  name: string;
  /** lowest score in this tier */
  floor: number;
  /**
   * How many rungs this tier adds to every ladder.
   *
   * This is how the SCORE still matters without being the thing that sets the punishment: a
   * player already in bad standing does not get the first-offence rate on a fresh kind of
   * offence. It is the "you have been here before" surcharge both reference systems apply,
   * expressed once rather than duplicated into every ladder.
   */
  bump: number;
  /** one line explaining where they stand, shown under the tier name */
  blurb: string;
}

/**
 * The ladder, best first.
 *
 * WARNING adds nothing on purpose. It is the rung whose whole job is to be seen before
 * anything extra is taken away — a player who dodged twice should find out the system is
 * watching while correcting is still free.
 */
export const STANDING_TIERS: readonly StandingTier[] = [
  {
    key: 'good',
    name: 'Good standing',
    floor: 80,
    bump: 0,
    blurb: 'Everything is available. Nothing to do.',
  },
  {
    key: 'warning',
    name: 'Warning',
    floor: 60,
    bump: 0,
    blurb: 'Nothing extra is being applied — but the next one escalates.',
  },
  {
    key: 'restricted',
    name: 'Restricted',
    floor: 40,
    bump: 1,
    blurb: 'Every penalty now starts one step up the ladder: longer locks, sooner.',
  },
  {
    key: 'probation',
    name: 'Probation',
    floor: 20,
    bump: 2,
    blurb: 'Penalties start two steps up, and even a dodge now costs ranked rating.',
  },
  {
    key: 'suspended',
    name: 'Suspended',
    floor: 0,
    bump: 3,
    blurb: 'Every offence lands at the top of the ladder — day-long ranked locks.',
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
  /** which rung of this kind's ladder it landed on (0-based), so the player can be told
   *  what the NEXT one costs rather than finding out by doing it */
  rung: number;
  /** queue cooldown applied, in minutes (0 ⇒ none) */
  cooldownMin: number;
  restrictedUntil: number | null;
  /** ranked rating charged (0 for the light track until it is chronic) */
  ratingCharge: number;
  /** the cooldown the NEXT offence of this kind would carry, in minutes */
  nextCooldownMin: number;
}

/**
 * Apply one offence.
 *
 * THE COUNT SETS THE PUNISHMENT, the score only aggravates it. That is the shape both
 * reference systems use, and it is the one players can actually follow: "this is my third
 * time" is something a person knows about themselves, whereas "I am at 43 points" is not.
 * The tier a player is already in adds rungs (`StandingTier.bump`), so bad standing makes
 * every ladder start higher without being the thing that defines it.
 *
 * THE TIER USED FOR THE BUMP IS THE ONE THEY LAND IN, not the one they came from. A player
 * who arrives in Probation in a single stretch of bad behaviour should feel Probation
 * immediately; reading it off the tier they held when they started would charge a long run
 * of offences at the mildest rate they ever had.
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
  const prior = Math.max(0, Math.floor(opts.priorSameKind ?? 0));
  const mult = repeatMult(prior + 1);
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
  const cools = COOLDOWN_LADDER[kind];
  const rates = RATING_LADDER[kind];
  const rung = ladderRung(prior, landed.bump, cools.length);
  const cooldownMin = enforced ? rungValue(cools, rung) : 0;
  const ratingCharge = enforced ? rungValue(rates, rung) : 0;
  const nextCooldownMin = enforced ? rungValue(cools, rung + 1) : 0;
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
    rung,
    cooldownMin,
    restrictedUntil,
    ratingCharge,
    nextCooldownMin,
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
  dodge: 'Left before the match started',
  afk: 'Did not drive for most of a match',
  leave: 'Left a match in progress',
  report: 'Reported by other players',
  reportUpheld: 'A moderator upheld reports against you',
  falseReport: 'A moderator found a report you filed to be false',
  card: 'Carded by the referee during a match',
};
