import { useEffect, useReducer, useRef, useState } from 'react';
import type { InputManager } from '../input/input';
import type { GameId, MobileLayout, MobilePos } from '../types';

// base radii (px, BEFORE the layout scale) — the visible ring + the handle travel.
const JOY_R = 58;
const MAX_RADIUS = 52;

type Which = 'drive' | 'turn';
interface StickRT {
  active: boolean;
  touchId: number | null;
  bx: number; // base centre (screen px) while active
  by: number;
  hx: number; // handle offset from base
  hy: number;
}
const idleStick = (): StickRT => ({ active: false, touchId: null, bx: 0, by: 0, hx: 0, hy: 0 });

/** viewport size, re-read on resize + orientation change (fractions → px). */
function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 800,
    h: typeof window !== 'undefined' ? window.innerHeight : 600,
  }));
  useEffect(() => {
    const on = (): void => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return vp;
}

/** one action button (fire / intake / catalyst). Hold-style in play; draggable in edit. */
function ActionButton({
  label,
  glyph,
  cls,
  size,
  left,
  top,
  editing,
  onDown,
  onUp,
  onDrag,
  onDragEnd,
}: {
  label: string;
  glyph: string;
  cls: string;
  size: number;
  left: number;
  top: number;
  editing: boolean;
  onDown: () => void;
  onUp: () => void;
  onDrag: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  const dragging = useRef(false);
  const style: React.CSSProperties = {
    left,
    top,
    width: size,
    height: size,
    fontSize: cls === 'shoot' ? 12 : 11,
  };
  if (editing) {
    return (
      <button
        type="button"
        className={`mobile-btn ${cls} editing`}
        style={style}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragging.current) onDrag(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
          onDragEnd();
        }}
        aria-label={`${label} (drag to move)`}
      >
        <span className="mb-ico" aria-hidden>
          {glyph}
        </span>
        <span className="mb-lbl">{label}</span>
      </button>
    );
  }
  const down = (e: React.TouchEvent): void => {
    e.stopPropagation();
    setPressed(true);
    onDown();
  };
  const up = (e: React.TouchEvent): void => {
    e.stopPropagation();
    setPressed(false);
    onUp();
  };
  return (
    <button
      type="button"
      className={`mobile-btn ${cls}${pressed ? ' pressed' : ''}`}
      style={style}
      onTouchStart={down}
      onTouchEnd={up}
      onTouchCancel={up}
      aria-label={label}
    >
      <span className="mb-ico" aria-hidden>
        {glyph}
      </span>
      <span className="mb-lbl">{label}</span>
    </button>
  );
}

export function MobileControls({
  inputManager,
  game,
  layout,
  editing = false,
  autoIntake = false,
  autoFire = false,
  hasFling = false,
  onLayoutChange,
}: {
  inputManager: InputManager;
  /** the active game — the catalyst buttons only apply to Chain Reaction */
  game?: GameId;
  /** the local robot's live assists: a button for an action the ROBOT is doing for you is
   * dead weight on a screen this small, so it is not drawn while its assist is on. */
  autoIntake?: boolean;
  autoFire?: boolean;
  /** Chain Reaction: this build's catalyst has a CATAPULT, so the THROW button applies */
  hasFling?: boolean;
  /** editable touch-control layout (centres as viewport fractions) */
  layout: MobileLayout;
  /** edit mode: drag controls to reposition instead of driving */
  editing?: boolean;
  /** called (on drag release) with the new layout to persist */
  onLayoutChange?: (l: MobileLayout) => void;
}) {
  const vp = useViewport();
  const scale = layout.scale;

  // live-editable working copy while in edit mode (persist on release)
  const [edit, setEdit] = useState<MobileLayout>(layout);
  useEffect(() => {
    setEdit(layout);
  }, [layout, editing]);
  const L = editing ? edit : layout;
  const toPx = (p: MobilePos): { x: number; y: number } => ({ x: p.x * vp.w, y: p.y * vp.h });

  // joystick runtime lives in a ref (touch matching) + a force-render tick
  const sticks = useRef<{ drive: StickRT; turn: StickRT }>({ drive: idleStick(), turn: idleStick() });
  const [, force] = useReducer((n: number) => n + 1, 0);

  const maxR = MAX_RADIUS * scale;

  const onTouchStart = (e: React.TouchEvent): void => {
    if (editing) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.clientY < vp.h * 0.3) continue; // leave the top strip for chips / menu
      const which: Which = t.clientX < vp.w / 2 ? 'drive' : 'turn';
      const st = sticks.current[which];
      if (st.active) continue; // that stick already owns a finger
      sticks.current[which] = { active: true, touchId: t.identifier, bx: t.clientX, by: t.clientY, hx: 0, hy: 0 };
    }
    force();
  };

  const onTouchMove = (e: React.TouchEvent): void => {
    if (editing) return;
    for (let i = 0; i < e.touches.length; i++) {
      const t = e.touches[i];
      for (const which of ['drive', 'turn'] as Which[]) {
        const st = sticks.current[which];
        if (st.touchId !== t.identifier) continue;
        let dx = t.clientX - st.bx;
        let dy = t.clientY - st.by;
        const d = Math.hypot(dx, dy);
        if (d > maxR) {
          dx = (dx / d) * maxR;
          dy = (dy / d) * maxR;
        }
        st.hx = dx;
        st.hy = dy;
        const nx = dx / maxR;
        const ny = dy / maxR;
        if (which === 'drive') inputManager.setVirtualInput({ driveX: nx, driveY: -ny });
        else inputManager.setVirtualInput({ rotate: -nx });
      }
    }
    force();
  };

  const onTouchEnd = (e: React.TouchEvent): void => {
    if (editing) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      for (const which of ['drive', 'turn'] as Which[]) {
        if (sticks.current[which].touchId !== t.identifier) continue;
        if (which === 'drive') inputManager.setVirtualInput({ driveX: 0, driveY: 0 });
        else inputManager.setVirtualInput({ rotate: 0 });
        sticks.current[which] = idleStick();
      }
    }
    force();
  };

  // drag a control's HOME position in edit mode (clamped on-screen, persisted on release)
  const dragControl = (name: keyof MobileLayout, clientX: number, clientY: number): void => {
    if (name === 'scale') return;
    const x = Math.max(0.04, Math.min(0.96, clientX / vp.w));
    const y = Math.max(0.06, Math.min(0.94, clientY / vp.h));
    setEdit((prev) => ({ ...prev, [name]: { x, y } }));
  };
  const commit = (): void => onLayoutChange?.(edit);

  // ---- joystick render (base always visible at home; floats to the finger) ----
  const joystick = (which: Which, home: MobilePos): React.ReactNode => {
    const st = sticks.current[which];
    const h = toPx(home);
    const cx = st.active ? st.bx : h.x;
    const cy = st.active ? st.by : h.y;
    const r = JOY_R * scale;
    const dragHandlers = editing
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation();
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          },
          onPointerMove: (e: React.PointerEvent) => {
            if (e.buttons || e.pressure > 0) dragControl(which, e.clientX, e.clientY);
          },
          onPointerUp: (e: React.PointerEvent) => {
            (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
            commit();
          },
        }
      : {};
    return (
      <div
        key={which}
        className={`mobile-joystick-base${st.active ? ' active' : ''}${editing ? ' editing' : ''}`}
        style={{ left: cx, top: cy, width: r * 2, height: r * 2 }}
        {...dragHandlers}
      >
        <div className="mobile-joystick-label">{which === 'drive' ? 'DRIVE' : 'TURN'}</div>
        <div
          className="mobile-joystick-handle"
          style={{
            width: r * 0.72,
            height: r * 0.72,
            transform: `translate(${st.hx}px, ${st.hy}px)`,
          }}
        />
      </div>
    );
  };

  const btnSize = (primary: boolean): number => (primary ? 82 : 62) * scale;
  const chain = game === 'chain';
  /**
   * The action buttons.
   *
   * `auto` marks one the ROBOT is currently handling itself. Those are HIDDEN in play —
   * a button that does nothing is worse than no button on a screen this size, where the
   * pad is competing with the field for room — but still drawn (ghosted) in EDIT mode, so
   * the layout stays fully arrangeable whatever the assists happen to be set to right now.
   *
   * `absent` marks one this build simply does not have — a DECODE robot has no catalyst,
   * a claw-only catalyst has nothing to throw — and those are never drawn at all.
   */
  interface ActionSpec {
    name: keyof MobileLayout;
    label: string;
    glyph: string;
    cls: string;
    primary: boolean;
    field: 'intake' | 'fire' | 'catalyst' | 'fling';
    absent?: boolean;
    auto?: boolean;
  }
  const buttons: ActionSpec[] = ([
    { name: 'intake', label: 'INTAKE', glyph: '▼', cls: 'intake', primary: false, field: 'intake', auto: autoIntake },
    { name: 'catalyst', label: 'CATALYST', glyph: '⬡', cls: 'catalyst', primary: false, field: 'catalyst', absent: !chain },
    { name: 'fling', label: 'THROW', glyph: '⤴', cls: 'fling', primary: false, field: 'fling', absent: !chain || !hasFling },
    { name: 'shoot', label: 'SHOOT', glyph: '◎', cls: 'shoot', primary: true, field: 'fire', auto: autoFire },
  ] as ActionSpec[]).filter((b) => !b.absent && (editing || !b.auto));

  return (
    <>
      {/* LOW-Z full-screen touch capture (below the HUD, so MENU/chips still work).
          Disabled in edit mode so the draggable controls own the pointer. */}
      <div
        className="mobile-touch"
        style={{ pointerEvents: editing ? 'none' : 'auto' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      />
      {/* HIGH-Z visuals + buttons (above the scorebar, so nothing occludes them).
          pointer-events:none except the interactive children. */}
      <div className="mobile-overlay">
        {joystick('drive', L.drive)}
        {joystick('turn', L.turn)}
        {buttons.map((b) => {
          const p = toPx(L[b.name] as MobilePos);
          const size = btnSize(b.primary);
          return (
            <ActionButton
              key={b.name}
              label={b.auto ? `${b.label} (automatic)` : b.label}
              glyph={b.glyph}
              cls={`${b.cls}${b.auto ? ' auto' : ''}`}
              size={size}
              left={p.x}
              top={p.y}
              editing={editing}
              onDown={() => inputManager.setVirtualInput({ [b.field]: true } as never)}
              onUp={() => inputManager.setVirtualInput({ [b.field]: false } as never)}
              onDrag={(cx, cy) => dragControl(b.name, cx, cy)}
              onDragEnd={commit}
            />
          );
        })}
      </div>
    </>
  );
}
