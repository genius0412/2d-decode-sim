import { useEffect, useRef } from 'react';
import {
  ADSENSE_CLIENT,
  AD_TFCD,
  AD_TFUAC,
  ensureAdSenseLoaded,
  fillSlot,
  slotFor,
  type AdUnit,
} from '../ads/adsense';
import { useAds } from '../ads/AdsProvider';
import { trackEvent } from '../analytics';

/** fixed pixel sizes per unit. See the comment on `reserved boxes` below. */
const SIZE: Record<AdUnit, { w: number; h: number }> = {
  // 160x600 wide skyscraper. Chosen over the better-earning 300x250 because
  // AdSense requires >=150px of clearance between an ad and a game, and only a
  // 160px unit leaves that clearance on a 1366- or 1440-wide laptop.
  game: { w: 160, h: 600 },
  // menu + results pages are not game-play pages, so the clearance rule does not
  // apply and the standard medium rectangle (the best-filled size in AdSense's
  // inventory) is the right unit.
  menu: { w: 300, h: 250 },
  results: { w: 300, h: 250 },
};

/**
 * One AdSense unit.
 *
 * RESERVED BOXES: the wrapper is given the unit's exact width and height up front,
 * before any creative arrives. Two reasons, and the second is enforced by CI:
 *
 *  - Late-loading ads are the classic source of layout shift, and this app's chrome
 *    sits in absolutely-positioned overlays that would jump if the flow moved.
 *  - `npm run shiftaudit` fails the build if ANY element in the document moves more
 *    than 0.5px while an interactive element is hovered. An ad iframe that resizes
 *    between the audit's two measurements reads as exactly that kind of shift.
 *
 * Renders nothing at all unless ads are configured AND the user is not a supporter
 * AND this unit has a slot id — so an un-approved or half-configured AdSense setup
 * degrades to empty space rather than a broken box.
 */
/**
 * Will this unit actually render anything?
 *
 * Callers need this to decide whether to lay out the CONTAINER at all: an empty
 * 310px ad column that reserves its width when AdSense is unconfigured would push
 * the field off-centre for no reason. `AdSlot` returning null is not enough on its
 * own — the column around it has to disappear too.
 */
export function useAdUnitActive(unit: AdUnit): boolean {
  const { showAds } = useAds();
  return showAds && !!slotFor(unit);
}

/**
 * The shell-page ad, wrapper included.
 *
 * A component rather than a bare `<AdSlot unit="menu">` because the SPACING
 * around it must disappear along with the unit: an empty 32px margin above
 * nothing is the tell-tale gap every ad-blocked page has, and this app's shell
 * pages end in a footer where that gap is very visible.
 */
export function MenuAd() {
  if (!useAdUnitActive('menu')) return null;
  return (
    <div className="menu-ad">
      <AdSlot unit="menu" />
    </div>
  );
}

/** the post-match results ad. Same reasoning as `MenuAd`; separate unit id so
 *  the two can be enabled, priced, and reported on independently. */
export function ResultsAd() {
  if (!useAdUnitActive('results')) return null;
  return (
    <div className="menu-ad">
      <AdSlot unit="results" />
    </div>
  );
}

export function AdSlot({ unit, className }: { unit: AdUnit; className?: string }) {
  const ref = useRef<HTMLModElement>(null);
  const slot = slotFor(unit);
  const active = useAdUnitActive(unit);

  useEffect(() => {
    if (!active) return;
    // which UNITS actually render, so "the game columns cost us N% of sessions"
    // is answerable. The unit name is the only property — no user, no page id.
    trackEvent('ads_shown', { unit });
    let cancelled = false;
    void ensureAdSenseLoaded().then(() => {
      if (cancelled || !ref.current) return;
      fillSlot(ref.current);
    });
    return () => {
      cancelled = true;
    };
  }, [active, unit]);

  if (!active) return null;

  const { w, h } = SIZE[unit];
  // the reserved box must include the "Advertisement" label, or the unit overflows
  // its own container by the label's height and the box stops being exact
  const LABEL_H = 14;
  return (
    <div
      className={`ad-slot${className ? ' ' + className : ''}`}
      style={{ width: w, height: h + LABEL_H }}
    >
      {/* the label is required by AdSense: ads must be distinguishable from content */}
      <span className="ad-slot-label">Advertisement</span>
      <ins
        ref={ref}
        className="adsbygoogle"
        style={{ display: 'inline-block', width: w, height: h }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={slot}
        // Audience signals, per unit. React drops a `false` on a data- attribute
        // but renders "false" for a string, so these are conditional rather than
        // ternary — the ABSENCE of the attribute is what means "not tagged", and
        // `data-tag-...="false"` would be read as a value, not as an opt-out.
        {...(AD_TFUAC ? { 'data-tag-for-under-age-of-consent': '1' } : {})}
        {...(AD_TFCD ? { 'data-tag-for-child-directed-treatment': '1' } : {})}
      />
    </div>
  );
}
