/**
 * SiriusXM, over plain fetch: the protocol lives in @profullstack/stream-providers.
 *
 * This file is the seam. Everything that used to be written here (the edge
 * gateway paths, the emailed-code and password sign-ins, the headless device
 * grant mint, the residential-proxy retries, the HLS rewrite and the AES key
 * decode) is the shared adapter, so a fix to how SiriusXM is spoken to lands on
 * every site at once. What stays in this app is whose session it is and where it
 * is stored: `session.js` and `pending.js`.
 *
 * puppeteer-core is this package's dependency, so it is loaded from here rather
 * than resolved from inside the shared package.
 */

import { configure } from '@profullstack/stream-providers/siriusxm';

configure({ loadPuppeteer: () => import('puppeteer-core') });

export * from '@profullstack/stream-providers/siriusxm';
