/**
 * Google AdSense integration — the single place that decides whether ads run.
 *
 * Everything is OPT-IN through env: with `VITE_ADSENSE_CLIENT` unset (the default,
 * and the state of every build until the AdSense application is approved) nothing
 * here loads, no script tag is injected, and `<AdSlot>` renders nothing. That keeps
 * the ad layer completely dormant rather than half-live.
 *
 * Three hard rules encoded here, each of which is a policy violation if broken:
 *
 *  1. NEVER in the desktop build. AdSense does not permit serving inside a
 *     non-browser application wrapper, and an Electron shell is exactly that.
 *  2. NEVER on touch devices. Not a policy rule but a product one — the compact
 *     mobile layout has no free space, and the field would have to shrink.
 *  3. NEVER for supporters. Removing ads is the headline membership benefit, so
 *     the gate has to exist from the first commit rather than be retrofitted.
 *
 * Rule 3 is reactive (it resolves asynchronously after sign-in) and so lives in
 * `AdsProvider`, not here. This module owns only the static facts.
 */

/** publisher id, e.g. `ca-pub-1234567890123456`. Absent ⇒ ads are fully off. */
const CLIENT = (import.meta.env.VITE_ADSENSE_CLIENT as string | undefined)?.trim() || '';

/** per-unit slot ids, created in the AdSense dashboard. Absent ⇒ that unit is off. */
const SLOT_GAME = (import.meta.env.VITE_ADSENSE_SLOT_GAME as string | undefined)?.trim() || '';
const SLOT_MENU = (import.meta.env.VITE_ADSENSE_SLOT_MENU as string | undefined)?.trim() || '';
const SLOT_RESULTS = (import.meta.env.VITE_ADSENSE_SLOT_RESULTS as string | undefined)?.trim() || '';

/**
 * PERSONALIZED ADS ARE OPT-IN, and the default is deliberately the low-revenue one.
 *
 * DSIM simulates FIRST Tech Challenge, which is grades 7–12 — a meaningful slice
 * of players are 12 or 13. The whole sim is playable SIGNED OUT, so for most ad
 * impressions there is no account, no stated age, and therefore no basis on which
 * to claim an adult audience. Serving behaviourally-targeted ads to that audience
 * by default is the wrong side of both Google's policies and the plain reading of
 * COPPA/GDPR-K, and the downside of being wrong (a policy strike, an account
 * termination, an angry parent) dwarfs the CPM difference.
 *
 * So: non-personalized by default, and `VITE_ADSENSE_PERSONALIZED=1` is the
 * deliberate act of an operator who has an age signal and has decided otherwise.
 */
const PERSONALIZED =
  (import.meta.env.VITE_ADSENSE_PERSONALIZED as string | undefined)?.trim() === '1';

/**
 * Tag every request as "under the age of consent" (Google's TFUAC).
 *
 * On by default for the same reason, and it is the WEAKER of the two available
 * signals on purpose. The stronger one — `tagForChildDirectedTreatment`, the
 * COPPA flag — would assert that the whole site is directed at under-13s, which
 * is not true (the terms set a 13+ minimum) and would be an inaccurate
 * declaration rather than a cautious one. TFUAC says "treat these users as below
 * the age of consent", which is exactly what is true of some of them and is safe
 * for the rest. `VITE_ADSENSE_TFCD=1` is there if the operator ever needs the
 * stronger flag.
 */
const TFUAC = (import.meta.env.VITE_ADSENSE_TFUAC as string | undefined)?.trim() !== '0';
const TFCD = (import.meta.env.VITE_ADSENSE_TFCD as string | undefined)?.trim() === '1';

export const AD_TFUAC = TFUAC;
export const AD_TFCD = TFCD;

export const ADSENSE_CLIENT = CLIENT;

/**
 * The ad units we run.
 *  - `menu`    — shell pages (leaderboards, records, changelog). The SAFE
 *                inventory: no gameplay, no clearance rule, no frame budget.
 *  - `results` — the post-match results screen. Also safe, and it is the moment
 *                a player is actually reading rather than driving.
 *  - `game`    — the columns flanking the live field. The highest-risk unit: it
 *                sits beside a 60 Hz canvas and is subject to AdSense's
 *                game-adjacency clearance rule. Kept OFF unless its own slot id
 *                is set, so the safe units can ship first.
 */
export type AdUnit = 'game' | 'menu' | 'results';

export function slotFor(unit: AdUnit): string {
  if (unit === 'game') return SLOT_GAME;
  if (unit === 'results') return SLOT_RESULTS;
  return SLOT_MENU;
}

/**
 * Running inside the Electron desktop shell? Checked two ways because each alone
 * is fragile: the user-agent string is the direct signal, and a relative BASE_URL
 * is what `vite.config.ts` sets when `ELECTRON=1` (so it holds even if Electron
 * ever stops advertising itself).
 */
export function isElectron(): boolean {
  if (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)) return true;
  return import.meta.env.BASE_URL === './';
}

/** a coarse pointer means the compact layout, which has no room to give away */
function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Can ads run in this build at all? Static only — it says nothing about whether
 * the current user is a supporter (see `AdsProvider`).
 */
export function adsConfigured(): boolean {
  return !!CLIENT && !isElectron() && !isTouch();
}

declare global {
  interface Window {
    adsbygoogle?: unknown[] & { requestNonPersonalizedAds?: number };
    googlefc?: Record<string, unknown>;
    __tcfapi?: unknown;
  }
}

let loading: Promise<void> | null = null;
let cmpLoaded = false;

/**
 * Google Funding Choices — the consent management platform.
 *
 * REQUIRED, not optional, if any traffic comes from the EEA, the UK, or
 * Switzerland: under Google's EU user consent policy a publisher must use a
 * Google-certified CMP, and without one Google stops serving ads to those users
 * entirely. So the choice is not "CMP or more revenue", it is "CMP or no
 * European revenue at all".
 *
 * Funding Choices is the free first-party option and binds to the same publisher
 * id as the ad tag, which is why there is no separate key to configure — the
 * MESSAGE itself (which regions it targets, what it says) is authored in the
 * AdSense dashboard under Privacy & messaging, and this only loads it.
 *
 * The `signalGooglefcPresent` stub below is Google's own snippet, and it is
 * load-bearing rather than ceremonial: it plants a hidden iframe carrying
 * `__uspapiLocator`/`googlefcPresent` so the ad tag can tell that a CMP is on its
 * way and hold the auction, instead of racing ahead and requesting ads before
 * consent is known. Skipping it is how sites end up serving an un-consented
 * impression on first paint.
 */
export function loadCmp(): void {
  if (cmpLoaded || !CLIENT || isElectron()) return;
  cmpLoaded = true;

  const pub = CLIENT.replace(/^ca-/, '');
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://fundingchoicesmessages.google.com/i/${encodeURIComponent(pub)}?ers=1`;
  document.head.appendChild(s);

  // Google's signalGooglefcPresent(), inlined rather than injected as a <script>
  // string so it survives a strict CSP without needing 'unsafe-inline'.
  const signal = (): void => {
    if (!window.frames['googlefcPresent' as unknown as number]) {
      if (document.body) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText =
          'width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;';
        iframe.style.display = 'none';
        iframe.name = 'googlefcPresent';
        document.body.appendChild(iframe);
      } else {
        setTimeout(signal, 0);
      }
    }
  };
  signal();
}

/** true when this build ships a CMP. Surfaced so the footer only offers a consent
 *  control when there is actually one to open. */
export function cmpEnabled(): boolean {
  return !!CLIENT && !isElectron();
}

/**
 * Reopen the consent message.
 *
 * Required, not a nicety: consent that cannot be withdrawn as easily as it was
 * given is not valid consent under the GDPR, and Google's own CMP policy expects
 * publishers to expose this. `googlefc.showRevocationMessage` is the documented
 * entry point; it only exists once Funding Choices has loaded AND the visitor is
 * in a region the message targets, which is why the caller must handle `false`
 * rather than assume a dialog appeared.
 */
export function showConsentSettings(): boolean {
  const fc = window.googlefc as { showRevocationMessage?: () => void } | undefined;
  if (typeof fc?.showRevocationMessage !== 'function') return false;
  fc.showRevocationMessage();
  return true;
}

/**
 * Inject the AdSense script, at most once per page.
 *
 * Deliberately lazy: this is never called at boot. The sim runs a 60 Hz rAF loop
 * against a Rapier physics step, and pulling a third-party script into startup
 * costs frames on exactly the surface the whole product is judged on. The script
 * loads when the first slot mounts and not before.
 *
 * A failed load resolves rather than rejects — no ad is a cosmetic problem, and it
 * must never surface as an error to someone trying to drive.
 */
export function ensureAdSenseLoaded(): Promise<void> {
  if (!adsConfigured()) return Promise.resolve();
  if (loading) return loading;
  // Belt and braces: normally the CMP has already loaded at boot (`main.tsx`),
  // which it must, because index.html hardcodes the ad tag and a CMP that waited
  // for the first slot would arrive after it. This call only matters if boot was
  // skipped. Not awaited: its job is to be PRESENT before an auction (the
  // `googlefcPresent` signal makes the tag wait), and awaiting it would block ads
  // on a third-party script an extension may have killed.
  loadCmp();
  loading = new Promise<void>((resolve) => {
    // Page-level ad settings must be pushed BEFORE the tag loads — the tag reads
    // `window.adsbygoogle` on arrival, and a flag set afterwards applies to
    // nothing. See the comment on PERSONALIZED for why this default is the
    // conservative one.
    const ads = (window.adsbygoogle = window.adsbygoogle || []);
    if (!PERSONALIZED) ads.requestNonPersonalizedAds = 1;

    const existing = document.querySelector('script[data-dsim-adsense]');
    if (existing) return resolve();
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.dsimAdsense = '1';
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CLIENT)}`;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // blocked or offline — degrade silently
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Hand a mounted `<ins>` to AdSense. Safe to call more than once for the same
 * element: React StrictMode runs effects twice in development, and pushing the
 * same slot twice makes AdSense throw "already have ads in them".
 */
export function fillSlot(el: HTMLElement): void {
  if (el.dataset.adsbygoogleStatus) return; // AdSense stamps this once filled
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch {
    /* blocked by an extension, or the script never arrived — leave the box empty */
  }
}
