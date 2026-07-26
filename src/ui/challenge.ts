import type { GameId } from '../types';
import { RATED_FORMATS, type QueueMode } from '../net/protocol';
import type { RoomInvite, SentInvite } from '../net/api';

/**
 * A "play a friend" challenge that resolves through the MATCHMAKER rather than
 * through a joinable room code — the rated formats.
 *
 * Both sides carry the same `token` (the challenge row's `room`) into the ranked
 * queue, where the server pairs the two entries holding it. That indirection is
 * the whole reason these formats can be rated at all: rating is only ever applied
 * to a matchmaker-staged room, never to one somebody joined by code.
 */
export interface PendingChallenge {
  /** the challenge token both sides queue under */
  token: string;
  format: string;
  mode: QueueMode;
  /** true ⇒ the pair IS the match (rated 1v1); false ⇒ premade into the open pool */
  partyOnly: boolean;
  game: GameId;
  /** the other player, for "Waiting for @them" */
  opponent: string;
}

/**
 * Read a challenge off an invite, or null if it's an ordinary room invite.
 *
 * The single place that decides "does accepting this open a lobby or enter the
 * queue?", so the sender's path and the recipient's path can't drift into
 * disagreeing about what a format means.
 */
export function challengeOf(
  inv: Pick<RoomInvite, 'room' | 'format' | 'game'>,
  opponent: string,
): PendingChallenge | null {
  const spec = inv.format ? RATED_FORMATS[inv.format] : undefined;
  if (!spec || !inv.format) return null;
  return {
    token: inv.room,
    format: inv.format,
    mode: spec.mode,
    partyOnly: spec.partyOnly,
    game: inv.game,
    opponent,
  };
}

/** human label for a challenge format, used in every surface that announces one */
export function formatLabel(format: string | null): string {
  switch (format) {
    case 'rated1v1':
      return 'Rated 1v1';
    case 'ranked2v2':
      return 'Ranked 2v2';
    case 'casual2v2':
      return 'Casual 2v2';
    case 'duorecord':
      return 'Co-op record';
    default:
      // null is a challenge sent by a client older than formats: it was always a
      // casual versus room, so say that rather than nothing
      return 'Casual 1v1';
  }
}

/** the one-line "@x wants to play" subtitle, format-aware */
export const challengeLine = (format: string | null): string => `wants to play · ${formatLabel(format)}`;

/** is this outgoing challenge still waiting on an answer? */
export const isPending = (s: SentInvite): boolean => !s.declined;
