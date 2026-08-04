import type { DrivetrainType, IntakeStyle } from '../types';

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
