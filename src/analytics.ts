/**
 * Analytics — the minimum needed to tell whether any of this monetization works.
 *
 * Without it there is no way to answer the only questions that matter after
 * launch: does anyone reach the Support page, does anyone click through to Ko-fi,
 * does a claim ever succeed, and do the ad columns shorten sessions. Shipping
 * ads and a paid tier with no measurement means tuning them by vibes.
 *
 * WHY VERCEL ANALYTICS and not something hand-rolled: the site already deploys
 * on Vercel, it is cookieless and stores no personal data (so it needs no consent
 * banner and adds nothing to the privacy policy's third-party list beyond the
 * host we already name), and the alternative — a bespoke events table on the game
 * server — would mean building session attribution, bot filtering, and a
 * dashboard, all of which are solved problems.
 *
 * PRIVACY RULE FOR EVERY EVENT BELOW: names and ids never leave the app. The
 * properties here are counts and enum-ish strings, never a user id, username,
 * email, or Ko-fi transaction id. An analytics payload is the easiest place in a
 * codebase to leak personal data by accident, so the rule is "no identifiers",
 * not "be careful".
 */
import { track } from '@vercel/analytics';

/** OFF unless explicitly enabled, matching how ads and auth are gated. A
 *  self-hosted or Electron build should not be firing beacons at a host it does
 *  not run on. */
const ENABLED = (import.meta.env.VITE_ANALYTICS as string | undefined)?.trim() === '1';

export function analyticsEnabled(): boolean {
  return ENABLED;
}

/** the events we care about, named so a dashboard reads as a funnel top-to-bottom */
export type AnalyticsEvent =
  | 'support_view' // reached the Support page
  | 'support_kofi_click' // clicked through to Ko-fi
  | 'support_claim_ok' // a claim succeeded
  | 'support_claim_fail' // a claim was rejected (see `reason`)
  | 'ads_shown' // an ad unit actually rendered
  | 'account_deleted';

export function trackEvent(
  event: AnalyticsEvent,
  props?: Record<string, string | number | boolean>,
): void {
  if (!ENABLED) return;
  try {
    track(event, props);
  } catch {
    /* analytics must never be able to break a page it is only observing */
  }
}
