import { useEffect, useState } from 'react';
import { fetchAnnouncements, type Announcement, type AnnouncementKind } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { APP_NAME, LINKS } from '../seasons';
import { Markdown } from './markdown';

const KIND_LABEL: Record<AnnouncementKind, string> = {
  patch: 'Patch notes',
  season: 'New season',
  act: 'New act',
};

/**
 * Changelog — every published announcement (patch notes, new seasons, new
 * acts), newest first, on its own page rather than the one-time "What's New"
 * modal (`Announcements.tsx`, which only ever shows the last few UNSEEN ones
 * and then never again). Reached from the footer's "Changes" button, which
 * replaced the bare GitHub link — GitHub is still one click away via the
 * button in the panel header, it's just not the footer's top billing anymore.
 */
export function Changelog() {
  const configured = gameServerConfigured();
  const [items, setItems] = useState<Announcement[] | null>(null);

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchAnnouncements(100).then((a) => {
      if (alive) setItems(a);
    });
    return () => {
      alive = false;
    };
  }, [configured]);

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Changelog</p>
      <h1 className="ds-h1">Changes</h1>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">What's changed</span>
          <a className="ds-btn" href={LINKS.repo} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
        <div style={{ padding: 16 }}>
          {!configured ? (
            <div className="ds-empty">
              <div className="big">No changelog yet</div>
              Changelogs need the game server (set <code>VITE_GAME_SERVER_URL</code>).
            </div>
          ) : items === null ? (
            <p className="ds-hint">Loading…</p>
          ) : items.length === 0 ? (
            <div className="ds-empty">
              <div className="big">Nothing published yet</div>
              Check back after the next patch, season, or act.
            </div>
          ) : (
            <div className="cl-list">
              {items.map((a) => (
                <article key={a.id} className={`ann-item ${a.kind}`}>
                  <header className="ann-item-head">
                    <span className={`ann-badge ${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <time className="ds-hint">{new Date(a.publishedAt).toLocaleDateString()}</time>
                  </header>
                  <h2 className="ann-item-title">{a.title}</h2>
                  {a.tagline && <p className="ann-item-tag">{a.tagline}</p>}
                  {a.body.trim() && <Markdown text={a.body} className="ann-md" />}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
