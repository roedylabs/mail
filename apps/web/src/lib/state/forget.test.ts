import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('#lib/state/forget.ts');
});

/** Fresh registry without registrations from earlier tests. */
async function fresh() {
  vi.resetModules();
  return import('#lib/state/forget.ts');
}

describe('onForget and forgetRegistered', () => {
  it('resets registered modules synchronously, in registration order, each once', async () => {
    const { onForget, forgetRegistered } = await fresh();
    const order: string[] = [];
    const a = () => order.push('a');
    onForget(a);
    onForget(() => order.push('b'));
    onForget(a);
    forgetRegistered();
    expect(order).toEqual(['a', 'b']);
    forgetRegistered();
    expect(order).toEqual(['a', 'b', 'a', 'b']);
  });

  it('the settings page modules register themselves when loaded', async () => {
    vi.resetModules();
    const registered: (() => void)[] = [];
    vi.doMock('#lib/state/forget.ts', () => ({
      onForget: (reset: () => void) => registered.push(reset),
      forgetRegistered: () => {},
    }));
    const { forgetBanner } = await import('#lib/banner.svelte.ts');
    const { forgetBranding } = await import('#lib/branding.svelte.ts');
    const { identities } = await import('#lib/identities.svelte.ts');
    const { rules } = await import('#lib/rules.svelte.ts');
    const { vacations } = await import('#lib/vacation.svelte.ts');
    const { keptUsers } = await import('#lib/users.svelte.ts');
    const { keptServers } = await import('#lib/servers.svelte.ts');
    const { keptSecurity } = await import('#lib/security.svelte.ts');
    expect(registered).toContain(forgetBanner);
    expect(registered).toContain(forgetBranding);
    const spies = [
      vi.spyOn(identities, 'reset'),
      vi.spyOn(rules, 'reset'),
      vi.spyOn(vacations, 'reset'),
      vi.spyOn(keptUsers, 'forget'),
      vi.spyOn(keptServers, 'forget'),
      vi.spyOn(keptSecurity, 'forget'),
    ];
    for (const reset of registered) reset();
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
    // Imports eight large modules without cache; under a full parallel run that
    // can take longer than the default 5 s.
  }, 20_000);
});
