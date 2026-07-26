import { useEffect, useRef, useState } from 'react';
import type { GameId, StartCat } from '../types';
import type { LobbyPlayer, PlayerPatch } from '../net/protocol';
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
 */

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
): RoleSwap {
  const role = me ? derivedRole(players, me) : undefined;
  const partner = me
    ? players.find((p) => p.alliance === me.alliance && !p.hidden && p.clientId !== me.clientId) ?? null
    : null;
  const canSwap = role !== undefined && partner !== null;
  const iWant = canSwap && me?.swapReq === true;
  const partnerWants = canSwap && partner?.swapReq === true;
  const bothWant = iWant && partnerWants;

  const enacted = useRef(false);
  useEffect(() => {
    if (bothWant && role) {
      if (!enacted.current) {
        enacted.current = true;
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
    incoming: partnerWants && !iWant,
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
