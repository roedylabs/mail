/**
 * The CSP comes with the document: `connect-src` names the servers of the
 * registry at load time. If this tab changes the registry (setup,
 * Administration › Mail servers) or the CSP blocks a fetch because another tab
 * changed it, the old CSP would block a new server and sign-in would report
 * "CORS not enabled". The page therefore reloads after the next navigation
 * (`afterNavigate` in the layout): history, `replace` and aborted navigations
 * stay as the app wanted them.
 */
export const csp = {
  /** The CSP of the document may not allow all servers of the registry. */
  stale: false,
  /** Reloads the page (replaced in tests). */
  reload: (): void => location.reload(),
};
