/**
 * Reactive stand-in for `page` from `$app/state` in tests: assigning `url`
 * updates a mounted layout like a navigation. Not a test file: imported by
 * `routes/layout.test.ts`.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- the tests replace `url` as a whole, like SvelteKit's `page`
export const page = $state({ url: new URL('http://localhost/'), status: 200, params: {} });
