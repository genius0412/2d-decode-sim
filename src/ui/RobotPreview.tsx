import type { RobotSpec } from '../types';
import { INTAKE_PRESETS, TURRET_OFFSET_FRAC, WHEEL_INSET, intakeMouth } from '../config';
import {
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_LAUNCH_LINE_FRAC,
  CHAIN_TWIN_BARREL_OFFSET,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_ARM_DRAW,
  CHAIN_CORNER_BODY_INSET,
} from '../games/chain/config';
import { catalystRailHalf, chainIntakeMouths } from '../games/chain/state';
import { EDGE_ANGLE, MOUNT_ANGLE, catalystMountOf, catalystMountPositions, edgeGeom, isEdgePos, isEndEdge, mountOrigin, shooterEdgeOf, turretLocal, turretRadius } from '../games/chain/mounts';
import { footprintExtents } from '../sim/field';
import { turretGeom, type TurretGeom } from '../render/drawRobot';

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
  // the SAME sizing the field renderer uses, so the preview cannot promise a
  // launcher that fits and then draw a different one in the match
  const tGeom = turretGeom(len / 2, w / 2, Math.abs(TURRET_OFFSET_FRAC * len));

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
  // A FRONTBACK swing is one arm drawn where it stows (the front) — see drawCatalystMech.
  const catPos = catalystMountPositions(catalystMountOf(spec))[0];
  const catOrigin = mountOrigin(spec, catPos);
  const catDist = 0; // shapes are drawn from the frame outward once translated to the mount
  const catType = spec.catalystType ?? CHAIN_DEFAULT_CATALYST;
  // how far the CATALYST mechanism protrudes past its mounted edge (the arm is the longest);
  // folded into the viewBox below so a claw tip is never clipped off the drawing
  const catOut = chain ? (catType === 'arm' ? CHAIN_ARM_DRAW + 1.5 : catType === 'launcher' ? 2.0 : 3.0) : 0;
  // half the RAIL carriage's travel — 0 for every non-rail catalyst, which makes the track
  // markup below a no-op for them without a second branch
  const catRailHalf = chain ? catalystRailHalf(spec) : 0;
  // How far past the chassis the mechanism sticks out, per axis, so the viewBox never clips a
  // claw tip. A CORNER mount protrudes on BOTH axes, which is why this tests the position's
  // components rather than switching on a single edge.
  const onFront = chain && catPos.startsWith('front');
  const onBack = chain && catPos.startsWith('back');
  const onSide = chain && (catPos.endsWith('left') || catPos.endsWith('right'));
  const catTop = onFront ? -(spec.length / 2 + catOut) : 0;
  const catBottom = onBack ? spec.length / 2 + catOut : 0;
  const catSide = onSide ? spec.width / 2 + catOut : 0;
  const dimLabel = `${w}" wide · ${len}" long`;
  const labelHalf = (dimLabel.length * DIM_FONT * 0.56) / 2; // ~0.56em avg advance
  const halfSpan = Math.max(w / 2, chain ? cHalf : mouthHalf, labelHalf, catSide) + 2.5;
  const top = Math.min(tipY, catTop) - 2;
  // The label clears everything that hangs off the BACK — a rear sweeper or a rear-mounted
  // claw. It used to sit at the chassis half-length, so a rear/frontback intake printed the
  // dimensions straight over its own rollers.
  const labelY = Math.max(chain ? cRearY : len / 2, catBottom) + 2.6;
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

  // CATALYST mechanism, on ITS mounted edge — authored in the robot frame like the intake
  // and launcher, so the schematic shows where the claw actually reaches from.
  const cCatalystEl = chain ? (
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
  ) : null;

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
      aria-label={
        chain
          ? `${spec.width} by ${spec.length} inch robot, ${spec.chainIntake ?? CHAIN_DEFAULT_INTAKE} intake, ${cMode} scorer`
          : `${spec.width} by ${spec.length} inch robot, ${spec.intake} intake`
      }
    >
      {chain ? cIntakeEl : intakeEl}
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
          {/* the flywheel launcher, in the ROBOT frame so the traction wheel sits on
              the same side here as it does on the field (see drawLauncher) */}
          <g transform={`${ROBOT_FRAME} translate(${TURRET_OFFSET_FRAC * len},0)`}>
            <Launcher g={tGeom} accent={accent} stroke={stroke} sorted={spec.canSort} />
          </g>
        </>
      )}

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

/**
 * The DECODE flywheel launcher, in ROBOT coords (+x forward) — the SVG twin of
 * `drawLauncher`. Both take their dimensions from `turretGeom`, so the preview
 * cannot show a shooter that fits and then have the match draw one that doesn't.
 *
 * Two side plates around a ball channel, one off-centre traction wheel intruding
 * into it (that is what throws the ball — a centred wheel would touch nothing), and
 * the feed hole on the axis of rotation so the hopper below need not rotate with the
 * turret. `sorted` fills the throat, the preview's existing tell for a colour sorter.
 */
function Launcher({
  g,
  accent,
  stroke,
  sorted,
}: {
  g: TurretGeom;
  accent: string;
  stroke: string;
  sorted: boolean;
}) {
  const { ring, chanHalf, plateT, plateLen, holeR } = g;
  const back = -(holeR + plateT);
  const wheelD = Math.min(2.6, plateLen * 0.62);
  const wheelT = Math.min(1.05, chanHalf * 0.62);
  const wx = plateLen * 0.55 - wheelD / 2;
  const wy = chanHalf - wheelT;
  return (
    <>
      {/* side plates — the body, and the shape that should read first */}
      {[-1, 1].map((s) => (
        <rect
          key={s}
          x={back}
          y={s > 0 ? chanHalf : -chanHalf - plateT}
          width={plateLen - back}
          height={plateT}
          fill={stroke}
          opacity={0.7}
        />
      ))}
      {/* back wall closing the breech */}
      <rect x={back} y={-chanHalf} width={plateT} height={chanHalf * 2} fill={stroke} opacity={0.5} />
      {/* feed throat + the bearing it turns on */}
      <circle
        cx={0}
        cy={0}
        r={holeR}
        fill={sorted ? accent : 'var(--ds-bg)'}
        fillOpacity={sorted ? 0.8 : 1}
      />
      <circle cx={0} cy={0} r={ring} fill="none" stroke={accent} strokeWidth={0.35} opacity={0.8} />
      {/* the traction wheel, off-centre against one plate */}
      <rect x={wx} y={wy} width={wheelD} height={wheelT} fill={accent} opacity={0.9} />
      {[1, 2, 3].map((i) => (
        <line
          key={i}
          x1={wx + (wheelD * i) / 4}
          y1={wy}
          x2={wx + (wheelD * i) / 4}
          y2={wy + wheelT}
          stroke="var(--ds-bg)"
          strokeWidth={0.22}
          opacity={0.7}
        />
      ))}
    </>
  );
}
