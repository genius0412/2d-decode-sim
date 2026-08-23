/**
 * IS THIS KEYSTROKE GOING INTO A TEXT FIELD?
 *
 * The game listens on `window`, so every keystroke anywhere on the page reached the robot —
 * including the ones being typed into the post-match report's "what happened" box. Two
 * things went wrong at once there: the letters bound to actions fired those actions while
 * you typed, and SPACE (always in `preventKeys`, so the page does not scroll under a driver)
 * had its default suppressed, which means the space bar did not type a space at all.
 * "I can't type properly in the report a player menu because some keys are counted as game
 * control."
 *
 * A field with focus owns the keyboard. That is the whole rule, and it is the browser's own:
 * text inputs, textareas, selects and anything contenteditable. Buttons and checkboxes are
 * NOT typing — a driver tabbing onto a HUD button should still be able to drive.
 */
function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(
    type,
  );
}

/** tracks held keys and edge-triggered presses */
export class Keyboard {
  private down = new Set<string>();
  private pressed = new Set<string>();
  /** keys whose browser default (scroll etc.) is suppressed — kept in sync
   * with the active bindings so any bound key works cleanly */
  private preventKeys = new Set<string>([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

  setPreventKeys(keys: Iterable<string>): void {
    this.preventKeys = new Set([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    for (const k of keys) this.preventKeys.add(k);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (typingInto(e.target)) {
      // ...and anything already held is RELEASED, so clicking into a field mid-drive does not
      // leave the robot pinned on the last key down (the same reason `onBlur` clears).
      this.down.clear();
      this.pressed.clear();
      return;
    }
    const k = e.key.toLowerCase();
    if (!e.repeat) this.pressed.add(k);
    this.down.add(k);
    if (this.preventKeys.has(k)) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // NOT guarded by `typingInto`: a key can go down on the field and come up somewhere else
    // (or the other way round), and a release must always be honoured — the failure mode of
    // missing one is a key stuck down forever.
    this.down.delete(e.key.toLowerCase());
  };

  /** focus moving INTO a field releases everything, so a held key does not survive the
   * transition — you click the box while driving forward and the robot stops. */
  private onFocusIn = (e: FocusEvent): void => {
    if (!typingInto(e.target)) return;
    this.down.clear();
    this.pressed.clear();
  };

  private onBlur = (): void => {
    this.down.clear();
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focusin', this.onFocusIn);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focusin', this.onFocusIn);
  }

  held(key: string): boolean {
    return this.down.has(key);
  }

  /** true once per physical key press; consumed on read */
  justPressed(key: string): boolean {
    if (this.pressed.has(key)) {
      this.pressed.delete(key);
      return true;
    }
    return false;
  }

  /** drop un-consumed presses at the end of the frame */
  endFrame(): void {
    this.pressed.clear();
  }
}
