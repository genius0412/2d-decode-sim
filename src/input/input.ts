import type { RobotCommand } from '../types';
import { clamp } from '../math';
import { Keyboard } from './keyboard';
import { GamepadInput } from './gamepad';
import { KEY_ACTIONS, type ControlBindings } from './bindings';

export interface VirtualInput {
  driveX: number;
  driveY: number;
  rotate: number;
  leftDrive: number;
  rightDrive: number;
  intake: boolean;
  fire: boolean;
  catalyst: boolean;
  driveMode: boolean;
}

/** merges keyboard + gamepad into one driver command per frame, resolving
 * physical keys/buttons through the user's ControlBindings */
export class InputManager {
  readonly keyboard = new Keyboard();
  private gamepad = new GamepadInput();
  gamepadConnected = false;
  /** edge-triggered "start match / confirm" from either device */
  startPressed = false;
  /** edge-triggered restart from either device */
  restartPressed = false;
  /** edge-triggered "flip robot front" from either device */
  flipPressed = false;
  /** edge-triggered "toggle park mode" from either device */
  parkPressed = false;

  private virtualState: VirtualInput = {
    driveX: 0,
    driveY: 0,
    rotate: 0,
    leftDrive: 0,
    rightDrive: 0,
    intake: false,
    fire: false,
    catalyst: false,
    driveMode: false,
  };

  constructor(private bindings: ControlBindings) {
    this.applyPreventKeys();
  }

  setVirtualInput(update: Partial<VirtualInput>): void {
    Object.assign(this.virtualState, update);
  }

  setBindings(bindings: ControlBindings): void {
    this.bindings = bindings;
    this.applyPreventKeys();
  }

  private applyPreventKeys(): void {
    this.keyboard.setPreventKeys(KEY_ACTIONS.flatMap((a) => this.bindings.keys[a]));
  }

  attach(): void {
    this.keyboard.attach();
  }

  detach(): void {
    this.keyboard.detach();
  }

  /** call once per animation frame; returns the merged command */
  poll(): RobotCommand {
    const k = this.keyboard;
    const keys = this.bindings.keys;
    const g = this.gamepad.sample(this.bindings.pad);
    this.gamepadConnected = g.connected;

    const heldAny = (list: string[]): boolean => list.some((key) => k.held(key));
    const pressedAny = (list: string[]): boolean =>
      list.reduce((hit, key) => k.justPressed(key) || hit, false);

    const kx = (heldAny(keys.driveRight) ? 1 : 0) - (heldAny(keys.driveLeft) ? 1 : 0);
    const ky = (heldAny(keys.driveUp) ? 1 : 0) - (heldAny(keys.driveDown) ? 1 : 0);
    const krot = (heldAny(keys.rotateCCW) ? 1 : 0) - (heldAny(keys.rotateCW) ? 1 : 0);

    // Tank drive specific keyboard mapping: W/S for left, Up/Down for right
    const kLeft = (heldAny(keys.driveUp) ? 1 : 0) - (heldAny(keys.driveDown) ? 1 : 0);
    const kRight = (k.held('arrowup') ? 1 : 0) - (k.held('arrowdown') ? 1 : 0);

    this.startPressed = pressedAny(keys.start) || g.start;
    this.restartPressed = pressedAny(keys.restart) || g.restart;
    this.flipPressed = pressedAny(keys.flipFront) || g.flipFront;
    this.parkPressed = pressedAny(keys.park) || g.park;

    const cmd: RobotCommand = {
      driveX: clamp(kx + g.driveX + this.virtualState.driveX, -1, 1),
      driveY: clamp(ky + g.driveY + this.virtualState.driveY, -1, 1),
      rotate: clamp(krot + g.rotate + this.virtualState.rotate, -1, 1),
      leftDrive: clamp(kLeft + g.leftY + this.virtualState.leftDrive, -1, 1),
      rightDrive: clamp(kRight + g.rightY + this.virtualState.rightDrive, -1, 1),
      intake: heldAny(keys.intake) || g.intake || this.virtualState.intake,
      fire: heldAny(keys.fire) || g.fire || this.virtualState.fire,
      // Chain Reaction ring pick-up/place — held; the sim edge-triggers it
      catalyst: heldAny(keys.catalyst) || g.catalyst || this.virtualState.catalyst,
      // BUTTERFLY wheel-set swap — also passed HELD, edge-triggered in the sim. Doing the
      // edge sim-side (not here) keeps it deterministic under prediction + reconcile:
      // a replayed input can't double-toggle the way a client-side edge flag would.
      driveMode: heldAny(keys.driveMode) || g.driveMode || this.virtualState.driveMode,
    };
    k.endFrame();
    return cmd;
  }
}
