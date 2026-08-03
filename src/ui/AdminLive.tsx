import { useEffect, useState } from 'react';
import { adminFetchPresence, type AdminPresence, type AdminPresencePlayer } from '../net/api';

/**
 * The operator's live view of the service: who is connected, what they are doing,
 * which matches are running, and how deep the queues are.
 *
 * WHAT THIS DELIBERATELY DOES NOT SHOW, and why it is worth knowing while reading it:
 *
 *  - No anonymous session is identified. Guests appear as COUNTS, bucketed by
 *    activity. There is no moderation action available against a guest other than
 *    ending their connection or their room — both reachable without knowing who
 *    they are — so an identifier would be surveillance with no remedy attached.
 *  - Nobody's screen or menu is reported. The activity column is the same coarse
 *    bucket a player's own friends list already publishes about them.
 *  - There is no history. The source row is a ~5s snapshot that overwrites itself,
 *    so this panel cannot answer "what was X doing an hour ago" even in principle.
 *
 * The note at the bottom says all of that to the operator too, on purpose: a
 * surveillance surface that quietly under-delivers is better than one whose limits
 * only exist in a commit message.
 */
const REFRESH_MS = 5000;

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

  // MERGE the database aggregate with this machine's own numbers. The heartbeat is
  // ~5s behind, so without the local row a room or a player that appeared a moment
  // ago is missing from the very machine holding their socket.
  const machines = mergeMachines(data);
  const players = machines.flatMap((m) => m.players.map((p) => ({ ...p, region: m.region })));
  const anon = machines.reduce(
    (a, m) => ({
      total: a.total + m.anon.total,
      inMatch: a.inMatch + m.anon.inMatch,
      inLobby: a.inLobby + m.anon.inLobby,
      idle: a.idle + m.anon.idle,
    }),
    { total: 0, inMatch: 0, inLobby: 0, idle: 0 },
  );
  const online = machines.reduce((n, m) => n + m.online, 0);
  const q = filter.trim().toLowerCase();
  const shown = q
    ? players.filter(
        (p) =>
          (p.handle ?? '').toLowerCase().includes(q) ||
          (p.username ?? '').toLowerCase().includes(q) ||
          (p.room ?? '').toLowerCase().includes(q) ||
          p.region.toLowerCase().includes(q),
      )
    : players;

  return (
    <>
      <div className="adm-stats">
        <Stat label="Online" value={online} hint="open sockets across every region" />
        <Stat label="Signed in" value={players.length} hint="distinct accounts connected" />
        <Stat label="Guests" value={anon.total} hint="anonymous sessions — counted, not identified" />
        <Stat label="In a match" value={players.filter((p) => p.act === 'match').length + anon.inMatch} />
        <Stat label="Queued" value={players.filter((p) => p.queue).length} hint="waiting for a ranked match" />
        <Stat label="Live matches" value={data.rooms.length} />
      </div>

      <h3 className="adm-h3">Regions</h3>
      <div className="adm-regions">
        {machines.length === 0 && <p className="ds-hint">No machine is reporting.</p>}
        {machines.map((m) => (
          <div key={m.machine} className="adm-region">
            <b>{m.region || 'local'}</b>
            <span className="ds-muted">{m.online} online</span>
            <span className="ds-muted">
              {m.players.length} signed in · {m.anon.total} guest{m.anon.total === 1 ? '' : 's'}
            </span>
            <span className="ds-muted">{beatAge(m.updatedAt)}</span>
          </div>
        ))}
      </div>

      <h3 className="adm-h3">
        Signed-in players <span className="ds-muted">({players.length})</span>
      </h3>
      <input
        className="adm-filter"
        placeholder="Filter by name, room or region…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {shown.length === 0 ? (
        <p className="ds-hint">{players.length === 0 ? 'Nobody signed in is connected.' : 'No match for that filter.'}</p>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Doing</th>
                <th>Queue</th>
                <th>Room</th>
                <th>Region</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.userId + p.region}>
                  <td>
                    <span className="adm-name">{p.handle ?? '(no profile)'}</span>
                    {p.username && <span className="ds-muted"> @{p.username}</span>}
                  </td>
                  <td>
                    <span className={`adm-pill ${p.act}`}>{actLabel(p)}</span>
                  </td>
                  <td>
                    {p.queue ? (
                      <span className="adm-pill queued">
                        {p.queue.toUpperCase()} · {waitLabel(p.queuedS ?? 0)}
                      </span>
                    ) : (
                      <span className="ds-muted">—</span>
                    )}
                  </td>
                  <td>
                    {p.room ? (
                      onWatch ? (
                        <button className="ds-btn small ghost" onClick={() => onWatch(p.room as string)}>
                          {p.room} ↗
                        </button>
                      ) : (
                        <code>{p.room}</code>
                      )
                    ) : (
                      <span className="ds-muted">—</span>
                    )}
                  </td>
                  <td className="ds-muted">{p.region || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="adm-h3">Guest sessions</h3>
      <div className="adm-stats small">
        <Stat label="Total" value={anon.total} />
        <Stat label="In a match" value={anon.inMatch} />
        <Stat label="In a lobby" value={anon.inLobby} />
        <Stat label="Browsing" value={anon.idle} />
      </div>
      <p className="ds-hint">
        Players who aren’t signed in are <b>counted, never identified</b>. There’s no per-session
        row, no identifier and no history here — the only thing you can do about a guest is end
        their connection or their room, and neither needs to know who they are.
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
                  · {r.ranked ? 'Ranked' : 'Custom'} {r.mode} · {r.phase} · {r.score.red}–{r.score.blue}
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
        <b>Scope of this page.</b> Signed-in rows show only what is already public (live matches
        list player names) or already shown to that player’s own friends, plus queue state the
        server must track to run matchmaking. Nobody’s screen, menu or inputs are recorded, and
        nothing here is retained — every figure is a live snapshot that overwrites itself every
        few seconds. Watching a match from this page does <b>not</b> appear in the spectator count
        players see; that’s disclosed in the privacy policy.
      </p>
    </>
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

/** the DB aggregate plus THIS machine's own row, deduped by machine id. The
 *  heartbeat lags ~5s, so the local row is what keeps a just-connected player from
 *  being missing from the very machine serving them. */
function mergeMachines(d: AdminPresence): AdminPresence['machines'] {
  const out = [...d.machines];
  const i = out.findIndex((m) => m.machine === d.local.machine);
  if (i >= 0) out[i] = d.local;
  else if (d.local.online > 0 || d.local.players.length > 0) out.push(d.local);
  return out;
}

function actLabel(p: AdminPresencePlayer): string {
  if (p.act === 'match') return p.game === 'chain' ? 'In a match · CR' : 'In a match';
  if (p.act === 'lobby') return 'In a lobby';
  return 'In menus';
}

function waitLabel(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function beatAge(iso?: string): string {
  if (!iso) return 'live';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 10 ? 'just now' : `${s}s ago`;
}
