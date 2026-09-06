import { useEffect, useState } from 'react';
import {
  adminFetchReports,
  adminFetchReportedUser,
  adminFetchScoreReports,
  adminResolveScoreReport,
  adminSetReportStatus,
  type ScoreReport,
} from '../net/api';
import { REPORT_LABELS, type ReportedUser, type ReportReason } from '../report';
import { STANDING_COST, STANDING_EVENT_LABEL, STANDING_MAX, tierOf, type StandingEventKind } from '../standing';
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
      <ScoreReportQueue onWatchReplay={onWatchReplay} />

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
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof adminFetchReportedUser>>>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!expanded || detail) return;
    void adminFetchReportedUser(u.userId).then((d) => d && setDetail(d));
  }, [expanded, detail, u.userId]);

  const triage = async (status: 'reviewed' | 'dismissed'): Promise<void> => {
    if (
      status === 'reviewed' &&
      !window.confirm(
        `Uphold the reports against ${u.handle}? That costs ${STANDING_COST.reportUpheld} standing, ` +
          'locks them out of ranked, and takes rating — more each time it happens.',
      )
    )
      return;
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
          {/* STANDING is the corroborating half. Reports are what other players CLAIM; this
              is what the server itself watched them do — a full standing next to twelve
              reports reads very differently from a collapsed one. */}
          {typeof u.standing === 'number' && u.standing < STANDING_MAX && (
            <span className={`adm-pill standing${tierOf(u.standing).key === 'good' ? ' ok' : ''}`}>
              {tierOf(u.standing).name} {u.standing}
            </span>
          )}
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
                    {r.detail && <p className="sr-detail">{r.detail}</p>}
                  </div>
                ))}
              </div>

              {detail.standingEvents.length > 0 && (
                <>
                  <h4 className="adm-h3">
                    What the server saw{detail.standing ? ` — standing ${detail.standing.score}/${STANDING_MAX}` : ''}
                  </h4>
                  <div className="adm-report-list">
                    {detail.standingEvents.slice(0, 8).map((e) => (
                      <div className="adm-report-item row" key={e.id}>
                        <span className="ds-muted">
                          {STANDING_EVENT_LABEL[e.kind as StandingEventKind] ?? e.kind} · −{e.points}
                          {e.cooldownMin > 0 && ` · ${e.cooldownMin}min lock`}
                          {e.ratingCharge > 0 && ` · −${e.ratingCharge} rating`}
                          {' · '}{ago(e.at)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

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
                          Watch replay
                        </button>
                      ) : (
                        <span className="ds-muted" title="This match saved no replay">no replay</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="sr-actions">
                {/* Triage marks the PLAYER, not each complaint — that is how the queue is
                    actually worked: you watch their matches and then make one call. */}
                <button className="ds-btn ghost small" disabled={busy || u.open === 0} onClick={() => void triage('dismissed')}>
                  Dismiss {u.open > 0 ? `(${u.open})` : ''}
                </button>
                <button className="ds-btn small" disabled={busy || u.open === 0} onClick={() => void triage('reviewed')}>
                  Uphold {u.open > 0 ? `(${u.open})` : ''}
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

/**
 * The MISSCORE queue — claims about a RESULT rather than about a person.
 *
 * Its own section because it is answered differently. A player report is judged by watching
 * someone drive; a misscore is judged by opening the replay and checking the arithmetic, and
 * the verdict is about the SCORE, not about the reporter. The reporter only enters it when
 * the claim turns out to be empty — which is what SMITE is for, and why every row shows how
 * many claims that person has filed and how many were rejected before offering it.
 *
 * UPHOLD costs nobody anything. There is no automatic re-score behind it: a result that has
 * been written, rated and published cannot be quietly rewritten from a moderation panel, and
 * pretending otherwise would be worse than leaving it. What upholding does is mark the claim
 * as real, which is what stops the filer's rejected-count from growing and is the record that
 * the sim got something wrong.
 */
function ScoreReportQueue({ onWatchReplay }: { onWatchReplay?: (replayId: string) => void }) {
  const [rows, setRows] = useState<ScoreReport[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = (): void => {
    void adminFetchScoreReports('open').then((r) => setRows(r ?? []));
  };
  useEffect(load, []);
  if (!rows || rows.length === 0) return null;

  const resolve = (id: string, verdict: 'upheld' | 'rejected', smite: number): void => {
    if (
      smite > 0 &&
      !window.confirm(
        `Reject this report and take ${smite} standing from the player who filed it? ` +
          'Only for a claim made in bad faith.',
      )
    )
      return;
    setBusy(id);
    void adminResolveScoreReport(id, verdict, smite).then(() => {
      setBusy(null);
      load();
    });
  };

  return (
    <>
      <h2 className="ds-h2">Moderation · misscores</h2>
      <p className="ds-sub" style={{ margin: '0 0 16px' }}>
        Claims that a match scored wrong. Open the replay and check it: UPHELD records that the
        sim got it wrong, REJECTED closes it. Smite only a claim that was made in bad faith —
        the count beside each filer is how many of theirs have been rejected before.
      </p>
      <div className="sr-list">
        {rows.map((r) => (
          <div key={r.id} className="sr-row">
            <div className="sr-head">
              <span className="adm-name">{r.reporterUsername ?? r.reporterHandle}</span>
              <span className="adm-pill">{GAME_LABEL[r.game] ?? r.game}</span>
              {r.reporterRejected > 0 && (
                <span className="adm-pill standing">
                  {r.reporterRejected} of {r.reporterFiled} rejected
                </span>
              )}
              <span className="ds-muted">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            <p className="adm-report-detail">{r.detail}</p>
            <div className="adm-report-actions">
              {r.matchId && onWatchReplay && (
                <button className="ds-btn ghost" onClick={() => onWatchReplay(r.matchId!)}>
                  WATCH
                </button>
              )}
              <button
                className="ds-btn ghost"
                disabled={busy === r.id}
                onClick={() => resolve(r.id, 'upheld', 0)}
              >
                UPHELD
              </button>
              <button
                className="ds-btn ghost"
                disabled={busy === r.id}
                onClick={() => resolve(r.id, 'rejected', 0)}
              >
                REJECT
              </button>
              {/* the smite, sized by the moderator. Three rungs rather than a free number:
                  "wrong", "wrong again", and "using the queue as a weapon" are the three
                  judgements actually being made, and a text box invites a fourth that is just
                  a mood. */}
              {[25, 50, 100].map((n) => (
                <button
                  key={n}
                  className="ds-btn danger"
                  disabled={busy === r.id}
                  onClick={() => resolve(r.id, 'rejected', n)}
                  title={`Reject and take ${n} standing points off ${r.reporterUsername ?? r.reporterHandle}`}
                >
                  SMITE −{n}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
