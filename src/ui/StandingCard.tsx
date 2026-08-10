import { useEffect, useState } from 'react';
import type React from 'react';
import { fetchStanding, type StandingEvent, type StandingInfo } from '../net/api';
import {
  HEAL_PER_CLEAN_MATCH,
  STANDING_EVENT_LABEL,
  STANDING_MAX,
  WINDOW_HOURS,
  lockRemaining,
  nextPenalty,
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
const GAUGE_W = 11;
const ARC = Math.PI * GAUGE_R; // length of a half-circle

function StandingGauge({ score, size = 132 }: { score: number; size?: number }) {
  const pct = Math.max(0, Math.min(1, score / STANDING_MAX));
  // the box hugs the arc: full width, half height, plus the stroke that overhangs each end
  const w = 2 * GAUGE_R + GAUGE_W;
  const h = GAUGE_R + GAUGE_W;
  const cx = w / 2;
  const cy = h - GAUGE_W / 2;
  const d = `M ${cx - GAUGE_R} ${cy} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${cx + GAUGE_R} ${cy}`;
  return (
    <svg
      className="ds-gauge"
      viewBox={`0 0 ${w} ${h}`}
      // the WIDTH is a custom property rather than a fixed style so CSS keeps ownership of
      // it — an inline width would beat any media query, and the gauge has to shrink on a
      // phone where it would otherwise eat half the card
      style={{ ['--gauge-w' as string]: `${size}px` } as React.CSSProperties}
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
      {/* centred in the BOWL, not on the baseline. `dominant-baseline` does the vertical
          centring so the pair reads as one block sitting inside the arc, rather than two
          lines hanging off its flat edge — the offsets are fractions of the radius, so they
          stay right at any size the card asks for. */}
      <text
        className="ds-gauge-num"
        x={cx}
        y={cy - GAUGE_R * 0.44}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {score}
      </text>
      <text
        className="ds-gauge-max"
        x={cx}
        y={cy - GAUGE_R * 0.08}
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
        <StandingGauge score={score} size={64} />
        <span className="ds-standing-line">
          <span className="ds-standing-cap">Account standing</span>
          <b>Good standing.</b> <span className="ds-muted">Nothing on your account.</span>
        </span>
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
          <p className="ds-standing-blurb">{tier.blurb}</p>
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

      {/* WHAT THE NEXT ONE COSTS. Both systems this is patterned on publish the next rung
          rather than letting a player find it by hitting it — an escalating ladder only
          deters anything if it can be seen coming. Counted from the ledger the player is
          already looking at, per kind, inside that kind's own window. */}
      {!compact && (
        <>
          <span className="ds-standing-cap">If it happens again</span>
          <ul className="ds-standing-log">
            {(['dodge', 'leave'] as const).map((k) => {
              const prior = data.events.filter(
                (e) => e.kind === k && Date.now() - new Date(e.at).getTime() < WINDOW_HOURS[k] * 3_600_000,
              ).length;
              const p = nextPenalty(k, prior, score);
              return (
                <li key={k}>
                  <span className="ds-standing-what">{STANDING_EVENT_LABEL[k]}</span>
                  <span className="ds-standing-cost ds-muted">
                    {p.cooldownMin > 0 ? lockText(p.cooldownMin) : 'no queue lock'}
                    {p.ratingCharge > 0 && ` · −${p.ratingCharge} rating`}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {score < STANDING_MAX && (
        <p className="ds-hint" style={{ margin: 0 }}>
          {/* THE WAY BACK, always. A score that only ever falls is one players stop trying to
              repair — and finishing your matches is exactly the behaviour being asked for. */}
          Finishing a ranked match without leaving it earns <b>+{HEAL_PER_CLEAN_MATCH}</b> back, and
          standing recovers slowly on its own.
        </p>
      )}
    </div>
  );
}

/** a lock length in the biggest unit that stays exact */
function lockText(min: number): string {
  if (min < 60) return `${min}min queue lock`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h queue lock`;
  return `${Math.round(min / (60 * 24))}-day queue lock`;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
