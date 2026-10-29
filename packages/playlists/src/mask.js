/**
 * Masking a stored playlist address.
 *
 * Its own file, importing nothing that touches a database, and that is
 * load-bearing rather than tidiness: a test that wanted only the mask used to
 * load the real query module, which re-registered it over another test file's
 * `mock.module`. The mask itself is the shared Xtream adapter's, which is pure.
 */

export { maskPlaylistUrl } from '@profullstack/stream-providers/xtream';
