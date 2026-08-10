import type { RobotSpec } from '../../types';
import { WHEEL_INSET } from '../../config';
import {
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_LAUNCH_LINE_FRAC,
  CHAIN_TWIN_BARREL_OFFSET,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_ARM_DRAW,
  CHAIN_CORNER_BODY_INSET,
} from './config';
import { catalystRailHalf, chainIntakeMouths } from './state';
import { EDGE_ANGLE, MOUNT_ANGLE, catalystDrawPos, catalystMountOf, catalystSwingOf, edgeGeom, isEdgePos, isEndEdge, mountOrigin, shooterEdgeOf, turretLocal, turretRadius } from './mounts';
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

  // one roller bar + a row of lip ticks per MOUNTED edge (front / back / both flanks / both ends)
  const cIntakeEl = cMouths.length ? (
    <g transform={ROBOT_FRAME}>
      {cMouths.map((m) => {
        const end = isEndEdge(m.edge); // ends run across y, flanks along x
        const half = end ? (m.y1 - m.y0) / 2 : (m.x1 - m.x0) / 2;
        const lip = 1.3; // tick depth, drawn just inside the outer edge
        return (
          <g key={m.edge}>
            <rect x={m.x0} y={m.y0} width={m.x1 - m.x0} height={m.y1 - m.y0} fill={accent} opacity={0.4} />
            {[-3, -2, -1, 0, 1, 2, 3].map((i) => {
              const t = (i * half) / 3.4; // position along the edge
              const op = Math.abs(i) <= 1 ? 0.95 : 0.6;
              const outer =
                m.edge === 'front' ? m.x1 - lip : m.edge === 'back' ? m.x0 : m.edge === 'left' ? m.y1 - lip : m.y0;
              return end ? (
                <rect key={i} x={outer} y={t - 0.5} width={lip} height={1} rx={0.3} fill={accent} opacity={op} />
              ) : (
                <rect key={i} x={t - 0.5} y={outer} width={1} height={lip} rx={0.3} fill={accent} opacity={op} />
              );
            })}
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
  const drumHalf = sGeom.span * 0.96; // spans (nearly) the whole mounted edge
  const drumN = Math.max(5, Math.round((drumHalf * 2) / 2.6));
  const lineHalf = sGeom.span * CHAIN_LAUNCH_LINE_FRAC; // catapult bucket width
  const drumX = sGeom.dist - 3.9; // roller bar, just inside the edge
  const cLauncherEl =
    cMode === 'drum' ? (
      <g transform={`${ROBOT_FRAME} rotate(${deg(EDGE_ANGLE[sEdge])})`}>
        {/* full-edge row of compliant flywheel rollers (not channels) */}
        <rect x={drumX} y={-drumHalf} width={3.4} height={drumHalf * 2} rx={0.8} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.5} />
        {Array.from({ length: drumN }, (_, k) => k).map((i) => {
          const y = -drumHalf + ((i + 0.5) * drumHalf * 2) / drumN;
          return <rect key={i} x={drumX + 0.5} y={y - 0.55} width={2.4} height={1.1} rx={0.4} fill={accent} opacity={0.85} />;
        })}
      </g>
    ) : cMode === 'dumper' ? (
      <g transform={`${ROBOT_FRAME} rotate(${deg(EDGE_ANGLE[sEdge])})`}>
        <polygon
          points={`${sGeom.dist - 6},${-lineHalf * 0.7} ${sGeom.dist - 1},${-lineHalf} ${sGeom.dist - 1},${lineHalf} ${sGeom.dist - 6},${lineHalf * 0.7}`}
          fill="var(--ds-bg)"
          stroke={accent}
          strokeWidth={0.5}
        />
        <line x1={sGeom.dist - 1} y1={-lineHalf} x2={sGeom.dist - 1} y2={lineHalf} stroke={accent} strokeWidth={1} />
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
        <circle cx={0} cy={0} r={cTurretR} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.5} />
        {/* a TWIN draws both barrels at the offset the sim actually launches from */}
        {(cMode === 'twinturret' ? [CHAIN_TWIN_BARREL_OFFSET, -CHAIN_TWIN_BARREL_OFFSET] : [0]).map((o) => (
          <line
            key={o}
            x1={o}
            y1={0}
            x2={o}
            y2={-cTurretR - 1.2}
            stroke={accent}
            strokeWidth={0.7}
            strokeLinecap="round"
          />
        ))}
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

