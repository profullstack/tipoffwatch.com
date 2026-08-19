import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Layout } = await import('../apps/web/src/views/Layout.jsx');

const html = async (props) => (await Layout(props).toString()).toString();

describe('Layout', () => {
  test('carries the known timezone for a signed-in visitor', async () => {
    const out = await html({ user: { timezone: 'America/New_York' }, children: 'x' });
    expect(out).toContain('data-known-tz="America/New_York"');
  });

  test('defaults a signed-in visitor with no stored zone to UTC', async () => {
    const out = await html({ user: {}, children: 'x' });
    expect(out).toContain('data-known-tz="UTC"');
  });

  test('omits the attribute entirely when signed out', async () => {
    // Signed-out pages are cached and served byte-identical to everyone, so a
    // timezone attribute here would be one visitor's zone shown to the next -- and
    // would make every reader POST a correction for a session that does not exist.
    const out = await html({ user: null, children: 'x' });
    expect(out).not.toContain('data-known-tz');
  });

  test('names the data source on every page', async () => {
    const out = await html({ user: null, children: 'x' });
    expect(out).toContain('ESPN');
  });
});
