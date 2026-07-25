import { useEffect, useState } from 'react';
import {
  type MatchHistoryEntry,
  type MatchHistoryOpts,
  type MatchHistoryPage,
  type MatchHistoryPlayer,
} from '../net/api';

type TypeFilter = NonNullable<MatchHistoryOpts['type']>;
type ResultFilter = NonNullable<MatchHistoryOpts['result']>;

const TYPE_OPTS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All types' },
  { id: 'ranked', label: 'Ranked' },
  { id: 'custom', label: 'Custom' },
  { id: 'solo', label: 'Solo runs' },
  { id: 'duo', label: 'Duo runs' },
];
const RESULT_OPTS: { id: ResultFilter; label: string }[] = [
  { id: 'all', label: 'Any result' },
  { id: 'win', label: 'Wins' },
  { id: 'loss', label: 'Losses' },
];
const PAGE_SIZES = [10, 25, 50];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function typeLabel(r: MatchHistoryEntry): string {
  if (r.kind === 'record') return r.mode === 'duo' ? 'Duo run' : 'Solo run';
  return `${r.ranked ? 'Ranked' : 'Custom'} ${r.mode.toUpperCase()}`;
}

/** one clickable @username (plain text if the player has no username yet) */
function PlayerLink({
  p,
  onOpenProfile,
}: {
  p: MatchHistoryPlayer;
  onOpenProfile?: (username: string) => void;
}) {
  const cls = `mh-player ${p.alliance ? `al-${p.alliance}` : ''}`;
  if (p.username && onOpenProfile) {
    return (
      <button
        className={`${cls} link`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenProfile(p.username!);
        }}
        title={`View @${p.username}`}
      >
        {p.handle}
      </button>
    );
  }
  return <span className={cls}>{p.handle}</span>;
}

/** the players cell — versus shows red vs blue; a record run lists the driver(s) */
function Players({
  r,
  onOpenProfile,
}: {
  r: MatchHistoryEntry;
  onOpenProfile?: (username: string) => void;
}) {
  const join = (ps: MatchHistoryPlayer[]) =>
    ps.map((p, i) => (
      <span key={p.userId}>
        {i > 0 && <span className="mh-sep">, </span>}
        <PlayerLink p={p} onOpenProfile={onOpenProfile} />
      </span>
    ));
  if (r.kind === 'versus') {
    const red = r.players.filter((p) => p.alliance === 'red');
    const blue = r.players.filter((p) => p.alliance === 'blue');
    return (
      <span className="mh-players">
        {join(red)}
        <span className="mh-vs">vs</span>
        {join(blue)}
      </span>
    );
  }
  return <span className="mh-players">{join(r.players)}</span>;
}

/** the score cell — a versus match shows BOTH alliances' final totals (red vs
 * blue, winner emphasised); a record run shows the single run score. */
function ScoreCell({ r }: { r: MatchHistoryEntry }) {
  if (r.kind === 'versus' && r.redScore != null && r.blueScore != null) {
    const redWon = r.redScore > r.blueScore;
    const blueWon = r.blueScore > r.redScore;
    return (
      <span className="mh-vscore">
        <span className={`al-red${redWon ? ' w' : ''}`}>{r.redScore}</span>
        <span className="mh-vscore-dash">–</span>
        <span className={`al-blue${blueWon ? ' w' : ''}`}>{r.blueScore}</span>
      </span>
    );
  }
  return <span>{r.score}</span>;
}

/**
 * Paginated, filterable match history for a player — the core of the Career page
 * and public profiles. Shows every persisted game (ranked + custom versus AND
 * solo/duo record runs) with a timestamp, who played (clickable @usernames),
 * result (WIN green / LOSS red), the final scores of BOTH teams, ELO Δ, and a
 * Watch-replay link. Filter by type/result and page through with a "show N"
 * selector — nothing dumps the whole history at once. The SEASON is controlled by
 * the parent Career view (one Act/Season picker drives both the stats panel and
 * this list); `fetchPage` is bound to a user id (Career) or username (profile).
 */
export function MatchHistory({
  fetchPage,
  season,
  seasonLabel,
  onWatch,
  onOpenProfile,
}: {
  fetchPage: (opts: MatchHistoryOpts) => Promise<MatchHistoryPage>;
  /** the selected period's balance_version, or null for the live season */
  season: number | null;
  /** "Act X · Season Y" label for the empty-state copy */
  seasonLabel: string;
  onWatch?: (replayId: string) => void;
  onOpenProfile?: (username: string) => void;
}) {
  const [type, setType] = useState<TypeFilter>('all');
  const [result, setResult] = useState<ResultFilter>('all');
  const [pageSize, setPageSize] = useState(25);
  const [offset, setOffset] = useState(0);

  const [page, setPage] = useState<MatchHistoryPage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState('');

  // a period switch resets to the first page (the old offset may exceed the count)
  useEffect(() => {
    setOffset(0);
  }, [season]);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    fetchPage({ season: season ?? undefined, offset, limit: pageSize, type, result })
      .then((p) => {
        if (!alive) return;
        setPage(p);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [fetchPage, season, offset, pageSize, type, result]);

  // any filter change resets to the first page
  const changeType = (t: TypeFilter) => {
    setType(t);
    setOffset(0);
  };
  const changeResult = (r: ResultFilter) => {
    setResult(r);
    setOffset(0);
  };
  const changeSize = (n: number) => {
    setPageSize(n);
    setOffset(0);
  };

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);
  const seasonName = seasonLabel;

  return (
    <div className="ds-panel" style={{ marginTop: 18 }}>
      <div className="ds-panel-h">
        <span className="ds-panel-title">Match history</span>
      </div>
      <div className="mh-filters">
          <select className="ds-select" value={type} onChange={(e) => changeType(e.target.value as TypeFilter)}>
            {TYPE_OPTS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="ds-select"
            value={result}
            onChange={(e) => changeResult(e.target.value as ResultFilter)}
          >
            {RESULT_OPTS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <select className="ds-select" value={pageSize} onChange={(e) => changeSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                Show {n}
              </option>
            ))}
          </select>
      </div>

      {status === 'loading' && <div className="ds-loading">Loading…</div>}
      {status === 'error' && (
        <div className="ds-empty">
          <div className="big">Couldn’t load match history</div>
          {error}
        </div>
      )}
      {status === 'ok' && total === 0 && (
        <div className="ds-empty">
          <div className="big">No matches</div>
          Nothing here for {seasonName}
          {type !== 'all' || result !== 'all' ? ' with these filters' : ''}.
        </div>
      )}
      {status === 'ok' && total > 0 && page && (
        <>
          <div className="mh-scroll">
            <table className="ds-table mh-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Players</th>
                  <th>Result</th>
                  <th style={{ textAlign: 'right' }}>Score</th>
                  <th style={{ textAlign: 'right' }}>ELO Δ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => {
                  const delta =
                    r.eloBefore != null && r.eloAfter != null ? r.eloAfter - r.eloBefore : null;
                  const watchable = !!r.replayId && !!onWatch;
                  return (
                    <tr key={`${r.kind}-${r.id}`}>
                      <td className="mh-when">{fmtDate(r.createdAt)}</td>
                      <td>
                        <span className={`ds-dt mh-type ${r.kind === 'record' ? 'rec' : r.ranked ? 'ranked' : 'custom'}`}>
                          {typeLabel(r)}
                        </span>
                      </td>
                      <td>
                        <Players r={r} onOpenProfile={onOpenProfile} />
                      </td>
                      <td>
                        {r.kind === 'record' ? (
                          <span className="mh-run">run</span>
                        ) : r.won == null ? (
                          <span style={{ color: 'var(--ds-mut)' }}>-</span>
                        ) : (
                          <span style={{ color: r.won ? 'var(--ds-ok)' : 'var(--ds-danger)', fontWeight: 700 }}>
                            {r.won ? 'WIN' : 'LOSS'}
                          </span>
                        )}
                      </td>
                      <td className="sc" style={{ color: 'var(--ds-ink)' }}>
                        <ScoreCell r={r} />
                      </td>
                      <td
                        className="sc"
                        style={{
                          color:
                            delta == null
                              ? 'var(--ds-mut)'
                              : delta >= 0
                                ? 'var(--ds-ok)'
                                : 'var(--ds-danger)',
                        }}
                      >
                        {delta == null ? '-' : delta >= 0 ? `+${delta}` : delta}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {watchable ? (
                          <button className="ds-btn ghost mh-watch" onClick={() => onWatch!(r.replayId!)}>
                            Watch ▶
                          </button>
                        ) : (
                          <span style={{ color: 'var(--ds-mut)', fontSize: 12 }}>-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mh-pager">
            <span className="mh-count">
              {from}–{to} of {total}
            </span>
            <span className="ds-head-spacer" />
            <button className="ds-btn ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
              ← Prev
            </button>
            <button
              className="ds-btn ghost"
              disabled={offset + pageSize >= total}
              onClick={() => setOffset(offset + pageSize)}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
