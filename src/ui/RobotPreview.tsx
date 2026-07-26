import type { RobotSpec } from '../types';
import { INTAKE_PRESETS, TURRET_OFFSET_FRAC, WHEEL_INSET, intakeMouth } from '../config';
import {
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_LAUNCH_LINE_FRAC,
} from '../games/chain/config';
import { chainIntakeMouths } from '../games/chain/state';
import { EDGE_ANGLE, edgeGeom, isEndEdge, shooterMountOf } from '../games/chain/mounts';
import { footprintExtents } from '../sim/field';

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
export function RobotPreview({
  spec,
  size = 200,
  chain = false,
}: {
  spec: RobotSpec;
  size?: number;
  chain?: boolean;
}) {
  const w = spec.width;
  const len = spec.length;
  const intake = INTAKE_PRESETS[spec.intake];
  const reach = intake.reach;
  const mouth = intakeMouth(spec); // vector's mouth spans the chassis width
  const mouthHalf = mouth.mouthHalf;
  const throatHalf = mouth.throatHalf;
  const wedge = mouth.wedge;
  const halfW = w / 2;

  const frontY = -len / 2; // chassis front edge (top) = the throat
  const wedgeTipY = frontY - (reach - 0.5); // wedge/plate front — just behind the roller
  const rollerTipY = frontY - (reach + 0.5); // shaft + wheels ride out just past the wedges
  // turret sits behind center of rotation, scaled by chassis length
  const turretY = -TURRET_OFFSET_FRAC * len;
  const turretR = Math.min(w, len) * 0.2;

  // Chain Reaction geometry — the SAME intake mouths the sim captures with, one per mounted
  // edge, in ROBOT coords (+x forward). The collision footprint moves with the mount, so the
  // viewBox extents come from `footprintExtents` (the sim's own hitbox) rather than the front.
  const cMouths = chain ? chainIntakeMouths(spec) : [];
  const cExt = chain ? footprintExtents(spec) : null;
  const cHalf = cExt ? cExt.half : 0; // ±y half-span (grown by a flank mount)
  const cTipY = cExt ? -cExt.front : frontY; // front-most in SCREEN y (robot +x → screen −y)
  const cRearY = cExt ? cExt.rear : len / 2; // rear-most in SCREEN y
  const cMode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;

  const tipY = chain ? cTipY : rollerTipY; // front-most, for the viewBox

  // viewBox spans the widest of chassis/intake plus a margin, kept square-ish.
  // The dimension label is centered and can be WIDER than a narrow chassis, so it
  // has to be measured in too — an <svg> clips to its viewport, and a 10"-wide
  // robot would otherwise lop the ends off "16.5" wide · 14.5" long".
  const dimLabel = `${w}" wide · ${len}" long`;
  const labelHalf = (dimLabel.length * DIM_FONT * 0.56) / 2; // ~0.56em avg advance
  const halfSpan = Math.max(w / 2, chain ? cHalf : mouthHalf, labelHalf) + 2.5;
  const top = tipY - 2;
  // room for the width dimension label — plus a rear-mounted CR intake, which grows the
  // footprint BACKWARD (a viewBox off the chassis alone would clip it off).
  const bottom = (chain ? cRearY : len / 2) + 3.5;
  const vbW = halfSpan * 2;
  const vbH = bottom - top;

  const wheelInset = WHEEL_INSET;
  const wx = w / 2 - wheelInset;
  const wy = len / 2 - wheelInset;

  const isTank = spec.drivetrain === 'tank';
  const wheelW = isTank ? 1.9 : 1.5;
  const wheelH = isTank ? 4.2 : 3.2;

  const stroke = 'var(--ds-ink-dim)';
  const accent = 'var(--ds-accent)';

  // intake geometry — MATCHES the in-game sprite (drawRobot.ts): front faces UP
  // here, so the sim's forward +x maps to −y. The ball-colliding wedges/mouth are
  // RECESSED (to wedgeTipY); the ROLLER (axle + compliant wheels) sticks out past
  // them to tipY. Funnel presets show two side slopes into the throat (no flat
  // front); the flat (vector) preset shows an open mouth to the chassis front.
  const roller = (
    <g>
      <rect x={-mouthHalf} y={rollerTipY} width={mouthHalf * 2} height={wedgeTipY - rollerTipY} fill={accent} opacity={0.45} />
      {[-3, -2, -1, 0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={(i * mouthHalf) / 3.4 - 0.5}
          y={rollerTipY}
          width={1}
          height={1.6}
          rx={0.3}
          fill={accent}
          opacity={Math.abs(i) <= 1 ? 0.95 : 0.6}
        />
      ))}
    </g>
  );
  let intakeEl: JSX.Element;
  if (!wedge) {
    intakeEl = (
      <g>
        <rect x={-mouthHalf} y={wedgeTipY} width={mouthHalf * 2} height={frontY - wedgeTipY} fill={accent} opacity={0.28} />
        {roller}
      </g>
    );
  } else {
    intakeEl = (
      <g>
        {/* funnel mouth: opening at the wedge line narrowing to the throat */}
        <polygon
          points={`${-halfW},${wedgeTipY} ${halfW},${wedgeTipY} ${throatHalf},${frontY} ${-throatHalf},${frontY}`}
          fill={accent}
          opacity={0.28}
          stroke={accent}
          strokeWidth={0.35}
        />
        {/* two right triangles — hypotenuse is the slope, no flat front */}
        {[1, -1].map((s) => (
          <polygon
            key={s}
            points={`${s * halfW},${frontY} ${s * halfW},${wedgeTipY} ${s * throatHalf},${frontY}`}
            fill={accent}
            opacity={0.6}
          />
        ))}
        {roller}
      </g>
    );
  }

  // ── Chain Reaction mechanisms, authored in the ROBOT frame ────────────────────────────────
  // Everything else in this preview is drawn in SCREEN coords (front = UP). The CR intake and
  // launcher can sit on ANY chassis edge, so they are authored in robot coords (+x = forward,
  // +y = the robot's LEFT) — exactly the sim's frame, so `chainIntakeMouths` rects can be used
  // verbatim — and mapped by ONE wrapper.
  //
  // That wrapper is a BIRD'S-EYE view with the nose up: forward (1,0) → screen (0,−1) = up, and
  // the robot's left (0,1) → screen (−1,0) = screen LEFT (look down at a robot facing away and
  // its left hand is on your left). Screen y points DOWN, so the matrix is [[0,−1],[−1,0]] —
  // NOT a plain rotate(−90), which would send the robot's left to screen RIGHT and draw a
  // LEFT-mounted shooter on the wrong flank. Symmetric mechanisms can't tell the difference;
  // a flank mount can.
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

  // Chain Reaction archetype launcher: drum = slotted bar along the mounted edge; dumper =
  // catapult bucket; turret = ring + barrel (top-mounted, so it ignores the mount).
  // Drum/dumper are authored along robot +x and rotated onto their mounted edge, so a
  // left/right mount spans the chassis LENGTH — matching how `launchAt` spreads the shot.
  const sEdge = shooterMountOf(spec);
  const sGeom = edgeGeom(spec, sEdge);
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
      <g>
        <circle cx={0} cy={turretY} r={turretR} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.5} />
        <line x1={0} y1={turretY} x2={0} y2={turretY - turretR - 1.2} stroke={accent} strokeWidth={0.7} strokeLinecap="round" />
      </g>
    );

  return (
    <svg
      width={size}
      height={(size * vbH) / vbW}
      viewBox={`${-halfSpan} ${top} ${vbW} ${vbH}`}
      role="img"
      aria-label={
        chain
          ? `${spec.width} by ${spec.length} inch robot, ${spec.chainIntake ?? CHAIN_DEFAULT_INTAKE} intake, ${cMode} scorer`
          : `${spec.width} by ${spec.length} inch robot, ${spec.intake} intake`
      }
    >
      {chain ? cIntakeEl : intakeEl}

      {/* chassis.

          DELIBERATELY still `--ds-panel`, not the supporter chassis colour. This
          preview lives on a THEMED UI panel, while the in-game sprite sits on the
          hardcoded-dark field — and every `CHASSIS_COLORS` value is tuned for that
          dark ground. Painting one here would put `--ds-accent` wheels and pods
          (a DARK green in light theme) on a dark chassis fill, which is the exact
          fill-vs-text collision shell.css warns about. The colour is previewed by
          its swatch in the builder instead. */}
      <rect
        x={-w / 2}
        y={-len / 2}
        width={w}
        height={len}
        rx={1.4}
        fill="var(--ds-panel)"
        stroke={stroke}
        strokeWidth={0.5}
      />

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
        return corners.map(([x, y]) => wheelRect(x, y, 0, wheelW, wheelH, '#0c151d'));
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

      {/* scoring mechanism — CR archetype launcher, or DECODE turret + triangle hint */}
      {chain ? (
        cLauncherEl
      ) : (
        <>
          {/* triangle-intake internal storage hint: two near the mouth (front/up),
              one deeper (rear/down) */}
          {spec.intake === 'triangle' && (
            <polygon
              points={`${-1.7},${turretY - 0.6} 1.7,${turretY - 0.6} 0,${turretY + 2.4}`}
              fill="none"
              stroke={stroke}
              strokeWidth={0.3}
              opacity={0.7}
            />
          )}
          {/* turret ring + barrel toward front */}
          <circle cx={0} cy={turretY} r={turretR} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.5} />
          <line x1={0} y1={turretY} x2={0} y2={turretY - turretR - 1.2} stroke={accent} strokeWidth={0.7} strokeLinecap="round" />
          {spec.canSort && <circle cx={0} cy={turretY} r={turretR * 0.4} fill={accent} opacity={0.8} />}
        </>
      )}

      {/* width dimension label */}
      <text
        x={0}
        y={len / 2 + 2.6}
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
