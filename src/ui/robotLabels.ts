import type { DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import type { GameId } from '../games/types';
import { CHAIN_MODE_LABELS } from '../games/chain/labels';
import { CHAIN_DEFAULT_SCORE_MODE } from '../games/chain/config';

/** Short human labels for robot-build enums, shared across the My Robot builder
 * (Menu) and the pre-match strategy screen (MatchStrategy) so the two never drift. */
export const DRIVETRAIN_LABELS: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-drive',
  butterfly: 'Butterfly',
};

export const INTAKE_SHORT: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
};

/**
 * ONE LINE describing a build, in the terms that game actually has: DECODE names
 * the intake and the sorter, Chain Reaction names the archetype (it has no intake
 * styles and no sorter). Lives here rather than in a screen because THREE screens
 * print it now — the ranked strategy window, the custom-room lobby, and anywhere
 * else a roster card wants to say what somebody is bringing — and two hand-written
 * copies of one sentence drift the way any two drawings of one object do.
 */
export function buildSummary(spec: RobotSpec, game: GameId): string {
  const parts =
    game === 'chain'
      ? [
          DRIVETRAIN_LABELS[spec.drivetrain],
          CHAIN_MODE_LABELS[spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE],
          `${spec.driveRpm} rpm`,
          `${spec.massLb} lb`,
        ]
      : [
          DRIVETRAIN_LABELS[spec.drivetrain],
          INTAKE_SHORT[spec.intake],
          `${spec.driveRpm} rpm`,
          `${spec.massLb} lb`,
          ...(spec.canSort ? ['sorter'] : []),
        ];
  return parts.join(' · ');
}
