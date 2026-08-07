import { useEffect, useRef, useState } from 'react';
import type { GameId, StartCat } from '../types';
import type { LobbyPlayer, PlayerPatch } from '../net/protocol';
import { MatchAudio } from '../audio';
import { categoryDefaultIndex, derivedRole, otherCat as other } from './startPositions';

/**
 * 2v2 start-ROLE negotiation. An alliance fills one CLOSE and one FAR slot; the
 * role limits which start-position category each robot may pick. The role
 * defaults to alliance join order (first by clientId = close, second = far) but
 * either member can propose a SWAP that the other must ACCEPT.
 *
 * The handshake rides two self-patched roster flags (no cross-patching, no new
 * server message): a member proposes by setting `swapReq`; the partner accepts by
 * setting theirs too; when BOTH are set each client flips ITS OWN role to the
 * opposite and clears its flag — race-free and convergent (they always held
 * opposite roles, so flipping both = a swap). A `enacted` ref stops a double-flip
 * during the patch→broadcast window. Only meaningful with exactly two members.
 *
 * SOUND. Both ends of the handshake are announced, because neither is something
 * you are looking at when it happens: a partner proposes while you are dragging a
 * start pose, and the flip lands a beat after you click Accept. The REQUEST cue
 * plays only for the partner being asked (the proposer already knows), the AGREED
 * cue plays on both clients at the moment each enacts its own flip.
 */

/** the two volume sliders these cues answer to (a slice of `settings.audio.volume`) */
export interface SwapVolume {
  master: number;
  alert: number;
}

export interface RoleSwap {
  /** the locked start category for this robot, or undefined when not a 2-member alliance */
  role: StartCat | undefined;
  partner: LobbyPlayer | null;
  /** two alliance members present ⇒ roles apply and swapping is possible */
  canSwap: boolean;
  /** I have proposed a swap and am waiting for my partner */
  requesting: boolean;
  /** my partner proposed a swap and I haven't accepted yet */
  incoming: boolean;
  /** both agreed — the flip is being enacted */
  swapping: boolean;
  requestSwap: () => void;
  acceptSwap: () => void;
  cancelSwap: () => void;
}

export function useRoleSwap(
  players: LobbyPlayer[],
  me: LobbyPlayer | null,
  update: (patch: PlayerPatch) => void,
  game?: GameId,
  vol?: SwapVolume,
): RoleSwap {
  const role = me ? derivedRole(players, me) : undefined;
  const partner = me
    ? players.find((p) => p.alliance === me.alliance && !p.hidden && p.clientId !== me.clientId) ?? null
    : null;
  const canSwap = role !== undefined && partner !== null;
  const iWant = canSwap && me?.swapReq === true;
  const partnerWants = canSwap && partner?.swapReq === true;
  const bothWant = iWant && partnerWants;

  // Its own MatchAudio, built on the first cue: this hook runs on the lobby and
  // strategy screens, where the game controller (which owns the shared instance)
  // does not exist yet. Same pattern as the matchmaker's "match found" chime.
  const audioRef = useRef<MatchAudio | null>(null);
  const cue = (play: (a: MatchAudio) => void): void => {
    if (!vol || vol.master <= 0 || vol.alert <= 0) return;
    audioRef.current ??= new MatchAudio();
    audioRef.current.masterVolume = vol.master;
    audioRef.current.alertVolume = vol.alert;
    play(audioRef.current);
  };

  const incoming = partnerWants && !iWant;
  const wasIncoming = useRef(false);
  useEffect(() => {
    // edge only — the flag stays true for as long as the request stands, and a
    // cue on every re-render would turn one proposal into a stutter.
    if (incoming && !wasIncoming.current) cue((a) => a.sfxSwapRequest());
    wasIncoming.current = incoming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  const enacted = useRef(false);
  useEffect(() => {
    if (bothWant && role) {
      if (!enacted.current) {
        enacted.current = true;
        cue((a) => a.sfxSwapDone());
        // flip my role and reset my ACTIVE start to the new category's default so a
        // now-FAR robot isn't left sitting at a CLOSE preset (and vice-versa).
        const next = other(role);
        update({ startRole: next, swapReq: false, startIndex: categoryDefaultIndex(next, game), startPose: null });
      }
    } else {
      enacted.current = false;
    }
    // `update` is a fresh closure each render but the ref guards re-entry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bothWant, role]);

  return {
    role: canSwap ? role : undefined,
    partner,
    canSwap,
    requesting: iWant && !partnerWants,
    incoming,
    swapping: bothWant,
    requestSwap: () => update({ swapReq: true }),
    acceptSwap: () => update({ swapReq: true }),
    cancelSwap: () => update({ swapReq: false }),
  };
}

/** small helper for the swap banner: partner-declined dismissal is LOCAL only
 * (the partner can't clear my flag), so this tracks whether I've hidden an
 * incoming request until it changes. */
export function useDismissable(active: boolean): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(false);
  const prev = useRef(active);
  useEffect(() => {
    if (prev.current && !active) setDismissed(false); // request ended → re-arm
    prev.current = active;
  }, [active]);
  return [dismissed, () => setDismissed(true)];
}
