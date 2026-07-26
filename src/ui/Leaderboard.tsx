import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  fetchElo,
  fetchRecords,
  fetchSeasons,
  type Board,
  type EloMode,
  type EloRow,
  type EloStanding,
  type RecordConfig,
  type RecordMode,
  type RecordRow,
  type SeasonInfo,
} from '../net/api';
import { gameServerConfigured } from '../net/env';
import { periodLabel } from '../seasons';
import { PeriodPicker } from './PeriodPicker';
import { SupporterBadge, type StaffRole } from './SupporterBadge';
import { PLACEMENT_GAMES } from '../config';
import { CHAIN_MODE_LABELS, CHAIN_INTAKE_LABELS } from '../games/chain/labels';
import {
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_CLEARANCE_DEFAULT,
} from '../games/chain/config';
import type { DrivetrainType, GameId, IntakeStyle, RobotSpec } from '../types';

type Kind = 'records' | 'ranked';

// RECORD boards are split by drivetrain (+ a cross-drivetrain Overall); the
// picker shows for records only — ranked (ELO) is a single board per mode.
const BOARDS: { id: Board; label: string }[] = [
  { id: 'overall', label: 'Overall' },
  { id: 'mecanum', label: 'Mecanum' },
  { id: 'tank', label: 'Tank' },
  { id: 'swerve', label: 'Swerve' },
  { id: 'xdrive', label: 'X-Drive' },
];

const DT_LABEL: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-drive',
};
const INTAKE_LABEL: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
};

/** a driver's name on a board: display handle + muted @username, clickable to
 * their public profile when they have a username (legacy rows without one render
 * as plain text). Stops propagation so clicking a name never triggers the row's
 * watch-replay handler. */
function DriverName({
  handle,
  username,
  supporter,
  role,
  onOpenProfile,
}: {
  handle: string | null;
  username: string | null;
  supporter?: boolean;
  role?: StaffRole;
  onOpenProfile?: (username: string) => void;
}) {
  const label = handle ?? (username ? `@${username}` : 'Player');
  if (username && onOpenProfile) {
    return (
      <button
        className="lb-name"
        onClick={(e) => {
          e.stopPropagation();
          onOpenProfile(username);
        }}
        title={`View @${username}`}
      >
        <span className="lb-name-h">
          {label}
          <SupporterBadge supporter={supporter} role={role} />
        </span>
        <span className="lb-at">@{username}</span>
      </button>
    );
  }
  return (
    <span className="lb-name-h">
      {label}
      <SupporterBadge supporter={supporter} role={role} />
    </span>
  );
}

/** one robot's spec stats (shared by solo + each half of a duo). Game-aware: a
 * Chain Reaction robot shows its CR config (archetype / sweeper mount / hopper /
 * clearance), NOT the DECODE intake-preset + flywheel — those fields are unused in
 * CR and would read as a "weird" random configuration. */
function RobotSpecSummary({ spec, game }: { spec: RobotSpec; game?: GameId }) {
  const isChain = game === 'chain';
  const stat = (value: ReactNode, label: string, small = false) => (
    <div className="ds-stat">
      <span className="sv" style={small ? { fontSize: 14 } : undefined}>{value}</span>
      <span className="sl">{label}</span>
    </div>
  );

  const chainMode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  const archetype = CHAIN_MODE_LABELS[chainMode] + (chainMode !== 'turret' && spec.shooterRear ? ' · rear' : '');
  const sweeper = `${CHAIN_INTAKE_LABELS[spec.chainIntake ?? CHAIN_DEFAULT_INTAKE]} · ${spec.intakeSide ? 'Side' : 'Front'}`;

  return (
    <>
      <div className="lb-config-name">
        {spec.name}
        {spec.teamNumber ? ` · #${spec.teamNumber}` : ''}
        {spec.teamName ? ` · ${spec.teamName}` : ''}
      </div>
      <div className="ds-stats">
        {stat(DT_LABEL[spec.drivetrain], 'drivetrain', true)}
        {stat(spec.massLb, 'lb mass')}
        {stat(spec.driveRpm, 'drive rpm')}
        {isChain ? (
          <>
            {stat(archetype, 'archetype', true)}
            {stat(sweeper, 'intake', true)}
            {stat(Math.round(spec.ballStorage ?? CHAIN_STORAGE_DEFAULT), 'hopper')}
            {stat(`${(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT).toFixed(1)}"`, 'clearance')}
          </>
        ) : (
          <>
            {stat(`${INTAKE_LABEL[spec.intake]}${spec.canSort ? ' +sort' : ''}`, 'intake', true)}
            {stat(spec.flywheelInertia.toFixed(2), 'flywheel')}
          </>
        )}
        {stat(`${spec.length}×${spec.width}"`, 'size')}
      </div>
    </>
  );
}

/** the robot config a record was set with — each driver's spec stats + the
 * owner's assists. A duo shows BOTH robots (drivers bring their own builds). */
function ConfigSummary({ cfg, game }: { cfg: RecordConfig; game?: GameId }) {
  const { spec, assists, partnerSpec } = cfg;
  const chip = (label: string, on: boolean) => (
    <span className={`ds-chip ${on ? 'on' : 'off'}`}>{label}</span>
  );
  return (
    <div className="lb-config">
      <RobotSpecSummary spec={spec} game={game} />
      {partnerSpec && <RobotSpecSummary spec={partnerSpec} game={game} />}
      <div className="lb-config-assists">
        {chip(assists.fieldCentric ? 'Field-centric' : 'Robot-centric', true)}
        {chip('Aim assist', assists.aimAssist)}
        {chip('Auto intake', assists.autoIntake)}
        {chip('Auto fire', assists.autoFire)}
      </div>
    </div>
  );
}

/** the signed-in viewer's own standing on the selected ranked board: their rank
 * once PLACED, or a "matches until placement" progress line while still in
 * placements. Only placed players appear in the table above, so this is the one
 * place a not-yet-placed (or off-page) player sees where they stand. */
function MyStanding({ me }: { me: EloStanding }) {
  const placed = me.rank != null;
  if (placed) {
    return (
      <div className="lb-standing placed">
        <span className="lb-standing-rank">#{me.rank}</span>
        <span className="lb-standing-text">
          Your rank · <strong>{me.rating}</strong> ELO
        </span>
      </div>
    );
  }
  const remaining = Math.max(0, PLACEMENT_GAMES - me.games);
  return (
    <div className="lb-standing placing">
      <span className="lb-standing-badge">?</span>
      <div className="lb-standing-col">
        <span className="lb-standing-text">
          <strong>{remaining}</strong> {remaining === 1 ? 'match' : 'matches'} until placement
        </span>
        <span className="lb-standing-sub">
          {me.games}/{PLACEMENT_GAMES} placement matches played - finish them to join the leaderboard.
        </span>
        <span className="lb-standing-bar" aria-hidden>
          <span style={{ width: `${Math.min(100, (me.games / PLACEMENT_GAMES) * 100)}%` }} />
        </span>
      </div>
    </div>
  );
}

/**
 * Ranked + record leaderboards. Segmented by board type (records / ranked),
 * mode, and drivetrain, read live from the server's public API. Empty and error
 * states are first-class (the boards start empty and fill as matches are played).
 */
export function Leaderboard({
  myUserId,
  game,
  onWatch,
  onOpenProfile,
}: {
  myUserId?: string | null;
  game?: GameId;
  onWatch?: (replayId: string) => void;
  onOpenProfile?: (username: string) => void;
}) {
  const [kind, setKind] = useState<Kind>('records');
  const [recMode, setRecMode] = useState<RecordMode>('solo');
  const [eloMode, setEloMode] = useState<EloMode>('1v1');
  const [board, setBoard] = useState<Board>('overall'); // record boards only

  const [rows, setRows] = useState<(RecordRow | EloRow)[]>([]);
  const [me, setMe] = useState<EloStanding | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);

  // seasons: null selection = the live season (server default)
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [season, setSeason] = useState<number | null>(null);

  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchSeasons(game)
      .then((r) => {
        if (!alive) return;
        setSeasons(r.seasons);
        setCurrent(r.current);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [configured, game]);

  useEffect(() => {
    if (!configured) {
      setStatus('error');
      setError('Leaderboards need the game server (set VITE_GAME_SERVER_URL).');
      return;
    }
    let alive = true;
    setStatus('loading');
    setMe(null);
    const s = season ?? undefined;
    const req =
      kind === 'records'
        ? fetchRecords(recMode, board, s, game).then((r) => ({ rows: r.rows, me: null as EloStanding | null }))
        : fetchElo(eloMode, s, myUserId, game);
    req
      .then(({ rows, me }) => {
        if (!alive) return;
        setRows(rows);
        setMe(me);
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
  }, [kind, recMode, eloMode, board, season, configured, myUserId, game]);

  const isRecords = kind === 'records';
  const valueLabel = isRecords ? 'Score' : 'ELO';
  const viewing = season ?? current;
  const viewingSeason = seasons.find((s) => s.season === viewing);
  const seasonLabel = viewingSeason ? periodLabel(viewingSeason) : 'Current period';
  const isArchived = viewing != null && current != null && viewing < current;

  return (
    <>
      {/* the page heading is owned by the Records host; the season badge is not */}
      <h2 className="ds-h2 lb-period-head">
        {seasonLabel}
        {isArchived ? ' · archived' : ''}
      </h2>

      <PeriodPicker seasons={seasons} current={current} value={season} onChange={setSeason} label="Period" />

      <div className="ds-panel">
        <div className="ds-panel-h">
          <div className="ds-segs">
            <button className={`ds-seg ${isRecords ? 'on' : ''}`} onClick={() => setKind('records')}>
              Records
            </button>
            <button className={`ds-seg ${!isRecords ? 'on' : ''}`} onClick={() => setKind('ranked')}>
              Ranked
            </button>
          </div>
          <div className="ds-segs">
            {isRecords ? (
              <>
                <button className={`ds-seg ${recMode === 'solo' ? 'on' : ''}`} onClick={() => setRecMode('solo')}>
                  Solo
                </button>
                <button className={`ds-seg ${recMode === 'duo' ? 'on' : ''}`} onClick={() => setRecMode('duo')}>
                  Duo
                </button>
              </>
            ) : (
              <>
                <button className={`ds-seg ${eloMode === '1v1' ? 'on' : ''}`} onClick={() => setEloMode('1v1')}>
                  1v1
                </button>
                <button className={`ds-seg ${eloMode === '2v2' ? 'on' : ''}`} onClick={() => setEloMode('2v2')}>
                  2v2
                </button>
              </>
            )}
          </div>
        </div>

        {isRecords && (
          <div className="ds-panel-h">
            <span className="ds-panel-title">Drivetrain</span>
            <div className="ds-segs">
              {BOARDS.map((b) => (
                <button key={b.id} className={`ds-seg ${board === b.id ? 'on' : ''}`} onClick={() => setBoard(b.id)}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isRecords && status === 'ok' && me && <MyStanding me={me} />}

        {status === 'loading' && <div className="ds-loading">Loading…</div>}
        {status === 'error' && (
          <div className="ds-empty">
            <div className="big">Couldn’t load the board</div>
            {error}
          </div>
        )}
        {status === 'ok' && rows.length === 0 && (
          <div className="ds-empty">
            <div className="big">{isRecords ? 'No entries yet' : 'No placed players yet'}</div>
            {isRecords
              ? 'Be the first to set a time on this board.'
              : `Players appear here after ${PLACEMENT_GAMES} ranked matches. Be the first to place.`}
          </div>
        )}
        {status === 'ok' && rows.length > 0 && (
          <table className="ds-table">
            <thead>
              <tr>
                <th className="rk">#</th>
                <th>Driver</th>
                {isRecords && <th>Robot</th>}
                {!isRecords && <th>Games</th>}
                <th style={{ textAlign: 'right' }}>{valueLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rec = r as RecordRow;
                const watchable = isRecords && !!rec.replayId && !!onWatch;
                const cfg = isRecords ? rec.config : null;
                const isOpen = openRow === r.userId;
                const isMe = !!myUserId && r.userId === myUserId;
                return (
                  <Fragment key={r.userId}>
                    <tr
                      className={`${watchable ? 'ds-clickable' : ''}${isMe ? ' lb-you' : ''}`}
                      onClick={watchable ? () => onWatch!(rec.replayId!) : undefined}
                      title={watchable ? 'Watch replay' : undefined}
                    >
                      <td className="rk">{i + 1}</td>
                      <td>
                        <span className="lb-drivers">
                          <DriverName
                            handle={r.handle}
                            username={r.username}
                            supporter={(r as { supporter?: boolean }).supporter}
                            role={(r as { role?: StaffRole }).role}
                            onOpenProfile={onOpenProfile}
                          />
                          {isRecords && rec.partnerId && (
                            <>
                              <span className="lb-amp">+</span>
                              <DriverName
                                handle={rec.partnerHandle}
                                username={rec.partnerUsername}
                                onOpenProfile={onOpenProfile}
                              />
                              <span className="ds-dt lb-duo-tag">DUO</span>
                            </>
                          )}
                          {isMe && <span className="ds-dt lb-you-tag">YOU</span>}
                        </span>
                      </td>
                      {isRecords && (
                        <td>
                          {cfg ? (
                            <button
                              className="lb-robot"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenRow(isOpen ? null : r.userId);
                              }}
                              title="View robot"
                            >
                              {DT_LABEL[cfg.spec.drivetrain]}
                              {cfg.partnerSpec && ` + ${DT_LABEL[cfg.partnerSpec.drivetrain]}`}
                              <span className="tw">{isOpen ? '▴' : '▾'}</span>
                            </button>
                          ) : (
                            <span style={{ color: 'var(--ds-mut)' }}>-</span>
                          )}
                        </td>
                      )}
                      {!isRecords && <td>{(r as EloRow).games}</td>}
                      <td className="sc">
                        {isRecords ? rec.score : (r as EloRow).rating}
                        {watchable && <span className="ds-watch"> ▶</span>}
                      </td>
                    </tr>
                    {isRecords && isOpen && cfg && (
                      <tr className="lb-detail">
                        <td colSpan={4}>
                          <ConfigSummary cfg={cfg} game={game} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
