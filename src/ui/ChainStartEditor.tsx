import { useEffect, useMemo, useRef, useState } from 'react';
import type { Alliance, RobotSpec, RobotState, StartCat, StartPose, World } from '../types';
import { DEFAULT_ASSISTS } from '../sim/spawn';
import { CHAIN_MODULE } from '../games/chain';
import {
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_START_POSES,
  chainAnchorCat,
  chainRoleLabel,
} from '../games/chain/config';
import { chainEvalStart, chainMirrorStart, chainSnapStart } from '../games/chain/state';
import { drawChainField } from '../games/chain/drawField';
import { drawChainRobot } from '../games/chain/drawRobot';

/**
 * Drag-and-drop editor for a Chain Reaction START POSITION — the CR twin of DECODE's
 * `StartPositionEditor`, built on the same stage/controls so the two games feel like one
 * product (and so they share every `ds-startpos-*` style; no new CSS, nothing new for the
 * contrast/shift audits to police).
 *
 * The rule it enforces is G04: a robot must begin the match COMPLETELY within its Lab Area,
 * and — because the Ring-Stand corner assembly is a solid collider — clear of that assembly.
 * `chainEvalStart` gives the verdict live (green / red clearance box) and `chainSnapStart`
 * is the repair, the SAME snap `chainStartPose` runs at spawn, so what you see placed is
 * exactly where the robot starts.
 *
 * Two things differ from DECODE, both because of CR's rules rather than for their own sake:
 *
 * - **Heading is always free.** G04 is a containment rule and the snap uses a conservative,
 *   rotation-agnostic extent (the chassis' larger dimension), so no heading can turn a legal
 *   spot illegal. The ring is therefore drawn as that axis-aligned CLEARANCE box — the thing
 *   actually being tested — rather than DECODE's rotated footprint.
 * - **No saved-position library.** DECODE's `savedStartPoses` is a single canonical list
 *   shared across games; CR poses live at completely different coordinates, so saving one
 *   would plant an unreachable entry in DECODE's Close/Far library. The four anchors already
 *   cover both Lab corners x floor/stand, and free placement inside a 24" square is a nudge,
 *   not a layout worth naming.
 *
 * Poses are stored CANONICAL (blue, +x side) and mirrored at the `onChange` boundary, so a
 * placement survives an alliance switch.
 */

const MARGIN = 4; // inches of padding around the field perimeter
const SPAN = (Math.max(CHAIN_HALF_X, CHAIN_HALF_Y) + MARGIN) * 2;

const specKey = (s: RobotSpec) =>
  `${s.length}|${s.width}|${s.intake}|${s.drivetrain}|${s.intakeMount}|${s.scoreMode}|${s.catalystType}|${s.catalystMount}`;

export function ChainStartEditor({
  spec,
  alliance,
  value,
  startIndex,
  lockedCategory,
  onChange,
  onPickPreset,
  size = 300,
}: {
  spec: RobotSpec;
  alliance: Alliance;
  /** the active CUSTOM pose (canonical frame), or null to use the `startIndex` anchor */
  value: StartPose | null | undefined;
  startIndex: number;
  /** a 2v2 role: locks the robot to one Lab corner so alliance partners never stack */
  lockedCategory?: StartCat;
  /** set the custom pose (canonical frame) */
  onChange: (pose: StartPose) => void;
  /** pick a named anchor — the parent MUST set startIndex AND clear startPose in ONE
   * update (`{ startIndex, startPose: null }`); two separate calls lose one to a stale
   * -state overwrite. */
  onPickPreset: (i: number) => void;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<'move' | 'rotate' | null>(null);
  // Snap defaults ON here, unlike DECODE. G04 leaves a genuinely NARROW legal band — the Lab
  // square is 24" and the solid corner assembly eats its outer corner, so a near-max chassis
  // has only an inch or so of play. Free-drag with snap off would paint almost every drop red
  // and read as broken; snapping lands the robot on the nearest legal spot and the strip
  // becomes discoverable. It is still a toggle for anyone who wants the raw placement.
  const [snapOn, setSnapOn] = useState(true);
  // an in-progress (possibly ILLEGAL) working pose, actual frame. Rendered live, but only
  // COMMITTED to the parent when legal — an illegal pose never saves.
  const [draft, setDraft] = useState<StartPose | null>(null);

  // keep each anchor's ORIGINAL index so a role-filtered list still picks the true one
  const anchors = CHAIN_START_POSES.map((p, index) => ({ p, index })).filter(
    ({ index }) => !lockedCategory || chainAnchorCat(index) === lockedCategory,
  );

  // the SAVED pose in the ACTUAL frame: a custom value mirrored out of canonical, else the
  // selected anchor (which is authored canonical too).
  const anchor = CHAIN_START_POSES[startIndex] ?? CHAIN_START_POSES[0];
  const base: StartPose = chainMirrorStart(
    value
      ? { x: value.x, y: value.y, headingDeg: value.headingDeg }
      : { x: anchor.pos.x, y: anchor.pos.y, headingDeg: (anchor.heading * 180) / Math.PI },
    alliance,
  );
  const pose = draft ?? base; // show the working draft if any, else the saved pose

  // a stale draft from another alliance/anchor must not linger after a switch
  useEffect(() => {
    setDraft(null);
  }, [alliance, startIndex, value]);

  // legality is judged in the CANONICAL frame (mirror is self-inverse)
  const canon = chainMirrorStart(pose, alliance);
  const legality = chainEvalStart(spec, { x: canon.x, y: canon.y });

  // a world + robot TEMPLATE for the real renderers, rebuilt only when the field/robot
  // identity changes (NOT on every drag). The spawn snaps its own pose legal, so pos/heading
  // are overridden below to show the RAW dragged pose.
  const world: World = useMemo(
    () =>
      CHAIN_MODULE.createWorld('match', 1, [
        { id: 0, alliance, spec, assists: DEFAULT_ASSISTS, startIndex: 0 },
      ]),
    [alliance, specKey(spec)],
  );

  // draw the field + robot at the current pose whenever anything changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);
    // camera: fit the field, +y up (flip), world units -> css px
    const s = size / SPAN;
    ctx.translate(size / 2, size / 2);
    ctx.scale(s, -s);

    drawChainField(ctx, world);

    const tpl = world.robots[0];
    const robot: RobotState = {
      ...tpl,
      pos: { x: pose.x, y: pose.y },
      heading: (pose.headingDeg * Math.PI) / 180,
      turretHeading: (pose.headingDeg * Math.PI) / 180,
    };
    drawChainRobot(ctx, robot, false, []);

    // the CLEARANCE BOX the G04 test actually uses (axis-aligned, largest dimension), so a
    // red ring always explains itself: this square must fit in the Lab and miss the assembly
    const e = legality.extent;
    ctx.beginPath();
    ctx.rect(pose.x - e, pose.y - e, e * 2, e * 2);
    ctx.fillStyle = legality.legal ? 'rgba(55,214,122,0.16)' : 'rgba(255,77,77,0.22)';
    ctx.fill();
    const col = legality.legal ? '#37d67a' : '#ff4d4d';
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // heading handle
    const hRad = robot.heading;
    const front = spec.length / 2 + 8;
    const hx = pose.x + Math.cos(hRad) * front;
    const hy = pose.y + Math.sin(hRad) * front;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pose.x, pose.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#0d1720';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.restore();
  }, [world, pose.x, pose.y, pose.headingDeg, spec, alliance, legality.legal, legality.extent, size]);

  /** commit an ACTUAL-frame pose back to the parent as canonical */
  const commit = (p: StartPose) => onChange(chainMirrorStart(p, alliance));

  /** edit the working pose: always show it, but only SAVE it when legal — an illegal pose
   * is previewed (red) and never persisted. */
  const edit = (p: StartPose) => {
    setDraft(p);
    const c = chainMirrorStart(p, alliance);
    if (chainEvalStart(spec, { x: c.x, y: c.y }).legal) commit(p);
  };

  const pointerWorld = (e: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const s = size / SPAN;
    const px = ((e.clientX - rect.left) / rect.width) * size;
    const py = ((e.clientY - rect.top) / rect.height) * size;
    return { x: (px - size / 2) / s, y: -(py - size / 2) / s };
  };

  const handleWorld = () => {
    const hRad = (pose.headingDeg * Math.PI) / 180;
    const front = spec.length / 2 + 8;
    return { x: pose.x + Math.cos(hRad) * front, y: pose.y + Math.sin(hRad) * front };
  };

  const onDown = (e: React.PointerEvent) => {
    const w = pointerWorld(e);
    if (!w) return;
    const h = handleWorld();
    drag.current = Math.hypot(w.x - h.x, w.y - h.y) < 6 ? 'rotate' : 'move';
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const w = pointerWorld(e);
    if (!w) return;
    if (drag.current === 'move') {
      const target = { x: w.x, y: w.y, headingDeg: pose.headingDeg };
      // with snap on, snap LIVE rather than on release: the legal band is narrow enough
      // that a free-dragging robot would sit red for the whole gesture and jump at the end.
      // Snapping every move makes it glide along the band, following the cursor.
      if (snapOn) snapTo(target);
      else edit(target);
    } else {
      let deg = (Math.atan2(w.y - pose.y, w.x - pose.x) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      edit({ x: pose.x, y: pose.y, headingDeg: Math.round(deg) });
    }
  };
  const snapTo = (p: StartPose) => {
    const c = chainMirrorStart(p, alliance);
    const s = chainSnapStart(spec, { x: c.x, y: c.y });
    onChange({ x: s.x, y: s.y, headingDeg: c.headingDeg }); // already canonical
    setDraft(null);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    const cur = draft ?? base;
    const c = chainMirrorStart(cur, alliance);
    if (chainEvalStart(spec, { x: c.x, y: c.y }).legal) {
      setDraft(null); // legal end: the saved pose already matches
    } else if (snapOn) {
      snapTo(cur); // opt-in: snap to the nearest legal spot
    }
    // else: snap OFF + illegal -> leave it exactly where it was dropped (previewed red,
    // "won't save") — no snap, no jump. The last LEGAL pose stays saved.
  };

  const setField = (k: 'x' | 'y' | 'headingDeg', v: number) => {
    if (!Number.isFinite(v)) return;
    edit({ ...pose, [k]: v });
  };

  const reason = legality.legal
    ? 'Legal setup ✓'
    : !legality.inLab
      ? 'Must start completely inside a Lab Area corner'
      : 'Robot overlaps the Ring Stand assembly';

  return (
    <div className="ds-startpos">
      <div className="ds-startpos-stage">
        <canvas
          ref={canvasRef}
          className="ds-startpos-canvas"
          /* width only — the CSS keeps it square via `aspect-ratio` so it can shrink on a
             narrow phone without squashing (see `.ds-startpos-canvas`) */
          style={{ width: size, cursor: drag.current === 'move' ? 'grabbing' : 'grab' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          role="group"
          aria-label="Start position field editor"
        />
      </div>

      <div className="ds-startpos-side">
        <div className={`ds-startpos-status ${legality.legal ? 'ok' : 'bad'}`}>
          {legality.legal ? reason : `${reason} - won't save`}
        </div>

        <div className="ds-startpos-inputs">
          <label>
            <span>X <small>(right +)</small></span>
            <input type="number" value={Math.round(pose.x * 10) / 10} step={0.5} onChange={(e) => setField('x', parseFloat(e.target.value))} />
          </label>
          <label>
            <span>Y <small>(far +)</small></span>
            <input type="number" value={Math.round(pose.y * 10) / 10} step={0.5} onChange={(e) => setField('y', parseFloat(e.target.value))} />
          </label>
          <label>
            <span>Heading°</span>
            <input type="number" value={Math.round(pose.headingDeg)} step={5} onChange={(e) => setField('headingDeg', ((parseFloat(e.target.value) % 360) + 360) % 360)} />
          </label>
        </div>

        <div className="ds-startpos-tools">
          <label className="ds-startpos-toggle" title="When on, releasing a drag on an illegal spot snaps the robot to the nearest legal pose. Off = free placement (illegal poses aren't saved).">
            <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} />
            <span>Snap to legal</span>
          </label>
          {!legality.legal && (
            <button type="button" className="ds-btn ghost small" onClick={() => snapTo(pose)}>
              Snap now
            </button>
          )}
        </div>

        {lockedCategory && (
          <div className="ds-startpos-role">{chainRoleLabel(lockedCategory)} robot · Lab corner</div>
        )}

        <div className="ds-startpos-presets">
          {anchors.map(({ p, index }) => (
            <button
              key={p.name}
              type="button"
              className={`ds-opt mini ${!value && startIndex === index ? 'on' : ''}`}
              onClick={() => {
                setDraft(null);
                onPickPreset(index); // parent sets startIndex AND clears startPose
              }}
            >
              <span className="ot">{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
