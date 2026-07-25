import type { StartCat } from '../types';
import { CHAIN_START_POSES, chainAnchorCat, chainRoleLabel } from '../games/chain/config';

/**
 * Chain Reaction start-position picker (rule G04 — start completely in the Lab Area). CR has
 * no drag/legality editor like DECODE's `StartPositionEditor`; every anchor is legal by
 * construction, so this is just a button list. Shared by the solo MatchSetup and the
 * multiplayer Lobby / MatchStrategy so CR never renders DECODE's field geometry.
 *
 * In a 2v2 each robot's ROLE locks it to one Lab corner — pass `role` (TOP = close /
 * BOTTOM = far) to limit the anchors to that corner's floor + ring-stand spots so the two
 * alliance robots never stack. Solo (no role) shows all four anchors.
 */
export function ChainStartSelector({
  startIndex,
  onPick,
  role,
}: {
  startIndex: number;
  onPick: (index: number) => void;
  /** locked 2v2 role — hides the other corner's anchors when set */
  role?: StartCat;
}) {
  // keep the original CHAIN_START_POSES index alongside each rendered anchor so the
  // filtered list still calls onPick with the true anchor index.
  const anchors = CHAIN_START_POSES.map((p, index) => ({ p, index })).filter(
    ({ index }) => !role || chainAnchorCat(index) === role,
  );
  return (
    <>
      <p className="ds-hint">
        {role
          ? `You are the ${chainRoleLabel(role)} robot — start in your Lab corner, on the floor or up on a ring stand.`
          : 'Your robot starts in the lab area — on the floor or up on a ring stand.'}
      </p>
      <div className="ds-opts two" style={{ marginTop: 8 }}>
        {anchors.map(({ p, index }) => (
          <button
            key={p.name}
            className={`ds-opt ${startIndex === index ? 'on' : ''}`}
            onClick={() => onPick(index)}
          >
            <span className="ot">{p.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}
