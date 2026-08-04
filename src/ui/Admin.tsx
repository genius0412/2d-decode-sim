import { useEffect, useState } from 'react';
import {
  adminAnnounce,
  adminCancelNotice,
  adminPurgeReplays,
  adminStartSeason,
  adminFetchRecords,
  adminDeleteRecord,
  adminClearUserRecords,
  adminSearchUsers,
  adminRenameUser,
  adminGrantSupporter,
  adminRevokeSupporter,
  adminSupporterHistory,
  type AdminUserRow,
  type SupporterGrantRow,
  adminPublishAnnouncement,
  adminDeleteAnnouncement,
  fetchAnnouncements,
  type AdminRecordRow,
  type Announcement,
  type AnnouncementKind,
} from '../net/api';
import { Markdown } from './markdown';
import { AdminLive } from './AdminLive';

type AdminTab = 'live' | 'server' | 'content' | 'moderation';
const TABS: { id: AdminTab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'server', label: 'Server' },
  { id: 'content', label: 'Content' },
  { id: 'moderation', label: 'Moderation' },
];

/** the console's title + tab bar. Split out so the Live tab (which renders a very
 *  different body) shares exactly the same chrome instead of a near-copy of it. */
function AdminHeader({ tab, setTab }: { tab: AdminTab; setTab: (t: AdminTab) => void }) {
  return (
    <>
      <p className="ds-eyebrow">Admin</p>
      <h1 className="ds-h1">Control panel</h1>
      <div className="adm-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`adm-tab${tab === t.id ? ' on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

type RecMode = 'solo' | 'duo';
const DRIVETRAINS = ['overall', 'mecanum', 'tank', 'swerve', 'xdrive'] as const;
const ANN_KINDS: { value: AnnouncementKind; label: string }[] = [
  { value: 'patch', label: 'Patch notes / bug fixes' },
  { value: 'season', label: 'New season (cinematic)' },
  { value: 'act', label: 'New act (cinematic)' },
];

/** admin console — only reachable by the account(s) in the server's ADMIN_USER_IDS.
 * Broadcasts a scheduled-restart countdown to every connected player; then you
 * deploy when it reaches 0. Also manages competitive SEASONS. */
export function Admin({ onWatch }: { onWatch?: (room: string) => void }) {
  // LIVE first: it is the tab you open during an incident, and the panel's other
  // jobs are all deliberate, unhurried ones you go looking for.
  const [tab, setTab] = useState<AdminTab>('live');
  const [minutes, setMinutes] = useState(5);
  const [message, setMessage] = useState('Scheduled server update');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [seasonName, setSeasonName] = useState('');
  const [seasonStatus, setSeasonStatus] = useState<string | null>(null);
  const [seasonBusy, setSeasonBusy] = useState(false);

  // moderation — leaderboard records
  const [recMode, setRecMode] = useState<RecMode>('solo');
  const [recDt, setRecDt] = useState<string>('overall');
  const [records, setRecords] = useState<AdminRecordRow[]>([]);
  const [recStatus, setRecStatus] = useState<string | null>(null);
  const [recBusy, setRecBusy] = useState(false);

  // announcements — patch notes / new-season + new-act reveals
  const [annKind, setAnnKind] = useState<AnnouncementKind>('patch');
  const [annTitle, setAnnTitle] = useState('');
  const [annTagline, setAnnTagline] = useState('');
  const [annBody, setAnnBody] = useState('');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annStatus, setAnnStatus] = useState<string | null>(null);
  const [annBusy, setAnnBusy] = useState(false);

  // moderation — user display names
  const [userQuery, setUserQuery] = useState('');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [rename, setRename] = useState<Record<string, string>>({});
  // supporter memberships — comps and chargebacks, on the same rows as the name
  // moderation above (one search, two jobs; a second search box would just be a
  // second place to paste the same user id).
  const [grantMonths, setGrantMonths] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, SupporterGrantRow[]>>({});
  const [userStatus, setUserStatus] = useState<string | null>(null);
  const [userBusy, setUserBusy] = useState(false);

  const loadRecords = async (): Promise<void> => {
    setRecBusy(true);
    const rows = await adminFetchRecords(recMode, recDt);
    setRecBusy(false);
    setRecords(rows);
    setRecStatus(rows.length ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.` : 'No records in this bucket (or not signed in as admin).');
  };

  const deleteRecord = async (row: AdminRecordRow): Promise<void> => {
    if (!window.confirm(`Delete ${row.handle}'s ${row.score}-pt ${row.drivetrain} run? This removes the run + its replay and cannot be undone.`)) return;
    setRecBusy(true);
    const ok = await adminDeleteRecord(row.recordId);
    setRecBusy(false);
    if (ok) setRecords((rs) => rs.filter((r) => r.recordId !== row.recordId));
    setRecStatus(ok ? `Deleted ${row.handle}'s run.` : 'Failed - check admin sign-in.');
  };

  const clearUser = async (row: AdminRecordRow): Promise<void> => {
    if (!window.confirm(`Delete ALL of ${row.handle}'s record runs (every mode/drivetrain)? For a confirmed cheater. Cannot be undone.`)) return;
    setRecBusy(true);
    const removed = await adminClearUserRecords(row.userId);
    setRecBusy(false);
    if (removed != null) setRecords((rs) => rs.filter((r) => r.userId !== row.userId));
    setRecStatus(removed != null ? `Cleared ${removed} run${removed === 1 ? '' : 's'} by ${row.handle}.` : 'Failed - check admin sign-in.');
  };

  const searchUsers = async (): Promise<void> => {
    setUserBusy(true);
    const found = await adminSearchUsers(userQuery);
    setUserBusy(false);
    setUsers(found);
    setRename(Object.fromEntries(found.map((u) => [u.userId, u.handle])));
    setUserStatus(found.length ? `${found.length} match${found.length === 1 ? '' : 'es'}.` : 'No matches (or not signed in as admin).');
  };

  const renameUser = async (userId: string, current: string): Promise<void> => {
    const next = (rename[userId] ?? '').trim();
    if (next === current) return;
    if (next.length < 2 || next.length > 24) {
      setUserStatus('Name must be 2–24 characters.');
      return;
    }
    if (!window.confirm(`Rename "${current}" to "${next}"?`)) return;
    setUserBusy(true);
    const saved = await adminRenameUser(userId, next);
    setUserBusy(false);
    if (saved) setUsers((us) => us.map((u) => (u.userId === userId ? { ...u, handle: saved } : u)));
    setUserStatus(saved ? `Renamed to "${saved}".` : 'Failed - check admin sign-in.');
  };

  /** comp a membership. Confirmed because it costs real money to honour. */
  const grantSupporter = async (u: AdminUserRow): Promise<void> => {
    const months = Math.floor(Number(grantMonths[u.userId] ?? '1'));
    if (!Number.isFinite(months) || months < 1 || months > 60) {
      setUserStatus('Months must be 1–60.');
      return;
    }
    const reason = window.prompt(`Give ${u.handle} ${months} month(s) of supporter. Reason?`, '');
    if (reason === null) return;
    setUserBusy(true);
    const r = await adminGrantSupporter(u.userId, months, reason);
    setUserBusy(false);
    if (!r) {
      setUserStatus('Failed - check admin sign-in.');
      return;
    }
    setUsers((us) =>
      us.map((x) =>
        x.userId === u.userId ? { ...x, supporter: true, supporterUntil: r.until } : x,
      ),
    );
    setUserStatus(
      `${u.handle} is a supporter until ${r.until ? new Date(r.until).toLocaleDateString() : '-'}.`,
    );
    void loadHistory(u.userId);
  };

  /** end a membership now — a chargeback, or a comp given in error */
  const revokeSupporter = async (u: AdminUserRow): Promise<void> => {
    const reason = window.prompt(`Revoke ${u.handle}'s supporter membership. Reason?`, 'chargeback');
    if (reason === null) return;
    setUserBusy(true);
    const r = await adminRevokeSupporter(u.userId, reason);
    setUserBusy(false);
    if (!r) {
      setUserStatus('Failed - check admin sign-in.');
      return;
    }
    setUsers((us) =>
      us.map((x) =>
        x.userId === u.userId ? { ...x, supporter: false, supporterUntil: null } : x,
      ),
    );
    setUserStatus(r.revoked ? `Revoked ${u.handle}'s membership.` : 'Nothing to revoke.');
    void loadHistory(u.userId);
  };

  const loadHistory = async (userId: string): Promise<void> => {
    const grants = await adminSupporterHistory(userId);
    setHistory((h) => ({ ...h, [userId]: grants }));
  };

  const run = async (fn: () => Promise<boolean>, okMsg: string): Promise<void> => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    setStatus(ok ? okMsg : 'Failed - are you still signed in as an admin?');
  };

  const startSeason = async (newAct: boolean): Promise<void> => {
    const what = newAct ? 'ACT' : 'season';
    if (
      !window.confirm(
        `Archive the live leaderboards and start a fresh ${what}? Old boards stay viewable.` +
          (newAct ? ' A new act resets the season count to 1.' : ''),
      )
    )
      return;
    setSeasonBusy(true);
    const season = await adminStartSeason(seasonName, { newAct });
    setSeasonBusy(false);
    setSeasonStatus(
      season != null
        ? `Started a new ${what}. New runs now score onto it; older periods are archived but still viewable.`
        : 'Failed - are you still signed in as an admin (and is the DB configured)?',
    );
  };

  const purgeReplays = async (): Promise<void> => {
    if (!window.confirm('Delete the replays of every ARCHIVED season? Boards stay; those runs just stop being watchable. This frees storage and cannot be undone.')) return;
    setSeasonBusy(true);
    const freed = await adminPurgeReplays();
    setSeasonBusy(false);
    setSeasonStatus(
      freed != null ? `Purged ${freed} archived-season replay${freed === 1 ? '' : 's'}.` : 'Failed - check admin sign-in / DB.',
    );
  };

  const loadAnnouncements = async (): Promise<void> => {
    const rows = await fetchAnnouncements(50);
    setAnnouncements(rows);
  };
  // pull the current feed once so the admin sees what's live + can retire old ones
  useEffect(() => {
    void loadAnnouncements();
  }, []);

  const publishAnnouncement = async (): Promise<void> => {
    const title = annTitle.trim();
    if (title.length < 2) {
      setAnnStatus('Give it a title (2+ characters).');
      return;
    }
    setAnnBusy(true);
    const created = await adminPublishAnnouncement({
      kind: annKind,
      title,
      body: annBody,
      tagline: annTagline.trim() || undefined,
    });
    setAnnBusy(false);
    if (created) {
      setAnnouncements((rows) => [created, ...rows]);
      setAnnTitle('');
      setAnnTagline('');
      setAnnBody('');
      setAnnStatus(`Published - players see it on their next load. ${created.kind === 'patch' ? '' : 'It plays a cinematic reveal.'}`);
    } else {
      setAnnStatus('Failed - check admin sign-in / DB.');
    }
  };

  const retireAnnouncement = async (a: Announcement): Promise<void> => {
    if (!window.confirm(`Retire "${a.title}"? It stops appearing for anyone who hasn't seen it yet.`)) return;
    setAnnBusy(true);
    const ok = await adminDeleteAnnouncement(a.id);
    setAnnBusy(false);
    if (ok) setAnnouncements((rows) => rows.filter((r) => r.id !== a.id));
    setAnnStatus(ok ? `Retired "${a.title}".` : 'Failed - check admin sign-in.');
  };

  const isCinematic = annKind !== 'patch';

  // TABS rather than one long scroll. The panel had grown to five unrelated jobs
  // stacked vertically, so the one you actually needed was always a scroll away —
  // and the live ops view (the thing you open during an incident) would have been
  // furthest down. It leads instead.
  if (tab === 'live') {
    return (
      <div className="ds-section adm-wide">
        <AdminHeader tab={tab} setTab={setTab} />
        <AdminLive onWatch={onWatch} />
      </div>
    );
  }

  return (
    <div className="ds-section adm-wide">
      <AdminHeader tab={tab} setTab={setTab} />

      {tab === 'server' && (
        <>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Announce a restart to every connected player with a live countdown, then deploy the
        server when it hits zero. Players see a banner; anyone already playing gets warned.
      </p>

      <div className="admin-card">
        <label className="admin-field">
          <span>Restart in</span>
          <input
            type="number"
            min={0}
            max={60}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
          />
          <span>minutes</span>
        </label>
        <label className="admin-field col">
          <span>Message</span>
          <input type="text" value={message} maxLength={90} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <div className="admin-buttons">
          <button
            className="ds-btn"
            disabled={busy}
            onClick={() => run(() => adminAnnounce(minutes * 60, message), `Announced - restart in ${minutes} min.`)}
          >
            ANNOUNCE RESTART
          </button>
          <button
            className="ds-btn ghost"
            disabled={busy}
            onClick={() => run(() => adminCancelNotice(), 'Notice cleared.')}
          >
            CANCEL NOTICE
          </button>
        </div>
        {status && <p className="ds-hint" style={{ marginTop: 12 }}>{status}</p>}
      </div>
      <p className="ds-hint" style={{ marginTop: 16 }}>
        Reminder: this only warns players - it doesn’t restart the server. Run your deploy when
        the countdown reaches 0.
      </p>
        </>
      )}

      {tab === 'content' && (
        <>
      <h2 className="ds-h2">Announcements</h2>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Publish patch notes, bug-fix summaries, or a new season / act. Each player sees it once -
        the first time they open the app after you publish. A new season or act plays a full-screen
        cinematic reveal; patch notes show in a “What’s new” panel.
      </p>
      <div className="admin-card">
        <label className="admin-field col">
          <span>Type</span>
          <select value={annKind} onChange={(e) => setAnnKind(e.target.value as AnnouncementKind)}>
            {ANN_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="admin-field col">
          <span>{isCinematic ? 'Title (the big reveal headline)' : 'Title'}</span>
          <input
            type="text"
            value={annTitle}
            maxLength={80}
            placeholder={isCinematic ? 'e.g. Act II - The Rising Tide' : 'e.g. Build 42 - gate + intake fixes'}
            onChange={(e) => setAnnTitle(e.target.value)}
          />
        </label>
        {isCinematic && (
          <label className="admin-field col">
            <span>Tagline (optional subtitle under the reveal)</span>
            <input
              type="text"
              value={annTagline}
              maxLength={80}
              placeholder="e.g. A NEW SEASON BEGINS"
              onChange={(e) => setAnnTagline(e.target.value)}
            />
          </label>
        )}
        <label className="admin-field col">
          <span>{isCinematic ? 'Details (shown in “What’s new”) - Markdown' : 'Notes - Markdown'}</span>
          <textarea
            className="admin-textarea"
            value={annBody}
            maxLength={8000}
            rows={8}
            placeholder={'## Gate & Intake\n- Fixed the gate lever swinging closed on a **resting** robot\n- Faster basin drain\n\n## Drivetrain\n- New swerve pod wobble tuning - see [the notes](https://example.com)'}
            onChange={(e) => setAnnBody(e.target.value)}
          />
          <span className="ds-hint" style={{ marginTop: 4 }}>
            Supports Markdown: <code>## headings</code>, <code>**bold**</code>, <code>- bullets</code>{' '}
            (indent to nest), <code>[links](url)</code>, <code>---</code> rules.
          </span>
        </label>
        {annBody.trim() && (
          <div className="admin-field col">
            <span className="ds-hint">Preview</span>
            <div className="ann-item" style={{ borderLeftColor: 'var(--ds-accent)' }}>
              <Markdown text={annBody} className="ann-md" />
            </div>
          </div>
        )}
        <div className="admin-buttons">
          <button className="ds-btn" disabled={annBusy} onClick={publishAnnouncement}>
            PUBLISH
          </button>
        </div>
        {annStatus && <p className="ds-hint" style={{ marginTop: 12 }}>{annStatus}</p>}
        {announcements.length > 0 && (
          <div className="admin-list" style={{ marginTop: 12 }}>
            {announcements.map((a) => (
              <div key={a.id} className="admin-row">
                <span className={`ann-badge ${a.kind}`}>{a.kind}</span>
                <span className="admin-grow">
                  <strong>{a.title}</strong>
                  <span className="ds-hint"> · {new Date(a.publishedAt).toLocaleDateString()}</span>
                </span>
                <button className="ds-btn ghost sm danger" disabled={annBusy} onClick={() => retireAnnouncement(a)}>
                  RETIRE
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 className="ds-h2" style={{ marginTop: 32 }}>Acts &amp; Seasons</h2>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Competitive periods are grouped Act → Season (both 1-indexed; Act 0 is the beta).
        A <b>new season</b> resets the boards within the current act; a <b>new act</b> also
        rolls the act and restarts the season count at 1, firing the “A NEW ACT” cinematic.
        Past periods stay fully viewable in the leaderboard’s picker; only new runs score onto
        the live one. Leave the name blank to auto-label “Act X · Season Y”.
      </p>
      <div className="admin-card">
        <label className="admin-field col">
          <span>Custom title (optional)</span>
          <input
            type="text"
            value={seasonName}
            maxLength={40}
            placeholder="e.g. Spring Showdown - blank ⇒ Act X · Season Y"
            onChange={(e) => setSeasonName(e.target.value)}
          />
        </label>
        <div className="admin-buttons">
          <button className="ds-btn" disabled={seasonBusy} onClick={() => startSeason(false)}>
            START NEW SEASON
          </button>
          <button className="ds-btn" disabled={seasonBusy} onClick={() => startSeason(true)}>
            START NEW ACT
          </button>
          <button className="ds-btn ghost" disabled={seasonBusy} onClick={purgeReplays}>
            PURGE ARCHIVED REPLAYS
          </button>
        </div>
        {seasonStatus && <p className="ds-hint" style={{ marginTop: 12 }}>{seasonStatus}</p>}
      </div>

        </>
      )}

      {tab === 'moderation' && (
        <>
      <h2 className="ds-h2">Moderation - records</h2>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Inspect a leaderboard bucket (live season) and remove cheated or invalid runs. Deleting a
        run also deletes its replay. “Clear all” wipes every run by that player - for confirmed
        cheaters.
      </p>
      <div className="admin-card">
        <div className="admin-field">
          <span>Board</span>
          <select value={recMode} onChange={(e) => setRecMode(e.target.value as RecMode)}>
            <option value="solo">Solo</option>
            <option value="duo">Duo</option>
          </select>
          <select value={recDt} onChange={(e) => setRecDt(e.target.value)}>
            {DRIVETRAINS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <button className="ds-btn" disabled={recBusy} onClick={loadRecords}>
            LOAD
          </button>
        </div>
        {records.length > 0 && (
          <div className="admin-list" style={{ marginTop: 12 }}>
            {records.map((r, i) => (
              <div key={r.recordId} className="admin-row">
                <span className="admin-rank">{i + 1}</span>
                <span className="admin-grow">
                  <strong>{r.handle}</strong> · {r.score} pts · {r.drivetrain}
                  <span className="ds-hint"> · {new Date(r.createdAt).toLocaleDateString()}</span>
                </span>
                <button className="ds-btn ghost sm" disabled={recBusy} onClick={() => deleteRecord(r)}>
                  DELETE
                </button>
                <button className="ds-btn ghost sm danger" disabled={recBusy} onClick={() => clearUser(r)}>
                  CLEAR ALL
                </button>
              </div>
            ))}
          </div>
        )}
        {recStatus && <p className="ds-hint" style={{ marginTop: 12 }}>{recStatus}</p>}
      </div>

      {/* main's heading was "Moderation - display names"; this section now does
          memberships too. Hyphen, not an em dash, per main's site-wide copy pass. */}
      <h2 className="ds-h2" style={{ marginTop: 32 }}>Players - names &amp; memberships</h2>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Find a player by display name, username, or exact user id. Force an inappropriate name to
        something clean, comp a supporter membership, or revoke one after a chargeback. Every
        membership change is written to an audit trail with your account id and your reason.
      </p>
      <div className="admin-card">
        <div className="admin-field">
          <span>Search</span>
          <input
            type="text"
            value={userQuery}
            placeholder="name or user id"
            onChange={(e) => setUserQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && searchUsers()}
          />
          <button className="ds-btn" disabled={userBusy} onClick={searchUsers}>
            SEARCH
          </button>
        </div>
        {users.length > 0 && (
          <div className="admin-list" style={{ marginTop: 12 }}>
            {users.map((u) => (
              <div key={u.userId} className="admin-user">
                <div className="admin-row">
                  <input
                    type="text"
                    className="admin-grow"
                    maxLength={24}
                    value={rename[u.userId] ?? ''}
                    onChange={(e) => setRename((m) => ({ ...m, [u.userId]: e.target.value }))}
                  />
                  <button
                    className="ds-btn ghost sm"
                    disabled={userBusy || (rename[u.userId] ?? '').trim() === u.handle}
                    onClick={() => renameUser(u.userId, u.handle)}
                  >
                    RENAME
                  </button>
                </div>
                <div className="admin-row admin-sub">
                  <span className="ds-hint admin-grow">
                    {/* Staff first, and stated separately from the membership:
                        this row is where months get granted, and `supporter` here
                        is deliberately the PAID predicate (see AdminUserRow), so a
                        colleague reads as "not a supporter" while still holding
                        every perk by role. Saying so avoids granting them months
                        they do not need. */}
                    {u.role && (
                      <>
                        <strong>{u.role === 'owner' ? 'Owner' : 'Admin'}</strong> · perks by role
                        {' · '}
                      </>
                    )}
                    {u.supporter ? (
                      <>
                        <strong>Supporter</strong> until{' '}
                        {u.supporterUntil ? new Date(u.supporterUntil).toLocaleDateString() : '-'}
                        {u.autoRenews ? ' · auto-renews' : ' · manual claims only'}
                      </>
                    ) : (
                      <>No paid membership{u.autoRenews ? ' · Ko-fi linked (lapsed)' : ''}</>
                    )}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    className="admin-months"
                    aria-label={`Months to grant ${u.handle}`}
                    value={grantMonths[u.userId] ?? '1'}
                    onChange={(e) =>
                      setGrantMonths((m) => ({ ...m, [u.userId]: e.target.value }))
                    }
                  />
                  <button className="ds-btn ghost sm" disabled={userBusy} onClick={() => grantSupporter(u)}>
                    GRANT
                  </button>
                  <button
                    className="ds-btn ghost sm"
                    disabled={userBusy || !u.supporter}
                    onClick={() => revokeSupporter(u)}
                  >
                    REVOKE
                  </button>
                  <button className="ds-btn ghost sm" disabled={userBusy} onClick={() => loadHistory(u.userId)}>
                    HISTORY
                  </button>
                </div>
                {history[u.userId] && (
                  <div className="admin-history">
                    {history[u.userId].length === 0 ? (
                      <p className="ds-hint">No membership changes recorded.</p>
                    ) : (
                      history[u.userId].map((g, i) => (
                        <p key={i} className="ds-hint">
                          {new Date(g.createdAt).toLocaleString()} · <strong>{g.source}</strong>
                          {g.months ? ` +${g.months}mo` : ''}
                          {g.note ? ` · ${g.note}` : ''}
                        </p>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {userStatus && <p className="ds-hint" style={{ marginTop: 12 }}>{userStatus}</p>}
      </div>
        </>
      )}
    </div>
  );
}
