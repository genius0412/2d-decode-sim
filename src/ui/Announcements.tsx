import { useEffect, useMemo, useState } from 'react';
import type { Announcement, AnnouncementKind } from '../net/api';
import { useAnnouncements } from '../net/announcements';
import { Markdown } from './markdown';

/**
 * Shows unseen announcements once, the first time a player opens the app after one
 * is published. `season`/`act` announcements get a full-screen cinematic reveal
 * first; then a "What's New" modal lists the patch notes. Dismissing marks
 * everything seen (localStorage). Mounted on the menu shell only — never over a
 * live match (respects the "no popups over the field" rule).
 */

const KIND_LABEL: Record<AnnouncementKind, string> = {
  patch: 'Patch notes',
  season: 'New season',
  act: 'New act',
};

/** a short celebratory swell for the cinematic reveal. Best-effort + self-contained
 * (no dependency on the game audio manager); silently no-ops if audio is blocked. */
function playRevealCue(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.22, now + 0.15);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.9);
    master.connect(ctx.destination);
    // a rising major triad → a bright, hopeful "new chapter" chord
    [392, 494, 587, 784].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f * 0.5, now);
      osc.frequency.exponentialRampToValueAtTime(f, now + 0.5 + i * 0.06);
      g.gain.setValueAtTime(0.25, now);
      osc.connect(g).connect(master);
      osc.start(now + i * 0.05);
      osc.stop(now + 2.0);
    });
    setTimeout(() => ctx.close().catch(() => {}), 2200);
  } catch {
    /* audio blocked / unsupported — the reveal is still visual */
  }
}

function KindBadge({ kind }: { kind: AnnouncementKind }): JSX.Element {
  return <span className={`ann-badge ${kind}`}>{KIND_LABEL[kind]}</span>;
}

/** the full-screen cinematic reveal for a new season / act */
function CinematicReveal({
  ann,
  muted,
  onContinue,
}: {
  ann: Announcement;
  muted: boolean;
  onContinue: () => void;
}): JSX.Element {
  useEffect(() => {
    if (!muted) playRevealCue();
    // allow Enter/Space/Esc to advance
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
        e.preventDefault();
        onContinue();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [muted, onContinue]);

  return (
    <div className={`ann-cinema ${ann.kind}`} role="dialog" aria-label={`${KIND_LABEL[ann.kind]}: ${ann.title}`}>
      <div className="ann-cinema-glow" aria-hidden />
      <div className="ann-cinema-inner">
        <p className="ann-cinema-eyebrow">
          <span aria-hidden>✦</span> {ann.kind === 'act' ? 'A NEW ACT' : 'A NEW SEASON'} <span aria-hidden>✦</span>
        </p>
        <h1 className="ann-cinema-title">{ann.title}</h1>
        {ann.tagline && <p className="ann-cinema-tag">{ann.tagline}</p>}
        <div className="ann-cinema-rule" aria-hidden>
          <span />
        </div>
        <button className="ann-cinema-btn" onClick={onContinue} autoFocus>
          CONTINUE
        </button>
      </div>
    </div>
  );
}

/** the "What's New" modal listing all unseen announcements */
function WhatsNew({ items, onClose }: { items: Announcement[]; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay ann-overlay" onClick={onClose}>
      <div className="ann-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="What’s new">
        <p className="ds-eyebrow">What’s new</p>
        <div className="ann-scroll">
          {items.map((a) => (
            <article key={a.id} className={`ann-item ${a.kind}`}>
              <header className="ann-item-head">
                <KindBadge kind={a.kind} />
                <time className="ds-hint">{new Date(a.publishedAt).toLocaleDateString()}</time>
              </header>
              <h2 className="ann-item-title">{a.title}</h2>
              {a.tagline && <p className="ann-item-tag">{a.tagline}</p>}
              {a.body.trim() && <Markdown text={a.body} className="ann-md" />}
            </article>
          ))}
        </div>
        <div className="ann-actions">
          <button className="ds-btn" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export function Announcements({ muted = false }: { muted?: boolean }): JSX.Element | null {
  const { unseen, dismiss } = useAnnouncements();
  // the newest season/act drives the cinematic reveal (shown before the notes)
  const cinematic = useMemo(
    () => unseen.find((a) => a.kind === 'season' || a.kind === 'act') ?? null,
    [unseen],
  );
  const [revealDone, setRevealDone] = useState(false);

  // reset the reveal phase whenever a fresh batch appears
  useEffect(() => {
    setRevealDone(false);
  }, [unseen]);

  if (unseen.length === 0) return null;
  if (cinematic && !revealDone) {
    return <CinematicReveal ann={cinematic} muted={muted} onContinue={() => setRevealDone(true)} />;
  }
  return <WhatsNew items={unseen} onClose={dismiss} />;
}
