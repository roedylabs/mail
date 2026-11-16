// Types for SvelteKit and the build info (see vite/build-info.ts).
declare global {
  interface ImportMetaEnv {
    /** Version of the app, e.g. `0.1.0`. */
    readonly ROEDY_VERSION: string;
    /** Short Git commit of the build; empty if unknown. */
    readonly ROEDY_BUILD_SHA: string;
    /** Time of the build or commit as an ISO 8601 string. */
    readonly ROEDY_BUILD_DATE: string;
  }
}

export {};
