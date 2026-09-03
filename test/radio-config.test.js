import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
const { config } = await import('../packages/config/src/index.js');

describe('config.radio', () => {
  test('the proxy pool reads Webshare lines and full URLs, and skips junk', () => {
    process.env.SIRIUSXM_PROXIES = '# note\n1.2.3.4:80:user:p@ss\nhttp://a:b@h:1, bad:line\n';
    expect(config.radio.proxyPool).toEqual(['http://user:p%40ss@1.2.3.4:80', 'http://a:b@h:1']);
    delete process.env.SIRIUSXM_PROXIES;
    expect(config.radio.proxyPool).toEqual([]);
  });

  test('falls back to the ESPN proxy, and SIRIUSXM=0 turns it off', () => {
    process.env.SPORTS_PROXY_URL = 'http://x:y@rotate:80';
    delete process.env.SIRIUSXM_PROXY_URL;
    expect(config.radio.proxyUrl).toBe('http://x:y@rotate:80');
    process.env.SIRIUSXM_PROXY_URL = 'http://pin:1';
    expect(config.radio.proxyUrl).toBe('http://pin:1');
    delete process.env.SIRIUSXM_PROXY_URL;
    delete process.env.SPORTS_PROXY_URL;

    expect(config.radio.enabled).toBe(true);
    process.env.SIRIUSXM = '0';
    expect(config.radio.enabled).toBe(false);
    delete process.env.SIRIUSXM;
  });

  test('off for genrewatch unless asked for: that site is VOD only', () => {
    process.env.BRAND = 'genrewatch';
    expect(config.radio.enabled).toBe(false);
    process.env.SIRIUSXM = '1';
    expect(config.radio.enabled).toBe(true);
    delete process.env.SIRIUSXM;
    delete process.env.BRAND;
    expect(config.radio.enabled).toBe(true);
  });
});
