import type { Artifact, RobotState, Vec2, World } from '../types';
import type { GameSimModule, GameUiSpec } from './types';

/**
 * The FULL (client) game module: the DOM-free `GameSimModule` plus the browser
 * canvas renderers + builder metadata. Kept separate from `./types.ts` so the
 * server (no DOM lib) never imports `CanvasRenderingContext2D`.
 */
export interface GameModule extends GameSimModule {
  /** `screenUp` is world-space "up" for z-lift — CR raises the beams into extruded tubes. */
  drawField(ctx: CanvasRenderingContext2D, world: World, screenUp?: Vec2): void;
  /** extra overlays drawn after the field, before robots (DECODE: ramp strips) */
  drawOverlays?(ctx: CanvasRenderingContext2D, world: World): void;
  /** per-robot sprite. DECODE omits it (the shared `drawRobot` is used); CR provides its
   * own so the archetype launcher + intake design read correctly. `screenUp` lets CR bob the
   * chassis up onto a beam it's crossing. `world` is optional and read-only — CR's rail-turret
   * claw TRACKS a live target, so its sprite needs to see where the loose rings are. */
  drawRobot?(
    ctx: CanvasRenderingContext2D,
    r: RobotState,
    intakeOn: boolean,
    held: Artifact[],
    screenUp?: Vec2,
    world?: World,
  ): void;
  /** scoring-elements renderer, drawn after the robots (DECODE: balls; CR: particles
   * + catalysts + endgame badges). `screenUp` is world-space "up" for z-lift. */
  drawBalls(ctx: CanvasRenderingContext2D, world: World, screenUp: Vec2): void;
  ui: GameUiSpec;
}
