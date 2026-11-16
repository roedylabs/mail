<!--
  Shared page of the routes `/login`, `/password/forgot` and
  `/password/reset/[token]`: the page persists when switching between them –
  one screen with steps, inputs and lockouts are kept –, the address selects
  the step (`fgOpen`, `pwNewOpen`) and follows it (`onFgView`, `onPwNewLeave`).
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import LoginPage from '#lib/components/LoginPage.svelte';
  import type { LoginRoute } from '#lib/login.svelte.ts';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();

  const route = $derived.by((): LoginRoute => {
    const path = page.url.pathname;
    if (path === '/password/forgot') return { kind: 'forgot' };
    if (path.startsWith('/password/reset/')) return { kind: 'newpw', token: page.params.token ?? '' };
    return { kind: 'login' };
  });

  function navigate(to: 'login' | 'forgot') {
    // Without `reset`: the focus stays in the field of the new step (otherwise SvelteKit moves it to <body>).
    void goto(to === 'forgot' ? resolve('/(auth)/password/forgot') : resolve('/(auth)/login'), {
      reset: false,
    });
  }
</script>

<LoginPage {route} {navigate} home={() => void goto(resolve('/start'))} />
{@render children()}
