import { raw } from 'hono/html';
import { CHECKOUT_ASSETS } from '../lib/checkout.js';

/**
 * The checkout form (@profullstack/checkout), with the two files it needs.
 *
 * `html` is the package's own markup, already escaped, made by formHtml() in
 * lib/checkout.js. It is a plain form post and sells with no script at all; the
 * script only makes the total follow the option picked. Both files come from
 * this origin, because the policy allows no inline script or style.
 */
export const CheckoutForm = ({ html }) => (
  <>
    <link rel="stylesheet" href={CHECKOUT_ASSETS.css.href} />
    {raw(html)}
    <script type="module" src={CHECKOUT_ASSETS.js.href} />
  </>
);
