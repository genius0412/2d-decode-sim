import { useEffect, useMemo, useRef } from 'react';
import type { RobotSpec, RobotState, World } from '../types';
import * as C from '../config';
import { createWorld, DEFAULT_ASSISTS } from '../sim/spawn';
import { footprintExtents } from '../sim/field';
import { drawRobot } from '../render/drawRobot';

/** clear space around the robot, as a fraction of its longest side */
const PAD = 0.16;
/** the caption's type size in CSS px */
const DIM_FONT = 11;

/**
 * The builder's robot preview — THE REAL SPRITE, not a drawing of one.
 *
 * This used to be a hand-written SVG schematic of the spec: a second implementation
 * of the same robot, in a different technology, maintained by hand. It drifted, which
 * is the only thing two drawings of one object ever do — reported as "the hero robot
 * looks way too different from the actual robot in the field". So it now renders
 * `drawRobot`, the exact function the match uses, from a real `RobotState` built by
 * `createWorld`. Change the sprite and this changes with it, because it IS the sprite.
 *
 * ON THE DARK GROUND, deliberately. The old schematic used `--ds-panel` and themed with
 * the app, and its comment explained why it could not use the chassis colour: every
 * `CHASSIS_COLORS` value is tuned for the hardcoded-dark field, and painting one on a
 * light panel produced the fill-vs-text collision `shell.css` warns about. Drawing the
 * mat here instead of a themed panel answers that at the root — the sprite is in the
 * environment it was designed for, so it needs no translation, and the supporter
 * chassis colour becomes previewable for the first time.
 *
 * NO ALLIANCE. A robot in the builder is not red or blue, so the outline is the
 * app's own accent rather than a side you have not chosen yet — read from
 * `--ds-on-field-accent` so the stylesheet stays the one source of truth.
 *
 * ⚠️ THE ON-FIELD ACCENT, NOT `--ds-accent`. Those are different colours: the plain
 * accent INVERTS with the theme (#366758 light, #5fb597 dark) because it is meant to
 * read against a themed panel, and its light value on this hardcoded-dark mat is
 * almost invisible. `--ds-on-field-accent` is the same mint in both themes, tuned for
 * exactly this ground — see the THEMING note in CLAUDE.md for the three categories.
 */
export function RobotPreview({ spec, size = 200 }: { spec: RobotSpec; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // a real world, and therefore a real RobotState — turret, wheels, hopper and all.
  // Rebuilt only when the BUILD changes; the spec object identity churns on every
  // keystroke in the name field, which is not a reason to respawn a world.
  const key = specKey(spec);
  const world: World = useMemo(
    () =>
      createWorld('match', 1, [
        { id: 0, alliance: 'blue', spec, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const fx = footprintExtents(spec);
  // NOSE UP: the robot is drawn at heading +90°, so its forward axis (+x in the robot
  // frame) maps to world +y, which the camera's y-flip puts at the top of the canvas.
  const worldW = fx.half * 2;
  const worldH = fx.front + fx.rear;
  const pad = Math.max(worldW, worldH) * PAD;
  const boxW = worldW + pad * 2;
  const boxH = worldH + pad * 2;
  const height = Math.round(size * (boxH / boxW));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    // the field's own ground, so the sprite renders in the environment it is tuned for
    ctx.fillStyle = C.COLORS.mat;
    ctx.fillRect(0, 0, size, height);

    // camera: fit the footprint, +y up, world inches → css px
    const s = Math.min(size / boxW, height / boxH);
    ctx.translate(size / 2, height / 2);
    ctx.scale(s, -s);
    // the chassis origin is not the footprint's centre when an intake extends one end
    ctx.translate(0, -(fx.front - fx.rear) / 2);

    const tpl = world.robots[0];
    const robot: RobotState = {
      ...tpl,
      pos: { x: 0, y: 0 },
      heading: Math.PI / 2,
      // straight ahead: a turret slewed at some goal it cannot see reads as a fault
      turretHeading: Math.PI / 2,
      // EMPTY. `createWorld` hands robot 0 the match PRELOAD, and `drawRobot` rings
      // the turret in artifact green while the hopper has anything in it — so the
      // builder was previewing a robot mid-match, with a second green that had
      // nothing to do with the chassis. You are configuring a robot here, not a
      // loaded one; the ring draws its empty grey instead.
      hopper: [],
    };
    drawRobot(ctx, robot, false, [], undefined, undefined, onFieldAccent());
    ctx.restore();

    // the caption, in SCREEN space — inside the flipped camera it would be mirrored
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.font = `600 ${DIM_FONT}px ui-monospace, monospace`;
    ctx.fillStyle = C.COLORS.white;
    ctx.globalAlpha = 0.75;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${spec.width}" wide · ${spec.length}" long`, size / 2, height - 6);
    ctx.restore();
  }, [world, spec, size, height, boxW, boxH, fx.front, fx.rear]);

  return (
    <canvas
      ref={canvasRef}
      className="ds-robot-sprite"
      style={{ width: size, height }}
      role="img"
      aria-label={`${spec.width} by ${spec.length} inch robot, ${spec.intake} intake`}
    />
  );
}

/**
 * The app's accent as the canvas should draw it.
 *
 * Read from the stylesheet rather than copied into `config.ts`, so the preview
 * follows the palette instead of drifting from it the way the old SVG schematic did.
 * The literal is the fallback for a context with no computed style (a test renderer,
 * or a canvas built before the sheet lands) — it is the token's own value, not a
 * second opinion about what the accent should be.
 */
function onFieldAccent(): string {
  if (typeof getComputedStyle !== 'function') return '#5fb597';
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--ds-on-field-accent')
    .trim();
  return v || '#5fb597';
}

/** the BUILD, not the identity: renaming a robot must not respawn a world */
function specKey(s: RobotSpec): string {
  return [
    s.length, s.width, s.intake, s.drivetrain, s.driveRpm,
    s.massLb, s.flywheelInertia, s.canSort, s.chassisColor,
  ].join('|');
}
