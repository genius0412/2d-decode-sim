import type {
  ChainCatalystMount,
  ChainCatalystType,
  ChainIntakeMount,
  ChainIntakeStyle,
  ChainScoreMode,
  ChainShooterMount,
} from '../../types';

/**
 * Shared display labels for Chain Reaction robot-config choices, so the builder
 * (Menu) and the leaderboard config summary name the same thing identically —
 * a CR record must show the CR archetype/intake, never a DECODE stat.
 */
export const CHAIN_MODE_LABELS: Record<ChainScoreMode, string> = {
  turret: 'Turret shooter',
  twinturret: 'Twin turret',
  drum: 'Drum shooter',
  dumper: 'Dumper',
};

export const CHAIN_INTAKE_LABELS: Record<ChainIntakeStyle, string> = {
  sweeper: 'Sweeper',
};

/** MOUNT labels — the builder's pickers and the leaderboard's config summary. Kept SHORT
 * (they sit in a 4-up button grid) with the tradeoff in the blurb. */
export const CHAIN_INTAKE_MOUNT_LABELS: Record<ChainIntakeMount, string> = {
  front: 'FRONT',
  back: 'BACK',
  side: 'SIDES',
  frontback: 'FRONT+BACK',
};

/** Blurbs are PARTIAL on purpose (main's caption sweep): a mount only gets one when it says
 * something the label does not — i.e. the hopper-volume cost of an open edge. "FRONT · grabs
 * from the front" is noise; "SIDES · least storage" is the tradeoff you are actually picking. */
export const CHAIN_INTAKE_MOUNT_BLURBS: Partial<Record<ChainIntakeMount, string>> = {
  side: 'Least storage',
  frontback: 'Less storage',
};

export const CHAIN_SHOOTER_MOUNT_LABELS: Record<ChainShooterMount, string> = {
  front: 'FRONT',
  back: 'BACK',
  left: 'LEFT',
  right: 'RIGHT',
};

/** The shooter mounts cost nothing and the label already names the edge, so none of them
 * carry a blurb — see the note on the intake blurbs above. */
export const CHAIN_SHOOTER_MOUNT_BLURBS: Partial<Record<ChainShooterMount, string>> = {};


/** CATALYST mechanism labels + the one-line tradeoff each archetype is actually picked for. */
export const CHAIN_CATALYST_LABELS: Record<ChainCatalystType, string> = {
  arm: 'Claw arm',
  launcher: 'Claw + catapult',
  turret: 'Rail turret claw',
};

export const CHAIN_CATALYST_BLURBS: Record<ChainCatalystType, string> = {
  arm: 'Longest reach · must face it · slow',
  launcher: 'Short reach · throws rings downfield',
  turret: 'Tracks hooks · any direction · fastest',
};

export const CHAIN_CATALYST_MOUNT_LABELS: Record<ChainCatalystMount, string> = {
  front: 'FRONT',
  back: 'BACK',
  left: 'LEFT',
  right: 'RIGHT',
};
