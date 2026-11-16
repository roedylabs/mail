import { describe, expect, it } from 'vitest';
import { hostOf, httpOther, localHttp, normUrl, originOf } from './url.ts';

describe('Addresses', () => {
  it('adds https:// and removes trailing slashes (normUrl)', () => {
    expect(normUrl('  mail.example.com/ ')).toBe('https://mail.example.com');
    expect(normUrl('http://localhost:8080//')).toBe('http://localhost:8080');
    expect(normUrl('HTTPS://Mail.Example.com')).toBe('HTTPS://Mail.Example.com');
    expect(normUrl('   ')).toBe('');
  });

  it('returns host with port and origin only for http(s) addresses', () => {
    expect(hostOf('https://mail.example.com:8443/path')).toBe('mail.example.com:8443');
    expect(hostOf('https://mail.example.com:443')).toBe('mail.example.com');
    expect(hostOf('ftp://mail.example.com')).toBe('');
    expect(hostOf('https://')).toBe('');
    expect(originOf('http://localhost:5173/x')).toBe('http://localhost:5173');
    expect(originOf('not a url')).toBe('');
  });

  it('allows http:// only on localhost and exactly 127.0.0.1', () => {
    expect(localHttp('http://localhost:8080')).toBe(true);
    expect(localHttp('http://127.0.0.1')).toBe(true);
    expect(localHttp('http://LOCALHOST')).toBe(true);
    expect(localHttp('https://localhost')).toBe(false);
    expect(localHttp('http://127.0.0.2')).toBe(false);
    expect(httpOther('http://stalwart:8080')).toBe(true);
    expect(httpOther('http://localhost:8080')).toBe(false);
    expect(httpOther('https://stalwart')).toBe(false);
    expect(httpOther('nonsense')).toBe(false);
  });
});
