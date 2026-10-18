// A stand-in for src/lib/recovery/constants.ts, which imports the JSON through Metro: Node reads
// data/recovery_constants.json from disk instead, as the engine tests do.

import { readFileSync } from 'node:fs';

import { parseConstants } from '../../lib/recovery/thresholds.ts';

export const DEFAULT_THRESHOLDS = parseConstants(
  JSON.parse(readFileSync(new URL('../../../../data/recovery_constants.json', import.meta.url), 'utf8')),
);
