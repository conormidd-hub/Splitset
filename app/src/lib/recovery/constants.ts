// The one place the app reads data/recovery_constants.json. Metro resolves it through the
// ../data watch folder in metro.config.js; tests read the file with node:fs instead.

import raw from '../../../../data/recovery_constants.json';
import { parseConstants } from './thresholds.ts';

/** The defaults, before any user's overrides. Use useThresholds() for the signed-in user. */
export const DEFAULT_THRESHOLDS = parseConstants(raw);
