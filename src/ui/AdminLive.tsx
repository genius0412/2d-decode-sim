import { useEffect, useState } from 'react';
import {
  adminFetchPresence,
  adminFetchMaintenance,
  adminSetMaintenance,
  type AdminPresence,
  type AdminPresencePlayer,
  type AdminPresenceGuest,
  type MaintenanceWindow,
} from '../net/api';
import { SEASONS } from '../seasons';
import { windowLabel } from './MaintenanceBanner';

/**
 * The operator's live view: who is connected, what each of them is doing, which
 * matches are running, and the maintenance lockdown.
 *
 * EVERY SESSION IS A ROW — signed-in accounts and guests alike. Guests are keyed by
 * the server's per-socket connection id, which is not an IP, not a fingerprint, is
 * written nowhere else, and dies with the socket. It tells two live sessions apart
 * right now; it cannot connect either to a past one. Nobody's screen, menu or inputs
 * are reported, and there is no history — the source is a ~5s snapshot that
 * overwrites itself. The privacy policy states this; if it widens, that moves too.
 */
const REFRESH_MS = 5000;
const GAME_LABEL: Record<string, string> = Object.fromEntries(SEASONS.map((s) => [s.key, s.name]));
const gameName = (g?: string): string => (g ? (GAME_LABEL[g] ?? g) : '');

export function AdminLive({ onWatch }: { onWatch?: (room: string) => void }) {
  const [data, setData] = useState<AdminPresence | null>(null);
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void adminFetchPresence().then((d) => {
        if (!alive) return;
        setErr(d === null);
        if (d) setData(d);
      });
    };
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (err && !data) {
    return (
      <div className="ds-empty">
        <div className="big">Couldn’t read live status</div>
        The game server is unreachable, or this account isn’t an admin on it.
      </div>
    );
  }
  if (!data) return <div className="ds-loading">Reading live status…</div>;

  // MERGE the database aggregate with this machine's own numbers: the heartbeat is
  // ~5s behind, so without the local row a session that appeared a moment ago is
  // missing from the very machine holding its socket.
  const machines = mergeMachines(data);
  const players = machines.flatMap((m) => m.players.map((p) => ({ ...p, region: m.region })));
  const guests = machines.flatMap((m) => (m.guests ?? []).map((g) => ({ ...g, region: m.region })));
  const sockets = machines.reduce((n, m) => n + m.online, 0);
  // sockets held by ACCOUNTS. Stated explicitly because "online" counts sockets and
  // "accounts" counts people: one player with two tabs makes those two disagree, and
  // without this the tiles look broken rather than merely subtle.
  const accountSessions = players.reduce((n, p) => n + (p.sessions ?? 1), 0);

  const q = filter.trim().toLowerCase();
  const match = (s: string | undefined | null): boolean => !!s && s.toLowerCase().includes(q);
  const shownPlayers = q
    ? players.filter((p) => match(p.handle) || match(p.username) || match(p.room) || match(p.region))
    : players;
  const shownGuests = q ? guests.filter((g) => match(g.id) || match(g.room) || match(g.region)) : guests;

  return (
    <>
      <MaintenancePanel />

      <div className="adm-stats">
        <Stat label="Sessions" value={sockets} hint="open sockets across every region" />
        <Stat label="Accounts" value={players.length} hint="distinct signed-in players" />
        <Stat label="Guests" value={guests.length} hint="sessions with no account" />
        <Stat
          label="In a match"
          value={players.filter((p) => p.act === 'match').length + guests.filter((g) => g.act === 'match').length}
        />
        <Stat label="Queued" value={players.filter((p) => p.queue).length} hint="waiting for a ranked match" />
        <Stat label="Live matches" value={data.rooms.length} />
      </div>
      <p className="ds-hint">
        {accountSessions} session{accountSessions === 1 ? '' : 's'} belong to {players.length} account
        {players.length === 1 ? '' : 's'} + {guests.length} guest{guests.length === 1 ? '' : 's'} ={' '}
        {accountSessions + guests.length} of {sockets}
        {accountSessions + guests.length !== sockets && ' — the rest are sockets that have not identified themselves yet (still connecting)'}
        . One player with two tabs is two sessions and one account.
      </p>

      <h3 className="adm-h3">Regions</h3>
      <div className="adm-regions">
        {machines.length === 0 && <p className="ds-hint">No machine is reporting.</p>}
        {machines.map((m) => (
          <div key={m.machine} className="adm-region">
            <b>{m.region || 'local'}</b>
            <span className="ds-muted">{m.online} sessions</span>
            <span className="ds-muted">
              {m.players.length} account{m.players.length === 1 ? '' : 's'} · {(m.guests ?? []).length} guest
              {(m.guests ?? []).length === 1 ? '' : 's'}
            </span>
            <span className="ds-muted">{beatAge(m.updatedAt)}</span>
          </div>
        ))}
      </div>

      <input
        className="adm-filter"
        style={{ marginTop: 20 }}
        placeholder="Filter every session by name, id, room or region…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <h3 className="adm-h3">
        Signed in <span className="ds-muted">({shownPlayers.length})</span>
      </h3>
      <SessionTable
        rows={shownPlayers.map((p) => ({
          key: p.userId + p.region,
          who: (
            <>
              <span className="adm-name">{p.handle ?? '(no profile)'}</span>
              {p.username && <span className="ds-muted"> @{p.username}</span>}
              {(p.sessions ?? 1) > 1 && <span className="adm-pill" style={{ marginLeft: 6 }}>×{p.sessions}</span>}
            </>
          ),
          act: p.act,
          actLabel: actLabel(p),
          queue: p.queue ? `${gameName(p.queueGame ?? p.game) || ''} ${p.queue.toUpperCase()} · ${waitLabel(p.queuedS ?? 0)}`.trim() : null,
          room: p.room,
          region: p.region,
        }))}
        empty={players.length === 0 ? 'Nobody signed in is connected.' : 'No match for that filter.'}
        onWatch={onWatch}
      />

      <h3 className="adm-h3">
        Guests <span className="ds-muted">({shownGuests.length})</span>
      </h3>
      <SessionTable
        rows={shownGuests.map((g) => ({
          key: g.id + g.region,
          who: <code className="adm-guest-id">{shortId(g.id)}</code>,
          act: g.act,
          actLabel: actLabel(g),
          queue: null, // ranked needs an account, so a guest is never in a queue
          room: g.room,
          region: g.region,
        }))}
        empty={guests.length === 0 ? 'No guest sessions.' : 'No match for that filter.'}
        onWatch={onWatch}
      />
      <p className="ds-hint">
        A guest row is keyed by its <b>connection id</b> — the server’s own per-socket
        routing id. It isn’t an IP or a fingerprint, it’s stored nowhere else, and it dies with
        the socket: the same person reconnecting gets an unrelated id. It tells two live sessions
        apart; it can’t link either to a past one.
      </p>

      <h3 className="adm-h3">
        Live matches <span className="ds-muted">({data.rooms.length})</span>
      </h3>
      {data.rooms.length === 0 ? (
        <p className="ds-hint">Nothing is being played on this machine right now.</p>
      ) : (
        <div className="adm-rooms">
          {data.rooms.map((r) => (
            <div key={r.room} className="adm-room">
              <div>
                <b>{r.players.map((p) => p.name).join(' vs ') || r.room}</b>
                <span className="ds-muted">
                  {' '}
                  · {gameName(r.game)} · {r.ranked ? 'Ranked' : 'Custom'} {r.mode} · {r.phase} ·{' '}
                  {r.score.red}–{r.score.blue}
                  {r.spectators > 0 ? ` · 👁 ${r.spectators}` : ''}
                </span>
              </div>
              {onWatch && (
                <button className="ds-btn small" onClick={() => onWatch(r.room)}>
                  Watch (hidden)
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="ds-hint adm-privacy">
        <b>Scope of this page.</b> Nobody’s screen, menu, inputs or messages are recorded, and
        nothing here is retained — every figure is a live snapshot that overwrites itself every few
        seconds, so this page cannot answer “what was X doing an hour ago”. Watching a match from
        here does <b>not</b> appear in the spectator count players see. All of this is stated in the
        privacy policy.
      </p>
    </>
  );
}

/** one shared table for both kinds of session, so a guest row and an account row
 *  can never drift into showing different things about the same situation */
function SessionTable({
  rows,
  empty,
  onWatch,
}: {
  rows: {
    key: string;
    who: React.ReactNode;
    act: 'menu' | 'lobby' | 'match';
    actLabel: string;
    queue: string | null;
    room?: string;
    region: string;
  }[];
  empty: string;
  onWatch?: (room: string) => void;
}) {
  if (rows.length === 0) return <p className="ds-hint">{empty}</p>;
  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Doing</th>
            <th>Queue</th>
            <th>Room</th>
            <th>Region</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.who}</td>
              <td>
                <span className={`adm-pill ${r.act}`}>{r.actLabel}</span>
              </td>
              <td>
                {r.queue ? <span className="adm-pill queued">{r.queue}</span> : <span className="ds-muted">—</span>}
              </td>
              <td>
                {r.room ? (
                  onWatch ? (
                    <button className="ds-btn small ghost" onClick={() => onWatch(r.room as string)}>
                      {r.room} ↗
                    </button>
                  ) : (
                    <code>{r.room}</code>
                  )
                ) : (
                  <span className="ds-muted">—</span>
                )}
              </td>
              <td className="ds-muted">{r.region || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The maintenance lockdown control.
 *
 * A window with a FUTURE start is the normal path and the default the form nudges
 * toward: it announces itself to everyone without locking anyone out yet, which is
 * the whole difference between scheduled maintenance and an outage. Admins are never
 * locked out — whoever is deploying has to be able to test what they just shipped.
 */
function MaintenancePanel() {
  const [w, setW] = useState<MaintenanceWindow | null>(null);
  const [biting, setBiting] = useState(false);
  const [mins, setMins] = useState(10);
  const [dur, setDur] = useState(30);
  const [msg, setMsg] = useState('Scheduled maintenance');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = (): void => {
    void adminFetchMaintenance().then((r) => {
      if (!r) return;
      setW(r.maintenance);
      setBiting(r.biting);
      if (r.maintenance.message) setMsg(r.maintenance.message);
    });
  };
  useEffect(() => {
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(t);
  }, []);

  const apply = async (next: MaintenanceWindow, okMsg: string): Promise<void> => {
    setBusy(true);
    const ok = await adminSetMaintenance(next);
    setBusy(false);
    setStatus(ok ? okMsg : 'Failed — check admin sign-in / database.');
    load();
  };

  const schedule = (): void => {
    const startsAt = Date.now() + Math.max(0, mins) * 60_000;
    void apply(
      { active: true, startsAt, endsAt: startsAt + Math.max(1, dur) * 60_000, message: msg },
      mins > 0 ? `Scheduled in ${mins} min for ${dur} min.` : `Locked down for ${dur} min.`,
    );
  };
  const lift = (): void =>
    void apply({ active: false, startsAt: null, endsAt: null, message: '' }, 'Lockdown lifted.');

  const live = w?.active ?? false;
  return (
    <div className={`admin-card adm-maint${biting ? ' biting' : ''}`}>
      <div className="adm-maint-h">
        <b>Maintenance lockdown</b>
        <span className={`adm-pill ${biting ? 'queued' : ''}`}>
          {biting ? 'LOCKED — only admins can start' : live ? 'SCHEDULED' : 'Off'}
        </span>
      </div>
      {live && w && (
        <p className="ds-hint" style={{ margin: 0 }}>
          {w.message || 'Maintenance'} · {windowLabel({ ...w, biting }) || 'no window set'}
        </p>
      )}
      <label className="admin-field">
        <span>Starts in</span>
        <input type="number" min={0} max={1440} value={mins} onChange={(e) => setMins(Math.max(0, Number(e.target.value) || 0))} />
        <span>min, lasting</span>
        <input type="number" min={1} max={1440} value={dur} onChange={(e) => setDur(Math.max(1, Number(e.target.value) || 1))} />
        <span>min</span>
      </label>
      <label className="admin-field col">
        <span>Message shown to players</span>
        <input type="text" maxLength={200} value={msg} onChange={(e) => setMsg(e.target.value)} />
      </label>
      <div className="admin-buttons">
        <button className="ds-btn" disabled={busy} onClick={schedule}>
          {mins > 0 ? 'SCHEDULE LOCKDOWN' : 'LOCK DOWN NOW'}
        </button>
        <button className="ds-btn ghost" disabled={busy || !live} onClick={lift}>
          LIFT
        </button>
      </div>
      <p className="ds-hint" style={{ margin: 0 }}>
        Blocks new matches, ranked queueing and custom rooms for everyone except admins — enforced
        on the server, not just hidden in the UI. Matches already running are left alone to finish.
        Set “starts in” above 0 so players get told before it bites.
      </p>
      {status && <p className="ds-hint" style={{ margin: 0 }}>{status}</p>}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="adm-stat" title={hint}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** the DB aggregate plus THIS machine's own row, deduped by machine id */
function mergeMachines(d: AdminPresence): AdminPresence['machines'] {
  const out = [...d.machines];
  const i = out.findIndex((m) => m.machine === d.local.machine);
  if (i >= 0) out[i] = d.local;
  else if (d.local.online > 0 || d.local.players.length > 0 || (d.local.guests ?? []).length > 0) out.push(d.local);
  return out;
}

function actLabel(p: AdminPresencePlayer | AdminPresenceGuest): string {
  if (p.act === 'match') return `In a match${p.game ? ` · ${gameName(p.game)}` : ''}`;
  if (p.act === 'lobby') return `In a lobby${p.game ? ` · ${gameName(p.game)}` : ''}`;
  return 'Idle · in menus';
}

function waitLabel(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** enough of a connection id to tell two rows apart without printing a UUID */
function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function beatAge(iso?: string): string {
  if (!iso) return 'live';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 10 ? 'just now' : `${s}s ago`;
}
