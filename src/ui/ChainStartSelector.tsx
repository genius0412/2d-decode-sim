import type { RobotSpec, StartCat, StartPose } from '../types';
import { CHAIN_START_POSES, chainAnchorCat, chainRoleLabel } from '../games/chain/config';
import { chainSnapStart } from '../games/chain/state';

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
  spec,
  pose,
  onPose,
}: {
  startIndex: number;
  onPick: (index: number) => void;
  /** locked 2v2 role — hides the other corner's anchors when set */
  role?: StartCat;
  /** the robot being placed — its size decides how close to a wall/assembly it can sit */
  spec?: RobotSpec;
  /** the current CUSTOM pose, or null when an anchor is selected */
  pose?: StartPose | null;
  /** set/clear a custom pose (omit to hide the fine controls entirely) */
  onPose?: (p: StartPose | null) => void;
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
          ? `You are the ${chainRoleLabel(role)} robot - start in your Lab corner, on the floor or up on a ring stand.`
          : 'Your robot starts in the lab area - on the floor or up on a ring stand.'}
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
      {onPose && spec && (
        <>
          {/* FINE PLACEMENT. The anchors are quick picks; this nudges to any spot in the Lab
              Area. Every edit is run through `chainSnapStart` — the SAME snap the spawn uses
              — so the value shown is always the value you will actually start at, and it can
              never be left overlapping the solid corner assembly. */}
          <div className="ds-fields" style={{ marginTop: 10 }}>
            {(
              [
                ['X', 'x', 0, 72],
                ['Y', 'y', -72, 72],
              ] as const
            ).map(([label, key, lo, hi]) => {
              const cur = pose ?? { ...CHAIN_START_POSES[startIndex].pos, headingDeg: 180 };
              const val = key === 'x' ? cur.x : cur.y;
              return (
                <label className="ds-field" key={key}>
                  <span className="cap">
                    Start {label} <span className="val">{val.toFixed(0)}"</span>
                  </span>
                  <input
                    className="ds-range"
                    type="range"
                    min={lo}
                    max={hi}
                    step={1}
                    value={val}
                    onChange={(e) => {
                      const next = { ...cur, [key]: Number(e.target.value) } as StartPose;
                      const snapped = chainSnapStart(spec, { x: next.x, y: next.y });
                      onPose({ x: snapped.x, y: snapped.y, headingDeg: next.headingDeg });
                    }}
                  />
                </label>
              );
            })}
            <label className="ds-field">
              <span className="cap">
                Start heading{' '}
                <span className="val">{(pose?.headingDeg ?? 180).toFixed(0)}°</span>
              </span>
              <input
                className="ds-range"
                type="range"
                min={-180}
                max={180}
                step={15}
                value={pose?.headingDeg ?? 180}
                onChange={(e) => {
                  const cur = pose ?? { ...CHAIN_START_POSES[startIndex].pos, headingDeg: 180 };
                  onPose({ x: cur.x, y: cur.y, headingDeg: Number(e.target.value) });
                }}
              />
            </label>
          </div>
          {pose && (
            <button className="ds-opt mini" style={{ marginTop: 6 }} onClick={() => onPose(null)}>
              <span className="ot">RESET TO ANCHOR</span>
            </button>
          )}
        </>
      )}
    </>
  );
}
