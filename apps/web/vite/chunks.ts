// Chunks of the client build (JS budget of the mailbox route).
//
// The root layout loads on every route, so it goes with all its static
// dependencies (`includeDependenciesRecursively`, Rolldown's default) into a
// few chunks. Otherwise Rolldown spreads them over about a hundred small files:
// each brings its own import/export lines, and gzip loses the context between
// them (mailbox 329 instead of about 295 kB gz). What only pages or dynamic
// imports need stays in its own chunks.
//
// The start-up order stays as without groups, hence three groups:
// `start.js` (Kit's `entry.js`) statically loads only "payload"; Kit sets it in
// `init()` and only then loads the runtime, because `$app/paths` reads it when
// evaluated. If "payload" were in the runtime chunk, `base` would be empty and
// every navigation would reload the whole page (the return from the mail
// server sign-in lost its state that way). The browser still evaluates the
// layout's app code only with node 0, as before.

/** Browser runtime: Svelte, SvelteKit and their dependencies. */
const RUNTIME = /[\\/]node_modules[\\/](svelte|@sveltejs[\\/]kit|devalue|esm-env|clsx)[\\/]/;
/** Kit's entry `start.js`: stays its own chunk with the dynamic import of the runtime (Kit looks for it at build time). */
const KIT_ENTRY = /[\\/]@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]client[\\/]entry\.js$/;
const KIT_PAYLOAD = /[\\/]@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]client[\\/]payload\.js$/;
const ROOT_LAYOUT = /[\\/]src[\\/]routes[\\/]\+layout\.svelte$/;

export interface ChunkGroup {
  name: string;
  test: (id: string) => boolean;
  /** Higher first; a module belongs to the first group that takes it (also via dependencies). */
  priority: number;
}

/** Groups for the client's `build.rolldownOptions.output.codeSplitting.groups`. */
export const chunkGroups: ChunkGroup[] = [
  { name: 'payload', test: (id) => KIT_PAYLOAD.test(id), priority: 3 },
  { name: 'runtime', test: (id) => RUNTIME.test(id) && !KIT_ENTRY.test(id), priority: 2 },
  { name: 'shell', test: (id) => ROOT_LAYOUT.test(id), priority: 1 },
];

/** First group by priority whose `test` takes the module (without dependencies); for tests. */
export function groupOf(id: string): string | null {
  const sorted = [...chunkGroups].sort((a, b) => b.priority - a.priority);
  return sorted.find((g) => g.test(id))?.name ?? null;
}
