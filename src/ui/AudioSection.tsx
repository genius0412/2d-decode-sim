import { useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { MatchAudio } from '../audio';
import { loadThemePref, setThemePref, type ThemePref } from '../theme';
import { rangeFill } from './rangeFill';

/**
 * One volume category. Auditions on RELEASE (pointer-up / key-up), never on
 * `onChange` — a drag fires change on every step and would stutter the preview
 * over itself. `muted` greys the value when master is at 0, so a row reading
 * "80%" while nothing plays doesn't look like a bug.
 */
function VolumeRow({
  label,
  value,
  onChange,
  onAudition,
  muted = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onAudition: () => void;
  muted?: boolean;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="ds-field">
      <span className="cap">
        {label}{' '}
        <span className="val" style={muted ? { color: 'var(--ds-mut)' } : undefined}>
          {pct}%
        </span>
      </span>
      <input
        className="ds-range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        style={rangeFill(pct, 0, 100)}
        aria-label={label}
        aria-valuetext={`${pct}%`}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onPointerUp={onAudition}
        onKeyUp={onAudition}
      />
    </label>
  );
}

const THEMES: { id: ThemePref; title: string }[] = [
  { id: 'system', title: 'System' },
  { id: 'light', title: 'Light' },
  { id: 'dark', title: 'Dark' },
];

/**
 * Audio and Visual preferences.
 *
 * The theme is NOT part of `GameSettings` (which syncs to Postgres per account and is
 * read after first paint) — it lives in its own localStorage key via `src/theme.ts`.
 * This component only renders the control; `setThemePref` owns persistence, stamping
 * `data-theme` on <html>, and arming/disarming the OS listener.
 *
 * The three theme buttons are TOGGLE BUTTONS (`aria-pressed`), not an ARIA radiogroup:
 * a radiogroup would owe us roving tabindex + arrow keys, and a partial pattern is worse
 * than none (the same trap as the old Records tablist — Phase 6, F6).
 */
export function AudioSection({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const vol = settings.audio.volume;
  const setVolume = (patch: Partial<GameSettings['audio']['volume']>) =>
    onChange({ ...settings, audio: { ...settings.audio, volume: { ...vol, ...patch } } });

  // own MatchAudio instance so a slider can AUDITION its category — the game
  // controller isn't up on this screen. Levels are pushed in on every render so
  // the preview always plays at what the slider currently reads.
  const audioRef = useRef<MatchAudio | null>(null);
  audioRef.current ??= new MatchAudio();
  const audio = audioRef.current;
  audio.masterVolume = vol.master;
  audio.gameVolume = vol.game;
  audio.sfxVolume = vol.sfx;
  audio.voiceVolume = vol.voice;

  const silent = vol.master <= 0;

  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref());
  const pickTheme = (pref: ThemePref): void => {
    setThemePref(pref); // persists + stamps <html data-theme> immediately
    setTheme(pref);
  };

  return (
    <>
      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Audio</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <VolumeRow
            label="Master"
            value={vol.master}
            onChange={(master) => setVolume({ master })}
            onAudition={() => audio.beep()}
          />
          <VolumeRow
            label="Game sounds"
            value={vol.game}
            muted={silent}
            onChange={(game) => setVolume({ game })}
            onAudition={() => audio.play('resume')}
          />
          <VolumeRow
            label="Beeping"
            value={vol.sfx}
            muted={silent}
            onChange={(sfx) => setVolume({ sfx })}
            onAudition={() => audio.sfxShoot()}
          />
          <VolumeRow
            label="Voice lines"
            value={vol.voice}
            muted={silent}
            onChange={(voice) => setVolume({ voice })}
            onAudition={() => audio.say('Volume', true)}
          />
          {silent && (
            <p className="ds-hint">Master is at 0% — everything is silent until you raise it.</p>
          )}
        </div>
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Visual</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="ds-opts three">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`ds-opt ${theme === t.id ? 'on' : ''}`}
                aria-pressed={theme === t.id}
                onClick={() => pickTheme(t.id)}
              >
                <span className="ot">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
