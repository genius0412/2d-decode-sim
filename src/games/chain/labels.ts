import type { ChainIntakeMount, ChainIntakeStyle, ChainScoreMode, ChainShooterMount } from '../../types';

/**
 * Shared display labels for Chain Reaction robot-config choices, so the builder
 * (Menu) and the leaderboard config summary name the same thing identically —
 * a CR record must show the CR archetype/intake, never a DECODE stat.
 */
export const CHAIN_MODE_LABELS: Record<ChainScoreMode, string> = {
  turret: 'Turret shooter',
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

export const CHAIN_INTAKE_MOUNT_BLURBS: Record<ChainIntakeMount, string> = {
  front: 'Grabs from the front',
  back: 'Grabs from the back',
  side: 'Both flanks · least storage',
  frontback: 'Both ends · less storage',
};

export const CHAIN_SHOOTER_MOUNT_LABELS: Record<ChainShooterMount, string> = {
  front: 'FRONT',
  back: 'BACK',
  left: 'LEFT',
  right: 'RIGHT',
};

export const CHAIN_SHOOTER_MOUNT_BLURBS: Record<ChainShooterMount, string> = {
  front: 'Shoots from the front',
  back: 'Shoots from the back',
  left: 'Fires off the left flank',
  right: 'Fires off the right flank',
};
