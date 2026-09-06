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
import { chainEvalStart, chainMirrorStart, chainSnapStartPose } from '../games/chain/state';
import { samePose, savedStartCap } from './startPositions';
import { useAds } from '../ads/AdsProvider';
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
 * `chainEvalStart` gives the verdict live (green / red clearance box) and `chainSnapStartPose`
 * is the repair, the SAME snap `chainStartPose` runs at spawn, so what you see placed is
 * exactly where the robot starts.
 *
 * Two things differ from DECODE, both because of CR's rules rather than for their own sake:
 *
 * - **Heading COSTS ROOM.** The Lab Area is a 24" square, and a chassis turned off-axis
 *   sweeps a wider axis-aligned bound than a squared-up one — peaking at 45°, where a
 *   maximum 18x18 robot needs ~25.5" and therefore has no legal diagonal start at all.
 *   So heading is not free here (it was modelled as free, wrongly, until the outline was
 *   made to rotate), and the editor treats "turned too far to fit" as its own failure
 *   with its own repair: `snapTo` squares the robot up before it tries to move it,
 *   because no amount of sliding fixes an angle the corner cannot accept.
 * - **The categories are TOP / BOTTOM**, not DECODE's CLOSE / FAR — a CR robot picks which
 *   Lab CORNER it occupies, and in a 2v2 the alliance's two robots lock one each so they
 *   never stack. The shared `StartCat` slots carry it (close = TOP, far = BOTTOM), so the
 *   saved library, the per-category memory and the account sync are the same machinery
 *   DECODE uses — `savedStartPoses` is already archived per game by `switchGame`, which is
 *   what makes one library per game work without the two ever seeing each other's poses.
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
  /** the active CUSTOM pose (canonical frame), or null to use the `startIndex` anchor */
  value: StartPose | null | undefined;
  startIndex: number;
  /** which Lab corner the active start belongs to (TOP / BOTTOM) */
  category: StartCat;
  /** the player's saved-position library, per category (per GAME — see `switchGame`) */
  saved: { close: StartPose[]; far: StartPose[] };
  /** a 2v2 role: locks the robot to one Lab corner so alliance partners never stack */
  lockedCategory?: StartCat;
  /** set the custom pose (canonical frame) */
  onChange: (pose: StartPose) => void;
  /** pick a named anchor — the parent MUST set startIndex AND clear startPose in ONE
   * update (`{ startIndex, startPose: null }`); two separate calls lose one to a stale
   * -state overwrite. */
  onPickPreset: (i: number) => void;
  /** switch the active Lab corner (restores that corner's remembered pick) */
  onCategory: (c: StartCat) => void;
  /** save the current pose into this corner's library (canonical frame) */
  onSave: (pose: StartPose) => void;
  onDeleteSaved: (c: StartCat, i: number) => void;
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

  // A 2v2 ROLE locks the corner; solo, the tabs pick it. Anchors keep their ORIGINAL index
  // so a filtered list still selects the true one.
  const cat = lockedCategory ?? category;
  const anchors = CHAIN_START_POSES.map((p, index) => ({ p, index })).filter(
    ({ index }) => chainAnchorCat(index) === cat,
  );
  const savedList = saved[cat] ?? [];
  // extra saved slots are a supporter perk, read from the ONE place that decides it so the
  // cap can never differ between this editor and DECODE's
  const maxSaved = savedStartCap(useAds().supporter);

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
  const legality = chainEvalStart(spec, { x: canon.x, y: canon.y }, canon.headingDeg);

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

    /**
     * The CLEARANCE OUTLINE — the robot's footprint plus its margin, ROTATED with the
     * robot. It used to be an axis-aligned square sized by the longer chassis dimension,
     * which sat there unmoved while the robot under it turned, and read as a bug.
     *
     * It rotates now because the RULE is heading-aware now (`chainStartExtents`): the
     * test is the axis-aligned bound of exactly this rectangle, and for the Lab square
     * those two are equivalent — a rotated rect is inside an axis-aligned box iff its
     * AABB is. So drawing the rotated rect is not decoration over a different test; it
     * IS the tested shape.
     */
    const col = legality.legal ? '#37d67a' : '#ff4d4d';
    const hRad = robot.heading;
    const mx = spec.length / 2 + 0.5;
    const my = spec.width / 2 + 0.5;
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(hRad);
    ctx.beginPath();
    ctx.rect(-mx, -my, mx * 2, my * 2);
    ctx.fillStyle = legality.legal ? 'rgba(55,214,122,0.16)' : 'rgba(255,77,77,0.22)';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // heading handle
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

  /** commit an ACTUAL-frame pose back to the parent as canonical */
  const commit = (p: StartPose) => onChange(chainMirrorStart(p, alliance));

  /** edit the working pose: always show it, but only SAVE it when legal — an illegal pose
   * is previewed (red) and never persisted. */
  const edit = (p: StartPose) => {
    setDraft(p);
    const c = chainMirrorStart(p, alliance);
    if (chainEvalStart(spec, { x: c.x, y: c.y }, c.headingDeg).legal) commit(p);
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
    // the SAME repair the spawn runs, so what the button produces is exactly where the
    // robot would start. It turns before it moves: a heading no corner accepts has no
    // legal position, so snapping position alone would leave the robot red however far
    // it slid, and the button would look broken.
    const s = chainSnapStartPose(spec, chainMirrorStart(p, alliance));
    onChange(s); // already canonical
    setDraft(null);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    const cur = draft ?? base;
    const c = chainMirrorStart(cur, alliance);
    if (chainEvalStart(spec, { x: c.x, y: c.y }, c.headingDeg).legal) {
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
    : // a heading that cannot fit is checked FIRST: it is the one failure moving the
      // robot cannot repair, and blaming containment there would send the player
      // dragging around a corner that was never going to accept this angle
      !legality.headingFits
      ? 'Turned too far to fit the Lab Area — square it up'
      : !legality.inLab
        ? 'Must start completely inside a Lab Area corner'
        : 'Robot overlaps the Ring Stand assembly';

  /**
   * WHERE a legal pose starts, which is not the same question as whether it is legal.
   *
   * Both readings are legal and the difference is invisible on the canvas — the Ring
   * Stand's ascend range is an unmarked radius around the solid corner assembly, so a
   * robot parked just outside the assembly may or may not be within it, and nothing
   * on screen says which. It decides whether the robot begins the match already in
   * ascend range, so it is worth stating outright rather than leaving to be discovered.
   */
  const placement = legality.onStand ? 'On the Ring Stand' : 'On the Lab floor';

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
        {/* KEPT IN THE LAYOUT when illegal rather than unmounted. Legality flips
            while you are dragging, and this sits above the inputs, the tabs and the
            presets — so removing it moved all of them, mid-drag. */}
        <div
          className={`ds-startpos-where ${legality.onStand ? 'stand' : ''}${legality.legal ? '' : ' blank'}`}
          aria-hidden={!legality.legal}
        >
          {legality.onStand ? '⬢' : '▢'} {placement}
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

        {/* WHICH LAB CORNER. Locked by a 2v2 role (the alliance's two robots take one each
            so they never stack), otherwise a pair of tabs — the CR twin of DECODE's
            Close/Far, named for what the choice actually is here. */}
        {lockedCategory ? (
          <div className="ds-startpos-role">{chainRoleLabel(lockedCategory)} robot · Lab corner</div>
        ) : (
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
                title={`Start in the ${chainRoleLabel(c)} Lab corner`}
              >
                {chainRoleLabel(c)}
              </button>
            ))}
          </div>
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
          {/* the player's OWN saved poses for this corner. Same library machinery DECODE
              uses, and already stored per game (`switchGame` archives it), so a CR pose can
              never surface in DECODE's list at coordinates that mean nothing there. */}
          {savedList.map((sp, i) => {
            const active = !!value && samePose(canon, sp);
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
          {savedList.length < maxSaved && (
            <button
              type="button"
              className="ds-opt mini add"
              disabled={!legality.legal}
              title={legality.legal ? 'Save this position to your Lab-corner library' : 'Make the position legal first'}
              onClick={() => onSave(canon)}
            >
              <span className="ot">＋ Save</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
