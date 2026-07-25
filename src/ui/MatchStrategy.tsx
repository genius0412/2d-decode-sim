import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameSettings, RobotSpec } from '../types';
import { START_POSES } from '../config';
import { CHAIN_START_POSES } from '../games/chain/config';
import { activeStartLegal } from '../sim/field';
import { StartPositionEditor } from './StartPositionEditor';
import { ChainStartSelector } from './ChainStartSelector';
import { selectStart, switchCategory, saveStart, deleteSavedStart, indexCategory } from './startPositions';
import { useRoleSwap, useDismissable } from './useRoleSwap';
import { RoleSwapBar } from './RoleSwapBar';
import type { LobbyClient } from '../net/lobbyClient';
import type { LobbyPlayer, PlayerIntro, QueueMode } from '../net/protocol';
import { RobotPreview } from './RobotPreview';
import { DRIVETRAIN_LABELS, INTAKE_SHORT } from './robotLabels';
import { Menu } from './Menu';
import { MatchAudio } from '../audio';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';

/** beep once per second over the final STRAT_TICK_FROM seconds of the strategy
 * deadline, rising in pitch as it nears (like a match countdown). */
const STRAT_TICK_FROM = 5;

interface Props {
  lobby: LobbyClient;
  players: LobbyPlayer[];
  myClientId: string;
  deadline: number; // epoch ms — match cancels if not everyone's ready by then
  mode: QueueMode;
  intros: PlayerIntro[];
  settings: GameSettings;
  onSettingsChange: (s: GameSettings) => void;
  onLeave: () => void;
}

/**
 * Ranked PRE-MATCH strategy window. Paired strangers (especially a 2v2 alliance)
 * finally see each other before the match: their OWN alliance's builds in full, the
 * opponents as minimal name/team/ELO cards (the server redacts opponent specs so no
 * one can counter-pick), a close/far start-pose claim so partners don't stack, and a
 * strict ready gate. Re-pick is allowed here — a driver can swap a saved robot or open
 * the full builder; the server takes the live build at match start (still clamped to
 * the build limits). The match starts the instant everyone readies; if the deadline
 * passes with anyone not ready the server cancels (arrives as an `error` → onLeave).
 *
 * NO `useEscape` here, unlike the other console screens: `onLeave` forfeits a paired
 * ranked match for everyone in the room, so it stays a deliberate click on ← Leave.
 */
export function MatchStrategy({
  lobby,
  players,
  myClientId,
  deadline,
  mode,
  intros,
  settings,
  onSettingsChange,
  onLeave,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(iv);
  }, []);

  const me = players.find((p) => p.clientId === myClientId) ?? null;
  const myAlliance = me?.alliance;
  const mates = useMemo(
    () => players.filter((p) => p.alliance === myAlliance && p.clientId !== myClientId && !p.hidden),
    [players, myAlliance, myClientId],
  );
  const opponents = useMemo(
    () => players.filter((p) => p.hidden || (myAlliance && p.alliance !== myAlliance)),
    [players, myAlliance],
  );

  const eloOf = (p: LobbyPlayer): string => {
    const e = p.slot !== undefined ? intros.find((i) => i.id === p.slot)?.elo : null;
    return e === null || e === undefined ? 'Unranked' : String(Math.round(e));
  };

  const secsLeft = Math.max(0, Math.ceil((deadline - now) / 1000));

  // countdown SFX: tick down over the final seconds before the deadline. Own audio
  // instance (the game controller isn't up yet here), gated by the Sounds toggle.
  const audioRef = useRef<MatchAudio | null>(null);
  if (audioRef.current === null) audioRef.current = new MatchAudio();
  audioRef.current.masterVolume = settings.audio.volume.master;
  audioRef.current.gameVolume = settings.audio.volume.game;
  audioRef.current.sfxVolume = settings.audio.volume.sfx;
  audioRef.current.voiceVolume = settings.audio.volume.voice;
  const lastTickRef = useRef(Infinity);
  useEffect(() => {
    const a = audioRef.current;
    // fire once per new second in the danger zone (poll runs at 4 Hz, so guard on a
    // strict decrease so we don't re-beep within the same second)
    if (a && secsLeft >= 1 && secsLeft <= STRAT_TICK_FROM && secsLeft < lastTickRef.current) {
      a.beep(700 + (STRAT_TICK_FROM - secsLeft) * 90, secsLeft === 1 ? 0.24 : 0.1, 0.4);
    }
    lastTickRef.current = secsLeft;
  }, [secsLeft]);

  const readyCount = players.filter((p) => p.ready).length;
  const allReady = players.length > 0 && players.every((p) => p.ready);

  const toggleReady = (): void => lobby.update({ ready: !me?.ready });

  // 2v2 ROLE + consent swap (shared with Lobby via useRoleSwap)
  const rs = useRoleSwap(players, me, (patch) => lobby.update(patch), settings.game);
  const startRole = rs.role;
  const [swapDismissed, dismissSwap] = useDismissable(rs.incoming);
  const sCat: GameSettings = { ...settings, startCat: startRole ?? settings.startCat };
  const applyStart = (patch: Partial<GameSettings>): void => {
    const roster: Record<string, unknown> = {};
    if ('startIndex' in patch) roster.startIndex = patch.startIndex;
    if ('startPose' in patch) roster.startPose = patch.startPose ?? null;
    if (Object.keys(roster).length) lobby.update(roster);
    const keys: (keyof GameSettings)[] = ['startCat', 'startMemory', 'savedStartPoses'];
    if (keys.some((k) => k in patch)) onSettingsChange({ ...settings, ...patch });
  };

  // A locked ROLE forces its category: if my active start is in the OTHER category,
  // switch it to this role's remembered/default pick so a FAR robot never sits on a
  // CLOSE spot (or vice-versa). See the matching effect in Lobby.
  useEffect(() => {
    if (!startRole || !me) return;
    const activeCat = me.startPose ? settings.startCat : indexCategory(me.startIndex, settings.game);
    if (activeCat !== startRole) applyStart(switchCategory(sCat, startRole));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRole, me?.startIndex, me?.startPose, settings.startCat]);

  /** re-pick: swap to a saved robot (or any spec) — echoes to the server + persists */
  const pickSpec = (spec: RobotSpec): void => {
    onSettingsChange({ ...settings, spec });
    lobby.update({ spec, assists: settings.assists });
  };

  /** the full builder edits settings.spec live; mirror every change to the server */
  const onBuilderChange = (next: GameSettings): void => {
    onSettingsChange(next);
    lobby.update({ spec: next.spec, assists: next.assists });
  };

  const mySpec = me?.spec ?? settings.spec;
  // my start pose must be legal for my (possibly just-swapped) chassis to ready up.
  // CR start anchors are legal by construction (G04) — only DECODE gates on G304.
  const startLegal =
    settings.game === 'chain' || activeStartLegal(mySpec, myAlliance ?? settings.alliance, me?.startPose);

  // full-builder takeover: reuse the My Robot menu, with a Done button back
  if (building) {
    return (
      <div className="ds-console">
        <div className="ds-console-in">
          <div className="ds-head">
            <button className="ds-back" onClick={() => setBuilding(false)}>
              ← Done
            </button>
            <span className="ds-mark">
              <Logo size={24} />
              {APP_NAME}
            </span>
          </div>
          <Menu settings={settings} onChange={onBuilderChange} />
          <div className="ds-actions">
            <button className="ds-cta" onClick={() => setBuilding(false)}>
              DONE ▶
            </button>
          </div>
        </div>
      </div>
    );
  }

  const buildRow = (spec: RobotSpec): JSX.Element => (
    <span className="ptm">
      {DRIVETRAIN_LABELS[spec.drivetrain]} · {INTAKE_SHORT[spec.intake]} · {spec.driveRpm} rpm ·{' '}
      {spec.massLb} lb{spec.canSort ? ' · sorts' : ''}
    </span>
  );

  return (
    <div className="ds-console">
      <div className="ds-console-in">
        <div className="ds-head">
          <button className="ds-back" onClick={onLeave}>
            ← Leave
          </button>
          <span className="ds-mark">
            <Logo size={24} />
            {APP_NAME}
          </span>
        </div>
        <div className="ds-title">
          <h1>
            Match <span className="accent">Strategy</span>
          </h1>
        </div>
        <p
          className="ds-sub"
          style={{
            marginTop: -10,
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span>
            {mode.toUpperCase()} · {readyCount}/{players.length} ready
          </span>
          <span className={`ds-chip ${secsLeft <= STRAT_TICK_FROM ? 'off' : 'on'}`} title="Match cancels if not everyone readies in time">
            ⏱ {secsLeft}s
          </span>
        </p>

        {/* opponents — minimal (server redacts their builds) */}
        {opponents.length > 0 && (
          <section className="ds-sec">
            <h2>{opponents.length > 1 ? 'Opponents' : 'Opponent'}</h2>
            <div className="ds-players">
              {opponents.map((p) => (
                <div key={p.clientId} className={`ds-player ${p.alliance}`}>
                  <span className="pdot" />
                  <span className="pnm">{p.name}</span>
                  <span className="ptm">Team {p.teamNumber || '—'}</span>
                  <span className={`ds-chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  <span className="ds-chip">ELO {eloOf(p)}</span>
                  <span className={`ds-chip ${p.ready ? 'on' : 'off'}`}>
                    {p.ready ? 'READY' : '…'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* your alliance — full build reveal */}
        <section className="ds-sec">
          <h2>Your alliance</h2>
          <div className="ds-strat-cards">
            {[me, ...mates].filter(Boolean).map((p) => {
              const pl = p as LobbyPlayer;
              const isMe = pl.clientId === myClientId;
              const spec = isMe ? mySpec : pl.spec;
              return (
                <div key={pl.clientId} className={`ds-strat-card ${pl.alliance}`}>
                  <div className="ds-strat-prev">
                    <RobotPreview spec={spec} size={132} chain={settings.game === 'chain'} />
                  </div>
                  <div className="ds-strat-meta">
                    <span className="pnm">
                      {pl.name}
                      {isMe ? ' (you)' : ''}
                    </span>
                    <span className="ptm">
                      {spec.name} · Team {pl.teamNumber || '—'}
                    </span>
                    {buildRow(spec)}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      <span className={`ds-chip ${pl.alliance}`}>{pl.alliance.toUpperCase()}</span>
                      <span className="ds-chip">
                        {pl.startPose
                          ? 'CUSTOM'
                          : settings.game === 'chain'
                            ? (CHAIN_START_POSES[pl.startIndex]?.name ?? '—')
                            : (START_POSES[pl.startIndex]?.label ?? '—')}
                      </span>
                      <span className="ds-chip">ELO {eloOf(pl)}</span>
                      <span className={`ds-chip ${pl.ready ? 'on' : 'off'}`}>
                        {pl.ready ? 'READY' : 'NOT READY'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* start position — drag to place, constrained to a legal G304 setup */}
        {me && (
          <section className="ds-sec">
            <h2>Start position {mates.length > 0 && <span className="ds-note">— agree who goes where</span>}</h2>
            {rs.canSwap && (
              <RoleSwapBar
                role={startRole}
                partnerName={rs.partner?.name ?? 'Partner'}
                rs={rs}
                dismissed={swapDismissed}
                onDismiss={dismissSwap}
                game={settings.game}
              />
            )}
            {settings.game === 'chain' ? (
              <ChainStartSelector
                startIndex={me.startIndex ?? 0}
                onPick={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
                role={startRole}
              />
            ) : (
              <StartPositionEditor
                spec={me.spec}
                alliance={me.alliance}
                value={me.startPose}
                startIndex={me.startIndex}
                category={startRole ?? settings.startCat}
                saved={settings.savedStartPoses}
                lockedCategory={startRole}
                onChange={(startPose) => startPose && applyStart(selectStart(sCat, { index: -1, pose: startPose }))}
                onPickPreset={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
                onCategory={(c) => applyStart(switchCategory(settings, c))}
                onSave={(pose) => applyStart(saveStart(sCat, pose))}
                onDeleteSaved={(c, i) => applyStart(deleteSavedStart(sCat, c, i))}
              />
            )}
          </section>
        )}

        {/* re-pick: quick-swap a saved robot, or open the full builder */}
        <section className="ds-sec">
          <h2>Your robot</h2>
          <div className="ds-opts" style={{ flexWrap: 'wrap' }}>
            {settings.savedRobots.map((r, i) => {
              const active =
                r.length === mySpec.length &&
                r.width === mySpec.width &&
                r.intake === mySpec.intake &&
                r.drivetrain === mySpec.drivetrain &&
                r.driveRpm === mySpec.driveRpm &&
                r.massLb === mySpec.massLb;
              return (
                <button
                  key={i}
                  className={`ds-opt mini ${active ? 'on' : ''}`}
                  onClick={() => pickSpec({ ...r })}
                >
                  <span className="ot">{r.name || `Robot ${i + 1}`}</span>
                  <span className="ds-note">{DRIVETRAIN_LABELS[r.drivetrain]}</span>
                </button>
              );
            })}
            <button className="ds-opt mini" onClick={() => setBuilding(true)}>
              <span className="ot">Edit build ✎</span>
              <span className="ds-note">full builder</span>
            </button>
          </div>
        </section>

        <div className="ds-actions">
          <button
            className={`ds-cta ${me?.ready ? 'ghost' : ''}`}
            disabled={!startLegal && !me?.ready}
            onClick={toggleReady}
          >
            {me?.ready ? '✓ READY' : 'READY UP'}
          </button>
        </div>
        <p className="ds-hint">
          {!startLegal
            ? '⚠ Your start position isn’t legal for this chassis — fix it above (or pick a preset) to ready up.'
            : allReady
              ? 'Everyone ready — starting…'
              : `The match starts when all ${players.length} drivers are ready. It CANCELS if anyone isn’t ready in ${secsLeft}s.`}
        </p>
      </div>
    </div>
  );
}
