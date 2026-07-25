import { useEffect, useMemo, useRef, useState } from 'react';
import type { Alliance, RobotSpec, RobotState, StartCat, StartPose, World } from '../types';
import { FIELD_HALF, MAX_SAVED_STARTS } from '../config';
import { createWorld, DEFAULT_ASSISTS } from '../sim/spawn';
import { drawField } from '../render/drawField';
import { drawRobot } from '../render/drawRobot';
import { datan2 } from '../math';
import {
  evalStartPose,
  footprintCorners,
  goalCenter,
  mirrorStartPose,
  presetPose,
  snapStartToLegal,
} from '../sim/field';
import { categoryPresets, samePose } from './startPositions';

/**
 * Drag-and-drop editor for a robot's match START POSITION, constrained to a
 * LEGAL FTC DECODE setup (rule G304: the robot must be over a white LAUNCH LINE,
 * touching the GOAL or the FIELD perimeter, and fully within its own half).
 *
 * The stage renders the REAL game field (`drawField`) and the REAL selected robot
 * (`drawRobot`) on a canvas, top-down in the alliance's ACTUAL frame (+x = audience
 * right, +y = away from the audience / up on screen). The robot can be dragged to
 * place it and rotated with the heading handle; numeric X / Y / heading inputs give
 * precise control. Legality is shown live (a green / red footprint ring), and
 * releasing a drag snaps the robot to the nearest legal pose so a placement always
 * "meets the rulebook". Poses are stored CANONICAL (goalSide=+1) — the editor
 * mirrors at the `onChange` boundary — so switching alliance keeps the same spot.
 */

const MARGIN = 4; // inches of padding around the field perimeter
const SPAN = (FIELD_HALF + MARGIN) * 2;

const specKey = (s: RobotSpec) => `${s.length}|${s.width}|${s.intake}|${s.drivetrain}|${s.canSort}`;

export function StartPositionEditor({
  spec,
  alliance,
  value,
  startIndex,
  category,
  saved,
  lockedCategory,
  onChange,
  onPickPreset,
  onCategory,
  onSave,
  onDeleteSaved,
  size = 300,
}: {
  spec: RobotSpec;
  alliance: Alliance;
  /** the active CUSTOM pose (canonical frame), or null to use the `startIndex` preset */
  value: StartPose | null | undefined;
  startIndex: number;
  /** the active category (which tab's presets/saves show) */
  category: StartCat;
  /** the player's saved-position library, per category */
  saved: { close: StartPose[]; far: StartPose[] };
  /** when set (a 2v2 role), the category is fixed and the tabs are hidden */
  lockedCategory?: StartCat;
  /** set (pose) or clear (null → fall back to the preset) the custom pose */
  onChange: (pose: StartPose | null) => void;
  /** pick a named preset quick-pick — the parent MUST set startIndex AND clear
   * startPose in ONE update (`{ startIndex, startPose: null }`); doing it as two
   * separate calls loses one to a stale-state overwrite. */
  onPickPreset: (i: number) => void;
  onCategory: (cat: StartCat) => void;
  onSave: (pose: StartPose) => void;
  onDeleteSaved: (cat: StartCat, i: number) => void;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<'move' | 'rotate' | null>(null);
  const [snapOn, setSnapOn] = useState(false); // OFF by default — free placement
  // an in-progress (possibly ILLEGAL) working pose, actual frame. Rendered live,
  // but only COMMITTED to the parent when legal — an illegal pose never saves.
  const [draft, setDraft] = useState<StartPose | null>(null);

  const cat: StartCat = lockedCategory ?? category; // a 2v2 role locks the category
  const presets = categoryPresets(cat);
  const savedList = saved[cat] ?? [];

  // the SAVED pose (actual frame), always legal. A custom `value` is mirrored to
  // the actual frame; a preset is resolved DYNAMICALLY for this chassis so it's
  // legal at any size.
  const base: StartPose = value
    ? mirrorStartPose({ x: value.x, y: value.y, headingDeg: value.headingDeg }, alliance)
    : presetPose(startIndex, alliance, spec);
  const pose = draft ?? base; // display the working draft if any, else the saved pose

  // a stale draft from another alliance/category must not linger after a switch
  useEffect(() => {
    setDraft(null);
  }, [alliance, cat, startIndex, value]);

  const legality = evalStartPose(spec, pose, alliance);

  // a world + robot TEMPLATE for the real renderers, rebuilt only when the field/
  // robot identity changes (NOT on every drag). createWorld snaps its spawn legal,
  // so we override pos/heading below to show the RAW dragged pose.
  const world: World = useMemo(
    () => createWorld('match', 1, [{ id: 0, alliance, spec, assists: DEFAULT_ASSISTS, startIndex: 0 }]),
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
    // camera: fit the field, +y up (flip), world units → css px
    const s = size / SPAN;
    ctx.translate(size / 2, size / 2);
    ctx.scale(s, -s);

    drawField(ctx, world);

    // the real robot at the RAW pose (turret aimed at its own goal for realism)
    const tpl = world.robots[0];
    const g = goalCenter(alliance);
    const robot: RobotState = {
      ...tpl,
      pos: { x: pose.x, y: pose.y },
      heading: (pose.headingDeg * Math.PI) / 180,
      turretHeading: datan2(g.y - pose.y, g.x - pose.x),
    };
    drawRobot(ctx, robot, false, []);

    // legality ring over the footprint + a heading handle
    const corners = footprintCorners(spec, { x: pose.x, y: pose.y }, robot.heading);
    const col = legality.legal ? '#37d67a' : '#ff4d4d';
    ctx.beginPath();
    corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.fillStyle = legality.legal ? 'rgba(55,214,122,0.16)' : 'rgba(255,77,77,0.22)';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.2;
    ctx.stroke();

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
  }, [world, pose.x, pose.y, pose.headingDeg, spec, alliance, legality.legal, size]);

  // commit an ACTUAL-frame pose back to the parent as canonical (SAVE)
  const commit = (p: StartPose) => {
    onChange(mirrorStartPose(p, alliance)); // mirror is self-inverse: actual → canonical
  };

  // edit the working pose: always show it (draft), but only SAVE it when legal —
  // an illegal pose is previewed (red) and never persisted.
  const edit = (p: StartPose) => {
    setDraft(p);
    if (evalStartPose(spec, p, alliance).legal) commit(p);
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
    const onHandle = Math.hypot(w.x - h.x, w.y - h.y) < 6;
    drag.current = onHandle ? 'rotate' : 'move';
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const w = pointerWorld(e);
    if (!w) return;
    if (drag.current === 'move') {
      edit({ x: w.x, y: w.y, headingDeg: pose.headingDeg });
    } else {
      let deg = (Math.atan2(w.y - pose.y, w.x - pose.x) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      edit({ x: pose.x, y: pose.y, headingDeg: Math.round(deg) });
    }
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    const cur = draft ?? base;
    if (evalStartPose(spec, cur, alliance).legal) {
      setDraft(null); // legal end: the saved pose already matches
    } else if (snapOn) {
      commit(snapStartToLegal(spec, cur, alliance)); // opt-in: snap to nearest legal
      setDraft(null);
    }
    // else: snap OFF + illegal → leave the robot exactly where it was dropped
    // (previewed red, "won't save") — no snap, no jump. The last LEGAL pose stays saved.
  };

  const setField = (k: 'x' | 'y' | 'headingDeg', v: number) => {
    if (!Number.isFinite(v)) return;
    edit({ ...pose, [k]: v });
  };
  const snapNow = () => {
    commit(snapStartToLegal(spec, pose, alliance));
    setDraft(null);
  };

  const reason = legality.legal
    ? 'Legal setup ✓'
    : !legality.contained
      ? 'Robot is off the field'
      : !legality.ownHalf
        ? 'Must be fully within your own half'
        : !legality.clear
          ? 'Robot is inside a structure'
          : !legality.overLaunchLine
            ? 'Must sit over a white launch line'
            : 'Must touch your goal or a wall';

  return (
    <div className="ds-startpos">
      <div className="ds-startpos-stage">
        <canvas
          ref={canvasRef}
          className="ds-startpos-canvas"
          style={{ width: size, height: size, cursor: drag.current === 'move' ? 'grabbing' : 'grab' }}
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
          {legality.legal ? reason : `${reason} — won't save`}
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
            <button type="button" className="ds-btn ghost small" onClick={snapNow}>
              Snap now
            </button>
          )}
        </div>

        {/* CLOSE / FAR category tabs (hidden when a 2v2 role locks the category) */}
        {!lockedCategory && (
          <div className="ds-startpos-tabs">
            {(['close', 'far'] as StartCat[]).map((c) => (
              <button
                key={c}
                type="button"
                className={`ds-startpos-tab ${cat === c ? 'on' : ''}`}
                onClick={() => {
                  setDraft(null);
                  onCategory(c);
                }}
              >
                {c === 'close' ? 'Close' : 'Far'}
              </button>
            ))}
          </div>
        )}
        {lockedCategory && (
          <div className="ds-startpos-role">{lockedCategory === 'close' ? 'CLOSE' : 'FAR'} robot · start positions</div>
        )}

        <div className="ds-startpos-presets">
          {presets.map((p) => {
            const active = !value && startIndex === p.index;
            return (
              <button
                key={p.label}
                type="button"
                className={`ds-opt mini ${active ? 'on' : ''}`}
                onClick={() => {
                  setDraft(null);
                  onPickPreset(p.index); // parent sets startIndex + clears startPose + remembers
                }}
              >
                <span className="ot">{p.label}</span>
              </button>
            );
          })}
          {savedList.map((sp, i) => {
            const active = !!value && samePose(value, sp);
            return (
              <button
                key={`saved-${i}`}
                type="button"
                className={`ds-opt mini saved ${active ? 'on' : ''}`}
                onClick={() => {
                  setDraft(null);
                  onChange({ x: sp.x, y: sp.y, headingDeg: sp.headingDeg });
                }}
                title="Your saved position"
              >
                <span className="ot">★ {i + 1}</span>
                <span
                  className="ds-startpos-del"
                  role="button"
                  aria-label="Delete saved position"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSaved(cat, i);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
          {savedList.length < MAX_SAVED_STARTS && (
            <button
              type="button"
              className="ds-opt mini add"
              disabled={!legality.legal}
              title={legality.legal ? 'Save this position to your Close/Far library' : 'Make the position legal first'}
              onClick={() => onSave(mirrorStartPose(pose, alliance))}
            >
              <span className="ot">＋ Save</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
