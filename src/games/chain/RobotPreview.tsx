import type { RobotSpec } from '../../types';
import { WHEEL_INSET } from '../../config';
import {
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_LAUNCH_LINE_FRAC,
  CHAIN_TWIN_BARREL_OFFSET,
  CHAIN_LAUNCH_PLATE_GAP,
  CHAIN_LAUNCH_PLATE_OVERHANG,
  CHAIN_PARTICLE_R,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_ARM_DRAW,
  CHAIN_CORNER_BODY_INSET,
} from './config';
import { catalystRailHalf, chainIntakeMouths } from './state';
import { EDGE_ANGLE, MOUNT_ANGLE, catalystDrawPos, catalystMountOf, catalystSwingOf, edgeGeom, intakeMouthFrame, isEdgePos, mountOrigin, shooterEdgeOf, turretLocal, turretRadius } from './mounts';
import { footprintExtents } from '../../sim/field';

/** dimension-label type size, in the viewBox's inch units */
const DIM_FONT = 1.7;

/**
 * Top-down schematic of a robot drawn straight from its `RobotSpec` — the live
 * preview in the My Robot builder. Front faces UP (screen −y). Everything is in
 * inches inside the viewBox so the drawing scales with the real chassis/intake
 * dimensions, and colors reference the ds- design tokens so it themes with the
 * app. Purely presentational; reads nothing but the spec + a few geometry
 * constants (matching the sim's own robotExtents / turret placement rules).
 */
export function ChainRobotPreview({ spec, size = 200 }: { spec: RobotSpec; size?: number }) {
  const w = spec.width;
  const len = spec.length;

  const frontY = -len / 2; // chassis front edge (top)

  // Chain Reaction geometry — the SAME intake mouths the sim captures with, one per mounted
  // edge, in ROBOT coords (+x forward). The collision footprint moves with the mount, so the
  // viewBox extents come from `footprintExtents` (the sim's own hitbox) rather than the front.
  const cMouths = chainIntakeMouths(spec);
  const cExt = footprintExtents(spec);
  const cHalf = cExt.half; // ±y half-span (grown by a flank mount)
  const tipY = -cExt.front; // front-most in SCREEN y (robot +x → screen −y), for the viewBox
  const cRearY = cExt.rear; // rear-most in SCREEN y
  const cMode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;

  // viewBox spans the widest of chassis/intake plus a margin, kept square-ish.
  // The dimension label is centered and can be WIDER than a narrow chassis, so it
  // has to be measured in too — an <svg> clips to its viewport, and a 10"-wide
  // robot would otherwise lop the ends off "16.5" wide · 14.5" long".
  // A FRONTBACK swing is one arm drawn where it stows (the front) — see drawCatalystMech.
  const catPos = catalystDrawPos(catalystMountOf(spec), catalystSwingOf(spec));
  const catOrigin = mountOrigin(spec, catPos);
  const catDist = 0; // shapes are drawn from the frame outward once translated to the mount
  const catType = spec.catalystType ?? CHAIN_DEFAULT_CATALYST;
  // how far the CATALYST mechanism protrudes past its mounted edge (the arm is the longest);
  // folded into the viewBox below so a claw tip is never clipped off the drawing
  const catOut = catType === 'arm' ? CHAIN_ARM_DRAW + 1.5 : catType === 'launcher' ? 2.0 : 3.0;
  // half the RAIL carriage's travel — 0 for every non-rail catalyst, which makes the track
  // markup below a no-op for them without a second branch
  const catRailHalf = catalystRailHalf(spec);
  // How far past the chassis the mechanism sticks out, per axis, so the viewBox never clips a
  // claw tip. A CORNER mount protrudes on BOTH axes, which is why this tests the position's
  // components rather than switching on a single edge.
  const onFront = catPos.startsWith('front');
  const onBack = catPos.startsWith('back');
  const onSide = catPos.endsWith('left') || catPos.endsWith('right');
  const catTop = onFront ? -(spec.length / 2 + catOut) : 0;
  const catBottom = onBack ? spec.length / 2 + catOut : 0;
  const catSide = onSide ? spec.width / 2 + catOut : 0;
  const dimLabel = `${w}" wide · ${len}" long`;
  const labelHalf = (dimLabel.length * DIM_FONT * 0.56) / 2; // ~0.56em avg advance
  const halfSpan = Math.max(w / 2, cHalf, labelHalf, catSide) + 2.5;
  const top = Math.min(tipY, catTop) - 2;
  // The label clears everything that hangs off the BACK — a rear sweeper or a rear-mounted
  // claw. It used to sit at the chassis half-length, so a rear/frontback intake printed the
  // dimensions straight over its own rollers.
  const labelY = Math.max(cRearY, catBottom) + 2.6;
  const bottom = labelY + DIM_FONT + 0.9;
  const vbW = halfSpan * 2;
  const vbH = bottom - top;

  // bumper thickness — the SAME rule the in-game body uses (drawChassisBody), kept just
  // under the wheel inset so the wheels read as inside the frame
  const bumpW = Math.min(WHEEL_INSET - 0.5, Math.max(0.95, Math.min(w, len) * 0.085));
  const wheelInset = WHEEL_INSET;
  const wx = w / 2 - wheelInset;
  const wy = len / 2 - wheelInset;

  const isTank = spec.drivetrain === 'tank';
  const wheelW = isTank ? 1.9 : 1.5;
  const wheelH = isTank ? 4.2 : 3.2;

  const stroke = 'var(--ds-ink-dim)';
  const accent = 'var(--ds-accent)';

  const ROBOT_FRAME = 'matrix(0,-1,-1,0,0,0)';
  const deg = (rad: number): number => (rad * 180) / Math.PI;

  /**
   * INTAKE — the same sweeper the match renderer draws (`drawChainIntake`), in SVG: two side
   * plates bolted at the frame line, a roller across the tip, and a transfer roller at the
   * frame when the mouth is deep enough. Authored through `intakeMouthFrame`, so the preview
   * and the sprite are the same mechanism drawn twice rather than two drawings that have to
   * be kept in sync by hand.
   */
  const roller = (cx: number, spanHalf: number, dia: number, key: string) => {
    const flaps = Math.max(3, Math.round((spanHalf * 2) / 2.3));
    return (
      <g key={key}>
        <rect
          x={cx - dia / 2}
          y={-spanHalf}
          width={dia}
          height={spanHalf * 2}
          rx={dia * 0.42}
          fill="var(--ds-bg)"
          stroke={stroke}
          strokeWidth={0.22}
        />
        {Array.from({ length: flaps }, (_, i) => {
          const y = -spanHalf + 0.45 + ((i + 0.5) * (spanHalf * 2 - 0.9)) / flaps;
          return (
            <line
              key={i}
              x1={cx - dia * 0.3}
              y1={y - 0.3}
              x2={cx + dia * 0.3}
              y2={y + 0.3}
              stroke={stroke}
              strokeWidth={0.18}
              opacity={0.9}
            />
          );
        })}
      </g>
    );
  };
  const cIntakeEl = cMouths.length ? (
    <g transform={ROBOT_FRAME}>
      {cMouths.map((m) => {
        const f = intakeMouthFrame(m, len / 2, w / 2);
        const outer = f.depth - 0.95;
        const inner = f.rail - 0.2;
        const deep = f.depth - f.rail > 2.2;
        return (
          <g key={m.edge} transform={`translate(${f.ox},${f.oy}) rotate(${deg(f.rot)})`}>
            {/* the open throat, neutral: the builder has no run/idle state to colour */}
            <rect x={f.rail} y={-f.half} width={f.depth - f.rail} height={f.half * 2} fill={stroke} opacity={0.14} />
            {[1, -1].map((sg) => (
              <rect
                key={sg}
                x={f.rail - 0.6}
                y={sg > 0 ? f.half - 0.55 : -f.half}
                width={f.depth - f.rail + 0.6}
                height={0.55}
                rx={0.2}
                fill={stroke}
                opacity={0.75}
              />
            ))}
            {deep ? roller(inner, f.half - 1.35, 0.8, 'in') : null}
            {roller(outer, f.half - 0.75, 1.5, 'out')}
          </g>
        );
      })}
    </g>
  ) : null;

  // CATALYST mechanism, on ITS mounted edge — authored in the robot frame like the intake
  // and launcher, so the schematic shows where the claw actually reaches from.
  const cCatalystEl = (
    <g
      transform={`${ROBOT_FRAME} translate(${catOrigin.x},${catOrigin.y}) rotate(${deg(MOUNT_ANGLE[catPos])}) translate(${isEdgePos(catPos) ? 0 : -CHAIN_CORNER_BODY_INSET},0)`}
      opacity={0.9}
    >
      {catType === 'arm' ? (
        <>
          {/* pivot block, tapered boom, and two curved claw jaws — a mechanism, not an arrow */}
          <rect x={catDist - 2} y={-1.5} width={1.9} height={3} rx={0.4} fill="var(--ds-bg)" stroke={stroke} strokeWidth={0.35} />
          <polygon
            points={`${catDist - 1.1},-0.85 ${catDist + CHAIN_ARM_DRAW - 0.4},-0.55 ${catDist + CHAIN_ARM_DRAW - 0.4},0.55 ${catDist - 1.1},0.85`}
            fill="var(--ds-bg)"
            stroke={stroke}
            strokeWidth={0.35}
          />
          {[1, -1].map((sg) => (
            <path
              key={sg}
              d={`M ${catDist + CHAIN_ARM_DRAW - 0.5} ${sg * 0.5} Q ${catDist + CHAIN_ARM_DRAW + 0.7} ${sg * 1.5} ${catDist + CHAIN_ARM_DRAW + 1.5} ${sg * 0.85}`}
              fill="none"
              stroke={stroke}
              strokeWidth={0.45}
            />
          ))}
        </>
      ) : catType === 'launcher' ? (
        <>
          <polygon
            points={`${catDist - 0.4},-2.2 ${catDist + 1.9},-1.2 ${catDist + 1.9},1.2 ${catDist - 0.4},2.2`}
            fill="var(--ds-bg)"
            stroke={stroke}
            strokeWidth={0.4}
          />
          <line x1={catDist - 0.6} y1={0} x2={catDist - 4.4} y2={-1.8} stroke={stroke} strokeWidth={0.5} />
        </>
      ) : (
        <>
          {/* RAIL only: the track the carriage runs along, spanning the mounted side. The
              preview shows the robot STOWED, so the carriage is drawn centred — where it
              actually sits at the start of a match. A plain turret claw has no track, which
              is the one visible difference between the two builds. */}
          {catType === 'rail' && catRailHalf > 0 && (
            <>
              <line
                x1={catDist - 2.3}
                y1={-catRailHalf}
                x2={catDist - 2.3}
                y2={catRailHalf}
                stroke={stroke}
                strokeWidth={0.35}
              />
              {[1, -1].map((sgn) => (
                <line
                  key={sgn}
                  x1={catDist - 3.0}
                  y1={sgn * catRailHalf}
                  x2={catDist - 1.6}
                  y2={sgn * catRailHalf}
                  stroke={stroke}
                  strokeWidth={0.55}
                />
              ))}
            </>
          )}
          <circle cx={catDist - 0.8} cy={0} r={2.1} fill="var(--ds-bg)" stroke={stroke} strokeWidth={0.4} />
          <line x1={catDist - 0.8} y1={0} x2={catDist + 2.8} y2={0} stroke={accent} strokeWidth={0.5} />
        </>
      )}
    </g>
  );

  // Chain Reaction archetype launcher: drum = slotted bar along the mounted edge; dumper =
  // catapult bucket; turret = ring + barrel (top-mounted, so it ignores the mount).
  // Drum/dumper are authored along robot +x and rotated onto their mounted edge, so a
  // left/right mount spans the chassis LENGTH — matching how `launchAt` spreads the shot.
  const sEdge = shooterEdgeOf(spec); // drum/dumper fire over a SIDE, never a corner
  const sGeom = edgeGeom(spec, sEdge);
  // where a TURRET is bolted (it aims itself, so the mount is a position, not a facing)
  const tOrigin = turretLocal(spec); // the SAME point the sim launches from
  const cTurretR = turretRadius(spec); // ...and the same ring size
  const teeth = Math.max(14, Math.round(cTurretR * 6)); // slew-ring teeth, as in the sprite
  // THE DRUM is ONE CYLINDER across (almost) the whole mounted edge on a single shaft — not
  // a row of separate wheels, which is a different machine. Bearing blocks at both ends, and
  // traction bands wrapped along its length.
  const drumHalf = sGeom.span * 0.9;
  const drumDia = 3.3;
  const drumX = sGeom.dist - drumDia / 2 - 0.55; // its axis, just inside the frame line
  const drumRings = Math.max(4, Math.round((drumHalf * 2) / 2.1));
  const lineHalf = sGeom.span * CHAIN_LAUNCH_LINE_FRAC; // catapult tray width
  const dumpPivot = sGeom.dist - 7.4;
  const dumpLip = sGeom.dist - 0.9;
  const cLauncherEl =
    cMode === 'drum' ? (
      <g transform={`${ROBOT_FRAME} rotate(${deg(EDGE_ANGLE[sEdge])})`}>
        <rect
          x={drumX - drumDia / 2 - 1.15}
          y={-drumHalf - 0.5}
          width={1.15}
          height={(drumHalf + 0.5) * 2}
          rx={0.35}
          fill={stroke}
          opacity={0.55}
        />
        <rect
          x={drumX - drumDia / 2}
          y={-drumHalf}
          width={drumDia}
          height={drumHalf * 2}
          rx={drumDia * 0.34}
          fill="var(--ds-bg)"
          stroke={stroke}
          strokeWidth={0.3}
        />
        {Array.from({ length: drumRings - 1 }, (_, i) => {
          const y = -drumHalf + ((i + 1) * (drumHalf * 2)) / drumRings;
          return (
            <line
              key={i}
              x1={drumX - drumDia / 2 + 0.22}
              y1={y}
              x2={drumX + drumDia / 2 - 0.22}
              y2={y}
              stroke={stroke}
              strokeWidth={0.16}
              opacity={0.85}
            />
          );
        })}
        {[1, -1].map((sg) => (
          <g key={sg}>
            <rect
              x={drumX - 0.95}
              y={sg > 0 ? drumHalf : -drumHalf - 1.5}
              width={1.9}
              height={1.5}
              rx={0.3}
              fill={stroke}
              opacity={0.8}
            />
            <circle cx={drumX} cy={sg * (drumHalf + 0.72)} r={0.42} fill={stroke} />
          </g>
        ))}
      </g>
    ) : cMode === 'dumper' ? (
      // a TRAY on a pivot: the shaft it swings about, two throwing arms, and the release lip
      <g transform={`${ROBOT_FRAME} rotate(${deg(EDGE_ANGLE[sEdge])})`}>
        <polygon
          points={`${dumpPivot},${-lineHalf * 0.72} ${dumpLip},${-lineHalf} ${dumpLip},${lineHalf} ${dumpPivot},${lineHalf * 0.72}`}
          fill={accent}
          opacity={0.12}
        />
        {[1, -1].map((sg) => (
          <line
            key={sg}
            x1={dumpPivot}
            y1={sg * lineHalf * 0.72}
            x2={dumpLip}
            y2={sg * lineHalf}
            stroke={stroke}
            strokeWidth={0.62}
            strokeLinecap="round"
          />
        ))}
        <line x1={dumpPivot} y1={-lineHalf * 0.72} x2={dumpPivot} y2={lineHalf * 0.72} stroke={stroke} strokeWidth={0.7} />
        {[1, -1].map((sg) => (
          <circle key={sg} cx={dumpPivot} cy={sg * lineHalf * 0.72} r={0.45} fill={stroke} />
        ))}
        <rect x={dumpLip - 0.45} y={-lineHalf} width={0.9} height={lineHalf * 2} rx={0.3} fill={accent} opacity={0.8} />
      </g>
    ) : (
      // The turret sits where it is BOLTED. Authored in SCREEN space (unlike the chassis-frame
      // groups), so the robot-frame offset is mapped by hand: ROBOT_FRAME sends robot (x,y) ->
      // screen (-y,-x).
      // `cy` is 0 and the radius is the SIM's `turretRadius`, deliberately: this used to draw at
      // DECODE's rear-of-centre `turretY` with its own `turretR`, which once the mount became a
      // real position meant a DOUBLE offset and a mismatched size — a corner turret hung off the
      // chassis in the preview while the sim had it comfortably inboard.
      <g transform={`translate(${-tOrigin.y},${-tOrigin.x})`}>
        {/* the SLEW RING it turns on, toothed like the sprite's */}
        <circle cx={0} cy={0} r={cTurretR} fill="var(--ds-bg)" stroke={stroke} strokeWidth={0.35} />
        {Array.from({ length: teeth }, (_, i) => {
          const a = (i / teeth) * Math.PI * 2;
          return (
            <line
              key={i}
              x1={Math.cos(a) * (cTurretR - 0.32)}
              y1={Math.sin(a) * (cTurretR - 0.32)}
              x2={Math.cos(a) * cTurretR}
              y2={Math.sin(a) * cTurretR}
              stroke={stroke}
              strokeWidth={0.2}
              opacity={0.8}
            />
          );
        })}
        {/* the FEED HOLE the Particle rises through, dead centre on the turret axis — the
            reason the launcher straddles the ring instead of hanging off one side of it */}
        <circle cx={0} cy={0} r={CHAIN_PARTICLE_R + 0.15} fill="var(--ds-bg)" stroke={stroke} strokeWidth={0.2} />
        {/* the SHOOTER HEAD: a body with the Particle channel cut through it and a pair of
            flywheels at the muzzle. A TWIN draws both, at the offsets the sim launches from —
            the preview shows it stowed forward, so the head points up. */}
        {(cMode === 'twinturret' ? [CHAIN_TWIN_BARREL_OFFSET, -CHAIN_TWIN_BARREL_OFFSET] : [0]).map((o) => {
          // A FLYWHEEL LAUNCHER: two parallel PLATES with a wheel between them. No barrel —
          // the gap is left empty, because that gap is what reads as the Particle's path, and
          // it is CHAIN_LAUNCH_PLATE_GAP wide because a 3" Particle has to fit down it. Same
          // geometry as `launcher` in the match sprite (drawRobot.ts).
          const gap = CHAIN_LAUNCH_PLATE_GAP;
          const plate = 0.42;
          // CENTRED on the ring: the Particle is fed up the hole in the MIDDLE of the turret,
          // so the plates straddle that axis. Front is up here, so the muzzle is −y.
          const y0 = cTurretR + CHAIN_LAUNCH_PLATE_OVERHANG; // plate rear
          const y1 = -y0; // ...and the muzzle end
          const wheelY = -cTurretR * 0.6; // the flywheel: past the feed hole, before the muzzle
          return (
            <g key={o}>
              {[1, -1].map((sg) => (
                <rect
                  key={sg}
                  x={o + sg * (gap / 2) - (sg > 0 ? 0 : plate)}
                  y={y1}
                  width={plate}
                  height={y0 - y1}
                  rx={0.16}
                  fill={stroke}
                  opacity={0.85}
                />
              ))}
              {/* standoffs: what says "two plates and a gap", not one solid block */}
              {[0.12, 0.92].map((f) => {
                const y = y0 + (y1 - y0) * f;
                return (
                  <line key={f} x1={o - gap / 2} y1={y} x2={o + gap / 2} y2={y} stroke={stroke} strokeWidth={0.2} opacity={0.7} />
                );
              })}
              {/* the flywheel on its axle, spanning the gap */}
              <rect
                x={o - gap / 2 + 0.1}
                y={wheelY - 0.75}
                width={gap - 0.2}
                height={1.5}
                rx={0.4}
                fill="var(--ds-bg)"
                stroke={stroke}
                strokeWidth={0.22}
              />
              <line x1={o - gap / 2 + 0.15} y1={y1 + 0.3} x2={o + gap / 2 - 0.15} y2={y1 + 0.3} stroke={accent} strokeWidth={0.3} />
            </g>
          );
        })}
      </g>
    );

  return (
    <svg
      width={size}
      height={(size * vbH) / vbW}
      viewBox={`${-halfSpan} ${top} ${vbW} ${vbH}`}
      role="img"
      aria-label={`${spec.width} by ${spec.length} inch robot, ${spec.chainIntake ?? CHAIN_DEFAULT_INTAKE} intake, ${cMode} scorer`}
    >
      {cIntakeEl}
      {cCatalystEl}

      {/* chassis.

          DELIBERATELY still `--ds-panel`, not the supporter chassis colour. This
          preview lives on a THEMED UI panel, while the in-game sprite sits on the
          hardcoded-dark field — and every `CHASSIS_COLORS` value is tuned for that
          dark ground. Painting one here would put `--ds-accent` wheels and pods
          (a DARK green in light theme) on a dark chassis fill, which is the exact
          fill-vs-text collision shell.css warns about. The colour is previewed by
          its swatch in the builder instead. */}
      {/* BUMPER BAND + DECK, mirroring the in-game `drawChassisBody` so the builder previews
          the same OBJECT rather than a plain outline. Neutral, not alliance-coloured: a
          preview has no alliance to show, and the fill note above rules out a strong fill
          here anyway. */}
      <rect
        x={-w / 2}
        y={-len / 2}
        width={w}
        height={len}
        rx={1.8}
        fill="var(--ds-line)"
        stroke={stroke}
        strokeWidth={0.5}
      />
      <rect
        x={-w / 2 + bumpW}
        y={-len / 2 + bumpW}
        width={w - bumpW * 2}
        height={len - bumpW * 2}
        rx={1}
        fill="var(--ds-panel)"
        stroke={stroke}
        strokeWidth={0.32}
      />
      {/* control hub — the box every FTC robot has. Pushed WELL back (0.62 of the deck,
          matching drawChassisBody): rear-of-centre is exactly where both games park a turret,
          so a hub any further forward is just something for the turret to sit on top of. */}
      {(() => {
        const dl = len / 2 - bumpW;
        const dw = w / 2 - bumpW;
        const hubW = Math.min(4.6, dw * 1.24);
        const hubH = Math.min(3, dl * 0.52);
        return (
          <rect
            x={-hubW / 2}
            y={dl * 0.62 - hubH / 2}
            width={hubW}
            height={hubH}
            rx={0.45}
            fill="var(--ds-bg)"
            stroke={stroke}
            strokeWidth={0.28}
          />
        );
      })()}

      {/* wheels ON TOP of the chassis (like the in-game drawRobot) — per
          drivetrain: mecanum/tank forward, SWERVE steering pods, X-drive omnis
          canted 45° into an X. Front = UP. */}
      {(() => {
        const corners: [number, number][] = [
          [wx, wy],
          [-wx, wy],
          [wx, -wy],
          [-wx, -wy],
        ];
        const wheelRect = (x: number, y: number, deg: number, ww: number, wh: number, fill: string) => (
          <rect
            key={`w${x}_${y}`}
            x={-ww / 2}
            y={-wh / 2}
            width={ww}
            height={wh}
            rx={0.5}
            fill={fill}
            stroke={stroke}
            strokeWidth={0.25}
            transform={`translate(${x} ${y}) rotate(${deg})`}
          />
        );
        if (spec.drivetrain === 'swerve') {
          return corners.flatMap(([x, y]) => [
            <rect key={`h${x}_${y}`} x={x - 2.6} y={y - 2.6} width={5.2} height={5.2} rx={1} fill="#0c1016" stroke={accent} strokeWidth={0.3} />,
            wheelRect(x, y, 0, wheelW, wheelH, '#1b212b'),
            <line key={`t${x}_${y}`} x1={x} y1={y} x2={x} y2={y - 2.4} stroke={accent} strokeWidth={0.5} />,
          ]);
        }
        if (spec.drivetrain === 'xdrive') {
          const long = Math.min(Math.hypot(wx, wy) * 1.1, 7.2);
          return corners.map(([x, y]) => wheelRect(x, y, x * y >= 0 ? 45 : -45, 2.0, long, '#2b333e'));
        }
        // MECANUM (and BUTTERFLY, which shows its mecanum set — the half it spawns on):
        // rollers at 45°, ALTERNATING by diagonal so they read as an X. Same rule as the
        // in-game renderer: the alternation is what makes the lateral components add
        // instead of cancel, i.e. what makes strafing possible. The preview maps robot
        // (x,y) → screen (−y,−x), which preserves the sign of the product, so the very
        // same `x * y >= 0` test picks the two diagonals here too.
        const rollered = spec.drivetrain === 'mecanum' || spec.drivetrain === 'butterfly';
        return corners.flatMap(([x, y]) => {
          const base = wheelRect(x, y, 0, wheelW, wheelH, '#0c151d');
          if (!rollered) return [base];
          const s = x * y >= 0 ? 1 : -1;
          const h = wheelW / 2;
          return [
            base,
            ...[-0.8, 0, 0.8].map((o) => (
              <line
                key={`r${x}_${y}_${o}`}
                x1={x - h}
                y1={y + o - s * h}
                x2={x + h}
                y2={y + o + s * h}
                stroke={stroke}
                strokeWidth={0.22}
                opacity={0.75}
              />
            )),
          ];
        });
      })()}

      {/* front indicator (a chevron at the front edge) */}
      <polyline
        points={`${-w * 0.18},${frontY + 1.6} 0,${frontY + 0.4} ${w * 0.18},${frontY + 1.6}`}
        fill="none"
        stroke={accent}
        strokeWidth={0.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* scoring mechanism — the CR archetype launcher */}
      {cLauncherEl}

      {/* width dimension label */}
      <text
        x={0}
        y={labelY}
        textAnchor="middle"
        fill="var(--ds-mut)"
        fontSize={DIM_FONT}
        fontFamily="var(--ds-font-mono)"
      >
        {dimLabel}
      </text>
    </svg>
  );
}

