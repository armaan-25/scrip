import { createHash } from 'node:crypto';
import { canonical } from '../missions/outcome-assessor.js';

/** sha256 of the canonical JSON form: same content gives the same code; any change gives a different one. */
export function orderFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}
