import type { GameMode, GameSettings, RobotCommand, World } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { IntakeStyle } from '../types';

/**
 * The GAME-ABSTRACTION seam (DOM-free core types).
 *
 * The simulator hosts more than one FTC-style game (DECODE, Chain Reaction, …).
 * Everything GENERIC — the drivetrain/motor model, the Rapier robot solver,
 * contact-torque square-up, the match phase machine, robot rendering — is shared.
 * Everything GAME-SPECIFIC lives behind a game module.
 *
 * The module is split in two so the SERVER (no DOM) can import the simulation half
 * without dragging in the browser-only renderers:
 * - `GameSimModule` (this file): id/scored/bounds/colliders/createWorld/step —
 *   everything the authoritative server + headless smoke need. NO DOM types.
 * - `GameModule` (`./module.ts`): `GameSimModule` + `drawField`/`drawOverlays`/`ui`
 *   (canvas rendering). Client-only.
 *
 * Design rules:
 * - DECODE's existing `src/sim/*` + `src/render/*` are NOT relocated; the DECODE
 *   module just references them. A new game is a new `src/games/<id>/` tree.
 * - Modules produce PLAIN-NUMBER collider specs (`StaticSpec`) — never Rapier.
 *   `physicsEngine.ts` owns RAPIER and turns specs into bodies.
 * - The shared Rapier robot solve + camera are PARAMETERIZED on a module's
 *   `bounds`/`colliders`, so a game with a different field size just works.
 */

export type GameId = 'decode' | 'chain';

/** one static cuboid collider, as plain numbers (Rapier-independent). Moved out
 * of physicsEngine.ts so any game module can produce field geometry. */
export interface StaticSpec {
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  rot: number;
}

/** rectangular field half-extents + fit margin — consumed by the camera (fit the
 * field to the viewport) and the ground/robot wall clamps. Inches. */
export interface FieldBounds {
  halfX: number;
  halfY: number;
  viewMargin: number;
}

/** a game's static field geometry plus any per-step dynamic colliders. */
export interface FieldColliders {
  /** perimeter walls + game structures (DECODE: goal-face hypotenuses +
   * classifier channels). CONSTANT numbers → identical colliders each build →
   * determinism preserved. Compute once at module load. */
  statics: StaticSpec[];
  /**
   * The PERIMETER, as a hard containment invariant rather than merely a collider.
   *
   * `solveRobots` uses it to guarantee that a robot which began a tick inside the field cannot
   * be pushed out of it — the same guarantee `clampBallPosToStatics` gives artifacts, and for
   * the same reason: a soft contact against a body that will not yield is not enough on its
   * own. It says nothing about a robot that was ALREADY outside (a seeded pose, a probe on the
   * outflow mouth); containment keeps you in, it does not teleport you in.
   */
  bounds: { halfX: number; halfY: number };
  /** per-step dynamic cuboids (DECODE: the physical gate handles). Omit for a
   * game with no moving field geometry (CR shell). `gateCol` is DECODE's
   * anticipated gate-lift fraction per alliance. */
  dynamic?(world: World, dt: number, gateCol?: Record<'red' | 'blue', number>): StaticSpec[];
}

/** builder/HUD metadata: how the menu + in-match chrome adapt to this game.
 * (DOM-free — just flags/lists; the actual renderers live on `GameModule`.) */
export interface GameUiSpec {
  /** show the full score bar / breakdown / motif HUD (false ⇒ minimal chrome) */
  showScoreHud: boolean;
  /** show the G304 start-position editor (false ⇒ hidden; game has no legality yet) */
  startEditor: boolean;
  /** intake presets offered in the builder for this game */
  intakes: readonly IntakeStyle[];
}

/**
 * The SIMULATION half of a game (DOM-free): everything the authoritative server
 * and the headless sim need. The client's full `GameModule` (./module.ts) extends
 * this with the canvas renderers + builder metadata.
 */
export interface GameSimModule {
  id: GameId;
  /** false ⇒ a shell with no scoring: never persist ELO/records, minimal HUD.
   * (Still runs full multiplayer — the schema/protocol are game-keyed already.) */
  scored: boolean;
  /** does this game have start-position LEGALITY (DECODE G304)? The server enforces
   * it only for such games; a game without it (CR shell) skips the legality gate. */
  startLegality: boolean;
  bounds: FieldBounds;
  colliders: FieldColliders;
  createWorld(mode: GameMode, seed: number, setups: RobotSetup[], settings?: GameSettings): World;
  step(world: World, dt: number, commands: Map<number, RobotCommand>): void;
}
