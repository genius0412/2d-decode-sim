/**
 * Legal page copy — privacy policy + terms of use.
 *
 * Kept as template-literal strings (the `src/contributors.ts` / `src/download.ts`
 * data-module convention) and rendered by the zero-dep `Markdown` component in
 * `src/ui/markdown.tsx`. That renderer downshifts headings (`#` -> h3), so these
 * documents start at `##` and sit under the page's own `.ds-h1`.
 *
 * The supported markdown subset is narrow: headings, paragraphs, bullets, **bold**,
 * *italic*, `code`, [links](url), and `---` rules. No tables, no blockquotes, no
 * code fences — keep to that subset or it renders as literal text.
 *
 * ACCURACY IS LOAD-BEARING. The data inventory below was written against the real
 * schema (`server/db/migrations/`) and the real localStorage keys. If you add a
 * table, a synced field, or a third-party service, update the matching section —
 * a policy that misdescribes what you collect is worse than no policy at all.
 */

/** last substantive revision — shown on both pages */
export const LEGAL_UPDATED = 'August 4, 2026';

/** where privacy / data-deletion requests go */
export const LEGAL_CONTACT = 'genius0412.tech@gmail.com';

/**
 * WHO the terms are with, and WHOSE LAW governs them.
 *
 * These are load-bearing, not boilerplate. A contract has to name a party — "the
 * operator of DSIM" is not someone anyone can be in a dispute with — and two
 * concrete things depend on it:
 *
 *  - AdSense requires an identifiable publisher; a policy that identifies nobody
 *    is a known rejection reason.
 *  - UK/EU consumer law requires a trader selling to consumers to give a name
 *    and a geographic contact, and a recurring membership is a consumer sale.
 *    That applies to European supporters regardless of where the operator is.
 *
 * DSIM is run by an individual, which is a perfectly lawful answer — there is no
 * requirement to incorporate before accepting support. If that ever changes (an
 * LLC, a different state), update BOTH of these and the date above: the governing
 * law clause in TERMS_MD reads from them.
 */
export const LEGAL_OPERATOR = 'Dohun Kim';
export const LEGAL_JURISDICTION = 'the Commonwealth of Massachusetts, United States';

/** true once the placeholders above have been filled in. The Terms page shows a
 *  visible warning while this is false, so an unfinished contract cannot quietly
 *  go live and start binding people. */
export const LEGAL_IDENTIFIED =
  !LEGAL_OPERATOR.startsWith('[') && !LEGAL_JURISDICTION.startsWith('[');

export const PRIVACY_MD = `
DSIM is a free FTC driver-practice simulator. This policy explains what the app
collects, why, and what you can do about it. It is written to be read, not to be
skimmed past - it is short because the app genuinely collects very little.

## The short version

You can play the entire single-player simulator **without an account and without
sending us anything**. Signing in is only required for multiplayer, leaderboards,
and saved records. If you never sign in, everything below about accounts simply
does not apply to you.

## What is stored on your own device

These live in your browser's local storage and are never transmitted unless you
sign in and enable account sync:

- **Settings** (\`decodesim.settings.v1\`) - robot builds, control bindings, assists,
  audio and start-position preferences.
- **Theme** (\`decodesim.theme\`) - light or dark.
- **Session scratch** (\`decodesim.active\`, \`decodesim.chain\`, \`decodesim.friends\`,
  \`decodesim.seen\`) - which match you were in, and which announcements you have read.

Clearing your browser data removes all of it. There is no recovery, and we keep no
copy unless you were signed in.

## What is stored on our servers

Only if you create an account:

- **Identity** - your email address and display name, handled by our authentication
  provider. If you sign in with Google, we receive your email and name from Google;
  we never see your Google password.
- **Profile** - your chosen username and public handle.
- **Settings** - the same settings blob described above, so your setup follows you
  between devices.
- **Gameplay records** - scores, game mode, drivetrain, and timestamps for record
  runs and ranked matches.
- **Replays** - the random seed, robot configurations, and per-tick inputs needed to
  reconstruct a match. A replay contains no personal information beyond the robot
  setups and the account it belongs to.
- **Ranking** - your Glicko-2 rating, deviation, and match history.
- **Social** - friend requests, friendships, blocks, room invites, and an online or
  last-seen status if you use those features.
- **Robot presets** - the names and specifications you save.

Our game servers also process your IP address to route your connection, as any
network service must. It is not stored in the database or used to build a profile.

## Live status while you are connected

To run matchmaking, host matches and keep the service healthy, each game server
keeps a **live snapshot** of what is happening on it right now. This is operational
state, not history:

- **If you are signed in**, the snapshot can include your account id, a coarse
  activity (in menus / in a lobby / in a match), the room code of a match you are
  in, and whether you are waiting in a ranked queue and for how long.
- **If you are not signed in**, your session appears with the same coarse activity,
  identified by a **connection id**. That id is the one our server generates to
  route messages on your socket: it is **not** your IP address, **not** a device
  fingerprint, it is stored nowhere else, and it **ceases to exist when you
  disconnect** - reconnecting gives you a completely unrelated one. It can tell two
  sessions that are live at the same moment apart. It cannot link you to anything
  you did before, or to any other session.
- **For nobody** do we record which screen or menu you are looking at, what you
  click, or your inputs.

Every snapshot is **overwritten by the next one** a few seconds later, and a
server's entry disappears when it stops reporting. Nothing here accumulates into a
timeline, so it cannot be used to reconstruct what anyone was doing earlier.

Separately, matches in progress are **listed publicly** so anyone can spectate
them, including the display names and team numbers of the players in them. That
list is what the "Watch Live" screen shows.

## Site administrators

Administrators of DSIM can see the live snapshot described above, for moderation
(investigating cheating or abuse) and for keeping the servers running. Concretely,
an administrator can see every connected session - signed-in accounts by name, and
sessions without an account by the temporary connection id described above - along
with the coarse activity, the room, and the ranked queue state for each. They
**cannot** see which screen you are on, your inputs, your messages, or any history
of your activity, and the connection id gives them no way to recognise a returning
visitor.

Administrators can also put DSIM into **maintenance**, which pauses new matches for
everyone else while an update or a season reset is applied. When one is scheduled or
running you will see a banner saying so, with the times.

Administrators can also **watch a live match without appearing in the spectator
count** that players see. We are stating this rather than leaving it implicit: the
count shown during a match reflects ordinary spectators, and an administrator
observing for moderation is deliberately not included in it. Matches are already
publicly spectatable by anyone, so this changes who is *visible*, not what is.

## Cookies and similar technologies

DSIM itself sets **no cookies**. Your settings live in your browser's local
storage (listed above), and signing in uses a token held by our authentication
provider - neither is used to track you between sites.

Where the web version shows advertising, **Google AdSense** and its partners may
set cookies or read device identifiers to serve and measure ads and to limit how
often you see the same one. That is the only third-party cookie use on the site.

## Advertising

The web version of DSIM shows advertising served by **Google AdSense**.

**Ads are non-personalised by default.** DSIM is a simulator for a school
robotics competition, so a real share of players are young teenagers and most are
not signed in at all - we therefore do not let advertising be targeted using
browsing history unless we have a reason to believe otherwise. Ad requests are
also tagged as being for users below the age of consent for advertising purposes.

If you are in the UK, the EEA, or Switzerland you will be asked for your
advertising choices through a Google-certified consent tool before any ads are
personalised, and you can reopen that choice at any time from the "Privacy &
Cookie Settings" link in the site footer.

You can also review and change Google's ad settings at
[Google's Ads Settings](https://adssettings.google.com), and read how Google uses
data from sites that use its services at
[policies.google.com/technologies/partner-sites](https://policies.google.com/technologies/partner-sites).

Ads are **not** shown in the desktop application, **not** shown on touch devices,
and **not** shown to supporters.

## Payments

Supporter memberships and donations are processed by **Ko-fi**, which in turn uses
**PayPal**. Your payment details go to those services, never to us - we never see
or store a card number.

What we do receive and store for each payment is the email address you paid with,
the amount and currency, and Ko-fi's own transaction and event identifiers. The
email address is what links your payment to your DSIM account so the membership
renews without you having to claim it every month; it is never displayed to anyone
and never used to contact you. If you delete your account, that email address is
erased, though the payment record itself is kept without it, because it is a
financial record.

## Who else touches your data

We use a small number of infrastructure providers, each acting on our behalf:

- **Neon** - database and authentication.
- **Fly.io** - the multiplayer game servers.
- **Vercel** - hosting for the website.
- **Google AdSense** - advertising on the web version.
- **Ko-fi** and **PayPal** - payments.

We do not sell your data, and we do not share it with anyone else.

## How long it is kept

Account data is kept while your account exists. Replays and records may be removed
at the end of a competitive season. Delete your account and the associated profile,
records, replays, ratings, presets, and social data are deleted with it.

The **live status snapshot** described above is not kept at all: each update
replaces the last, and a server's entry disappears within seconds of it going
quiet. Connection ids are gone the moment the socket closes. There is nothing there
to export or delete after you disconnect.

## Your choices

- **See or correct your data** - most of it is visible on your profile and settings
  pages.
- **Delete everything** - there is a **Delete account** button on your Profile
  page. It removes your profile, username, settings, robot presets, records and
  their replays, rating and rating history, and all friendships, blocks, and
  invites, immediately and permanently. If that button is unavailable for any
  reason, email us and we will do exactly the same thing by hand.
- **Advertising choices** - see the Advertising section above.
- **Play anonymously** - simply do not sign in.

Two things deliberately survive an account deletion, and it is fairer to say so
than to promise otherwise: matches you played remain in the other players' match
history (without your name), because they are a record of their games too; and
payment records are retained, with your email removed, because they are financial
records.

If you are in the UK, EU, or a jurisdiction with comparable law, you have rights of
access, correction, deletion, and portability. The delete button covers deletion;
for anything else, email us and we will action the request.

## Age

DSIM is intended for players aged **13 and over**. We do not knowingly collect
information from children under 13. If you believe a child under 13 has created an
account, email us and we will delete it.

## Changes

If this policy changes materially, the date at the top of the page changes and the
update is noted in the app's announcements.

## Contact

Questions, corrections, and deletion requests: **${LEGAL_CONTACT}**
`;

export const TERMS_MD = `
These terms cover your use of DSIM - the website, the multiplayer service, and the
desktop application. Using any of them means you accept what follows.

## Who you are agreeing with

DSIM is operated by **${LEGAL_OPERATOR}**, and you can reach a human at
**${LEGAL_CONTACT}**. It is an independent project, not a company product.

## Who can use DSIM

You must be **13 or older** to create an account. If you are under 18, you should
have a parent or guardian's permission, and they must be the one to make any
purchase.

## Your account

You are responsible for what happens under your account. Pick a username that is
not offensive, not impersonating someone else, and not misleading about your
affiliation with a team or organisation. We may reclaim usernames that break this.

## Fair play

DSIM runs a server-authoritative simulation, and ranked play depends on that being
respected. Do not modify the client to gain an advantage, automate play, exploit
bugs for rating, or deliberately disrupt other players' matches. Accounts that do
may lose their rating, their records, or their access.

## Supporter memberships

Supporter benefits are cosmetic or convenience features. **They do not confer any
competitive advantage**, and they never will - that is a deliberate design rule, not
a current limitation.

Memberships are billed monthly through Ko-fi and you can cancel at any time from
your Ko-fi account; cancelling stops future charges and you keep the benefit until
the paid period ends.

**Refunds.** Email us within **14 days** of a payment and we will refund it in
full, no reason needed - that is a promise, not a discretion, and it is the same
14-day cancellation right UK and EU consumers have by law. After 14 days a
payment for a period already served is not normally refunded, but if something has
gone wrong - a double charge, a membership that never activated, a payment made by
a child without a parent's permission - email us and we will fix it rather than
argue about it.

A one-off tip is a tip, not a purchase. If you tipped at or above the monthly
price you can claim it as membership on the Support page; below that it buys
nothing and grants nothing, which the Support page says before you pay.

**Amount and tier.** The current price is shown on the Support page and is the
authoritative one; it is served from the same setting that decides what a payment
buys, so the two cannot disagree. If the price changes, existing memberships keep
their current terms until they lapse.

## Your content

Robot names, usernames, and anything else you type stay yours. You give us
permission to display them where you would expect: leaderboards, profiles, match
results, and replays.

## What we do not promise

DSIM is provided **as is**, free of charge for the parts that are free. We do not
guarantee it will be available, bug-free, or that records and ratings will survive
a season reset or a balance change. It is a practice tool, not a system of record.

To the fullest extent the law allows, we are not liable for indirect or
consequential loss arising from your use of it.

## Not affiliated with FIRST

DSIM is an independent, unofficial project. It is **not** affiliated with,
endorsed by, or sponsored by *FIRST*, FTC, RTX, or any of their partners. Game
names and rules are referenced for the purpose of simulating the competition.

## Ending things

You can stop using DSIM and delete your account at any time - there is a **Delete
account** button on your Profile page, and it takes effect immediately. We may
suspend an account that breaks these terms, and will say why where we reasonably
can. If we suspend a supporter's account for a reason that is not their fault, we
refund the unused part of their membership.

## Governing law

These terms are governed by the law of **${LEGAL_JURISDICTION}**, and its courts
have jurisdiction over any dispute. If you are a consumer, this does not take away
the protections of the law where you live - you can always bring a claim there.

## Changes

Material changes to these terms are announced in the app, and the date at the top of
the page changes. If a change affects a live membership, it takes effect for that
membership only when it next renews.

## Contact

**${LEGAL_CONTACT}**
`;
