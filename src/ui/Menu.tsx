import type { GameSettings } from '../types';
import type { ChainScoreMode, DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import { MAX_SAVED_ROBOTS, ROBOT_PRESETS } from '../config';
import {
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_STORAGE_MIN,
  CHAIN_SCORE_MODES,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_PRESETS,
  CHAIN_MIN_LENGTH,
  CHAIN_MAX_LENGTH,
  chainStorageMax,
} from '../games/chain/config';
import { CHAIN_MODE_LABELS, CHAIN_INTAKE_LABELS } from '../games/chain/labels';
import { driveParams, lengthLimits, massLimits, rpmLimits, widthLimits } from '../sim/drivetrain';
import { coerceSpec } from '../sim/spawn';
import { RobotPreview } from './RobotPreview';
import { DRIVETRAIN_LABELS, INTAKE_SHORT } from './robotLabels';
import { rangeFill } from './rangeFill';

const INTAKE_LABELS: Record<IntakeStyle, string> = {
  sloped: 'Sloped intake',
  vector: 'Vector wheel intake',
  triangle: 'Triangle intake',
};

/** the shooting range a flywheel inertia is tuned for: a LOW-inertia wheel spins
 * up fast for close rapid-fire, a HIGH-inertia wheel holds speed to sustain long
 * shots (matches the flywheel-recovery cadence model). */
function optimizedZone(inertia: number): string {
  if (inertia <= 0.4) return 'Close range';
  if (inertia <= 0.7) return 'Mid range';
  return 'Long range';
}

// Chain Reaction robot config blurbs (CR-only builder controls). The LABELS
// (CHAIN_MODE_LABELS / CHAIN_INTAKE_LABELS) are shared with the leaderboard config
// summary via ../games/chain/labels so both name the archetype/intake identically.
const CHAIN_MODE_BLURBS: Record<ChainScoreMode, string> = {
  turret: 'Aims itself and fires one at a time',
  drum: 'Face the goal and fire a fast stream',
  dumper: 'Face the goal and dump the whole load up close',
};

/** does the current spec exactly match a preset? (value compare) */
/** a preset match is about the BUILD only — name/team/number are the player's
 * own identity, never copied from (or compared against) a preset. */
function specMatches(a: RobotSpec, b: RobotSpec): boolean {
  return (
    a.length === b.length &&
    a.width === b.width &&
    a.intake === b.intake &&
    a.massLb === b.massLb &&
    a.drivetrain === b.drivetrain &&
    a.driveRpm === b.driveRpm &&
    a.flywheelInertia === b.flywheelInertia &&
    a.canSort === b.canSort
  );
}

/** Chain Reaction preset match: the shared drivetrain/size/mass/rpm build PLUS the
 * CR-specific loadout (archetype, intake design, storage, clearance). Flywheel inertia
 * is ignored (CR doesn't use it). */
function chainSpecMatches(a: RobotSpec, b: RobotSpec): boolean {
  return (
    a.length === b.length &&
    a.width === b.width &&
    a.massLb === b.massLb &&
    a.drivetrain === b.drivetrain &&
    a.driveRpm === b.driveRpm &&
    (a.scoreMode ?? 'turret') === (b.scoreMode ?? 'turret') &&
    (a.chainIntake ?? 'sweeper') === (b.chainIntake ?? 'sweeper') &&
    !!a.intakeSide === !!b.intakeSide &&
    !!a.shooterRear === !!b.shooterRear &&
    (a.ballStorage ?? 0) === (b.ballStorage ?? 0) &&
    (a.groundClearance ?? 0) === (b.groundClearance ?? 0)
  );
}

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}

/**
 * The robot loadout builder — the ROBOT section of `Configure`, which owns the
 * page heading. Robot-only by design: presets, the custom builder, intake, and
 * driver-preference tuning (drive style, assists, park). Its sibling Configure
 * sections hold the match setup, controls, and audio; the server region and
 * identity stay in Account. Matches start from `ModeSelect` — there is
 * deliberately no "start match" here.
 */
export function Menu({ settings, onChange }: Props) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  // Apply a fully-formed spec, and when the DRIVETRAIN changes, swap the ACTIVE
  // assists to that drivetrain's remembered slot (assists are per-drivetrain: swerve
  // field-centric, everything else robot-centric). Used by the drivetrain buttons,
  // the intake/slider edits (via setSpec), and preset/saved-robot loads.
  const applySpec = (next: RobotSpec) => {
    const dtChanged = next.drivetrain !== settings.spec.drivetrain;
    onChange({
      ...settings,
      spec: next,
      ...(dtChanged ? { assists: settings.assistsByDrivetrain[next.drivetrain] } : {}),
    });
  };
  // any spec edit RE-CLAMPS all coupled values (mass floor moves with drivetrain +
  // flywheel inertia; rpm ceiling with drivetrain; length with the intake preset)
  const setSpec = (patch: Partial<GameSettings['spec']>) => {
    // STRICT: every edit runs through the SAME canonical validator as load / save /
    // server / spawn (coerceSpec), so the live spec can never hold an out-of-range
    // size, mass, speed, or inertia — length is clamped per intake preset, width to
    // the 18" cube, mass to the drivetrain×inertia floor/ceiling, rpm to the
    // drivetrain range, inertia to 0..1. Identity TEXT (name/team) is kept as typed;
    // it is length-capped on save, not mid-keystroke.
    const merged = { ...settings.spec, ...patch };
    const next: GameSettings['spec'] = {
      ...coerceSpec(merged, undefined, settings.game),
      name: merged.name,
      teamName: merged.teamName,
    };
    applySpec(next);
  };
  // an assist edit updates the ACTIVE assists AND writes back to the current
  // drivetrain's remembered slot, so the choice sticks per drivetrain
  const setAssist = (patch: Partial<GameSettings['assists']>) => {
    const merged = { ...settings.assists, ...patch };
    onChange({
      ...settings,
      assists: merged,
      assistsByDrivetrain: { ...settings.assistsByDrivetrain, [settings.spec.drivetrain]: merged },
    });
  };

  const spec = settings.spec;
  // the shooter-specific build controls (intake preset, flywheel inertia, color
  // sorter) are DECODE concepts — hidden for the Chain Reaction shell, whose real
  // intakes/config arrive with its rules. The shared chassis controls
  // (drivetrain/size/mass/rpm) stay for every game.
  const isDecode = settings.game === 'decode';
  // slider envelopes come from the SAME limit functions coerceSpec clamps with,
  // in the same dependency order (intake → size, drivetrain → rpm, drivetrain ×
  // inertia → mass), so the UI and the validator can never disagree
  // CR runs its own length range (its sweeper doesn't eat into an 18" cube, unlike DECODE's
  // reach-limited intakes) — mirror coerceSpec's game-aware clamp.
  const { min: minLength, max: maxLength } = isDecode
    ? lengthLimits(spec.intake)
    : { min: CHAIN_MIN_LENGTH, max: CHAIN_MAX_LENGTH };
  const { min: minWidth, max: maxWidth } = widthLimits(spec.intake, spec.drivetrain);
  const { min: minRpm, max: maxRpm } = rpmLimits(spec.drivetrain);
  const { min: minMass, max: maxMass } = massLimits(spec.drivetrain, spec.flywheelInertia);
  const dp = driveParams(spec);
  // the builder shows DECODE robot presets or CR archetype presets per the active game
  const presets = isDecode ? ROBOT_PRESETS : CHAIN_PRESETS;
  const presetMatches = isDecode ? specMatches : chainSpecMatches;
  const isCustom = !presets.some((p) => presetMatches(spec, p));

  // ---- the player's SAVED robot library (their own full robots, up to 3) ----
  const savedRobots = settings.savedRobots;
  // a saved slot is the active one when the whole robot matches (identity + build)
  const sameRobot = (a: RobotSpec, b: RobotSpec): boolean =>
    specMatches(a, b) &&
    a.name === b.name &&
    a.teamName === b.teamName &&
    a.teamNumber === b.teamNumber;
  const alreadySaved = savedRobots.some((r) => sameRobot(spec, r));
  const saveCurrentRobot = (): void => {
    if (savedRobots.length >= MAX_SAVED_ROBOTS || alreadySaved) return;
    set({ savedRobots: [...savedRobots, { ...spec }] });
  };
  const deleteSavedRobot = (i: number): void =>
    set({ savedRobots: savedRobots.filter((_, j) => j !== i) });

  function selectIntake(intake: IntakeStyle) {
    // setSpec re-clamps chassis length into the new preset's range (18in cube)
    setSpec({ intake });
  }

  return (
    <>
      {/* the page heading is owned by the Configure host */}
      <div className="ds-robot">
        {/* ---------- robot hero ---------- */}
        <div className="ds-hero">
          <div className="ds-hero-view">
            <RobotPreview spec={spec} size={160} chain={!isDecode} />
          </div>
          <div className="ds-hero-info">
            <div>
              <div className="ds-hero-name">
                {spec.name || 'Unnamed'}
                {isCustom && <span className="cust">CUSTOM</span>}
              </div>
              <div className="ds-hero-team">
                {spec.teamName || 'No team'}
                {spec.teamNumber ? ` · #${spec.teamNumber}` : ''}
              </div>
            </div>
            <div className="ds-stats">
              <div className="ds-stat">
                <span className="sv">{dp.maxSpeed.toFixed(0)}</span>
                <span className="sl">in/s top</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{dp.accel.toFixed(0)}</span>
                <span className="sl">in/s² accel</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{dp.maxTurn.toFixed(1)}</span>
                <span className="sl">rad/s turn</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{dp.turnAccel.toFixed(1)}</span>
                <span className="sl">rad/s² ang. accel</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{spec.massLb}</span>
                <span className="sl">lb mass</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{spec.driveRpm}</span>
                <span className="sl">drive rpm</span>
              </div>
              <div className="ds-stat">
                <span className="sv" style={{ fontSize: 13 }}>
                  {DRIVETRAIN_LABELS[spec.drivetrain]}
                </span>
                <span className="sl">drivetrain</span>
              </div>
              <div className="ds-stat">
                <span className="sv" style={{ fontSize: 13 }}>
                  {INTAKE_SHORT[spec.intake]}
                  {spec.canSort ? ' +sort' : ''}
                </span>
                <span className="sl">intake</span>
              </div>
            </div>
          </div>
        </div>

        {/* ---------- saved robots (the player's own garage) ---------- */}
        <section className="ds-sec">
          <h2>
            Saved robots <span className="ds-count">{savedRobots.length}/{MAX_SAVED_ROBOTS}</span>
          </h2>
          <div className="ds-opts">
            {savedRobots.map((r, i) => (
              <div
                key={i}
                className={`ds-opt ${sameRobot(spec, r) ? 'on' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => applySpec({ ...r })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') applySpec({ ...r });
                }}
              >
                <button
                  className="ds-opt-del"
                  title="Delete this robot"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSavedRobot(i);
                  }}
                >
                  ✕
                </button>
                <span className="ot">{r.name || 'Unnamed'}</span>
                <span className="od">
                  {r.teamNumber ? `${r.teamNumber} · ` : ''}
                  {r.teamName || 'No team'}
                </span>
                <span className="om">
                  {DRIVETRAIN_LABELS[r.drivetrain]} · {r.massLb} lb · {r.driveRpm} RPM ·{' '}
                  {INTAKE_SHORT[r.intake]} · {r.flywheelInertia} inertia
                  {r.canSort ? ' · sorts' : ''}
                </span>
              </div>
            ))}
            {savedRobots.length < MAX_SAVED_ROBOTS && (
              <button
                className="ds-opt ds-opt-add"
                onClick={saveCurrentRobot}
                disabled={alreadySaved}
                title={alreadySaved ? 'This robot is already saved' : 'Save the current robot'}
              >
                <span className="ot">＋ Save current</span>
                <span className="od">
                  {alreadySaved
                    ? 'Already in your garage'
                    : `${spec.name || 'Unnamed'} → slot ${savedRobots.length + 1}`}
                </span>
              </button>
            )}
          </div>
        </section>

        {/* ---------- presets ---------- */}
        <section className="ds-sec">
          <h2>Presets</h2>
          <div className="ds-opts">
            {presets.map((p) => (
              <button
                key={p.name}
                className={`ds-opt ${presetMatches(spec, p) ? 'on' : ''}`}
                onClick={() =>
                  // copy the BUILD only — keep the player's own name/team/number.
                  // applySpec swaps assists to the preset's drivetrain slot (so the
                  // Cypher swerve preset loads field-centric, the rest robot-centric).
                  applySpec({
                    ...p,
                    name: spec.name,
                    teamName: spec.teamName,
                    teamNumber: spec.teamNumber,
                  })
                }
              >
                <span className="ot">{p.name}</span>
                <span className="od">
                  {isDecode ? `${p.teamNumber} · ${p.teamName}` : p.teamName}
                </span>
                {isDecode ? (
                  <>
                    <span className="om">
                      {DRIVETRAIN_LABELS[p.drivetrain]} · {p.massLb} lb · {p.driveRpm} RPM ·{' '}
                      {INTAKE_SHORT[p.intake]} · {p.flywheelInertia} inertia
                      {p.canSort ? ' · sorts' : ''}
                    </span>
                    <span className="oz">🎯 {optimizedZone(p.flywheelInertia)}</span>
                  </>
                ) : (
                  <>
                    <span className="om">
                      {DRIVETRAIN_LABELS[p.drivetrain]} · {p.massLb} lb · {p.driveRpm} RPM ·{' '}
                      {CHAIN_INTAKE_LABELS[p.chainIntake ?? CHAIN_DEFAULT_INTAKE]} · {p.ballStorage} store
                    </span>
                    <span className="oz">
                      🎯 {CHAIN_MODE_LABELS[p.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE]}
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* ---------- builder ---------- */}
        <section className="ds-sec">
          <h2>Customize</h2>
          <div className="ds-panelbox">
            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">Robot name</span>
                <input
                  className="ds-input"
                  type="text"
                  maxLength={24}
                  value={spec.name}
                  onChange={(e) => setSpec({ name: e.target.value })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">Team name</span>
                <input
                  className="ds-input"
                  type="text"
                  maxLength={48}
                  value={spec.teamName}
                  onChange={(e) => setSpec({ teamName: e.target.value })}
                />
              </label>
              <label className="ds-field" style={{ flex: '0 1 110px' }}>
                <span className="cap">Team #</span>
                <input
                  className="ds-input"
                  type="number"
                  min={0}
                  max={99999}
                  value={spec.teamNumber || ''}
                  onChange={(e) =>
                    setSpec({ teamNumber: Math.max(0, Math.round(Number(e.target.value) || 0)) })
                  }
                />
              </label>
            </div>

            <div className="ds-opts four">
              {(Object.keys(DRIVETRAIN_LABELS) as DrivetrainType[]).map((d) => (
                <button
                  key={d}
                  className={`ds-opt mini ${spec.drivetrain === d ? 'on' : ''}`}
                  onClick={() => setSpec({ drivetrain: d })}
                >
                  <span className="ot">{DRIVETRAIN_LABELS[d]}</span>
                </button>
              ))}
            </div>

            {/* Chain Reaction — SCORING ARCHETYPE + shooter mount + intake come FIRST: they
                set the numeric limits (storage cap, etc.) the sliders below are clamped to. */}
            {!isDecode && (
              <>
                <h3 className="ds-subh">Scoring archetype</h3>
                <div className="ds-opts">
                  {CHAIN_SCORE_MODES.map((m) => (
                    <button
                      key={m}
                      className={`ds-opt ${(spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE) === m ? 'on' : ''}`}
                      onClick={() => setSpec({ scoreMode: m })}
                    >
                      <span className="ot">{CHAIN_MODE_LABELS[m]}</span>
                      <span className="od">{CHAIN_MODE_BLURBS[m]}</span>
                    </button>
                  ))}
                </div>
                {(spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE) !== 'turret' && (
                  <>
                    <h3 className="ds-subh">Shooter mount</h3>
                    <div className="ds-opts two">
                      <button
                        className={`ds-opt ${!spec.shooterRear ? 'on' : ''}`}
                        onClick={() => setSpec({ shooterRear: false })}
                      >
                        <span className="ot">FRONT</span>
                      </button>
                      <button
                        className={`ds-opt ${spec.shooterRear ? 'on' : ''}`}
                        onClick={() => setSpec({ shooterRear: true })}
                      >
                        <span className="ot">REAR</span>
                      </button>
                    </div>
                  </>
                )}
                <h3 className="ds-subh">Intake design</h3>
                <div className="ds-opts">
                  <div className="ds-opt on" aria-disabled>
                    <span className="ot">{CHAIN_INTAKE_LABELS.sweeper}</span>
                  </div>
                </div>
                <h3 className="ds-subh">Intake mount</h3>
                <div className="ds-opts two">
                  <button
                    className={`ds-opt ${!spec.intakeSide ? 'on' : ''}`}
                    onClick={() => setSpec({ intakeSide: false })}
                  >
                    <span className="ot">FRONT</span>
                  </button>
                  <button
                    className={`ds-opt ${spec.intakeSide ? 'on' : ''}`}
                    onClick={() => setSpec({ intakeSide: true })}
                  >
                    <span className="ot">SIDE</span>
                    <span className="od">Holds fewer</span>
                  </button>
                </div>
              </>
            )}

            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  Length <span className="val">{spec.length}"</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minLength}
                  max={maxLength}
                  step={0.5}
                  value={spec.length}
                  style={rangeFill(spec.length, minLength, maxLength)}
                  onChange={(e) => setSpec({ length: Number(e.target.value) })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">
                  Width <span className="val">{spec.width}"</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minWidth}
                  max={maxWidth}
                  step={0.5}
                  value={spec.width}
                  style={rangeFill(spec.width, minWidth, maxWidth)}
                  onChange={(e) => setSpec({ width: Number(e.target.value) })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">
                  Mass <span className="val">{spec.massLb} lb</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minMass}
                  max={maxMass}
                  step={1}
                  value={spec.massLb}
                  style={rangeFill(spec.massLb, minMass, maxMass)}
                  onChange={(e) => setSpec({ massLb: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  Drive RPM <span className="val">{spec.driveRpm}</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minRpm}
                  max={maxRpm}
                  step={5}
                  value={spec.driveRpm}
                  style={rangeFill(spec.driveRpm, minRpm, maxRpm)}
                  onChange={(e) => setSpec({ driveRpm: Number(e.target.value) })}
                />
              </label>
              {isDecode && (
                <label className="ds-field">
                  <span className="cap">
                    Flywheel inertia <span className="val">{spec.flywheelInertia.toFixed(2)}</span>
                  </span>
                  <input
                    className="ds-range"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={spec.flywheelInertia}
                    style={rangeFill(spec.flywheelInertia, 0, 1)}
                    // a bigger flywheel weighs more: setSpec raises the mass floor
                    // and pulls mass up with it so the loadout stays legal
                    onChange={(e) => setSpec({ flywheelInertia: Number(e.target.value) })}
                  />
                </label>
              )}
              {isDecode && (
                <button
                  className={`ds-opt mini ${spec.canSort ? 'on' : ''}`}
                  style={{ flex: '1 1 150px' }}
                  onClick={() => setSpec({ canSort: !spec.canSort })}
                >
                  <span className="ot">Sorter {spec.canSort ? 'ON' : 'OFF'}</span>
                </button>
              )}
              {!isDecode && (() => {
                const storeMax = chainStorageMax(spec);
                const store = Math.min(spec.ballStorage ?? CHAIN_STORAGE_DEFAULT, storeMax);
                return (
                  <label className="ds-field">
                    <span className="cap">
                      Ball storage <span className="val">{store} / {storeMax} particles</span>
                    </span>
                    <input
                      className="ds-range"
                      type="range"
                      min={CHAIN_STORAGE_MIN}
                      max={storeMax}
                      step={1}
                      value={store}
                      style={rangeFill(store, CHAIN_STORAGE_MIN, storeMax)}
                      onChange={(e) => setSpec({ ballStorage: Number(e.target.value) })}
                    />
                  </label>
                );
              })()}
              {!isDecode && (
                <label className="ds-field">
                  <span className="cap">
                    Ground clearance{' '}
                    <span className="val">{(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT).toFixed(1)}"</span>
                  </span>
                  <input
                    className="ds-range"
                    type="range"
                    min={CHAIN_CLEARANCE_MIN}
                    max={CHAIN_CLEARANCE_MAX}
                    step={0.1}
                    value={spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT}
                    style={rangeFill(
                      spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT,
                      CHAIN_CLEARANCE_MIN,
                      CHAIN_CLEARANCE_MAX,
                    )}
                    onChange={(e) => setSpec({ groundClearance: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>
          </div>

          {isDecode && (
          <div className="ds-opts">
            {(Object.keys(INTAKE_LABELS) as IntakeStyle[]).map((i) => (
              <button
                key={i}
                className={`ds-opt ${spec.intake === i ? 'on' : ''}`}
                onClick={() => selectIntake(i)}
              >
                <span className="ot">{INTAKE_LABELS[i]}</span>
              </button>
            ))}
          </div>
          )}

        </section>

        {/* ---------- driver preferences (remembered per drivetrain) ---------- */}
        <section className="ds-sec">
          <h2>Drive style</h2>
          <div className="ds-opts two">
            <button
              className={`ds-opt ${settings.assists.fieldCentric ? 'on' : ''}`}
              onClick={() => setAssist({ fieldCentric: true })}
            >
              <span className="ot">Field-centric</span>
            </button>
            <button
              className={`ds-opt ${!settings.assists.fieldCentric ? 'on' : ''}`}
              onClick={() => setAssist({ fieldCentric: false })}
            >
              <span className="ot">Robot-centric</span>
            </button>
          </div>
          {spec.drivetrain === 'tank' && (
            <div className="ds-opts two" style={{ marginTop: 12 }}>
              <button
                className={`ds-opt ${settings.tankControlMode === 'normal' ? 'on' : ''}`}
                onClick={() => set({ tankControlMode: 'normal' })}
              >
                <span className="ot">Normal Tank</span>
                <span className="od">L-stick/W-S: Fwd/Back · R-stick/Arrows: Turn</span>
              </button>
              <button
                className={`ds-opt ${settings.tankControlMode === 'traditional' ? 'on' : ''}`}
                onClick={() => set({ tankControlMode: 'traditional' })}
              >
                <span className="ot">Traditional Tank</span>
                <span className="od">L-stick/W-S: Left · R-stick/Arrows: Right</span>
              </button>
            </div>
          )}
        </section>

        <section className="ds-sec">
          <h2>Driver assists</h2>
          <div className="ds-opts">
            <button
              className={`ds-opt ${settings.assists.aimAssist ? 'on' : ''}`}
              onClick={() => setAssist({ aimAssist: !settings.assists.aimAssist })}
            >
              <span className="ot">Aim assist {settings.assists.aimAssist ? 'ON' : 'OFF'}</span>
            </button>
            <button
              className={`ds-opt ${settings.assists.autoIntake ? 'on' : ''}`}
              onClick={() => setAssist({ autoIntake: !settings.assists.autoIntake })}
            >
              <span className="ot">Auto intake {settings.assists.autoIntake ? 'ON' : 'OFF'}</span>
            </button>
            <button
              className={`ds-opt ${settings.assists.autoFire ? 'on' : ''}`}
              onClick={() => setAssist({ autoFire: !settings.assists.autoFire })}
            >
              <span className="ot">Auto fire {settings.assists.autoFire ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Park mode</h2>
          <div className="ds-panelbox">
            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  Speed cap <span className="val">{settings.parkSpeedPct}%</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={settings.parkSpeedPct}
                  style={rangeFill(settings.parkSpeedPct, 0, 100)}
                  onChange={(e) => set({ parkSpeedPct: Number(e.target.value) })}
                />
              </label>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
