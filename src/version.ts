import { createRequire } from 'node:module';

// Single source of truth: package.json (one level up from both src/ and dist/).
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
