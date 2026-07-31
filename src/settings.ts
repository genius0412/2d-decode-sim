import type { GameId, GameLoadout, GameSettings } from './types';
import {
  DEFAULT_SPEC,
  coerceSpec,
  coerceAssists,
  coerceAutoPath,
  coerceStartPose,
  defaultAssistsFor,
  defaultAssistsByDrivetrain,
} from './sim/spawn';
import { START_POSES, MAX_SAVED_ROBOTS, MAX_SAVED_AUTOS, MAX_SAVED_STARTS_SUPPORTER } from './config';
import { CHAIN_START_POSES } from './games/chain/config';
import type { StartSel, StartPose } from './types';

/** how many named start anchors a game has (for clamping startIndex per game) */
const startPoseCount = (game: GameId): number =>
  game === 'chain' ? CHAIN_START_POSES.length : START_POSES.length;
import { cloneBindings, DEFAULT_BINDINGS, mergeBindings } from './input/bindings';
import { clamp } from './math';

const STORAGE_KEY = 'decodesim.settings.v1';

/** default touch-control layout (centres as viewport fractions), tuned for landscape:
 * drive stick bottom-left, turn stick bottom-right, action buttons clustered on the
 * right above the turn stick. Editable + persisted per device. */
export const DEFAULT_MOBILE_LAYOUT: GameSettings['mobileLayout'] = {
  drive: { x: 0.13, y: 0.74 },
  turn: { x: 0.87, y: 0.74 },
  shoot: { x: 0.9, y: 0.44 },
  intake: { x: 0.74, y: 0.44 },
  catalyst: { x: 0.82, y: 0.29 },
  scale: 1,
};

export function defaultSettings(): GameSettings {
  return {
    game: 'decode',
    mode: 'match',
    alliance: 'blue',
    // active assists = the default spec's drivetrain slot; library = per-drivetrain defaults
    assists: defaultAssistsFor(DEFAULT_SPEC.drivetrain),
    assistsByDrivetrain: defaultAssistsByDrivetrain(),
    spec: { ...DEFAULT_SPEC },
    savedRobots: [],
    savedAutos: [],
    startIndex: 0,
    startCat: 'close',
    savedStartPoses: { close: [], far: [] },
    // GATE (index 0, close) + AUDIENCE (index 1, far) are the default per-category picks
    startMemory: { close: { index: 0, pose: null }, far: { index: 1, pose: null } },
    practiceDummies: false,
    audio: {
      volume: { master: 1, game: 1, shoot: 1, intake: 1, gate: 1, beep: 1, alert: 1, voice: 1 },
      sounds: true,
      voice: true,
    },
    bindings: cloneBindings(DEFAULT_BINDINGS),
    autoPath: null, // Default to no auto path loaded
    autoPathEnabled: false, // Default to auto path disabled
    showEventLog: true,
    parkSpeedPct: 30,
    tankControlMode: 'normal',
    mobileLayout: cloneMobileLayout(DEFAULT_MOBILE_LAYOUT),
  };
}

function cloneMobileLayout(l: GameSettings['mobileLayout']): GameSettings['mobileLayout'] {
  return {
    drive: { ...l.drive },
    turn: { ...l.turn },
    shoot: { ...l.shoot },
    intake: { ...l.intake },
    catalyst: { ...l.catalyst },
    scale: l.scale,
  };
}

// ---- PER-GAME loadouts (robot build + saved robots + start positions) ---------

/** the game-specific slice of the settings (what `switchGame` archives + restores) */
function pickLoadout(s: GameSettings): GameLoadout {
  return {
    spec: s.spec,
    savedRobots: s.savedRobots,
    startIndex: s.startIndex,
    startPose: s.startPose ?? null,
    startCat: s.startCat,
    savedStartPoses: s.savedStartPoses,
    startMemory: s.startMemory,
  };
}

/** a fresh loadout for a game: its default robot + empty libraries */
function defaultLoadout(game: GameId): GameLoadout {
  const d = defaultSettings();
  return {
    spec: coerceSpec(DEFAULT_SPEC, DEFAULT_SPEC, game),
    savedRobots: [],
    startIndex: d.startIndex,
    startPose: null,
    startCat: d.startCat,
    savedStartPoses: { close: [], far: [] },
    startMemory: d.startMemory,
  };
}

/** validate an archived loadout (spec + saved robots clamped for THAT game; start fields
 * light-checked). Written from already-clean data, so this mostly guards a hand-edited store. */
function coerceLoadout(raw: unknown, game: GameId): GameLoadout {
  const d = defaultLoadout(game);
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const saves = (x: unknown): StartPose[] =>
    Array.isArray(x)
      // capped at the SUPPORTER ceiling, never the free one — see the comment on
      // MAX_SAVED_STARTS_SUPPORTER. Slicing to 2 here would delete a paying
      // supporter's saved poses on any load before the entitlement resolves.
      ? x.map((p) => coerceStartPose(p)).filter((p): p is StartPose => p !== null).slice(0, MAX_SAVED_STARTS_SUPPORTER)
      : [];
  const sp = typeof r.savedStartPoses === 'object' && r.savedStartPoses !== null
    ? (r.savedStartPoses as Record<string, unknown>)
    : {};
  return {
    spec: r.spec !== undefined ? coerceSpec(r.spec, DEFAULT_SPEC, game) : d.spec,
    savedRobots: Array.isArray(r.savedRobots)
      ? r.savedRobots.slice(0, MAX_SAVED_ROBOTS).map((x) => coerceSpec(x, undefined, game))
      : d.savedRobots,
    startIndex: typeof r.startIndex === 'number' && Number.isFinite(r.startIndex)
      ? clamp(Math.round(r.startIndex), 0, startPoseCount(game) - 1)
      : d.startIndex,
    startPose: r.startPose == null ? null : coerceStartPose(r.startPose),
    startCat: r.startCat === 'far' ? 'far' : 'close',
    savedStartPoses: { close: saves(sp.close), far: saves(sp.far) },
    startMemory: d.startMemory,
  };
}

/** switch the ACTIVE game, swapping the flat robot/start fields to that game's OWN copy
 * (archiving the game we're leaving first) so saved robots + start positions never bleed
 * across games. Active assists follow the restored robot's drivetrain slot. */
export function switchGame(s: GameSettings, game: GameId): GameSettings {
  if (game === s.game) return s;
  const loadouts: Partial<Record<GameId, GameLoadout>> = { ...(s.loadouts ?? {}) };
  loadouts[s.game] = pickLoadout(s); // archive the game we're leaving
  const restore = loadouts[game] ?? defaultLoadout(game); // restore the one we enter
  delete loadouts[game]; // it becomes the active (flat) copy, not an archive entry
  return {
    ...s,
    game,
    loadouts,
    ...restore,
    assists: s.assistsByDrivetrain[restore.spec.drivetrain] ?? s.assists,
  };
}

type AudioVolume = GameSettings['audio']['volume'];

/** the legacy ON/OFF pair an older client would read, derived from the levels.
 * Seven categories can't map onto two switches exactly — `sounds` mirrors the old
 * master switch (is ANY audio audible) and `voice` the old voice-lines toggle. */
function audioMirrors(av: AudioVolume): { sounds: boolean; voice: boolean } {
  const anyEffect =
    av.game > 0 || av.shoot > 0 || av.intake > 0 || av.gate > 0 || av.beep > 0 || av.alert > 0;
  return {
    sounds: av.master > 0 && (anyEffect || av.voice > 0),
    voice: av.master > 0 && av.voice > 0,
  };
}

/** Re-derive the legacy mirrors after a settings EDIT. `coerceSettings` does this
 * on every load, but a slider drag writes the live object straight to localStorage
 * and the account without passing through coerce — so App's `update()` (the one
 * choke point feeding both) runs this to keep the persisted blob consistent for
 * old clients. Returns `s` unchanged when the mirrors already agree. */
export function syncAudioMirrors(s: GameSettings): GameSettings {
  const m = audioMirrors(s.audio.volume);
  if (s.audio.sounds === m.sounds && s.audio.voice === m.voice) return s;
  return { ...s, audio: { ...s.audio, ...m } };
}

/** validate an arbitrary settings object field by field — anything stale,
 * missing, or corrupt falls back to its default. Shared by the localStorage
 * load and the per-account (server) load, so both paths sanitize identically. */
export function coerceSettings(raw: unknown): GameSettings {
  const out = defaultSettings();
  try {
    if (typeof raw !== 'object' || raw === null) return out;
    const s = raw as Record<string, unknown>;
    if (s.game === 'decode' || s.game === 'chain') out.game = s.game;
    if (s.mode === 'match' || s.mode === 'free') out.mode = s.mode;
    if (s.alliance === 'red' || s.alliance === 'blue') out.alliance = s.alliance;
    // assists + spec share ONE validation path with the server (coerceAssists /
    // coerceSpec in sim/spawn): a hand-edited localStorage spec is clamped to the
    // same legal ranges as a spoofed wire spec, so both surfaces agree exactly.
    // Spec is coerced FIRST because its drivetrain decides the active-assist fallback.
    if (s.spec !== undefined) out.spec = coerceSpec(s.spec, out.spec, out.game);
    // per-drivetrain assist library: each slot coerced against its own drivetrain default
    const dfltByDt = defaultAssistsByDrivetrain();
    const hadByDt = typeof s.assistsByDrivetrain === 'object' && s.assistsByDrivetrain !== null;
    const rawByDt = hadByDt ? (s.assistsByDrivetrain as Record<string, unknown>) : {};
    out.assistsByDrivetrain = {
      mecanum: coerceAssists(rawByDt.mecanum, dfltByDt.mecanum),
      tank: coerceAssists(rawByDt.tank, dfltByDt.tank),
      swerve: coerceAssists(rawByDt.swerve, dfltByDt.swerve),
      xdrive: coerceAssists(rawByDt.xdrive, dfltByDt.xdrive),
    };
    // active assists: an explicitly-stored value wins; else this drivetrain's slot
    out.assists = coerceAssists(s.assists, out.assistsByDrivetrain[out.spec.drivetrain]);
    // migration: an old save with no per-drivetrain library seeds the active
    // drivetrain's slot from its stored active assists, so the choice survives a
    // drivetrain round-trip (other drivetrains get the new defaults)
    if (!hadByDt && s.assists !== undefined) {
      out.assistsByDrivetrain[out.spec.drivetrain] = { ...out.assists };
    }
    // saved libraries: validate each entry through the same coercers, cap the count
    if (Array.isArray(s.savedRobots)) {
      out.savedRobots = s.savedRobots.slice(0, MAX_SAVED_ROBOTS).map((r) => coerceSpec(r, undefined, out.game));
    }
    if (Array.isArray(s.savedAutos)) {
      out.savedAutos = s.savedAutos
        .map((a) => coerceAutoPath(a))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .slice(0, MAX_SAVED_AUTOS);
    }
    if (typeof s.startIndex === 'number') {
      out.startIndex = clamp(Math.round(s.startIndex), 0, startPoseCount(out.game) - 1);
    }
    // custom start pose: structural + field-bounds only here (G304 legality is
    // enforced spec+alliance-aware at spawn via coerceSetup). null ⇒ use preset.
    if ('startPose' in s) out.startPose = s.startPose == null ? null : coerceStartPose(s.startPose);
    if (s.startCat === 'close' || s.startCat === 'far') out.startCat = s.startCat;
    // saved start-position library: coerce each pose, cap per category
    const coerceSaves = (raw: unknown): StartPose[] =>
      Array.isArray(raw)
        ? raw.map((p) => coerceStartPose(p)).filter((p): p is StartPose => p !== null).slice(0, MAX_SAVED_STARTS_SUPPORTER)
        : [];
    if (typeof s.savedStartPoses === 'object' && s.savedStartPoses !== null) {
      const sp = s.savedStartPoses as Record<string, unknown>;
      out.savedStartPoses = { close: coerceSaves(sp.close), far: coerceSaves(sp.far) };
    }
    // per-category memory: clamp index, coerce pose
    const coerceSel = (raw: unknown, fallback: StartSel): StartSel => {
      if (typeof raw !== 'object' || raw === null) return fallback;
      const r = raw as Record<string, unknown>;
      const index = typeof r.index === 'number' && Number.isFinite(r.index)
        ? clamp(Math.round(r.index), -1, startPoseCount(out.game) - 1)
        : fallback.index;
      const pose = r.pose == null ? null : coerceStartPose(r.pose);
      return { index, pose };
    };
    if (typeof s.startMemory === 'object' && s.startMemory !== null) {
      const m = s.startMemory as Record<string, unknown>;
      out.startMemory = {
        close: coerceSel(m.close, out.startMemory.close),
        far: coerceSel(m.far, out.startMemory.far),
      };
    }
    // the NON-active games' archived loadouts (robot + saved robots + start positions), so a
    // game switch restores that game's own build/library. The active game lives in the flat
    // fields above and is never kept in the archive.
    if (typeof s.loadouts === 'object' && s.loadouts !== null) {
      const lo = s.loadouts as Record<string, unknown>;
      const archive: Partial<Record<GameId, GameLoadout>> = {};
      for (const g of ['decode', 'chain'] as GameId[]) {
        if (g !== out.game && lo[g] !== undefined) archive[g] = coerceLoadout(lo[g], g);
      }
      out.loadouts = archive;
    }
    if (typeof s.practiceDummies === 'boolean') out.practiceDummies = s.practiceDummies;
    if (typeof s.audio === 'object' && s.audio !== null) {
      const au = s.audio as Record<string, unknown>;
      const vol = au.volume;
      if (typeof vol === 'object' && vol !== null) {
        const v = vol as Record<string, unknown>;
        // MIGRATION: `sfx` was one level behind a slider labelled "Beeping" that
        // actually drove the shooter, the intake, the gate AND the countdown beep.
        // Seed all four from it FIRST, so a player who had turned it down keeps that
        // choice, then let any explicit new key override.
        const legacy = v.sfx;
        if (typeof legacy === 'number' && Number.isFinite(legacy)) {
          const n = clamp(legacy, 0, 1);
          out.audio.volume.shoot = n;
          out.audio.volume.intake = n;
          out.audio.volume.gate = n;
          out.audio.volume.beep = n;
        }
        for (const k of ['master', 'game', 'shoot', 'intake', 'gate', 'beep', 'alert', 'voice'] as const) {
          const n = v[k];
          if (typeof n === 'number' && Number.isFinite(n)) out.audio.volume[k] = clamp(n, 0, 1);
        }
      } else {
        // LEGACY boolean-only shape: a pre-slider save, or a blob that round-tripped
        // through an old client (which drops `volume` when it saves). Map the two
        // switches onto levels so nobody's deliberate mute comes back un-muted.
        if (au.sounds === false) out.audio.volume.master = 0;
        if (au.voice === false) out.audio.volume.voice = 0;
      }
    }
    // re-derive the legacy mirrors from the levels every time, so they can never
    // drift from the sliders (see the `audio` type for why they still exist)
    Object.assign(out.audio, audioMirrors(out.audio.volume));
    if (typeof s.showEventLog === 'boolean') out.showEventLog = s.showEventLog;
    if (typeof s.parkSpeedPct === 'number') {
      out.parkSpeedPct = clamp(Math.round(s.parkSpeedPct), 0, 100);
    }
    if (typeof s.preferredServerId === 'string') {
      out.preferredServerId = s.preferredServerId;
    }
    if (s.tankControlMode === 'traditional' || s.tankControlMode === 'normal') {
      out.tankControlMode = s.tankControlMode;
    }
    if (typeof s.mobileLayout === 'object' && s.mobileLayout !== null) {
      const ml = s.mobileLayout as Record<string, unknown>;
      const pos = (raw: unknown, def: { x: number; y: number }): { x: number; y: number } => {
        if (typeof raw !== 'object' || raw === null) return { ...def };
        const p = raw as Record<string, unknown>;
        return {
          x: typeof p.x === 'number' ? clamp(p.x, 0, 1) : def.x,
          y: typeof p.y === 'number' ? clamp(p.y, 0, 1) : def.y,
        };
      };
      out.mobileLayout = {
        drive: pos(ml.drive, DEFAULT_MOBILE_LAYOUT.drive),
        turn: pos(ml.turn, DEFAULT_MOBILE_LAYOUT.turn),
        shoot: pos(ml.shoot, DEFAULT_MOBILE_LAYOUT.shoot),
        intake: pos(ml.intake, DEFAULT_MOBILE_LAYOUT.intake),
        catalyst: pos(ml.catalyst, DEFAULT_MOBILE_LAYOUT.catalyst),
        scale: typeof ml.scale === 'number' ? clamp(ml.scale, 0.7, 1.5) : 1,
      };
    }
    out.bindings = mergeBindings(s.bindings);

    // Load autoPath and autoPathEnabled (validated + field-clamped by coerceAutoPath)
    const autoPath = coerceAutoPath(s.autoPath);
    if (autoPath) {
      out.autoPath = autoPath;
      // If autoPathEnabled is not explicitly set or is invalid, enable it if a path is loaded
      if (typeof s.autoPathEnabled === 'boolean') {
        out.autoPathEnabled = s.autoPathEnabled;
      } else {
        out.autoPathEnabled = true;
      }
    } else {
      out.autoPath = null;
      out.autoPathEnabled = false;
    }

  } catch {
    /* corrupt data — defaults */
  }
  return out;
}

/** load persisted settings from localStorage (validated field by field) */
export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    return coerceSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable — settings just won't persist */
  }
}