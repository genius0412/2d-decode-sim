/** user-customizable control bindings: keyboard keys per action, gamepad
 * button indices per action, and which stick drives. Escape is reserved
 * (menu / cancel capture) and never bindable. */

export type KeyAction =
  | 'driveUp'
  | 'driveDown'
  | 'driveLeft'
  | 'driveRight'
  | 'rotateCCW'
  | 'rotateCW'
  | 'intake'
  | 'fire'
  | 'catalyst'
  | 'fling'
  | 'driveMode'
  | 'flipFront'
  | 'park'
  | 'start'
  | 'restart';

export type PadAction = 'fire' | 'intake' | 'catalyst' | 'fling' | 'driveMode' | 'flipFront' | 'park' | 'start' | 'restart';

export interface PadBindings {
  /** which stick translates the robot — the other stick's X axis turns */
  driveStick: 'left' | 'right';
  /** standard-mapping button indices per action */
  buttons: Record<PadAction, number[]>;
  /** radial stick deadzone, 0-0.4 (fraction of full travel ignored near center) */
  deadzone: number;
  /** sensitivity curve exponent applied to stick input past the deadzone: 1 =
   * linear, higher = softer/more precise near center, ramping to full at the
   * stick's edge (classic RC/gaming "expo" curve) */
  curve: number;
  /** analog trigger press threshold, 0.1-0.9 (LT/RT register as "held" past this) */
  triggerThreshold: number;
}

export interface ControlBindings {
  /** `KeyboardEvent.key.toLowerCase()` values per action */
  keys: Record<KeyAction, string[]>;
  pad: PadBindings;
}

export const KEY_ACTIONS: KeyAction[] = [
  'driveUp',
  'driveDown',
  'driveLeft',
  'driveRight',
  'rotateCCW',
  'rotateCW',
  'intake',
  'fire',
  'catalyst',
  'fling',
  'driveMode',
  'flipFront',
  'park',
  'start',
  'restart',
];

export const PAD_ACTIONS: PadAction[] = ['fire', 'intake', 'catalyst', 'fling', 'driveMode', 'flipFront', 'park', 'start', 'restart'];

export const DEFAULT_BINDINGS: ControlBindings = {
  keys: {
    driveUp: ['w'],
    driveDown: ['s'],
    driveLeft: ['a'],
    driveRight: ['d'],
    rotateCCW: ['arrowleft', 'q'],
    rotateCW: ['arrowright', 'e'],
    intake: ['shift', 'k'],
    fire: [' '],
    catalyst: ['c'],
    // CATAPULT throw (launcher catalyst mechanism) — its OWN button, so it is never
    // ambiguous with the claw's grab/place on the same press.
    fling: ['v'],
    // BUTTERFLY: drop the other wheel set. 'b' for butterfly; free on the default map.
    driveMode: ['b'],
    flipFront: ['f'],
    park: ['p'],
    start: ['enter'],
    restart: ['r'],
  },
  pad: {
    driveStick: 'left',
    buttons: {
      fire: [7, 0], // RT or A
      intake: [6, 1], // LT or B
      catalyst: [4], // LB
      fling: [10], // L3 (left stick click)
      driveMode: [5], // RB — the only unused face/shoulder button
      flipFront: [3], // Y
      park: [2], // X
      start: [9],
      restart: [8], // Back / Select / View
    },
    deadzone: 0.12,
    curve: 1,
    triggerThreshold: 0.35,
  },
};

export function cloneBindings(b: ControlBindings): ControlBindings {
  const keys = {} as Record<KeyAction, string[]>;
  for (const a of KEY_ACTIONS) keys[a] = [...b.keys[a]];
  const buttons = {} as Record<PadAction, number[]>;
  for (const a of PAD_ACTIONS) buttons[a] = [...b.pad.buttons[a]];
  return {
    keys,
    pad: {
      driveStick: b.pad.driveStick,
      buttons,
      deadzone: b.pad.deadzone,
      curve: b.pad.curve,
      triggerThreshold: b.pad.triggerThreshold,
    },
  };
}

/** validate a possibly-stale/corrupt saved value field by field; anything
 * that doesn't check out falls back to the default for that action */
export function mergeBindings(saved: unknown): ControlBindings {
  const out = cloneBindings(DEFAULT_BINDINGS);
  if (typeof saved !== 'object' || saved === null) return out;
  const s = saved as { keys?: unknown; pad?: unknown };
  if (typeof s.keys === 'object' && s.keys !== null) {
    const keys = s.keys as Record<string, unknown>;
    for (const a of KEY_ACTIONS) {
      const v = keys[a];
      if (Array.isArray(v) && v.every((k) => typeof k === 'string' && k !== 'escape')) {
        out.keys[a] = v.map((k: string) => k.toLowerCase());
      }
    }
  }
  if (typeof s.pad === 'object' && s.pad !== null) {
    const pad = s.pad as {
      driveStick?: unknown;
      buttons?: unknown;
      deadzone?: unknown;
      curve?: unknown;
      triggerThreshold?: unknown;
    };
    if (pad.driveStick === 'left' || pad.driveStick === 'right') {
      out.pad.driveStick = pad.driveStick;
    }
    if (typeof pad.buttons === 'object' && pad.buttons !== null) {
      const buttons = pad.buttons as Record<string, unknown>;
      for (const a of PAD_ACTIONS) {
        const v = buttons[a];
        if (Array.isArray(v) && v.every((i) => Number.isInteger(i) && i >= 0 && i < 32)) {
          out.pad.buttons[a] = v as number[];
        }
      }
    }
    if (typeof pad.deadzone === 'number' && Number.isFinite(pad.deadzone)) {
      out.pad.deadzone = Math.min(0.4, Math.max(0, pad.deadzone));
    }
    if (typeof pad.curve === 'number' && Number.isFinite(pad.curve)) {
      out.pad.curve = Math.min(3, Math.max(1, pad.curve));
    }
    if (typeof pad.triggerThreshold === 'number' && Number.isFinite(pad.triggerThreshold)) {
      out.pad.triggerThreshold = Math.min(0.9, Math.max(0.1, pad.triggerThreshold));
    }
  }
  return out;
}

/** display label for a bound key */
export function keyLabel(k: string): string {
  const special: Record<string, string> = {
    ' ': 'SPACE',
    arrowleft: '◄',
    arrowright: '►',
    arrowup: '▲',
    arrowdown: '▼',
    shift: 'SHIFT',
    control: 'CTRL',
    alt: 'ALT',
    enter: 'ENTER',
    tab: 'TAB',
    backspace: 'BKSP',
  };
  return special[k] ?? k.toUpperCase();
}

const PAD_BUTTON_LABELS = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'BACK',
  'START',
  'LS',
  'RS',
  'D-UP',
  'D-DOWN',
  'D-LEFT',
  'D-RIGHT',
];

/** display label for a standard-mapping gamepad button index */
export function padButtonLabel(i: number): string {
  return PAD_BUTTON_LABELS[i] ?? `B${i}`;
}
