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
          <a className="ds-home-link" href={LINKS.repo} target="_blank" rel="noreferrer">
            <GitHubGlyph />
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

function GitHubGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
