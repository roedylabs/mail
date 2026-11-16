// Writes tokens.css from the TypeScript constants (run: pnpm --filter @roedy/tokens build).
import { writeFileSync } from 'node:fs';
import { renderTokensCss } from '../src/css.ts';

const target = new URL('../tokens.css', import.meta.url);
writeFileSync(target, renderTokensCss());
console.log(`written: ${target.pathname}`);
