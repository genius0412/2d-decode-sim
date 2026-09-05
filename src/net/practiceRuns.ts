import type { GameId } from '../types';
import type { Replay, ReplayResult } from '../sim/replay';

/**
 * SOLO PRACTICE REPLAYS, kept on this device.
 *
 * Solo practice runs offline on the local sim — there is no authoritative server watching it,
 * which is exactly why it is not a leaderboard score and never will be. What it IS is the
 * player's own match, and the sim is deterministic, so the input log reproduces it exactly.
 * This is where that log lives until (and whether) it reaches the account.
 *
 * LOCAL FIRST, upload second, deliberately:
 *  - solo practice is the primary OFFLINE mode and works signed out. A run you can only keep
 *    by having an account would be a worse mode than the one that existed before.
 *  - the upload can fail (offline, cold server, no session) and a run must not evaporate
 *    because of it. `uploaded` records what the account already has; everything else is still
 *    watchable from here.
 *
 * Storage is an INDEX plus one entry per run rather than a single blob, because a replay is
 * tens of kilobytes and rewriting every run to append one is how a 5 MB quota is spent. The
 * index is small enough to rewrite on every change.
 */

const KEY = 'decodesim.practice.v1';
const bodyKey = (id: string): string => `${KEY}.${id}`;

/**
 * How many runs this device keeps. Ten is roughly a practice session's worth, and it bounds
 * the footprint at a few hundred KB against a ~5 MB localStorage quota — a match-length replay
 * is tens of KB, so the cap is what stops a long practice night filling it. Oldest goes first.
 */
export const MAX_LOCAL_RUNS = 10;

/** what the Career list and the local list both show — everything except the log itself */
export interface PracticeRunMeta {
  /** local id; also the key of the stored body */
  id: string;
  /** epoch ms the run finished */
  at: number;
  game: GameId;
  /** the run's own alliance total, as the local sim computed it */
  score: number;
  ticks: number;
  balanceVersion: number;
  /** SIM_VERSION when recorded — `replayRefusal` compares this to decide playability */
  sim: number;
  /** the server's id once this run has been uploaded; absent ⇒ local only */
  remoteId?: string;
}

const readIndex = (): PracticeRunMeta[] => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as PracticeRunMeta[];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
  } catch {
    // storage unavailable, or an index this build cannot read: practice replays are a
    // convenience, so lose them rather than break the mode
    return [];
  }
};

const writeIndex = (list: PracticeRunMeta[]): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* nothing to do — the bodies are already written or already gone */
  }
};

const dropBody = (id: string): void => {
  try {
    localStorage.removeItem(bodyKey(id));
  } catch {
    /* ignore */
  }
};

/** newest first — the order both the local list and the Career feed show */
export function listPracticeRuns(): PracticeRunMeta[] {
  return readIndex().sort((a, b) => b.at - a.at);
}

/** the stored input log for a run, or null if the body is gone (quota eviction, cleared site
 *  data, or a run that only exists on the account) */
export function loadPracticeReplay(id: string): Replay | null {
  try {
    const raw = localStorage.getItem(bodyKey(id));
    return raw ? (JSON.parse(raw) as Replay) : null;
  } catch {
    return null;
  }
}

export function deletePracticeRun(id: string): void {
  dropBody(id);
  writeIndex(readIndex().filter((m) => m.id !== id));
}

/**
 * Keep a finished run on this device, evicting the oldest past `MAX_LOCAL_RUNS`.
 *
 * Returns the metadata (so the caller can upload it) or null when nothing could be stored —
 * a private window, a cleared quota, storage switched off. The caller must treat null as "not
 * kept" rather than assuming success: the results screen still offers the replay it holds in
 * memory, which is the run you just played and the one you are most likely to want.
 *
 * A QUOTA FAILURE EVICTS AND RETRIES rather than giving up. The cap is a policy about how many
 * runs are worth keeping; the quota is a hard limit that other things on the origin share, and
 * the newest run is the one the player just asked for.
 */
export function savePracticeRun(replay: Replay, result: ReplayResult): PracticeRunMeta | null {
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const alliance = replay.setups[0]?.alliance ?? 'blue';
  const meta: PracticeRunMeta = {
    id,
    at: Date.now(),
    game: replay.game ?? 'decode',
    score: result.score[alliance] ?? 0,
    ticks: replay.ticks,
    balanceVersion: replay.balanceVersion,
    sim: replay.sim ?? 0,
  };

  const body = JSON.stringify(replay);
  let index = readIndex().sort((a, b) => b.at - a.at);
  // evict down to the cap BEFORE writing, so the common path writes once
  for (const old of index.slice(MAX_LOCAL_RUNS - 1)) dropBody(old.id);
  index = index.slice(0, MAX_LOCAL_RUNS - 1);

  for (;;) {
    try {
      localStorage.setItem(bodyKey(id), body);
      break;
    } catch {
      const oldest = index.pop();
      if (!oldest) return null; // nothing left to give back; the run stays in memory only
      dropBody(oldest.id);
    }
  }

  writeIndex([meta, ...index]);
  return meta;
}

/**
 * Runs this device has that the ACCOUNT does not, oldest first.
 *
 * The other half of "device first, account second". An upload can fail for reasons that have
 * nothing to do with the run — signed out at the time, offline, or (routinely, on a Fly app
 * that auto-stops when idle) a server still cold-booting when the match ended. Without a list
 * of what has not landed, every one of those is a run permanently missing from the account,
 * and nothing would ever notice.
 *
 * Oldest first so a flush replays them in the order they were played, which is the order the
 * server's own prune assumes when it drops the oldest past the cap.
 */
export function pendingPracticeUploads(): PracticeRunMeta[] {
  return readIndex()
    .filter((m) => !m.remoteId)
    .sort((a, b) => a.at - b.at);
}

/** record that the account now holds this run too (so the list can stop offering to retry) */
export function markPracticeUploaded(id: string, remoteId: string): void {
  const index = readIndex();
  const hit = index.find((m) => m.id === id);
  if (!hit) return;
  hit.remoteId = remoteId;
  writeIndex(index);
}
