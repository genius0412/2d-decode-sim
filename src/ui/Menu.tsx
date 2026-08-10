import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../types';
import type { ChainScoreMode, DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import { MAX_SAVED_ROBOTS, ROBOT_PRESETS, CHASSIS_COLORS, CHASSIS_COLOR_KEYS } from '../config';
import { useAds } from '../ads/AdsProvider';
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
  chainStorageMax,
  chainMassFloorBump,
  chainSizeLimits,
  CHAIN_CATALYST_TYPES,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_CATAPULT_RANGE_MIN,
  CHAIN_CATAPULT_RANGE_MAX,
  CHAIN_CATAPULT_YAW_STEP,
  chainCatapultRange,
} from '../games/chain/config';
import {
  CHAIN_MODE_LABELS,
  CHAIN_INTAKE_LABELS,
  CHAIN_INTAKE_MOUNT_LABELS,
  CHAIN_INTAKE_MOUNT_BLURBS,
  CHAIN_SHOOTER_MOUNT_LABELS,
  CHAIN_SHOOTER_MOUNT_BLURBS,
  CHAIN_CATALYST_LABELS,
  CHAIN_CATALYST_BLURBS,
  CHAIN_CATALYST_MOUNT_LABELS,
} from '../games/chain/labels';
import {
  CHAIN_CATALYST_MOUNTS,
  isEdgePos,
  mountsClash,
  CHAIN_INTAKE_MOUNTS,
  CHAIN_SHOOTER_MOUNTS,
  CHAIN_TURRET_POSITIONS,
  catalystMountOf,
  catalystSwingOf,
  intakeMountOf,
  isSwingMount,
  isTurreted,
  shooterMountOf,
  swingHomeFor,
} from '../games/chain/mounts';
import {
  butterflyTankRpm,
  butterflyTankRpmLimits,
  driveParams,
  lengthLimits,
  massLimits,
  rpmLimits,
  widthLimits,
} from '../sim/drivetrain';
import { coerceSpec, coerceAssists, PLAYER_ASSISTS } from '../sim/spawn';
import { RobotPreview } from './RobotPreview';
import { ChainRobotPreview } from '../games/chain/RobotPreview';
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
  twinturret: 'Two shooters on one turret · faster, holds less',
  drum: 'Face the goal and fire a fast stream',
  dumper: 'Face the goal and dump the whole load up close',
};

/**
 * Is the pinned hero scrolled past? Drives the compact `.stuck` strip (see `.ds-hero`).
 *
 * A passive SCROLL listener rather than an IntersectionObserver: the offset it compares
 * against is measured ONCE at mount, so each scroll event is a single number comparison — no
 * `getBoundingClientRect`, no forced reflow, and `setStuck` with an unchanged value is a React
 * no-op, so a long drag re-renders only on the two transitions. (IntersectionObserver would be
 * the textbook pick, but it does not fire at all in a backgrounded/hidden view, which makes
 * this impossible to verify — and a feature you cannot check is a feature you do not know
 * works.)
 */
function useStuck(): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const root = el?.closest('.ds-app');
    if (!el || !root) return;
    // How far the hero pins BELOW the sticky app bar is a CSS contract (`--ds-bar-h`), so this
    // only has to decide WHEN it is pinned: the sentinel's own offset in the scroll content,
    // less that bar height. Re-measured on resize because the layout reflows.
    const barH = () =>
      parseFloat(getComputedStyle(root).getPropertyValue('--ds-bar-h')) || 0;
    const measure = () =>
      el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - barH();
    let base = measure();
    const onScroll = () => setStuck(root.scrollTop > base);
    const onResize = () => {
      base = measure();
      onScroll();
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return [ref, stuck];
}

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
    (a.tankRpm ?? 0) === (b.tankRpm ?? 0) &&
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
    (a.tankRpm ?? 0) === (b.tankRpm ?? 0) &&
    (a.scoreMode ?? 'turret') === (b.scoreMode ?? 'turret') &&
    (a.chainIntake ?? 'sweeper') === (b.chainIntake ?? 'sweeper') &&
    intakeMountOf(a) === intakeMountOf(b) &&
    shooterMountOf(a) === shooterMountOf(b) &&
    (a.ballStorage ?? 0) === (b.ballStorage ?? 0) &&
    (a.groundClearance ?? 0) === (b.groundClearance ?? 0)
  );
}

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}

/**
 * SUPPORTER COSMETIC: the chassis fill.
 *
 * Shown to EVERYONE, locked for non-supporters. A perk that is invisible until
 * you pay for it sells nothing and, worse, makes the tier feel like a mystery
 * box; a visible locked row is honest about what the membership actually is.
 * The swatches are the real hex values, so the row is also the preview — see the
 * comment in `RobotPreview` for why the SVG chassis deliberately is not.
 */
function ChassisColorRow({
  spec,
  onPick,
}: {
  spec: RobotSpec;
  onPick: (key: string) => void;
}) {
  const { supporter } = useAds();
  const current = spec.chassisColor ?? 'default';
  return (
    <div className="ds-field" style={{ flex: '1 1 100%' }}>
      <span className="cap">
        Chassis colour{' '}
        <span className="val">
          {supporter ? current : 'supporter perk'}
        </span>
      </span>
      <div className="chassis-swatches">
        {CHASSIS_COLOR_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`chassis-sw${current === key ? ' on' : ''}`}
            style={{ background: CHASSIS_COLORS[key] }}
            // A locked swatch is `disabled`, not hidden: the browser skips it in
            // the tab order and announces it as unavailable, which is the right
            // story for "you could have this" — and it can't be clicked past.
            disabled={!supporter && key !== 'default'}
            aria-label={`Chassis colour ${key}${!supporter && key !== 'default' ? ' (supporter only)' : ''}`}
            aria-pressed={current === key}
            title={!supporter && key !== 'default' ? 'Supporter perk' : key}
            onClick={() => onPick(key)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The robot loadout builder — the ROBOT section of `Configure`, which owns the
 * page heading. Robot-only by design: presets, the custom builder, intake, and
 * driver-preference tuning (drive style, assists, park). Its sibling Configure
 * sections hold the match setup, controls, and audio; the server region and
 * identity stay in Account. Matches start from `ModeSelect` — there is
 * deliberately no "start match" here.
 */
/**
 * The eight directions a bolted catapult can be aimed, laid out as the 3x3 chassis map every
 * other mount picker uses. YAW IS CCW FROM CHASSIS FORWARD and the robot frame has +y to the
 * LEFT, so left is +90 and right is −90 — the sign nobody should have to work out from a
 * slider. The middle cell is dead: a catapult throws outward, and there is no "into itself".
 */
const CATAPULT_DIRS: { label: string; yaw: number | null; title: string }[] = [
  { label: 'F·LEFT', yaw: 45, title: 'forward-left' },
  { label: 'FRONT', yaw: 0, title: 'straight ahead' },
  { label: 'F·RIGHT', yaw: -45, title: 'forward-right' },
  { label: 'LEFT', yaw: 90, title: 'out the left flank' },
  { label: '·', yaw: null, title: '' },
  { label: 'RIGHT', yaw: -90, title: 'out the right flank' },
  { label: 'B·LEFT', yaw: 135, title: 'back-left' },
  { label: 'BACK', yaw: 180, title: 'straight backward' },
  { label: 'B·RIGHT', yaw: -135, title: 'back-right' },
];

export function Menu({ settings, onChange }: Props) {
  const [sentinelRef, stuck] = useStuck();
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  // Apply a fully-formed spec. ASSISTS RIDE THE ROBOT, so the ACTIVE assists always
  // re-mirror from the incoming spec — loading a preset or a saved robot (or switching
  // games, via switchGame) brings that robot's own drive frame + automation with it.
  // Used by the drivetrain buttons, the intake/slider edits (via setSpec), and loads.
  const applySpec = (next: RobotSpec) => {
    onChange({
      ...settings,
      spec: next,
      assists: coerceAssists(next.assists, PLAYER_ASSISTS),
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
  // an assist edit writes ONTO THE ROBOT (`spec.assists`) and mirrors to the active
  // `assists`, so the choice is saved with the build — it rides saved-robot slots, the
  // per-game loadout, and account sync, instead of being a separate global preference.
  const setAssist = (patch: Partial<GameSettings['assists']>) => {
    const merged = { ...settings.assists, ...patch };
    onChange({
      ...settings,
      spec: { ...settings.spec, assists: merged },
      assists: merged,
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
  // SIZE envelopes, mirroring coerceSpec's game-aware clamp exactly so the slider can never
  // offer a value the coercer would immediately rewrite. CR's is the SAME 15-18" envelope for
  // every build: the sweeper deploys, so it never competed with the chassis for the starting
  // cube, and the mount is paid for in hopper volume instead (`chainMountStoreMult`).
  const crSize = chainSizeLimits(spec);
  const { min: minLength, max: maxLength } = isDecode
    ? lengthLimits(spec.intake)
    : { min: crSize.minLength, max: crSize.maxLength };
  const dtWidth = widthLimits(spec.intake, spec.drivetrain);
  const { min: minWidth, max: maxWidth } = isDecode
    ? dtWidth
    : { min: crSize.minWidth, max: crSize.maxWidth };
  const { min: minRpm, max: maxRpm } = rpmLimits(spec.drivetrain);
  // BUTTERFLY carries two independently geared wheel sets, so it gets a SECOND rpm slider.
  // The traction set runs the torque-biased tank envelope, which tops out lower.
  const isButterfly = spec.drivetrain === 'butterfly';
  const { min: minTankRpm, max: maxTankRpm } = butterflyTankRpmLimits();
  const tankRpmValue = butterflyTankRpm(spec);
  const { min: minMass, max: maxMass } = massLimits(
    spec.drivetrain,
    spec.flywheelInertia,
    // CR mechanisms that weigh something (today: the twin turret's second flywheel). Same
    // value coerceSpec uses, so the slider floor IS the enforced floor.
    isDecode ? 0 : chainMassFloorBump(spec),
  );
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
        {/* ---------- robot hero (PINNED — see .ds-hero) ---------- */}
        <div ref={sentinelRef} aria-hidden style={{ height: 1, marginBottom: -1 }} />
        <div className={`ds-hero${stuck ? ' stuck' : ''}`}>
          <div className="ds-hero-view">
            {/* TWO components, not one with a `chain` flag: DECODE's schematic is
                main's, untouched, and Chain Reaction's is its own — so work on one
                game's mechanisms can never change how the other's robot looks. */}
            {isDecode ? (
              <RobotPreview spec={spec} size={stuck ? 96 : 160} />
            ) : (
              <ChainRobotPreview spec={spec} size={stuck ? 96 : 160} />
            )}
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
              {/* The one PER-GAME tile. It used to print DECODE's intake style for both
                  games, so a Chain Reaction robot claimed a "Sloped" intake — a DECODE
                  part it does not have. CR has a single intake design, so naming it says
                  nothing; the SCORING ARCHETYPE is that game's defining build choice and
                  is otherwise absent from this summary. */}
              {isDecode ? (
                <div className="ds-stat">
                  <span className="sv" style={{ fontSize: 13 }}>
                    {INTAKE_SHORT[spec.intake]}
                    {spec.canSort ? ' +sort' : ''}
                  </span>
                  <span className="sl">intake</span>
                </div>
              ) : (
                <>
                  <div className="ds-stat">
                    <span className="sv" style={{ fontSize: 13 }}>
                      {CHAIN_MODE_LABELS[spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE]}
                    </span>
                    <span className="sl">scoring</span>
                  </div>
                  {/* THE CATALYST, which this summary never mentioned. It is half the build
                      in CR — a whole mechanism with a type, a place on the chassis and, now,
                      a direction it swings — and changing any of that left every tile on the
                      card reading exactly the same, which looks like the picker did nothing. */}
                  <div className="ds-stat">
                    <span className="sv" style={{ fontSize: 13 }}>
                      {CHAIN_CATALYST_LABELS[spec.catalystType ?? CHAIN_DEFAULT_CATALYST]}
                    </span>
                    <span className="sl">catalyst</span>
                    <span className="sl">
                      {catalystSwingOf(spec)
                        ? `swing ${catalystSwingOf(spec) === 'fb' ? '↕' : '↔'} · ${CHAIN_CATALYST_MOUNT_LABELS[catalystMountOf(spec)]}`
                        : CHAIN_CATALYST_MOUNT_LABELS[catalystMountOf(spec)]}
                    </span>
                  </div>
                </>
              )}
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
                {/* GAME-AWARE, like the preset cards above. This line used to print
                    the DECODE fields whatever game you were in — intake preset,
                    flywheel inertia, colour sorter — none of which a Chain Reaction
                    robot has or uses, so a CR saved slot described a robot that did
                    not exist. Same split the leaderboard's spec summary makes. */}
                {isDecode ? (
                  <span className="om">
                    {DRIVETRAIN_LABELS[r.drivetrain]} · {r.massLb} lb · {r.driveRpm} RPM ·{' '}
                    {INTAKE_SHORT[r.intake]} · {r.flywheelInertia} inertia
                    {r.canSort ? ' · sorts' : ''}
                  </span>
                ) : (
                  <span className="om">
                    {DRIVETRAIN_LABELS[r.drivetrain]} · {r.massLb} lb · {r.driveRpm} RPM ·{' '}
                    {CHAIN_INTAKE_LABELS[r.chainIntake ?? CHAIN_DEFAULT_INTAKE]} ·{' '}
                    {CHAIN_MODE_LABELS[r.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE]}
                  </span>
                )}
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
                      {CHAIN_INTAKE_LABELS[p.chainIntake ?? CHAIN_DEFAULT_INTAKE]}{' '}
                      {CHAIN_INTAKE_MOUNT_LABELS[intakeMountOf(p)]} · {p.ballStorage} store
                    </span>
                    {/* a turret is top-mounted, so naming its shooter mount would be noise */}
                    <span className="oz">
                      🎯 {CHAIN_MODE_LABELS[p.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE]}
                      {!isTurreted(p.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE)
                        ? ` · ${CHAIN_SHOOTER_MOUNT_LABELS[shooterMountOf(p)]}`
                        : ''}
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

            {/* ONE SUBSYSTEM PER BLOCK. Each mechanism's picker sits with the sliders that
                tune THAT mechanism (catapult range/yaw under Catalyst, RPM under Drivetrain,
                storage under Scoring) instead of the old layout, where every picker came
                first and every slider was pooled at the bottom — so the catapult sliders sat
                under the chassis dimensions and read as frame settings.

                ORDER IS LOAD-BEARING: FRAME (length/width/mass) comes LAST because every
                block above clamps it — the catalyst and flywheel raise the mass floor, and
                the drivetrain sets both mass and rpm. Picking
                a mechanism and watching a slider below re-clamp reads as cause and effect;
                the reverse reads as the builder fighting you. */}
            <h3 className="ds-subh">Drivetrain</h3>
            <div className="ds-opts five">
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
            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  {isButterfly ? 'Mecanum RPM' : 'Drive RPM'} <span className="val">{spec.driveRpm}</span>
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
              {isButterfly && (
                <label className="ds-field">
                  <span className="cap">
                    Traction RPM <span className="val">{tankRpmValue}</span>
                  </span>
                  <input
                    className="ds-range"
                    type="range"
                    min={minTankRpm}
                    max={maxTankRpm}
                    step={5}
                    value={tankRpmValue}
                    style={rangeFill(tankRpmValue, minTankRpm, maxTankRpm)}
                    onChange={(e) => setSpec({ tankRpm: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>

            {/* ---- SCORING ---- */}
            <h3 className="ds-subh">Scoring</h3>
            {isDecode ? (
              <div className="ds-fields">
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
                <button
                  className={`ds-opt mini ${spec.canSort ? 'on' : ''}`}
                  style={{ flex: '1 1 150px' }}
                  onClick={() => setSpec({ canSort: !spec.canSort })}
                >
                  <span className="ot">Sorter {spec.canSort ? 'ON' : 'OFF'}</span>
                </button>
              </div>
            ) : (
              <>
                <div className="ds-opts card4">
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
                {/* The mount means two different things, so it is TWO different pickers.
                    TURRETLESS: which chassis EDGE the launcher fires over — four sides, and a
                    corner is not buildable because the launch line spans a side.
                    TURRETED: where the turret is BOLTED. It aims itself, so this is a position,
                    not a facing — and it is where the Particle is actually born. Nine positions
                    laid out as a 3x3 map of the chassis (front row on top), so the picker reads
                    as a top-down diagram rather than a list of words. */}
                {isTurreted(spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE) ? (
                  <div className="ds-opts three" style={{ marginTop: 8 }}>
                    {CHAIN_TURRET_POSITIONS.map((m) => (
                      <button
                        key={m}
                        className={`ds-opt mini ${shooterMountOf(spec) === m ? 'on' : ''}`}
                        onClick={() => setSpec({ shooterMount: m })}
                        title={`Turret bolted at the ${CHAIN_SHOOTER_MOUNT_LABELS[m]} of the chassis`}
                      >
                        <span className="ot">{CHAIN_SHOOTER_MOUNT_LABELS[m]}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="ds-opts four" style={{ marginTop: 8 }}>
                    {CHAIN_SHOOTER_MOUNTS.map((m) => (
                      <button
                        key={m}
                        className={`ds-opt mini ${shooterMountOf(spec) === m ? 'on' : ''}`}
                        onClick={() => setSpec({ shooterMount: m })}
                      >
                        <span className="ot">{CHAIN_SHOOTER_MOUNT_LABELS[m]}</span>
                        {CHAIN_SHOOTER_MOUNT_BLURBS[m] ? (
                          <span className="od">{CHAIN_SHOOTER_MOUNT_BLURBS[m]}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ---- INTAKE ---- */}
            <h3 className="ds-subh">Intake</h3>
            {isDecode ? (
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
            ) : (
              <>
                <div className="ds-opts fill">
                  <div className="ds-opt on" aria-disabled>
                    <span className="ot">{CHAIN_INTAKE_LABELS.sweeper}</span>
                  </div>
                </div>
                <div className="ds-opts four" style={{ marginTop: 8 }}>
                  {CHAIN_INTAKE_MOUNTS.map((m) => (
                    <button
                      key={m}
                      className={`ds-opt mini ${intakeMountOf(spec) === m ? 'on' : ''}`}
                      onClick={() => setSpec({ intakeMount: m })}
                    >
                      <span className="ot">{CHAIN_INTAKE_MOUNT_LABELS[m]}</span>
                      {CHAIN_INTAKE_MOUNT_BLURBS[m] ? (
                        <span className="od">{CHAIN_INTAKE_MOUNT_BLURBS[m]}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* ---- CATALYST (CR only) ---- */}
            {!isDecode && (
              <>
                <h3 className="ds-subh">Catalyst</h3>
                <div className="ds-opts">
                  {CHAIN_CATALYST_TYPES.map((t) => (
                    <button
                      key={t}
                      className={`ds-opt ${(spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === t ? 'on' : ''}`}
                      onClick={() => setSpec({ catalystType: t })}
                    >
                      <span className="ot">{CHAIN_CATALYST_LABELS[t]}</span>
                      <span className="od">{CHAIN_CATALYST_BLURBS[t]}</span>
                    </button>
                  ))}
                </div>
                {/* SWING is a property of the MECHANISM, not a place to put it. It used to be
                    the centre cell of this grid, which made "a swing" and "on the right"
                    mutually exclusive picks — so a fore-aft swing arm bolted to the right
                    rail, an ordinary build, could not be expressed at all. The DIRECTION
                    matters as much as the fact of it: which positions a pivot can use follows
                    from which way it turns, so the grid below re-gates on this. */}
                {/* ARM ONLY. A turret claw already aims through a full circle and a rail
                    already traverses, so a pivot adds nothing to either — it is the fixed
                    arm, the one mechanism that has to be pointed at its work, for which
                    swinging is a real build decision. `coerceSpec` drops a swing on anything
                    else, so this is a gate on an offer, not on a capability the sim keeps. */}
                {(spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'arm' && (
                  <div className="ds-opts three" style={{ marginTop: 8 }}>
                    {([null, 'fb', 'lr'] as const).map((axis) => (
                      <button
                        key={axis ?? 'fixed'}
                        className={`ds-opt mini ${catalystSwingOf(spec) === axis ? 'on' : ''}`}
                        onClick={() => {
                          // moving to a pivot from a mount it cannot use takes the nearest one
                          // that works on THIS axis, rather than refusing the click
                          const m = catalystMountOf(spec);
                          setSpec({
                            catalystSwing: axis ?? undefined,
                            catalystMount: axis ? swingHomeFor(m, axis) : m === 'center' ? 'front' : m,
                          });
                        }}
                        title={
                          axis === null
                            ? 'Bolted in one place, reaching from that one spot'
                            : axis === 'fb'
                              ? 'One arm on a pivot that swings FRONT to BACK — it works whichever end is nearer'
                              : 'One arm on a pivot that swings LEFT to RIGHT — it works whichever flank is nearer'
                        }
                      >
                        <span className="ot">{axis === null ? 'FIXED' : axis === 'fb' ? 'SWING ↕' : 'SWING ↔'}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* Same 3x3 chassis map as the turret picker: where the mechanism is BOLTED. */}
                <div className="ds-opts three" style={{ marginTop: 8 }}>
                  {CHAIN_CATALYST_MOUNTS.map((m) => {
                    // A cell is unavailable for three physical reasons, and the picker says
                    // WHICH — coerceSpec would quietly relocate the mount otherwise, and a
                    // button that moves your choice somewhere else without explaining is
                    // worse than one that refuses.
                    const railed = (spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'rail';
                    const swung = catalystSwingOf(spec);
                    const noTrack = railed && !isEdgePos(m);
                    // a pivot needs BOTH of its working ends reachable, which depends on the
                    // axis: a fore-aft arm wants a front and a back, a lateral one wants two
                    // flanks. And with no pivot at all, the middle reaches nothing.
                    const noPivot = !!swung && !isSwingMount(m, swung);
                    const noReach = !swung && m === 'center';
                    const taken = mountsClash(
                      { pos: m, spansEdge: railed, swing: swung },
                      { pos: shooterMountOf(spec), spansEdge: !isTurreted(spec.scoreMode) },
                    );
                    const off = noTrack || taken || noPivot || noReach;
                    return (
                      <button
                        key={m}
                        className={`ds-opt mini ${catalystMountOf(spec) === m ? 'on' : ''}${off ? ' off' : ''}`}
                        disabled={off}
                        onClick={() => setSpec({ catalystMount: m })}
                        title={
                          noTrack
                            ? 'A rail needs a whole chassis side to run along — corners and the centre have no span for a track'
                            : taken
                              ? 'The shooter is mounted here'
                              : noPivot
                                ? swung === 'lr'
                                  ? 'A left–right swing pivots between the flanks — bolt it to the centre line or an end'
                                  : 'A front–back swing pivots between the ends — bolt it to the centre line or a flank'
                                : noReach
                                  ? 'Nothing reaches from the middle of a chassis — turn on the swing arm to work from here'
                                  : swung
                                    ? `Pivot on the ${CHAIN_CATALYST_MOUNT_LABELS[m]}, swinging ${swung === 'fb' ? 'front to back' : 'left to right'}`
                                    : `Claw mounted at the ${CHAIN_CATALYST_MOUNT_LABELS[m]} of the chassis`
                        }
                      >
                        <span className="ot">{CHAIN_CATALYST_MOUNT_LABELS[m]}</span>
                      </button>
                    );
                  })}
                </div>
                {(spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'launcher' && (
                  <div className="ds-fields">
                    <label className="ds-field">
                      <span className="cap">
                        Catapult range <span className="val">{chainCatapultRange(spec)}"</span>
                      </span>
                      <input
                        className="ds-range"
                        type="range"
                        min={CHAIN_CATAPULT_RANGE_MIN}
                        max={CHAIN_CATAPULT_RANGE_MAX}
                        step={5}
                        value={chainCatapultRange(spec)}
                        style={rangeFill(chainCatapultRange(spec), CHAIN_CATAPULT_RANGE_MIN, CHAIN_CATAPULT_RANGE_MAX)}
                        onChange={(e) => setSpec({ catapultRange: Number(e.target.value) })}
                      />
                    </label>
                    {/* WHICH WAY IT THROWS. The catapult is bolted, not turreted — it fires
                        along the chassis plus this offset — so the direction is a build
                        decision, and picking it off a slider means doing trigonometry to
                        answer "out of the back". Eight compass points on the same 3x3 map as
                        every other mount picker; the slider under it stays for the angles
                        between them. */}
                    <div className="ds-opts three" style={{ gridColumn: '1 / -1' }}>
                      {CATAPULT_DIRS.map((d) => (
                        <button
                          key={d.label}
                          className={`ds-opt mini ${(spec.catapultYaw ?? 0) === d.yaw ? 'on' : ''}${d.yaw === null ? ' off' : ''}`}
                          disabled={d.yaw === null}
                          onClick={() => d.yaw !== null && setSpec({ catapultYaw: d.yaw })}
                          title={d.yaw === null ? 'A catapult throws outward, not into itself' : `Throws ${d.title} (${d.yaw}°)`}
                        >
                          <span className="ot">{d.label}</span>
                        </button>
                      ))}
                    </div>
                    <label className="ds-field">
                      <span className="cap">
                        Catapult yaw <span className="val">{spec.catapultYaw ?? 0}°</span>
                      </span>
                      <input
                        className="ds-range"
                        type="range"
                        min={-180}
                        max={180}
                        step={CHAIN_CATAPULT_YAW_STEP}
                        value={spec.catapultYaw ?? 0}
                        style={rangeFill(spec.catapultYaw ?? 0, -180, 180)}
                        onChange={(e) => setSpec({ catapultYaw: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                )}
              </>
            )}

            {/* ---- FRAME: clamped by every block above, so it comes last ---- */}
            <h3 className="ds-subh">Frame</h3>
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
              {/* BALL STORAGE sits with the FRAME, under the dimensions, because that is what
                  sets it: the cap is footprint x archetype x intake mount (chainStorageMax),
                  so it re-clamps as you drag Length/Width right above it. Full-width on its
                  own row deliberately — a fifth 140px column would orphan-wrap, and the
                  "12 / 24 particles" value needs the room. */}
              {!isDecode && (() => {
                const storeMax = chainStorageMax(spec);
                const store = Math.min(spec.ballStorage ?? CHAIN_STORAGE_DEFAULT, storeMax);
                return (
                  <label className="ds-field" style={{ flex: '1 1 100%' }}>
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
              <ChassisColorRow spec={spec} onPick={(chassisColor) => setSpec({ chassisColor })} />
            </div>
          </div>
        </section>

        {/* ---------- driver preferences (remembered per drivetrain) ---------- */}
        <section className="ds-sec">
          {/* No helper caption, per main's caption sweep. The one that used to sit here
              explained the retired per-drivetrain memory; assists now ride spec.assists. */}
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
            {/* AIM ASSIST IS NOT OFFERED — it is always on, in both games. The flag and
                the sim's manual-aim path both still exist (`coerceSettings` forces the
                stored value true), so putting the toggle back is this block returning. */}
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
