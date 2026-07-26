import type { GameId, GameSettings, StartCat, StartPose, StartSel } from '../types';
import type { LobbyPlayer } from '../net/protocol';
import { START_POSES, MAX_SAVED_STARTS } from '../config';
import { chainAnchorCat, chainDefaultIndex } from '../games/chain/config';

export const otherCat = (c: StartCat): StartCat => (c === 'close' ? 'far' : 'close');

/**
 * This player's locked 2v2 start role (CLOSE/FAR), GUARANTEEING the two alliance
 * members hold DISTINCT roles. Precedence:
 *  1. both members carry an explicit `startRole` and they differ → honour mine;
 *  2. only I'm explicit → mine;
 *  3. only my PARTNER is explicit → the OPPOSITE of theirs;
 *  4. neither explicit (or both explicit but IDENTICAL — a collision) → a
 *     deterministic positional split by clientId (first = close, second = far).
 *
 * Rule 3 fixes the swap→host-leave→rejoin bug: a lobby rejoin returns as a fresh
 * `join` with a NEW clientId and NO `startRole` (rejoin never reattaches a duo
 * lobby slot), so the rejoiner must take the opposite of its partner's RETAINED
 * swapped role — the old clientId-only sort ignored the partner and could land
 * both on the same role. Both clients compute this identically from the shared
 * roster, so they always converge on one close + one far. Returns undefined unless
 * exactly the alliance has ≥2 visible members.
 */
export function derivedRole(players: LobbyPlayer[], me: LobbyPlayer): StartCat | undefined {
  const allies = players
    .filter((p) => p.alliance === me.alliance && !p.hidden)
    .sort((a, b) => a.clientId.localeCompare(b.clientId));
  if (allies.length < 2) return undefined;
  const [first, second] = allies;
  const partner = first.clientId === me.clientId ? second : first;
  const mine = me.startRole;
  const theirs = partner.startRole;
  if (mine && theirs && mine !== theirs) return mine;
  if (mine && !theirs) return mine;
  if (!mine && theirs) return otherCat(theirs);
  return first.clientId === me.clientId ? 'close' : 'far';
}

/**
 * Pure helpers for the Close/Far start-position model shared by the editor and
 * its host screens. The ACTIVE start (`startIndex`/`startPose`) is what spawns /
 * travels on the wire; `startCat` picks the category, `savedStartPoses` is the
 * per-category library (≤ MAX_SAVED_STARTS each), and `startMemory` remembers the
 * last selection in each category so switching tabs restores it.
 */

export interface CatPreset {
  index: number;
  pose: StartPose;
  label: string;
}

/** the built-in presets belonging to a category, with their START_POSES index */
export function categoryPresets(cat: StartCat): CatPreset[] {
  const out: CatPreset[] = [];
  START_POSES.forEach((p, index) => {
    if (p.cat === cat) out.push({ index, pose: { x: p.x, y: p.y, headingDeg: p.headingDeg }, label: p.label });
  });
  return out;
}

/** the fallback preset index for a category (its first preset) — game-aware: CR maps
 * the category onto its TOP/BOTTOM Lab-corner anchors, DECODE onto its Close/Far presets. */
export function categoryDefaultIndex(cat: StartCat, game?: GameId): number {
  if (game === 'chain') return chainDefaultIndex(cat);
  return categoryPresets(cat)[0]?.index ?? 0;
}

/** the category a preset/anchor index belongs to (game-aware, see above) */
export function indexCategory(index: number, game?: GameId): StartCat {
  if (game === 'chain') return chainAnchorCat(index);
  return START_POSES[index]?.cat ?? 'close';
}

/** the ACTIVE start fields (startIndex/startPose) for a remembered selection */
function activeFromSel(cat: StartCat, sel: StartSel, game?: GameId): { startIndex: number; startPose: StartPose | null } {
  const index = sel.index >= 0 ? sel.index : categoryDefaultIndex(cat, game);
  return { startIndex: index, startPose: sel.pose };
}

/** patch: switch the active category, restoring that category's remembered pick */
export function switchCategory(s: GameSettings, cat: StartCat): Partial<GameSettings> {
  return { startCat: cat, ...activeFromSel(cat, s.startMemory[cat], s.game) };
}

/** patch: set the active start to `sel` within the CURRENT category + remember it */
export function selectStart(s: GameSettings, sel: StartSel): Partial<GameSettings> {
  const cat = s.startCat;
  return { ...activeFromSel(cat, sel, s.game), startMemory: { ...s.startMemory, [cat]: sel } };
}

/** patch: save a custom pose into the current category's library (cap, drop oldest) */
export function saveStart(s: GameSettings, pose: StartPose): Partial<GameSettings> {
  const cat = s.startCat;
  const list = [...s.savedStartPoses[cat], pose].slice(-MAX_SAVED_STARTS);
  return { savedStartPoses: { ...s.savedStartPoses, [cat]: list } };
}

/** patch: delete a saved pose from a category */
export function deleteSavedStart(s: GameSettings, cat: StartCat, i: number): Partial<GameSettings> {
  return {
    savedStartPoses: { ...s.savedStartPoses, [cat]: s.savedStartPoses[cat].filter((_, k) => k !== i) },
  };
}

/** are two poses effectively the same spot? (for highlighting the active pick) */
export function samePose(a: StartPose | null | undefined, b: StartPose | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05 && Math.abs(a.headingDeg - b.headingDeg) < 0.5;
}
