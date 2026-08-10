import { useEffect, useState } from 'react';
import { fetchStanding, type StandingEvent, type StandingInfo } from '../net/api';
import {
  STANDING_EVENT_LABEL,
  STANDING_MAX,
  STANDING_TIERS,
  lockRemaining,
  nextStepDown,
  tierOf,
  type StandingEventKind,
} from '../standing';

/**
 * ACCOUNT STANDING, as the player sees it.
 *
 * The design rule here is that NOTHING IS HIDDEN. A behaviour system that shows a player a
 * penalty without the reason for it, or a score without a way back up, is the thing people
 * mean when they call moderation arbitrary — so this shows the tier, exactly what it
 * restricts, what each offence cost, and what earns it back, in that order.
 *
 * IT ONLY APPEARS WHEN THERE IS SOMETHING TO SAY. A player in good standing with no history
 * gets one quiet line; the meter, the ledger and the recovery note are for people who have
 * actually spent some. Showing a full bar and an empty offence list to everyone would turn a
 * penalty system into a permanent accusation.
 */

/**
 * The standing METER — a semicircular gauge, the shape a player already reads as "how full
 * is this" from every mobile game that has one.
 *
 * It replaces a coloured dot. A dot can only ever say WHICH tier, never how far into it you
 * are or how close the next one is, so the number beside it was doing all the work and the
 * dot was decoration. An arc answers both at a glance, and it is the one element on the card
 * that has to survive being looked at for half a second.
 *
 * Geometry: a 180° arc of radius `R` centred on the baseline, drawn twice — the track, then
 * the fill, whose length is set by `stroke-dasharray` rather than by a computed path, so the
 * sweep is one interpolated number and nothing has to re-derive an arc endpoint. Round caps,
 * because a square end at 1% reads as a rendering artefact.
 */
const GAUGE_R = 40;
const GAUGE_W = 13;
/** room outside the arc for the threshold labels — they are the point of the gauge */
const GAUGE_PAD = 16;
const ARC = Math.PI * GAUGE_R; // length of a half-circle

/** a point on the arc for a 0..1 fraction (0 = left end, 1 = right end) */
function arcPoint(cx: number, cy: number, r: number, f: number): { x: number; y: number } {
  const a = Math.PI - f * Math.PI;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}

function StandingGauge({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(1, score / STANDING_MAX));
  const w = 2 * GAUGE_R + GAUGE_W + 2 * GAUGE_PAD;
  const h = GAUGE_R + GAUGE_W / 2 + GAUGE_PAD;
  const cx = w / 2;
  const cy = GAUGE_PAD + GAUGE_R;
  const d = `M ${cx - GAUGE_R} ${cy} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${cx + GAUGE_R} ${cy}`;
  /**
   * THE THRESHOLDS, marked on the arc.
   *
   * Without them the gauge says "you are at 52" and leaves the reader to wonder 52 out of
   * what, and how much further before something changes. The whole system is a LADDER of
   * consequences, so the rungs belong on the dial: a notch cut through the band at each tier
   * floor, and the number beside it. Now the distance to the next penalty step is something
   * you SEE rather than something you compute.
   *
   * The bottom tier's floor is 0 — that is the end of the dial, not a step within it — so it
   * is dropped.
   */
  const marks = STANDING_TIERS.map((t) => t.floor).filter((f) => f > 0 && f < STANDING_MAX);
  return (
    <svg
      className="ds-gauge"
      viewBox={`0 0 ${w} ${h}`}
      // NO inline sizing, not even a custom property: an inline declaration wins over any
      // stylesheet rule for the same element, so setting `--gauge-w` here silently defeated
      // the media query meant to shrink it on a phone. CSS owns the size outright.
      role="img"
      aria-label={`${score} out of ${STANDING_MAX}`}
    >
      <path className="ds-gauge-track" d={d} strokeWidth={GAUGE_W} fill="none" strokeLinecap="round" />
      <path
        className="ds-gauge-fill"
        d={d}
        strokeWidth={GAUGE_W}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={ARC}
        strokeDashoffset={ARC * (1 - pct)}
      />
      {marks.map((v) => {
        const f = v / STANDING_MAX;
        const a = arcPoint(cx, cy, GAUGE_R - GAUGE_W / 2 - 0.5, f);
        const b = arcPoint(cx, cy, GAUGE_R + GAUGE_W / 2 + 0.5, f);
        const label = arcPoint(cx, cy, GAUGE_R + GAUGE_W / 2 + 8, f);
        return (
          <g key={v}>
            {/* drawn in the CARD's colour, so it reads as a notch cut through the band
                rather than as a line laid over it — and it works over the track and the
                fill without knowing which is underneath */}
            <line className="ds-gauge-tick" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <text
              className="ds-gauge-mark"
              x={label.x}
              y={label.y}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {v}
            </text>
          </g>
        );
      })}
      {/* centred in the BOWL, not on the baseline. `dominant-baseline` does the vertical
          centring so the pair reads as one block sitting inside the arc, rather than two
          lines hanging off its flat edge — the offsets are fractions of the radius, so they
          stay right at any size the card asks for. */}
      <text
        className="ds-gauge-num"
        x={cx}
        y={cy - GAUGE_R * 0.40}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {score}
      </text>
      <text
        className="ds-gauge-max"
        x={cx}
        y={cy - GAUGE_R * 0.04}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        / {STANDING_MAX}
      </text>
    </svg>
  );
}

export function StandingCard({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<{ standing: StandingInfo | null; events: StandingEvent[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void fetchStanding().then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // the lock is a live clock, so it has to tick down rather than go stale on screen
  const until = data?.standing?.restrictedUntil ?? null;
  useEffect(() => {
    if (!until || until <= now) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [until, now]);

  if (!data?.standing) return null;
  const { score } = data.standing;
  const tier = tierOf(score);
  // the notches on the dial say WHERE the steps are; this says what the next one is and how
  // much room is left before it (see `nextStepDown` — the arithmetic is not obvious)
  const step = nextStepDown(score);
  const locked = until !== null && until > now;
  const clean = tier.key === 'good' && data.events.length === 0;

  if (clean) {
    // NAMED, even when there is nothing to report. The quiet state was one unlabelled line
    // among a page of stat tiles, so a player going looking for their standing could not
    // find it and reasonably concluded the feature was missing. It stays a single line —
    // a full meter and an empty offence list for everyone would read as an accusation —
    // but it now says what it IS.
    return (
      <div className="ds-standing good" data-tier={tier.key}>
        <div className="ds-standing-head">
          <StandingGauge score={score} />
          <div className="ds-standing-headtext">
            <span className="ds-standing-cap">Account standing</span>
            <span className="ds-standing-name">Good standing</span>
            <p className="ds-standing-blurb">Nothing on your account.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`ds-standing ${compact ? 'compact' : ''}`} data-tier={tier.key}>
      <div className="ds-standing-head">
        <StandingGauge score={score} />
        <div className="ds-standing-headtext">
          <span className="ds-standing-cap">Account standing</span>
          <span className="ds-standing-name">{tier.name}</span>
          {step && (
            <p className="ds-standing-next">
              Next step down: <b>{step.tier.name.toLowerCase()}</b> below {step.below}
              <span className="ds-muted"> — {step.toGo} to go</span>
            </p>
          )}
        </div>
      </div>

      {locked && (
        <p className="ds-standing-lock">
          Ranked is locked for another <b>{lockRemaining(until as number, now)}</b>.
        </p>
      )}

      {!compact && data.events.length > 0 && (
        <>
          <span className="ds-standing-cap">What happened</span>
          <ul className="ds-standing-log">
            {data.events.slice(0, 6).map((e) => (
              <li key={e.id}>
                <span className="ds-standing-what">
                  {STANDING_EVENT_LABEL[e.kind as StandingEventKind] ?? e.kind}
                </span>
                <span className="ds-standing-cost ds-muted">
                  −{e.points}
                  {e.cooldownMin > 0 && ` · ${e.cooldownMin}min queue lock`}
                  {e.ratingCharge > 0 && ` · −${e.ratingCharge} rating`}
                  {' · '}
                  {ago(e.at)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

    </div>
  );
}


function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
