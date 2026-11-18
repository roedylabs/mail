import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dialogValues, ServersPage, type AdminServer, type ServerDialogValues } from '#lib/servers.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import ServerDialog from './ServerDialog.svelte';
import SOURCE from './ServerDialog.svelte?raw';

const S2: AdminServer = {
  id: 's2',
  label: 'VPS 2',
  url: 'https://mail.s2.test',
  host: 'mail.s2.test',
  domains: ['s2.test'],
  client_id: 'c2',
  has_secret: true,
  reach: 'ok',
  cors: 'ok',
  oauth: 'ok',
  tested_at: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  ui.reset();
});

/** Dialog with the values of a page; `sync()` takes over changes to the state. */
function open(server: AdminServer | null, isMobile = false) {
  const p = new ServersPage();
  p.redirectUri = 'https://app.example.com/oauth/callback';
  p.openDialog(server);
  const sd = () => dialogValues(p) as ServerDialogValues;
  const view = render(ServerDialog, { sd: sd(), isMobile });
  const sync = () => view.rerender({ sd: sd(), isMobile });
  return { p, view, sync };
}

describe('ServerDialog', () => {
  it('shows fields, registration and redirect URI on desktop; input goes to the state', async () => {
    const { p, view, sync } = open(null);
    expect(view.getByRole('dialog', { name: 'Add server' })).toBeInTheDocument();
    expect(view.getByText('JMAP server that users can connect to')).toBeInTheDocument();
    const label = view.getByLabelText('Label');
    expect(document.activeElement).toBe(label);
    await fireEvent.input(label, { target: { value: 'New' } });
    await fireEvent.input(view.getByLabelText('Add domain'), { target: { value: 'new.test,' } });
    expect(p.dialog).toMatchObject({ label: 'New', domains: ['new.test'], domIn: '' });
    await sync();
    expect(view.getByRole('button', { name: 'Remove new.test' })).toBeInTheDocument();
    expect(view.getByRole('radio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true');
    expect(view.getByLabelText('Mail server admin user')).toBeInTheDocument();
    expect(view.getByLabelText('Administrator’s app password')).toHaveAttribute(
      'placeholder',
      'App password from Stalwart',
    );
    expect(view.getByText(/^Sign in once with the username and app password/)).toBeInTheDocument();
    expect(view.getByText('https://app.example.com/oauth/callback')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Register client automatically' }));
    await sync();
    expect(view.getAllByRole('alert').map((a) => a.textContent?.trim())).toEqual([
      'Enter the server’s URL first.',
      'Please enter the mail server’s admin user and app password.',
    ]);
    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(p.dialog).toBeNull();
  });

  it('shows the manual client with a stored secret and toggles the display', async () => {
    const { p, view, sync } = open(S2);
    expect(view.getByRole('dialog', { name: 'Edit server' })).toBeInTheDocument();
    expect(view.getByLabelText('Client ID')).toHaveValue('c2');
    expect(view.getByText(/^The secret is saved\. Leave empty/)).toBeInTheDocument();
    const secret = view.getByLabelText('Client secret (optional)');
    expect(secret).toHaveAttribute('type', 'password');
    await fireEvent.click(view.getByRole('button', { name: 'Show' }));
    await sync();
    expect(secret).toHaveAttribute('type', 'text');
    expect(view.getByRole('button', { name: 'Save and test' })).toBeInTheDocument();
    // A click in the dialog does not close, one on the backdrop does.
    await fireEvent.mouseDown(view.getByRole('dialog'));
    expect(p.dialog).not.toBeNull();
    await fireEvent.mouseDown(view.getByRole('presentation'));
    expect(p.dialog).toBeNull();
  });

  it('shows the registered client and on mobile only the sheet content', async () => {
    mockApi({ 'POST admin/servers/register-client': [{ body: { client_id: 'roedy-xyz', has_secret: true } }] });
    const { p, view, sync } = open(null, true);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByText('Add server')).toBeInTheDocument();
    expect(view.getByText('Accounts with these domains are assigned automatically.')).toBeInTheDocument();
    p.setUrl('http://localhost:8080');
    p.setAdminUser('admin');
    p.setAdminPassword('pw');
    await p.register();
    await sync();
    expect(view.getByText('Unencrypted. Only for development on this machine.')).toBeInTheDocument();
    expect(view.getByRole('status')).toHaveTextContent('Client registered');
    expect(view.getByText('Client ID roedy-xyz · Secret stored in the backend')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Register again' }));
    expect(p.dialog?.aSt).toBeNull();
  });

  it('shows the registration secret on desktop without advice on the redirect URI', async () => {
    mockApi({ 'POST admin/servers/register-client': [{ body: { client_id: 'roedy-xyz', has_secret: true } }] });
    const { p, view, sync } = open(null);
    p.setUrl('https://mail.new.test');
    p.setAdminUser('admin');
    p.setAdminPassword('app-password');
    await p.register();
    await sync();
    expect(
      view.getByText('Client ID roedy-xyz · Secret stored in the backend · Admin credentials discarded'),
    ).toBeInTheDocument();
    p.setOa('manual');
    await sync();
    expect(
      view.getByText(
        'The secret from the automatic registration is stored in the backend and applied when you save. Leave empty to use it.',
      ),
    ).toBeInTheDocument();
    p.setCid('other');
    await sync();
    expect(
      view.getByText(
        'Optional. Only needed if the client was created as a confidential client in Stalwart. The secret stays in the backend only. Create the client in the Stalwart web admin with the redirect URI below.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a Stalwart rate limit as a box and disables the button', async () => {
    mockApi({
      'POST admin/servers/register-client': [
        { status: 502, body: { error: 'registration_failed', reason: 'throttled', retry_after: 90 } },
      ],
    });
    const { p, view, sync } = open(null);
    p.setUrl('https://mail.new.test');
    p.setAdminUser('admin');
    p.setAdminPassword('app-password');
    await p.register();
    await sync();
    expect(view.getByRole('alert')).toHaveTextContent(
      'Too many requests. The mail server is throttling requests from Roedy Mail. Try again in 2 minutes.',
    );
    expect(view.getByRole('button', { name: /^Register client automatically in 1:[23]\d$/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    p.regLock.stop();
  });

  it('shows the icon on mobile only in the client ID / secret error line', async () => {
    const { p, view, sync } = open(S2, true);
    p.setLabel('');
    p.setUrl('');
    p.setCid('c\u0001');
    await p.save();
    await sync();
    const alerts = view.getAllByRole('alert');
    expect(alerts.map((a) => a.textContent?.trim())).toEqual([
      'Please enter a label.',
      'The URL must start with https://, e.g. https://mail.example.com.',
      'The client ID contains invalid characters or is too long.',
    ]);
    expect(alerts.map((a) => a.querySelector('svg') !== null)).toEqual([false, false, true]);
    expect(alerts[2]).toHaveClass('cred', 'm');
  });

  it('shows the admin error on mobile without icon and the rate limit text level with the tile', async () => {
    mockApi({
      'POST admin/servers/register-client': [
        { status: 502, body: { error: 'registration_failed', reason: 'throttled', retry_after: 90 } },
      ],
    });
    const { p, view, sync } = open(null, true);
    p.setUrl('https://mail.new.test');
    await p.register();
    await sync();
    const adm = view.getByRole('alert');
    expect(adm).toHaveTextContent('Please enter the mail server’s admin user and app password.');
    expect(adm).toHaveClass('adm', 'm');
    expect(adm.querySelector('svg')).toBeNull();
    p.setAdminUser('admin');
    p.setAdminPassword('app-password');
    try {
      await p.register();
      await sync();
      const box = view.getByRole('alert');
      expect(box.querySelector('.locked-text')).toHaveTextContent(/^Too many requests\. /);
      expect(view.getByRole('button', { name: /^Register client automatically in/ })).toHaveClass('off');
    } finally {
      p.regLock.stop();
    }
  });

  it('styles the rate limit box and the disabled register button', () => {
    const rule = (selector: string) =>
      new RegExp(`^ {2}${selector.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(SOURCE)?.[1] ?? '';
    expect(rule('.locked')).toMatch(/border-radius: 16px;/);
    expect(rule('.locked-text')).toMatch(/padding-top: 4px;/);
    expect(rule('.reg.off')).toMatch(/opacity: 0\.55;\s*cursor: not-allowed;/);
    expect(rule('.field-err.adm.m')).toMatch(/padding: 0 4px;/);
  });

  it('names the linked accounts before a new client when editing', async () => {
    const { p, view, sync } = open({ ...S2, accounts: 2 });
    expect(view.queryByText(/linked accounts have to sign in again/)).toBeNull();
    p.setCid('new');
    await sync();
    expect(
      view.getByText('With a different client ID, the 2 linked accounts have to sign in again.'),
    ).toBeInTheDocument();
    p.setOa('auto');
    await sync();
    expect(view.getByText('With a new client, the 2 linked accounts have to sign in again.')).toBeInTheDocument();
  });
});
