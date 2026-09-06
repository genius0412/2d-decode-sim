import { useState } from 'react';
import {
  REPORT_REASONS,
  REPORT_LABELS,
  REPORT_DETAIL_MAX,
  type ReportReason,
} from '../report';

/**
 * Report another driver, from the post-match results screen.
 *
 * POST-MATCH is the right and only place for this. It is the moment a player has just
 * witnessed the thing they want to report, they can still see who did it, and the match
 * they were in is the evidence a moderator will actually look at. Reporting from a profile
 * would mean reporting someone you cannot currently see doing anything, and an in-match
 * button would ask a driver to stop driving to fill in a form.
 *
 * The target is identified by ROBOT ID, never a user id — the client is never told who its
 * opponents are, and `Room.resolveReport` maps the id onto an account server-side. So this
 * component genuinely cannot report anyone outside the match it was opened from.
 *
 * There is no confirmation of what happened to the report, deliberately. A duplicate, an
 * anonymous opponent and an accepted report all answer the same way: telling them apart
 * would turn the button into a probe for who is signed in and who has been reported before.
 */
export function ReportDialog({
  drivers,
  onSubmit,
  onClose,
}: {
  /** the opponents this player may report: robot id + the name they played under */
  drivers: { robotId: number; name: string }[];
  onSubmit: (robotId: number, reason: ReportReason, detail: string) => void;
  onClose: () => void;
}) {
  const [robotId, setRobotId] = useState<number | null>(drivers.length === 1 ? drivers[0].robotId : null);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [sent, setSent] = useState(false);
  // "Something else" without a description is not actionable — a moderator opening it learns
  // nothing at all — so it is the one category that requires the note.
  const needsDetail = reason === 'other';
  const ready = robotId !== null && reason !== null && (!needsDetail || detail.trim().length > 0);

  if (sent) {
    return (
      <div className="ds-report">
        <h3 className="ds-report-h">Report submitted</h3>
        <p className="ds-hint">
          A moderator will check it against the match. One report is enough.
        </p>
        <div className="ds-report-actions">
          <button className="ds-btn" onClick={onClose}>CLOSE</button>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-report">
      <h3 className="ds-report-h">Report a player</h3>

      {drivers.length > 1 && (
        <>
          <span className="ds-report-cap">Who</span>
          <div className="ds-opts">
            {drivers.map((d) => (
              <button
                key={d.robotId}
                type="button"
                className={`ds-opt mini ${robotId === d.robotId ? 'on' : ''}`}
                onClick={() => setRobotId(d.robotId)}
              >
                <span className="ot">{d.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <span className="ds-report-cap">Why</span>
      {/* MINI, and no blurb. Six full option cards each carrying a sentence turned a
          dialog into a page — and every one of those sentences restated its own label
          ("Not playing / AFK" / "Present but not driving, for most of the match"). The
          "Who" grid above is already mini; these now match it. */}
      <div className="ds-opts two">
        {REPORT_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            className={`ds-opt mini ${reason === r ? 'on' : ''}`}
            onClick={() => setReason(r)}
          >
            <span className="ot">{REPORT_LABELS[r]}</span>
          </button>
        ))}
      </div>

      <label className="ds-field col">
        <span className="cap">
          What happened {needsDetail ? <b>(required)</b> : <span className="ds-muted">(optional)</span>}
        </span>
        <textarea
          className="ds-input"
          rows={3}
          maxLength={REPORT_DETAIL_MAX}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Anything that helps a moderator find it in the replay"
        />
        <span className="ds-hint" style={{ margin: 0 }}>
          {detail.length}/{REPORT_DETAIL_MAX}
        </span>
      </label>

      <div className="ds-report-actions">
        <button className="ds-btn ghost" onClick={onClose}>CANCEL</button>
        <button
          className="ds-btn"
          disabled={!ready}
          onClick={() => {
            if (!ready || robotId === null || reason === null) return;
            onSubmit(robotId, reason, detail.trim());
            setSent(true);
          }}
        >
          SUBMIT REPORT
        </button>
      </div>
    </div>
  );
}
