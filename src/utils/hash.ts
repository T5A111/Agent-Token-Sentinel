import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short, sortable, collision-resistant-enough id for local artifacts. */
export function makeId(prefix: string, now: number = Date.now()): string {
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `${prefix}-${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${rand}`;
}
