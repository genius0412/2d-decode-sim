import { useEffect, useState } from 'react';
import { fetchStanding, type StandingEvent, type StandingInfo } from '../net/api';
import {
  HEAL_PER_CLEAN_MATCH,
  STANDING_EVENT_LABEL,
  STANDING_MAX,
  lockRemaining,
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
    return (
      <div className="ds-standing good">
        <span className="ds-standing-dot" data-tier={tier.key} aria-hidden />
        <span className="ds-standing-line">
          <b>Good standing.</b> <span className="ds-muted">Nothing on your account.</span>
        </span>
      </div>
    );
  }

  return (
    <div className={`ds-standing ${compact ? 'compact' : ''}`} data-tier={tier.key}>
      <div className="ds-standing-head">
        <span className="ds-standing-dot" data-tier={tier.key} aria-hidden />
        <span className="ds-standing-name">{tier.name}</span>
        <span className="ds-standing-score">
          {score}
          <span className="ds-muted">/{STANDING_MAX}</span>
        </span>
      </div>

      <span className="ds-standing-bar" aria-hidden>
        <span className="ds-standing-fill" style={{ width: `${Math.round((score / STANDING_MAX) * 100)}%` }} />
      </span>

      <p className="ds-standing-blurb">{tier.blurb}</p>

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

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
