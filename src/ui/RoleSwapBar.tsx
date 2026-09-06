import type { GameId, StartCat } from '../types';
import { chainRoleLabel } from '../games/chain/config';
import type { RoleSwap } from './useRoleSwap';

// role labels are game-specific: DECODE splits CLOSE/FAR (distance to goal), Chain
// Reaction splits TOP/BOTTOM (which Lab corner). `useRoleSwap` still carries the two
// abstract StartCat slots; only the wording differs per game.
const roleLabel = (r: StartCat | undefined, game?: GameId) =>
  game === 'chain' ? chainRoleLabel(r) : r === 'close' ? 'CLOSE' : r === 'far' ? 'FAR' : '-';

/**
 * The 2v2 start-ROLE bar: shows this robot's role (Close/Far for DECODE, Top/Bottom
 * for Chain Reaction) and drives the consent-based swap handshake (propose → the
 * partner accepts). Rendered in the lobby + ranked strategy start-position section.
 * Pure presentational over the `useRoleSwap` result.
 */
export function RoleSwapBar({
  role,
  partnerName,
  rs,
  dismissed,
  onDismiss,
  game,
}: {
  role: StartCat | undefined;
  partnerName: string;
  rs: RoleSwap;
  dismissed: boolean;
  onDismiss: () => void;
  game?: GameId;
}) {
  return (
    <div className="ds-roleswap">
      <span className="ds-roleswap-role">
        You are the <b>{roleLabel(role, game)}</b> robot
      </span>
      <div className="ds-roleswap-ctl">
        {rs.swapping ? (
          <span className="ds-roleswap-note">Swapping roles…</span>
        ) : rs.incoming && !dismissed ? (
          <>
            <span className="ds-roleswap-note">{partnerName} wants to swap roles</span>
            <button type="button" className="ds-btn small" onClick={rs.acceptSwap}>
              Accept
            </button>
            <button type="button" className="ds-btn ghost small" onClick={onDismiss}>
              Decline
            </button>
          </>
        ) : rs.requesting ? (
          <>
            <span className="ds-roleswap-note">Waiting for {partnerName} to accept…</span>
            <button type="button" className="ds-btn ghost small" onClick={rs.cancelSwap}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="ds-btn ghost small" onClick={rs.requestSwap}>
            ⇄ Swap roles
          </button>
        )}
      </div>
    </div>
  );
}
