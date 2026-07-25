import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../../types';
import * as C from '../../config';
import { clamp, datan2, dcos, dsin, hyp, nextRandom, rot, wrapAngle } from '../../math';
import { robotExtents } from '../../sim/physics';
import {
  CHAIN_ACCEL_DEPTH,
  CHAIN_ACCEL_HALF_Y,
  CHAIN_PTS,
  CHAIN_CATALYST_PICK_R,
  CHAIN_EJECT_SPEED,
  CHAIN_EJECT_SPREAD,
  CHAIN_EJECT_VZ,
  CHAIN_FIRE_INTERVAL,
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_HOOK_PLACE_R,
  chainHopperCap,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_TURRET_SLEW,
  CHAIN_AIM_TOL,
  CHAIN_AIM_GAIN,
  CHAIN_LAUNCH_LINE_FRAC,
  CHAIN_LAUNCH_Z0,
  CHAIN_DRUM_INTERVAL,
  CHAIN_DRUM_JITTER,
  CHAIN_DRUM_SPEED,
  CHAIN_DUMP_RANGE,
  CHAIN_DUMP_INTERVAL,
  CHAIN_DUMP_SPEED,
  CHAIN_DUMP_SIDE_VAR,
  CHAIN_FUNNEL_S,
  CHAIN_FUNNEL_MIN,
  CHAIN_GOAL_REST,
  CHAIN_GOAL_FRICTION,
  CHAIN_FUNNEL_DRIFT_ACC,
  CHAIN_LAUNCHER_MARGIN,
  CHAIN_THROWBACK_SPEED,
  CHAIN_THROWBACK_SPREAD,
  CHAIN_PARTICLE_R,
  CHAIN_PART_FRICTION,
  CHAIN_PART_REST_SPEED,
  CHAIN_PART_SEP_ITERS,
  CHAIN_PART_WALL_REST,
  CHAIN_SHOT_SPEED,
  CHAIN_ENDGAME_S,
  CHAIN_PRELAUNCH_PER_TICK,
  CHAIN_PRELAUNCH_SPEED,
  CHAIN_PRELAUNCH_VZ,
} from './config';
import {
  accelMultiplier,
  accelSide,
  chainIntakeBand,
  hookPos,
  labAreas,
  onRingStand,
  CHAIN_HOOKS_PER_GOAL,
  type ChainState,
} from './state';

/**
 * Chain Reaction gameplay step (called from `chainStep` after the robots move).
 *
 * Particles: bespoke integrator + a spatial-hash SEPARATION pass so they never
 * overlap (scales to 300). Shooter: launch held particles into the alliance
 * ACCELERATOR; a scored particle visibly flies INTO the accelerator, is counted,
 * then the auto-score system EJECTS it back onto the field (same ball — count stays
 * conserved at 300). Catalysts: a BUTTON picks up a nearby ring / places a carried
 * ring on a hook. Endgame park/ascend. Deterministic (commands + world.rngState).
 */
export function updateChain(
  world: World,
  dt: number,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
): void {
  const chain = world.chain!;
  const r2 = CHAIN_PARTICLE_R;

  const rand = (): number => {
    const n = nextRandom(world.rngState);
    world.rngState = n.state;
    return n.value;
  };

  // carried catalysts ride their robot
  for (const c of chain.catalysts) {
    if (c.carriedBy === null) continue;
    const rob = world.robots.find((x) => x.id === c.carriedBy);
    if (!rob) {
      c.carriedBy = null;
      continue;
    }
    c.pos = { x: rob.pos.x, y: rob.pos.y };
  }

  // ── robots: aim, fire/dump, catalyst button ────────────────────────────────
  for (const r of world.robots) {
    if (r.passive) continue; // inert dummy: no turret slew / fire / catalyst work
    const mouth = { x: accelSide(r.alliance) * CHAIN_HALF_X, y: 0 };
    const cmd = cmds.get(r.id);
    const wantsFire = enabled && (r.autoFire || (cmd?.fire ?? false));
    const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
    const distMouth = hyp(mouth.x - r.pos.x, mouth.y - r.pos.y);

    if (mode === 'turret') {
      // TURRET single-shooter: auto-aim + index ONE particle per cadence, from ANY range.
      // SHOOTING ON THE MOVE: the turret leads (aims where muzzle + inherited chassis velocity
      // heads at the mouth), BUT it SLEWS toward that solution at a finite rate — it can't snap.
      // Driving steadily, it tracks perfectly; a SUDDEN velocity change (a robot shoves it) makes
      // the lead solution jump faster than the turret can follow, so shots fired mid-correction
      // fly along the STALE heading and miss. The launch reads r.turretHeading (physical).
      const desiredTurret = leadDir(r.pos, mouth, CHAIN_SHOT_SPEED, r.vel);
      r.turretHeading = slewAngle(r.turretHeading, desiredTurret, CHAIN_TURRET_SLEW * dt);
      if (wantsFire && r.hopper.length > 0 && world.time >= r.fireReadyAt) {
        r.hopper.shift();
        launchToAccel(world, chain, r, mouth, CHAIN_SHOT_SPEED, 0);
        r.fireReadyAt = world.time + CHAIN_FIRE_INTERVAL;
        r.lastFireAt = world.time;
      }
    } else {
      // TURRETLESS (drum / dumper): no turret — the barrel is the chassis, so the robot
      // AIMS BY TURNING to face the goal (the fire button steers it, see chainAimAssist in
      // step.ts) and fires a PARALLEL LINE of particles across its width. Only fires once
      // ALIGNED; drum from any range, dumper only within its (generous) stand-off range.
      r.turretHeading = r.heading;
      const aligned = Math.abs(wrapAngle(chainGoalAimHeading(r) - r.heading)) <= CHAIN_AIM_TOL;
      const inRange = mode === 'drum' ? true : distMouth <= CHAIN_DUMP_RANGE;
      if (wantsFire && aligned && inRange && r.hopper.length > 0 && world.time >= r.fireReadyAt) {
        if (mode === 'drum') {
          // flywheel drum: stream ONE particle at a time from a RANDOM lateral position across
          // the full-width rollers (never a uniform line), at a naturally JITTERED cadence.
          // Uniform launch SPEED — only the position + timing vary, so the pattern flows.
          r.hopper.shift();
          launchAt(world, chain, r, rand() - 0.5, CHAIN_DRUM_SPEED, 0);
          // SYMMETRIC jitter around the nominal 1/23 s ⇒ the drum AVERAGES 23 balls/s while the
          // cadence varies naturally (never a rigid uniform stream).
          r.fireReadyAt = world.time + CHAIN_DRUM_INTERVAL * (1 - CHAIN_DRUM_JITTER + rand() * 2 * CHAIN_DRUM_JITTER);
        } else {
          // catapult: fling the WHOLE hopper at once, side-to-side velocity variance
          const n = r.hopper.length;
          r.hopper.length = 0;
          launchLine(world, chain, r, n, CHAIN_DUMP_SPEED, CHAIN_DUMP_SIDE_VAR);
          r.fireReadyAt = world.time + CHAIN_DUMP_INTERVAL;
        }
        r.lastFireAt = world.time;
      }
    }

    // catalyst pick-up / place-down — EDGE-triggered (acts once per press)
    const held = chain.catalystHeld[r.id] ?? false;
    const now = enabled && (cmd?.catalyst ?? false);
    if (now && !held) catalystAction(chain, r);
    chain.catalystHeld[r.id] = now;
  }

  // ── flight particles: fly at the goal → score + FUNNEL down → wall-side launcher
  //    flings them back out; a MISS is thrown back into the field by a human ──────
  // pre-match: the goal launchers fling STAGED particles onto the field to randomize it
  prematchRandomize(world, chain, rand);

  const survivors: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') {
      survivors.push(b);
      continue;
    }
    const st = b.state;
    if (st.staged) {
      survivors.push(b); // held inside the goal until the launcher ejects it
      continue;
    }
    const a = st.target;
    const side = accelSide(a);
    const wall = side * CHAIN_HALF_X;

    if (!st.scored) {
      // ballistic flight toward the goal
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.z += b.vz * dt;
      b.vz -= C.GRAVITY * dt;
      const beyond = side < 0 ? b.pos.x <= wall : b.pos.x >= wall;
      if (beyond && Math.abs(b.pos.y) <= CHAIN_ACCEL_HALF_Y) {
        // ENTERED the tall opening → score. It KEEPS its momentum and bounces around inside
        // the goal box (below) before the wall-side launcher flings it back out.
        chain.scored[a]++;
        chain.particlePoints[a] += accelMultiplier(chain, a);
        st.scored = true;
        st.funnelT = CHAIN_FUNNEL_S;
        survivors.push(b);
      } else if (beyond) {
        // missed the opening (hit the perimeter wall) → a human throws it back in
        survivors.push(throwBack(b, side, rand));
      } else if (b.z <= 0) {
        survivors.push(landed(b, { x: b.pos.x, y: b.pos.y })); // fell short, into the field
      } else {
        survivors.push(b);
      }
      continue;
    }

    // SCORED. Bounce/jumble around inside the goal box (real containment + restitution),
    // funnel toward the wall-side launcher, then get flung back onto the field.
    if ((st.funnelT ?? 0) > 0) {
      st.funnelT = (st.funnelT ?? 0) - dt;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.z += b.vz * dt;
      b.vz -= C.GRAVITY * dt;
      // floor bounce
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < 0) b.vz = -b.vz * CHAIN_GOAL_REST;
        if (Math.abs(b.vz) < 12) b.vz = 0;
      }
      // back wall of the goal box (the outer face)
      const backWall = side * (CHAIN_HALF_X + CHAIN_ACCEL_DEPTH);
      if (side * b.pos.x > side * backWall - CHAIN_PARTICLE_R) {
        b.pos.x = backWall - side * CHAIN_PARTICLE_R;
        if (side * b.vel.x > 0) b.vel.x = -b.vel.x * CHAIN_GOAL_REST;
      }
      // side walls (goal width in y)
      if (b.pos.y > CHAIN_ACCEL_HALF_Y - CHAIN_PARTICLE_R) {
        b.pos.y = CHAIN_ACCEL_HALF_Y - CHAIN_PARTICLE_R;
        b.vel.y = -Math.abs(b.vel.y) * CHAIN_GOAL_REST;
      } else if (b.pos.y < -CHAIN_ACCEL_HALF_Y + CHAIN_PARTICLE_R) {
        b.pos.y = -CHAIN_ACCEL_HALF_Y + CHAIN_PARTICLE_R;
        b.vel.y = Math.abs(b.vel.y) * CHAIN_GOAL_REST;
      }
      // horizontal friction (jumble settles) + a drift toward the wall-side launcher
      const sp = hyp(b.vel.x, b.vel.y);
      if (sp > 0) {
        const ns = Math.max(0, sp - CHAIN_GOAL_FRICTION * dt);
        b.vel.x *= ns / sp;
        b.vel.y *= ns / sp;
      }
      b.vel.x -= side * CHAIN_FUNNEL_DRIFT_ACC * dt;
      // funneled back to the wall-side launcher (near the wall, drifting fieldward) after at
      // least the min dwell — OR the max dwell expired → FLING it back onto the field
      const elapsed = CHAIN_FUNNEL_S - (st.funnelT ?? 0);
      const atLauncher = side * (b.pos.x - wall) <= CHAIN_LAUNCHER_MARGIN && side * b.vel.x < 0;
      if ((atLauncher && elapsed > CHAIN_FUNNEL_MIN) || (st.funnelT ?? 0) <= 0) {
        st.funnelT = 0;
        const spd = CHAIN_EJECT_SPEED * (0.8 + rand() * 0.5);
        b.pos.x = wall - side * CHAIN_PARTICLE_R;
        b.vel.x = -side * spd;
        b.vel.y = (rand() - 0.5) * CHAIN_EJECT_SPREAD;
        b.vz = CHAIN_EJECT_VZ * (0.8 + rand() * 0.5);
        b.z = Math.max(b.z, 5);
      }
      survivors.push(b);
    } else {
      // ejecting back onto the field — integrate + land as a ground particle
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.z += b.vz * dt;
      b.vz -= C.GRAVITY * dt;
      if (b.z <= 0) survivors.push(landed(b, { x: b.pos.x, y: b.pos.y }));
      else survivors.push(b);
    }
  }
  world.balls = survivors;

  // ── ground particles: friction, integrate, robot plow/intake ───────────────
  const out: Artifact[] = [];
  const ground: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') {
      out.push(b);
      continue;
    }
    const sp = hyp(b.vel.x, b.vel.y);
    if (sp > 0) {
      const ns = sp - CHAIN_PART_FRICTION * dt;
      if (ns <= CHAIN_PART_REST_SPEED) {
        b.vel.x = 0;
        b.vel.y = 0;
      } else {
        b.vel.x *= ns / sp;
        b.vel.y *= ns / sp;
      }
    }
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;

    let absorbed = false;
    for (const rob of world.robots) {
      if (interact(b, rob, cmds.get(rob.id), enabled) === 'absorbed') {
        rob.hopper.push('green');
        rob.lastIntakeAt = world.time;
        absorbed = true;
        break;
      }
    }
    if (!absorbed) ground.push(b);
  }

  // never overlap: spatial-hash separation, then clamp inside the walls
  separateParticles(ground);
  const lim = CHAIN_HALF_X - r2;
  const limY = CHAIN_HALF_Y - r2;
  for (const b of ground) {
    if (b.pos.x > lim) {
      b.pos.x = lim;
      if (b.vel.x > 0) b.vel.x = -b.vel.x * CHAIN_PART_WALL_REST;
    } else if (b.pos.x < -lim) {
      b.pos.x = -lim;
      if (b.vel.x < 0) b.vel.x = -b.vel.x * CHAIN_PART_WALL_REST;
    }
    if (b.pos.y > limY) {
      b.pos.y = limY;
      if (b.vel.y > 0) b.vel.y = -b.vel.y * CHAIN_PART_WALL_REST;
    } else if (b.pos.y < -limY) {
      b.pos.y = -limY;
      if (b.vel.y < 0) b.vel.y = -b.vel.y * CHAIN_PART_WALL_REST;
    }
    out.push(b);
  }
  world.balls = out;

  // ── scoring + endgame ──────────────────────────────────────────────────────
  // AUTO DESCENT (manual: descend a Ring Stand in auto = 100 pt): a robot that STARTED
  // perched on a stand (armed at spawn) earns the descent ONCE when it comes down off
  // the stand during auto. Latched in `chain.descended` so it survives the per-tick total
  // recompute below. `descentArmed`/`descended` default to {} for an old-server snapshot.
  const descended = (chain.descended ??= {});
  const descentArmed = (chain.descentArmed ??= {});
  if (world.match.phase === 'auto') {
    for (const rob of world.robots) {
      if (descentArmed[rob.id] && !descended[rob.id] && !onRingStand(rob.pos)) {
        descended[rob.id] = true;
        world.events.push(`DESCENT +${CHAIN_PTS.ringStandDescend}`);
      }
    }
  }

  const isEndgame =
    world.match.phase === 'post' ||
    (world.match.phase === 'teleop' && world.match.phaseTimeLeft <= CHAIN_ENDGAME_S);
  for (const rob of world.robots) {
    chain.endgame[rob.id] = isEndgame ? endgameOf(rob) : 'none';
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    let eg = 0;
    for (const rob of world.robots) {
      if (rob.alliance !== a) continue;
      const st = chain.endgame[rob.id];
      eg += st === 'ascended' ? CHAIN_PTS.ringStandAscend : st === 'parked' ? CHAIN_PTS.labPark : 0;
      if (descended[rob.id]) eg += CHAIN_PTS.ringStandDescend; // auto descent (latched)
    }
    world.match.scores[a].total = chain.particlePoints[a] + eg + world.match.scores[a].foulPoints;
    world.goals[a].classifiedCount = chain.scored[a]; // surfaces in worldHash
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** launch one particle from robot `r` toward its accelerator `mouth` at a fixed
 * horizontal speed, with an optional lateral velocity (a dump fans several out). Aims
 * at the mouth center and solves the vertical velocity so the ballistic arc lands
 * mid-box at ANY distance (so a shot never falls short). Pushes a 'flight' ball. */
function launchToAccel(
  world: World,
  chain: ChainState,
  r: RobotState,
  mouth: { x: number; y: number },
  horizSpeed: number,
  latVel: number,
): void {
  const distMouth = Math.max(1, hyp(mouth.x - r.pos.x, mouth.y - r.pos.y));
  // PHYSICAL launch: the ball leaves along the turret's ACTUAL heading (`r.turretHeading`, which
  // SLEWS toward the lead solution and lags a sudden velocity change — see the turret branch) plus
  // the inherited chassis velocity. It is NOT re-solved to guarantee a hit — if the turret is
  // mid-correction (e.g. just got shoved), muzzle·speed + velocity no longer points at the mouth
  // and the shot MISSES the opening (→ thrown back). Aim is a physical state, not a promise.
  const dir = { x: dcos(r.turretHeading), y: dsin(r.turretHeading) };
  const perp = { x: -dir.y, y: dir.x }; // lateral spread axis
  const netx = dir.x * horizSpeed + perp.x * latVel + r.vel.x;
  const nety = dir.y * horizSpeed + perp.y * latVel + r.vel.y;
  const netSpeed = Math.max(1, hyp(netx, nety));
  const z0 = 8;
  const land = distMouth + CHAIN_ACCEL_DEPTH * 0.5; // arc timing: sized to the goal distance
  const t = land / netSpeed;
  const vz = 0.5 * C.GRAVITY * t - z0 / t; // solve z(t)=0 for the landing point
  world.balls.push({
    id: chain.nextBallId++,
    color: 'green',
    state: { kind: 'flight', target: r.alliance },
    pos: { x: r.pos.x + dir.x * 4, y: r.pos.y + dir.y * 4 }, // leaves from the barrel tip
    vel: { x: netx, y: nety },
    z: z0,
    vz,
  });
}

/** rotate `cur` toward `target` by at most `maxStep` radians (shortest way around). Used to
 * SLEW the turret so it can't instantly snap to a jumped aim solution. */
function slewAngle(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur);
  if (Math.abs(d) <= maxStep) return wrapAngle(target);
  return wrapAngle(cur + Math.sign(d) * maxStep);
}

/** The muzzle heading (radians) to hit stationary `target` with a projectile of speed `speed`
 * that ALSO inherits `vel` (the shooter's own velocity) — the classic projectile-lead solve:
 * pick the muzzle direction so muzzle·speed + vel points from the shooter straight at target. */
function leadDir(
  from: { x: number; y: number },
  target: { x: number; y: number },
  speed: number,
  vel: { x: number; y: number },
): number {
  const gx = target.x - from.x;
  const gy = target.y - from.y;
  const gd = Math.max(1e-6, hyp(gx, gy));
  const ghx = gx / gd;
  const ghy = gy / gd; // unit direction to the target
  const vg = vel.x * ghx + vel.y * ghy; // v · ĝ
  const v2 = vel.x * vel.x + vel.y * vel.y;
  const k = vg + Math.sqrt(Math.max(0, vg * vg - v2 + speed * speed)); // net speed along ĝ
  return datan2(k * ghy - vel.y, k * ghx - vel.x); // muzzle = (k·ĝ − v), normalized by speed
}

/**
 * The heading a turretless launcher should face to MAXIMIZE particles into the goal: aim the
 * launch-line center at the goal-opening CENTER from the robot's position (so an off-axis robot
 * turns DIAGONALLY toward the goal). SHOOTING ON THE MOVE: it LEADS by turning the whole CHASSIS
 * — `leadDir` returns the heading where the muzzle (chassis-forward) speed + the inherited
 * chassis velocity heads straight at the mouth, so a turretless robot can also stay accurate
 * while moving. A REAR shooter faces its BACK to the goal (+π).
 */
export function chainGoalAimHeading(r: RobotState): number {
  const mouth = { x: accelSide(r.alliance) * CHAIN_HALF_X, y: 0 }; // opening center (±72, 0)
  const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  const speed = mode === 'dumper' ? CHAIN_DUMP_SPEED : CHAIN_DRUM_SPEED;
  const lead = leadDir(r.pos, mouth, speed, r.vel);
  return r.spec.shooterRear ? wrapAngle(lead + Math.PI) : lead;
}

/**
 * TURRETLESS AIM ASSIST (drum / dumper). While the MANUAL fire button is held, steer the
 * whole robot to FACE the goal opening — the fire button turns the robot, THEN it shoots
 * (see the fire gate in updateChain). Returns a `rotate` command override, or null to leave
 * the player's rotation alone (turret, or auto-fire, which fires opportunistically without
 * hijacking the driver's heading). Called from `chainStep` BEFORE the drivetrain model.
 */
export function chainAimAssist(r: RobotState, cmd: RobotCommand | undefined, enabled: boolean): number | null {
  const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  if (mode !== 'drum' && mode !== 'dumper') return null;
  if (!enabled || !(cmd?.fire ?? false)) return null; // only the manual button steers
  const err = wrapAngle(chainGoalAimHeading(r) - r.heading);
  return clamp(err * CHAIN_AIM_GAIN, -1, 1);
}

/**
 * Fire a PARALLEL LINE of `count` particles across the robot's width toward its goal.
 * The launcher is fixed to the chassis (no turret), so every ball leaves along the robot's
 * FORWARD heading (aim comes from the robot turning to face the goal) — they travel
 * parallel, NOT converging on a point. `speed` is the base horizontal launch speed;
 * `sideVar` (dumper catapult) makes balls stored on opposite sides leave at ± that
 * fraction of the speed ⇒ scatter. The arc is solved so each is still airborne crossing
 * the wall plane (the tall over-field opening). Deterministic (no RNG).
 */
function launchLine(
  world: World,
  chain: ChainState,
  r: RobotState,
  count: number,
  speed: number,
  sideVar: number,
): void {
  if (count <= 0) return;
  for (let i = 0; i < count; i++) {
    launchAt(world, chain, r, count > 1 ? i / (count - 1) - 0.5 : 0, speed, sideVar);
  }
}

/** Launch ONE particle toward the goal from lateral fraction `frac` (−0.5..0.5 across the
 * chassis width). It leaves along the robot's FORWARD heading (aim = the robot facing the
 * goal); `sideVar` scales the speed by its lateral position (dumper catapult scatter). The
 * arc is solved so it is still airborne crossing the wall plane (the tall over-field opening). */
function launchAt(
  world: World,
  chain: ChainState,
  r: RobotState,
  frac: number,
  speed: number,
  sideVar: number,
): void {
  const side = accelSide(r.alliance);
  const hw = r.spec.width / 2;
  const hl = r.spec.length / 2;
  // a REAR shooter launches from the BACK edge, in the −forward direction
  const sSign = r.spec.shooterRear ? -1 : 1;
  const fwd = { x: dcos(r.heading) * sSign, y: dsin(r.heading) * sSign };
  const wall = side * CHAIN_HALF_X;
  const w = rot({ x: sSign * hl, y: frac * 2 * hw * CHAIN_LAUNCH_LINE_FRAC }, r.heading);
  const px = r.pos.x + w.x;
  const py = r.pos.y + w.y;
  const spd = speed * (1 + sideVar * (frac * 2)); // frac*2 ∈ [−1,1] — catapult side variance
  // shooting on the move: the shot inherits the FULL chassis velocity (turretless is fixed to
  // the chassis) — the robot compensates by turning its heading (chainGoalAimHeading leads).
  const netx = fwd.x * spd + r.vel.x;
  const nety = fwd.y * spd + r.vel.y;
  const vhx = Math.max(1, Math.abs(netx));
  const tWall = Math.max(0.05, Math.abs(wall - px) / vhx);
  world.balls.push({
    id: chain.nextBallId++,
    color: 'green',
    state: { kind: 'flight', target: r.alliance },
    pos: { x: px, y: py },
    vel: { x: netx, y: nety },
    z: CHAIN_LAUNCH_Z0,
    vz: 0.5 * C.GRAVITY * tWall,
  });
}

/** a HUMAN retrieves a missed particle at the wall and throws it back into the field
 * (tossed inward from where it hit; FOR NOW — this rule may change). */
function throwBack(b: Artifact, side: -1 | 1, rand: () => number): Artifact {
  b.state = { kind: 'ground' };
  b.z = 0;
  b.vz = 0;
  b.pos.x = side * (CHAIN_HALF_X - CHAIN_PARTICLE_R);
  b.pos.y = clamp(b.pos.y, -(CHAIN_HALF_Y - CHAIN_PARTICLE_R), CHAIN_HALF_Y - CHAIN_PARTICLE_R);
  const spd = CHAIN_THROWBACK_SPEED * (0.7 + rand() * 0.6);
  b.vel.x = -side * spd;
  b.vel.y = (rand() - 0.5) * CHAIN_THROWBACK_SPREAD;
  return b;
}

/**
 * PRE-MATCH FIELD RANDOMIZATION (manual auto-score/reject). Each alliance goal holds a stack of
 * STAGED particles; the wall-side launcher flings `CHAIN_PRELAUNCH_PER_TICK` of them PER GOAL
 * each tick out onto the field with a randomized ballistic arc (so they scatter across the
 * playing area), until the goals empty (~2.5 s). The launched ball drops its `staged` flag,
 * keeps `scored` (never re-counted), and flies out on the existing eject path → lands as a
 * ground particle. Deterministic (world RNG). Runs every tick; a no-op once all staged.
 */
function prematchRandomize(world: World, chain: ChainState, rand: () => number): void {
  void chain;
  const left: Record<Alliance, number> = { red: CHAIN_PRELAUNCH_PER_TICK, blue: CHAIN_PRELAUNCH_PER_TICK };
  for (const b of world.balls) {
    if (b.state.kind !== 'flight' || !b.state.staged) continue;
    const a = b.state.target;
    if (left[a] <= 0) continue;
    left[a]--;
    const side = accelSide(a);
    // launch from the wall-side launcher, just inside the field, out toward the field
    b.state = { kind: 'flight', target: a, scored: true, funnelT: 0 };
    b.pos.x = side * (CHAIN_HALF_X - CHAIN_PARTICLE_R);
    b.pos.y = clamp(b.pos.y, -(CHAIN_ACCEL_HALF_Y - CHAIN_PARTICLE_R), CHAIN_ACCEL_HALF_Y - CHAIN_PARTICLE_R);
    b.z = 5;
    b.vel.x = -side * CHAIN_PRELAUNCH_SPEED * (0.55 + rand() * 0.95); // scatter near → far
    b.vel.y = (rand() - 0.5) * CHAIN_EJECT_SPREAD;
    b.vz = CHAIN_PRELAUNCH_VZ * (0.7 + rand() * 0.7);
  }
}

/** convert a flight ball to a resting ground particle at `pos` */
function landed(b: Artifact, pos: { x: number; y: number }): Artifact {
  b.state = { kind: 'ground' };
  b.pos = pos;
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
  return b;
}

/** push overlapping ground particles apart (position-based) using a uniform grid so
 * 300 particles never rest on top of each other. A few passes settle a pile. */
function separateParticles(ground: Artifact[]): void {
  const cell = 2 * CHAIN_PARTICLE_R;
  const minD = 2 * CHAIN_PARTICLE_R;
  const minD2 = minD * minD;
  const key = (cx: number, cy: number): number => (cx + 128) * 512 + (cy + 128);
  for (let iter = 0; iter < CHAIN_PART_SEP_ITERS; iter++) {
    const grid = new Map<number, Artifact[]>();
    for (const b of ground) {
      const k = key(Math.floor(b.pos.x / cell), Math.floor(b.pos.y / cell));
      const arr = grid.get(k);
      if (arr) arr.push(b);
      else grid.set(k, [b]);
    }
    for (const b of ground) {
      const cx = Math.floor(b.pos.x / cell);
      const cy = Math.floor(b.pos.y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const arr = grid.get(key(cx + ox, cy + oy));
          if (!arr) continue;
          for (const o of arr) {
            if (o.id <= b.id) continue;
            const dx = o.pos.x - b.pos.x;
            const dy = o.pos.y - b.pos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= minD2 || d2 < 1e-9) continue;
            const d = Math.sqrt(d2);
            const push = (minD - d) / 2;
            const nx = dx / d;
            const ny = dy / d;
            b.pos.x -= nx * push;
            b.pos.y -= ny * push;
            o.pos.x += nx * push;
            o.pos.y += ny * push;
          }
        }
      }
    }
  }
}

/**
 * Resolve one ground particle against one robot: intake it (front zone + active +
 * room) ⇒ 'absorbed'; else plow it out of the chassis (impart the robot's velocity).
 */
function interact(
  b: Artifact,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
): 'absorbed' | 'none' {
  const e = robotExtents(rob);
  const rel = { x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y };
  const local = rot(rel, -rob.heading);
  const r2 = CHAIN_PARTICLE_R;

  const inBox = local.x < e.front + r2 && local.x > -e.rear - r2 && Math.abs(local.y) < e.half + r2;

  const intakeActive = enabled && (rob.autoIntake || (cmd?.intake ?? false));
  const cap = chainHopperCap(rob.spec);
  // CR intake: capture every particle inside the intake MOUTH (`chainIntakeBand` — the SAME
  // band the renderer draws, so the grab area is exactly the visible intake). It reaches the
  // collision front (the intake tip), so a particle at the intake is captured BEFORE the frame
  // would plow it forward — driving into a cluster collects fast instead of shoving them away.
  if (intakeActive && rob.hopper.length < cap) {
    const m = chainIntakeBand(rob.spec);
    if (m.side) {
      // SIDE mount: rollers on BOTH side edges — a particle alongside either flank (within the
      // chassis length, out to `outer`, in past `inner`) is grabbed.
      const aly = Math.abs(local.y);
      if (Math.abs(local.x) < m.halfLen && aly > m.inner && aly < m.outer + r2) return 'absorbed';
    } else if (local.x > m.back && local.x < m.front + r2 && Math.abs(local.y) < m.half) {
      return 'absorbed';
    }
  }

  // plow (not intaking, or no room, or particle outside the mouth): only inside the footprint
  if (!inBox) return 'none';

  // push out along the min-penetration axis (robot-local), impart robot vel
  const penX = e.front + r2 - local.x;
  const penXneg = local.x + e.rear + r2;
  const penY = e.half + r2 - Math.abs(local.y);
  let nx = 0;
  let ny = 0;
  if (Math.min(penX, penXneg) < penY) nx = penX < penXneg ? 1 : -1;
  else ny = local.y >= 0 ? 1 : -1;
  const world = rot({ x: nx, y: ny }, rob.heading);
  b.pos.x += world.x * 0.6;
  b.pos.y += world.y * 0.6;
  const rv = hyp(rob.vel.x, rob.vel.y);
  b.vel.x = world.x * rv * 0.9;
  b.vel.y = world.y * rv * 0.9;
  return 'none';
}

/** edge action: place a carried ring on a nearby empty hook (else drop it), or pick
 * up the nearest free ring in range if not carrying one. */
function catalystAction(chain: ChainState, rob: RobotState): void {
  const mine = chain.catalysts.find((c) => c.carriedBy === rob.id);
  if (mine) {
    // seat on the NEAREST reachable empty hook of EITHER goal — your own OR the opponent's
    let bestHook: { alliance: Alliance; index: number } | null = null;
    let bestHookD = CHAIN_HOOK_PLACE_R;
    for (const a of ['red', 'blue'] as Alliance[]) {
      for (let i = 0; i < CHAIN_HOOKS_PER_GOAL; i++) {
        const taken = chain.catalysts.some((o) => o.hook && o.hook.alliance === a && o.hook.index === i);
        if (taken) continue;
        const h = hookPos(a, i);
        const d = hyp(h.x - rob.pos.x, h.y - rob.pos.y);
        if (d < bestHookD) {
          bestHookD = d;
          bestHook = { alliance: a, index: i };
        }
      }
    }
    if (bestHook) {
      mine.hook = bestHook;
      mine.carriedBy = null;
      return;
    }
    // no hook in range → drop it here
    mine.carriedBy = null;
    mine.pos = { x: rob.pos.x, y: rob.pos.y };
    return;
  }
  // not carrying → take the nearest reachable ring: a FREE ring on the field, OR a
  // SEATED ring off a hook — either your OWN goal or the OPPONENT's (de-scoring).
  let best: (typeof chain.catalysts)[number] | null = null;
  let bestD = Infinity;
  for (const c of chain.catalysts) {
    if (c.carriedBy !== null) continue;
    let d: number;
    if (c.hook) {
      const h = hookPos(c.hook.alliance, c.hook.index); // reach to the hook (any goal)
      d = hyp(h.x - rob.pos.x, h.y - rob.pos.y);
      if (d >= CHAIN_HOOK_PLACE_R) continue;
    } else {
      d = hyp(c.pos.x - rob.pos.x, c.pos.y - rob.pos.y);
      if (d >= CHAIN_CATALYST_PICK_R) continue;
    }
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best) {
    best.hook = null; // if it was seated, this removes it from the goal (de-score)
    best.carriedBy = rob.id;
  }
}

/**
 * What catalyst action is AVAILABLE to `rob` right now (for the HUD/render prompt) — mirrors
 * `catalystAction`'s range checks without mutating: 'place' when carrying a ring near an empty
 * own hook, 'pickup' when a free/seated ring is reachable, else null. Also returns the target
 * position so the renderer can highlight it. */
export function chainCatalystPrompt(
  chain: ChainState,
  rob: RobotState,
): { action: 'pickup' | 'place'; target: { x: number; y: number } } | null {
  const mine = chain.catalysts.find((c) => c.carriedBy === rob.id);
  if (mine) {
    // an empty hook on EITHER goal (your own or the opponent's) is a valid place target
    let best: { x: number; y: number } | null = null;
    let bestD = CHAIN_HOOK_PLACE_R;
    for (const a of ['red', 'blue'] as Alliance[]) {
      for (let i = 0; i < CHAIN_HOOKS_PER_GOAL; i++) {
        const taken = chain.catalysts.some((o) => o.hook && o.hook.alliance === a && o.hook.index === i);
        if (taken) continue;
        const h = hookPos(a, i);
        const d = hyp(h.x - rob.pos.x, h.y - rob.pos.y);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
    }
    return best ? { action: 'place', target: best } : null;
  }
  let best: { action: 'pickup'; target: { x: number; y: number } } | null = null;
  let bestD = Infinity;
  for (const c of chain.catalysts) {
    if (c.carriedBy !== null) continue;
    const target = c.hook ? hookPos(c.hook.alliance, c.hook.index) : c.pos;
    const range = c.hook ? CHAIN_HOOK_PLACE_R : CHAIN_CATALYST_PICK_R;
    const d = hyp(target.x - rob.pos.x, target.y - rob.pos.y);
    if (d < range && d < bestD) {
      bestD = d;
      best = { action: 'pickup', target };
    }
  }
  return best;
}

/** a robot's endgame status: ascended (near a ring stand, slow) > parked (center in a
 * lab-area corner) > none */
function endgameOf(rob: RobotState): 'none' | 'parked' | 'ascended' {
  const slow = hyp(rob.vel.x, rob.vel.y) < 12;
  if (slow && onRingStand(rob.pos)) return 'ascended';
  const cx = rob.pos.x;
  const cy = rob.pos.y;
  for (const lab of labAreas(rob.alliance)) {
    if (cx >= lab.x0 && cx <= lab.x1 && cy >= lab.y0 && cy <= lab.y1) return 'parked';
  }
  return 'none';
}
