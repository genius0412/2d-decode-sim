import { useEffect, useState } from 'react';
import {
  adminFetchReports,
  adminFetchReportedUser,
  adminSetReportStatus,
  type ModMatch,
} from '../net/api';
import { REPORT_LABELS, type ReportedUser, type ReportRow, type ReportReason } from '../report';
import { SEASONS } from '../seasons';

/**
 * The REPORT QUEUE — who has been reported, how often, for what, by how many people, and
 * (the part that makes it workable) their actual matches, one click from a replay.
 *
 * A report for cheating or throwing cannot be judged from its text. The moderator has to
 * watch the match. A queue that shows the complaint but makes them go and hunt for the
 * replay somewhere else is a queue that quietly stops being worked, so the drill-down loads
 * the reports AND the reported player's recent matches in one request and puts a WATCH
 * button on every one that has a replay.
 *
 * DISTINCT REPORTERS is shown next to the total on purpose. Four reports from four people
 * and four from one are completely different signals — one is a pattern, the other might be
 * a grudge — and a queue sorted only on volume rewards whoever clicks hardest.
 */
const GAME_LABEL: Record<string, string> = Object.fromEntries(SEASONS.map((s) => [s.key, s.name]));

export function AdminReports({ onWatchReplay }: { onWatchReplay?: (replayId: string) => void }) {
  const [users, setUsers] = useState<ReportedUser[] | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = (): void => {
    void adminFetchReports().then((u) => {
      setErr(u === null);
      if (u) setUsers(u);
    });
  };
  useEffect(load, []);

  return (
    <>
      <h2 className="ds-h2">Moderation · reports</h2>
      <p className="ds-sub" style={{ margin: '0 0 16px' }}>
        Players other players have reported, most recently reported first. Open one to read the
        reports and watch their recent matches — a cheating or throwing report is only
        judgeable from the replay.
      </p>

      {err && !users ? (
        <div className="ds-empty">
          <div className="big">Couldn’t load reports</div>
          The game server is unreachable, or this account isn’t an admin on it.
        </div>
      ) : !users ? (
        <div className="ds-loading">Loading reports…</div>
      ) : users.length === 0 ? (
        <div className="ds-empty">
          <div className="big">No reports</div>
          Nobody has been reported yet.
        </div>
      ) : (
        <div className="adm-reports">
          {users.map((u) => (
            <ReportedRow
              key={u.userId}
              u={u}
              expanded={open === u.userId}
              onToggle={() => setOpen(open === u.userId ? null : u.userId)}
              onWatchReplay={onWatchReplay}
              onTriaged={load}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ReportedRow({
  u,
  expanded,
  onToggle,
  onWatchReplay,
  onTriaged,
}: {
  u: ReportedUser;
  expanded: boolean;
  onToggle: () => void;
  onWatchReplay?: (replayId: string) => void;
  onTriaged: () => void;
}) {
  const [detail, setDetail] = useState<{ reports: ReportRow[]; matches: ModMatch[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!expanded || detail) return;
    void adminFetchReportedUser(u.userId).then((d) => d && setDetail(d));
  }, [expanded, detail, u.userId]);

  const triage = async (status: 'reviewed' | 'dismissed'): Promise<void> => {
    setBusy(true);
    await adminSetReportStatus(u.userId, status);
    setBusy(false);
    setDetail(null);
    onTriaged();
  };

  return (
    <div className={`adm-report ${expanded ? 'open' : ''}`}>
      <button className="adm-report-head" onClick={onToggle}>
        <span className="adm-report-who">
          <b>{u.handle}</b>
          {u.username && <span className="ds-muted"> @{u.username}</span>}
        </span>
        <span className="adm-report-counts">
          {/* OPEN is the number a moderator is working through; TOTAL is the history. Both,
              because a player with 1 open and 40 reviewed is a different problem. */}
          {u.open > 0 && <span className="adm-pill queued">{u.open} open</span>}
          <span className="adm-pill">{u.total} total</span>
          <span className="adm-pill">{u.reporters} reporter{u.reporters === 1 ? '' : 's'}</span>
        </span>
        <span className="adm-report-reasons ds-muted">
          {u.reasons.slice(0, 3).map((r) => `${REPORT_LABELS[r.reason as ReportReason] ?? r.reason} ×${r.n}`).join(' · ')}
        </span>
        <span className="adm-report-when ds-muted">{ago(u.latest)}</span>
        <span className="adm-report-caret">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="adm-report-body">
          {!detail ? (
            <div className="ds-loading">Loading…</div>
          ) : (
            <>
              <h4 className="adm-h3">Reports</h4>
              <div className="adm-report-list">
                {detail.reports.map((r) => (
                  <div className="adm-report-item" key={r.id}>
                    <span className="adm-pill">{REPORT_LABELS[r.reason] ?? r.reason}</span>
                    <span className="adm-report-by ds-muted">
                      by {r.reporterUsername ? `@${r.reporterUsername}` : r.reporterHandle} · {ago(r.createdAt)}
                      {r.roomCode && ` · room ${r.roomCode}`}
                      {r.status !== 'open' && ` · ${r.status}`}
                    </span>
                    {r.detail && <p className="adm-report-detail">{r.detail}</p>}
                  </div>
                ))}
              </div>

              <h4 className="adm-h3">Their recent matches</h4>
              {detail.matches.length === 0 ? (
                <p className="ds-hint">No matches on record for this player.</p>
              ) : (
                <div className="adm-report-list">
                  {detail.matches.map((m) => (
                    <div className="adm-report-item row" key={m.matchId}>
                      <span className="ds-muted">
                        {GAME_LABEL[m.game] ?? m.game} · {m.ranked ? 'Ranked' : 'Custom'} {m.mode} ·{' '}
                        {m.score} pts · {m.won === null ? '—' : m.won ? 'won' : 'lost'} · {ago(m.createdAt)}
                      </span>
                      {m.replayId && onWatchReplay ? (
                        <button className="ds-btn small" onClick={() => onWatchReplay(m.replayId as string)}>
                          ▶ Watch
                        </button>
                      ) : (
                        <span className="ds-muted" title="This match saved no replay">no replay</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="adm-report-actions">
                {/* Triage marks the PLAYER, not each complaint — that is how the queue is
                    actually worked: you watch their matches and then make one call. */}
                <button className="ds-btn ghost small" disabled={busy || u.open === 0} onClick={() => void triage('dismissed')}>
                  Dismiss {u.open > 0 ? `(${u.open})` : ''}
                </button>
                <button className="ds-btn small" disabled={busy || u.open === 0} onClick={() => void triage('reviewed')}>
                  Mark reviewed
                </button>
              </div>
            </>
          )}
        </div>
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
