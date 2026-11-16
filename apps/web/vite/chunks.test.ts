import { describe, expect, it } from 'vitest';
import { chunkGroups, groupOf } from './chunks.ts';

const NM = '/repo/node_modules/.pnpm/x/node_modules';
const KIT = `${NM}/@sveltejs/kit/src/runtime`;

describe('chunkGroups', () => {
  it("Kit's payload.js stays without the runtime: it comes before all other groups", () => {
    expect(groupOf(`${KIT}/client/payload.js`)).toBe('payload');
    const prio = Object.fromEntries(chunkGroups.map((g) => [g.name, g.priority]));
    expect(prio.payload).toBeGreaterThan(prio.runtime!);
    expect(prio.runtime).toBeGreaterThan(prio.shell!);
  });

  it("Kit's entry.js (start.js) belongs to no group", () => {
    expect(groupOf(`${KIT}/client/entry.js`)).toBeNull();
  });

  it('Svelte and SvelteKit form the runtime, also with Windows paths', () => {
    expect(groupOf(`${KIT}/client/client.js`)).toBe('runtime');
    expect(groupOf(`${KIT}/app/paths/internal/client.js`)).toBe('runtime');
    expect(groupOf(`${NM}/svelte/src/internal/client/runtime.js`)).toBe('runtime');
    expect(groupOf(`${NM}/devalue/src/parse.js`)).toBe('runtime');
    expect(groupOf('C:\\repo\\node_modules\\svelte\\src\\index-client.js')).toBe('runtime');
  });

  it('the root layout forms the shell, other pages and packages no group', () => {
    expect(groupOf('/repo/apps/web/src/routes/+layout.svelte')).toBe('shell');
    expect(groupOf('/repo/apps/web/src/routes/(auth)/+layout.svelte')).toBeNull();
    expect(groupOf('/repo/apps/web/src/routes/mailbox/[account]/[...path]/+page.svelte')).toBeNull();
    expect(groupOf(`${NM}/dompurify/dist/purify.es.mjs`)).toBeNull();
    expect(groupOf(`${NM}/svelte-check/dist/index.js`)).toBeNull();
  });
});
