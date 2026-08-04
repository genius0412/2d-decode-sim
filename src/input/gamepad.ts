import type { PadBindings } from './bindings';

/** deadzone + sensitivity curve: below `deadzone` reads as dead center; past
 * it, the remaining travel is rescaled to 0-1 and raised to `curve` (1 =
 * linear, higher = softer near center / more precise low-speed control,
 * still reaching full deflection at the stick's edge — the classic RC/gaming
 * "expo" curve), then given back the original sign. */
const shape = (v: number, deadzone: number, curve: number): number => {
  const av = Math.abs(v);
  if (av < deadzone) return 0;
  const scaled = (av - deadzone) / (1 - deadzone);
  return Math.sign(v) * Math.pow(scaled, curve);
};

export interface GamepadSample {
  connected: boolean;
  driveX: number;
  driveY: number;
  rotate: number;
  leftY: number; // raw left stick Y (inverted)
  rightY: number; // raw right stick Y (inverted)
  fire: boolean;
  intake: boolean;
  catalyst: boolean;
  driveMode: boolean;
  flipFront: boolean;
  park: boolean;
  start: boolean;
  restart: boolean;
}

const EMPTY: GamepadSample = {
  connected: false,
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftY: 0,
  rightY: 0,
  fire: false,
  intake: false,
  catalyst: false,
  driveMode: false,
  flipFront: false,
  park: false,
  start: false,
  restart: false,
};

/** standard-mapping gamepad. Stick roles and button assignments come from the
 * user's PadBindings: the drive stick translates, the other stick's X turns. */
export class GamepadInput {
  private prevStart = false;
  private prevRestart = false;
  private prevFlip = false;
  private prevPark = false;

  sample(bindings: PadBindings): GamepadSample {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    if (!pad) {
      this.prevStart = false;
      this.prevRestart = false;
      this.prevFlip = false;
      this.prevPark = false;
      return { ...EMPTY };
    }
    const btn = (i: number): boolean =>
      pad.buttons[i] ? pad.buttons[i].pressed || pad.buttons[i].value > bindings.triggerThreshold : false;
    const anyBtn = (idxs: number[]): boolean => idxs.some(btn);
    const ax = (i: number): number => shape(pad.axes[i] ?? 0, bindings.deadzone, bindings.curve);
    // left stick = axes 0/1, right stick = axes 2/3
    const drive = bindings.driveStick === 'left' ? [0, 1] : [2, 3];
    const rotAxis = bindings.driveStick === 'left' ? 2 : 0;
    const startNow = anyBtn(bindings.buttons.start);
    const restartNow = anyBtn(bindings.buttons.restart);
    const flipNow = anyBtn(bindings.buttons.flipFront);
    const parkNow = anyBtn(bindings.buttons.park);
    const sampleOut: GamepadSample = {
      connected: true,
      driveX: ax(drive[0]),
      driveY: -ax(drive[1]),
      rotate: -ax(rotAxis),
      leftY: -ax(1),
      rightY: -ax(3),
      fire: anyBtn(bindings.buttons.fire),
      intake: anyBtn(bindings.buttons.intake),
      catalyst: anyBtn(bindings.buttons.catalyst),
      driveMode: anyBtn(bindings.buttons.driveMode),
      flipFront: flipNow && !this.prevFlip,
      park: parkNow && !this.prevPark,
      start: startNow && !this.prevStart,
      restart: restartNow && !this.prevRestart,
    };
    this.prevStart = startNow;
    this.prevRestart = restartNow;
    this.prevFlip = flipNow;
    this.prevPark = parkNow;
    return sampleOut;
  }
}
