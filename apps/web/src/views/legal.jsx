import { brand, config, href } from '@tipoff/config';
import { faqNode } from '../lib/jsonld.js';
import { Layout } from './Layout.jsx';

/**
 * Privacy, terms and contact.
 *
 * Written from what the code actually does rather than from a template: the
 * tables that hold personal data are listed in packages/db/migrations, the
 * cookies are the three set in app.js, and the analytics script is the one the
 * Layout loads. A policy that describes a generic web app is a policy nobody can
 * check, and this one is meant to be checkable.
 *
 * Deliberately not lawyer-shaped. Everything else on this site is written in
 * sentences a reader can follow, and there is no reason these three should be the
 * exception.
 */

/** The address, when one is configured. See config.contactEmail. */
const Address = () =>
  config.contactEmail ? (
    <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>
  ) : (
    <a href="/contact">the contact page</a>
  );

export const Privacy = ({ user }) => (
  <Layout
    title="Privacy"
    user={user}
    canonical="/privacy"
    description={`What ${brand.name} collects, why it collects it, who it is shared with, and how to have it deleted.`}
    jsonld={[
      faqNode([
        [
          `Does ${brand.name} sell or share personal data?`,
          'No. Data is not sold, rented, or shared with advertisers, and there is no advertising ' +
            'on the site. It is passed only to the services needed to run it: the mail provider ' +
            'that delivers reminders, the browser push services, and the payment processor.',
        ],
        [
          `What does ${brand.name} store about me?`,
          'An email address, a time zone, what you follow, and any reminder settings. Optionally ' +
            'a handle, display name and bio if you set one. Nothing is required beyond an email ' +
            'address, and browsing the site needs no account at all.',
        ],
        [
          'How do I delete my account?',
          'Ask, from the address on the account, and everything belonging to it is deleted. ' +
            'Follows, messages, push subscriptions and any stored playlist go with it.',
        ],
      ]),
    ]}
  >
    <h1>Privacy</h1>
    <p>
      The short version: you can use the whole calendar without an account. If you make one, it is
      to send you reminders, and what is stored is what sending them requires.
    </p>

    <h2>What is collected, and why</h2>
    <p class="muted">
      Nothing here is collected for analysis or profiling. Each row exists because a feature needs
      it.
    </p>
    <ul>
      <li>
        <strong>Your email address.</strong> It is the account. It is used to sign you in and to
        send the reminders you asked for.
      </li>
      <li>
        <strong>Your time zone.</strong> Set from your browser or chosen in settings. An emailed
        reminder has no browser to ask, so the zone has to be stored.
      </li>
      <li>
        <strong>What you follow</strong>, and your reminder preferences.
      </li>
      <li>
        <strong>Push subscriptions.</strong> The endpoint your browser gives us, plus its keys.
        These identify a browser, not a person, and are deleted when you turn notifications off.
      </li>
      <li>
        <strong>A handle, display name and bio</strong>, only if you set them. A profile is public
        by default and can be made private in settings.
      </li>
      <li>
        <strong>Messages and comments</strong> you send, which are visible to the people you send
        them to.
      </li>
      <li>
        <strong>Sign-in attempts</strong>, with the address they came from, kept briefly so that
        repeated failures can be slowed down. This is the only place an IP address is stored.
      </li>
      <li>
        <strong>Payments</strong>, if you buy anything: what was bought and when. Card and wallet
        details never reach this site — they are handled by the payment processor.
      </li>
    </ul>

    <h2>Playlist credentials</h2>
    <p>
      If you import your own provider playlist, its URL contains your provider username and
      password. It is encrypted with AES-256-GCM before it is stored, is never rendered back into a
      page, and is never shown to anyone else — including to people you share channels with. Delete
      it from <a href="/settings">settings</a> at any time and the stored copy goes with it.
    </p>

    <h2>Cookies</h2>
    <p class="muted">
      Three, all strictly functional, all <code>HttpOnly</code>. There is no advertising cookie and
      nothing to consent to, so there is no banner.
    </p>
    <ul>
      <li>
        <code>tw_session</code> — keeps you signed in.
      </li>
      <li>
        <code>tw_pk</code> — holds a passkey challenge for five minutes during sign-in.
      </li>
      <li>
        <code>tw_invite</code> — remembers who invited you, if you arrived from an invite link.
      </li>
    </ul>

    <h2>Analytics</h2>
    <p>
      Page views are counted by{' '}
      <a href="https://crawlproof.com" rel="noopener">
        CrawlProof
      </a>
      . It sets no cookie. It records the page, the referring page and your screen size, and keeps a
      value in your browser's local storage to avoid counting the same visit twice. It does not
      build a profile and does not follow you to other sites.
    </p>

    <h2>Who else sees it</h2>
    <p class="muted">
      Nothing is sold, rented, or given to advertisers. It reaches only the services required to run
      the site: the host, the mail provider that delivers reminders and sign-in links, your
      browser's own push service, and the payment processor if you buy something.
    </p>

    <h2>How long it is kept</h2>
    <p class="muted">
      For as long as the account exists. Sign-in attempt records are pruned as they age out of the
      window used to slow down repeated failures. Push subscriptions disappear when the browser
      revokes them or you turn notifications off.
    </p>

    <h2>Deleting it</h2>
    <p>
      Write from the address on the account and it is deleted — follows, messages, push
      subscriptions, any stored playlist, all of it. If you would rather take it with you first, ask
      and you will get it back in a readable form. <Address /> reaches us.
    </p>

    <h2>Children</h2>
    <p class="muted">
      This is not aimed at children and no account should be made by anyone under 13.
    </p>

    <h2>Changes</h2>
    <p class="muted">
      If this changes in a way that affects what is collected, the change will be announced on this
      page before it takes effect rather than after.
    </p>
  </Layout>
);

export const Terms = ({ user }) => (
  <Layout
    title="Terms"
    user={user}
    canonical="/terms"
    description={`The terms for using ${brand.name}: what is free, what is not, and what is expected of everyone using it.`}
  >
    <h1>Terms</h1>
    <p>
      Plain terms for a small site. Using {brand.name} means these apply; if you disagree with them,
      do not use it.
    </p>

    <h2>What you get</h2>
    <p class="muted">
      Following, reminders, and the calendar feeds are free and stay free. They are provided as they
      are, with no promise of uptime. Schedules come from upstream providers and can be wrong, late,
      or missing — a reminder is a convenience and not something to plan around when it matters.
    </p>

    <h2>What costs money</h2>
    <p class="muted">
      Only the paid tier described on <a href="/premium">{brand.copy.premiumTitle}</a>. It is bought
      outright rather than by subscription, so nothing renews on its own and there is nothing to
      cancel. If it does not do what that page says it does, ask for your money back.
    </p>

    <h2>Your account</h2>
    <p class="muted">
      One person per account. Keep your email secure — anyone who can read it can sign in as you.
      You are responsible for what is sent from your account.
    </p>

    <h2>Streams and playlists</h2>
    <p>
      Any provider playlist you import is <em>yours</em>. Importing it does not make it available to
      anyone else, and nothing is pooled, cached, or re-served to other readers. You are responsible
      for having the right to use whatever you import, and for the terms of your own provider.
    </p>

    <h2>Behaviour</h2>
    <p class="muted">
      Do not use the site to harass anyone, do not scrape it in a way that degrades it for others,
      and do not try to reach accounts or data that are not yours. Accounts doing any of these can
      be closed without notice.
    </p>

    <h2>The data on this site</h2>
    <p class="muted">
      Schedules are public facts and the <a href="/api/v1">API</a> is open and needs no key. Team
      names, crests and league marks belong to their owners; {brand.name} is not affiliated with any
      league, team, or data provider named on the site.
    </p>

    <h2>Ending it</h2>
    <p class="muted">
      You can delete your account at any time — see <a href="/privacy">privacy</a>. We can close an
      account that breaks these terms. If the site shuts down, notice will be given by email to
      anyone with an account.
    </p>
  </Layout>
);

export const Contact = ({ user }) => (
  <Layout
    title="Contact"
    user={user}
    canonical="/contact"
    description={`How to reach ${brand.name} — support, privacy requests, corrections to a fixture, and security reports.`}
  >
    <h1>Contact</h1>
    {config.contactEmail ? (
      <p>
        Write to <Address />. It is read by a person, and there is no ticket system in front of it.
      </p>
    ) : (
      <p>
        Reach us through{' '}
        <a href={`https://${brand.domain}`} rel="noopener">
          {brand.domain}
        </a>
        . A direct address is being set up; until then, an account holder can reply to any reminder
        email and it will reach us.
      </p>
    )}

    <h2>Something on the site is wrong</h2>
    <p class="muted">
      Fixtures, scores and league listings come from upstream providers and are corrected upstream
      first — see <a href="/about">about</a> for where each one comes from. If something is wrong
      here but right at the source, that is a bug worth reporting.
    </p>

    <h2>Your data</h2>
    <p class="muted">
      To get a copy of what is stored about you, or to have the account deleted, write from the
      address on the account. See <a href="/privacy">privacy</a> for what that covers.
    </p>

    <h2>Security</h2>
    <p class="muted">
      Report a vulnerability here rather than publicly, and give us a reasonable window to fix it.
      The machine-readable version of this is at{' '}
      <a href="/.well-known/security.txt">/.well-known/security.txt</a>.
    </p>

    <h2>Anything else</h2>
    <p class="muted">
      There is no sales team and nothing to demo —{' '}
      <a href={href.category()}>{brand.words.browse}</a> and follow something. It is free.
    </p>
  </Layout>
);
