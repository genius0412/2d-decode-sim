import { useEffect, useState } from 'react';
import {
  KEY_ACTIONS,
  PAD_ACTIONS,
  DEFAULT_BINDINGS,
  cloneBindings,
  keyLabel,
  padButtonLabel,
  type ControlBindings,
  type KeyAction,
  type PadAction,
} from '../input/bindings';
import { rangeFill } from './rangeFill';

const KEY_LABELS: Record<KeyAction, string> = {
  driveUp: 'Drive forward',
  driveDown: 'Drive back',
  driveLeft: 'Strafe left',
  driveRight: 'Strafe right',
  rotateCCW: 'Turn left',
  rotateCW: 'Turn right',
  intake: 'Intake (hold)',
  fire: 'Shoot (hold)',
  catalyst: 'Ring pick up / place (Chain Reaction)',
  flipFront: 'Flip front',
  park: 'Toggle park mode',
  start: 'Start match',
  restart: 'Restart',
};

const PAD_LABELS: Record<PadAction, string> = {
  fire: 'Shoot',
  intake: 'Intake',
  catalyst: 'Ring pick up / place',
  flipFront: 'Flip front',
  park: 'Toggle park mode',
  start: 'Start match',
  restart: 'Restart',
};

type Capture =
  | { kind: 'key'; action: KeyAction; slot: number }
  | { kind: 'pad'; action: PadAction; slot: number };

/** a rebound key is removed from every other action it was assigned to */
function assignKey(b: ControlBindings, action: KeyAction, slot: number, key: string): ControlBindings {
  const next = cloneBindings(b);
  for (const a of KEY_ACTIONS) next.keys[a] = next.keys[a].filter((k) => k !== key);
  const list = next.keys[action];
  if (slot < list.length) list[slot] = key;
  else list.push(key);
  return next;
}

function assignPadButton(b: ControlBindings, action: PadAction, slot: number, idx: number): ControlBindings {
  const next = cloneBindings(b);
  for (const a of PAD_ACTIONS) next.pad.buttons[a] = next.pad.buttons[a].filter((i) => i !== idx);
  const list = next.pad.buttons[action];
  if (slot < list.length) list[slot] = idx;
  else list.push(idx);
  return next;
}

interface Props {
  bindings: ControlBindings;
  onChange: (b: ControlBindings) => void;
  /** launch Free Drive with the on-screen touch-control layout editor open */
  onEditTouchControls: () => void;
}

export function ControlsSection({ bindings, onChange, onEditTouchControls }: Props) {
  const [capture, setCapture] = useState<Capture | null>(null);

  // keyboard capture: next keydown becomes the binding; Escape cancels
  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapture(null);
        return;
      }
      if (capture.kind === 'key') {
        onChange(assignKey(bindings, capture.action, capture.slot, e.key.toLowerCase()));
        setCapture(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture, bindings, onChange]);

  // gamepad capture: poll for a button that goes down AFTER capture starts
  useEffect(() => {
    if (!capture || capture.kind !== 'pad') return;
    const { action, slot } = capture;
    const alreadyDown = new Set<number>();
    let first = true;
    let done = false;
    let raf = 0;
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = Array.from(pads).find((p) => p && p.connected);
      if (pad) {
        for (let i = 0; i < pad.buttons.length; i++) {
          const pressed = pad.buttons[i].pressed || pad.buttons[i].value > 0.5;
          if (pressed && first) alreadyDown.add(i);
          else if (pressed && !alreadyDown.has(i) && !done) {
            done = true;
            onChange(assignPadButton(bindings, action, slot, i));
            setCapture(null);
            return;
          } else if (!pressed) alreadyDown.delete(i);
        }
        first = false;
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [capture, bindings, onChange]);

  const keycap = (
    label: string,
    active: boolean,
    unbound: boolean,
    onClick: () => void,
    key?: number,
  ) => (
    <button
      key={key}
      className={`ds-key ${active ? 'capturing' : ''} ${unbound ? 'unbound' : ''}`}
      onClick={onClick}
    >
      {active ? 'PRESS…' : label}
    </button>
  );

  return (
    <section className="ds-sec">
      <h2>Controls</h2>
      <div className="ds-bind-block" style={{ marginBottom: 18 }}>
        <h3>Touch controls</h3>
        <button className="ds-btn" onClick={onEditTouchControls}>
          Customize touch controls
        </button>
      </div>
      <div className="ds-binds">
        <div className="ds-bind-block">
          <h3>Keyboard</h3>
          <div className="ds-bind-grid">
            {KEY_ACTIONS.map((a) => (
              <div className="ds-bind-row" key={a}>
                <span className="ds-bind-label">{KEY_LABELS[a]}</span>
                <span className="ds-keys">
                  {bindings.keys[a].map((k, i) =>
                    keycap(
                      keyLabel(k),
                      capture?.kind === 'key' && capture.action === a && capture.slot === i,
                      false,
                      () => setCapture({ kind: 'key', action: a, slot: i }),
                      i,
                    ),
                  )}
                  {bindings.keys[a].length === 0 &&
                    keycap(
                      'UNBOUND',
                      capture?.kind === 'key' && capture.action === a,
                      true,
                      () => setCapture({ kind: 'key', action: a, slot: 0 }),
                    )}
                </span>
              </div>
            ))}
            <div className="ds-bind-row">
              <span className="ds-bind-label">Menu</span>
              <span className="ds-keys">
                <span className="ds-key fixed">ESC</span>
              </span>
            </div>
          </div>
        </div>

        <div className="ds-bind-block">
          <h3>Gamepad</h3>
          <div className="ds-bind-grid">
            <div className="ds-bind-row">
              <span className="ds-bind-label">Drive stick</span>
              <span className="ds-keys">
                <button
                  className={`ds-key ${bindings.pad.driveStick === 'left' ? 'selected' : ''}`}
                  onClick={() =>
                    onChange({ ...cloneBindings(bindings), pad: { ...bindings.pad, driveStick: 'left' } })
                  }
                >
                  LEFT
                </button>
                <button
                  className={`ds-key ${bindings.pad.driveStick === 'right' ? 'selected' : ''}`}
                  onClick={() =>
                    onChange({ ...cloneBindings(bindings), pad: { ...bindings.pad, driveStick: 'right' } })
                  }
                >
                  RIGHT
                </button>
              </span>
            </div>
            <div className="ds-bind-row">
              <span className="ds-bind-label">Turn stick</span>
              <span className="ds-keys">
                <span className="ds-key fixed">
                  {bindings.pad.driveStick === 'left' ? 'RIGHT (X axis)' : 'LEFT (X axis)'}
                </span>
              </span>
            </div>
            <div className="ds-bind-row">
              <span className="ds-bind-label">Stick deadzone {Math.round(bindings.pad.deadzone * 100)}%</span>
              <input
                type="range"
                min={0}
                max={0.4}
                step={0.01}
                value={bindings.pad.deadzone}
                style={rangeFill(bindings.pad.deadzone, 0, 0.4)}
                onChange={(e) =>
                  onChange({ ...cloneBindings(bindings), pad: { ...bindings.pad, deadzone: Number(e.target.value) } })
                }
              />
            </div>
            <div className="ds-bind-row">
              <span className="ds-bind-label">
                Sensitivity curve {bindings.pad.curve.toFixed(1)}
                {bindings.pad.curve === 1 ? ' (linear)' : ''}
              </span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.1}
                value={bindings.pad.curve}
                style={rangeFill(bindings.pad.curve, 1, 3)}
                onChange={(e) =>
                  onChange({ ...cloneBindings(bindings), pad: { ...bindings.pad, curve: Number(e.target.value) } })
                }
              />
            </div>
            <div className="ds-bind-row">
              <span className="ds-bind-label">
                Trigger threshold {Math.round(bindings.pad.triggerThreshold * 100)}%
              </span>
              <input
                type="range"
                min={0.1}
                max={0.9}
                step={0.05}
                value={bindings.pad.triggerThreshold}
                style={rangeFill(bindings.pad.triggerThreshold, 0.1, 0.9)}
                onChange={(e) =>
                  onChange({
                    ...cloneBindings(bindings),
                    pad: { ...bindings.pad, triggerThreshold: Number(e.target.value) },
                  })
                }
              />
            </div>
            {PAD_ACTIONS.map((a) => (
              <div className="ds-bind-row" key={a}>
                <span className="ds-bind-label">{PAD_LABELS[a]}</span>
                <span className="ds-keys">
                  {bindings.pad.buttons[a].map((idx, i) =>
                    keycap(
                      padButtonLabel(idx),
                      capture?.kind === 'pad' && capture.action === a && capture.slot === i,
                      false,
                      () => setCapture({ kind: 'pad', action: a, slot: i }),
                      i,
                    ),
                  )}
                  {bindings.pad.buttons[a].length === 0 &&
                    keycap(
                      'UNBOUND',
                      capture?.kind === 'pad' && capture.action === a,
                      true,
                      () => setCapture({ kind: 'pad', action: a, slot: 0 }),
                    )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="ds-bind-foot">
        <button className="ds-btn" onClick={() => onChange(cloneBindings(DEFAULT_BINDINGS))}>
          RESET TO DEFAULTS
        </button>
      </div>
    </section>
  );
}
