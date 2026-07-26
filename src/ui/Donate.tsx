import { useEffect, useState } from 'react';
import { APP_NAME, LINKS } from '../seasons';
import { claimKofiPayment, fetchEntitlements, fetchPricing, type TierPrice } from '../net/api';
import { useAds } from '../ads/AdsProvider';
import { isElectron } from '../ads/adsense';
import { authEnabled } from '../lib/authClient';
import { MAX_SAVED_STARTS, MAX_SAVED_STARTS_SUPPORTER } from '../config';
import { trackEvent } from '../analytics';

/**
 * Donate / supporter page.
 *
 * Payment happens entirely on Ko-fi — we never touch card details, and there is
 * no checkout to build. What lives here is the CLAIM step: Ko-fi identifies a
 * buyer by the email they paid with, which frequently is not the email on their
 * DSIM account (a student paying through a parent's PayPal is the ordinary case,
 * not the edge case). Rather than guess at a match, the buyer pastes the
 * transaction id Ko-fi gave them and the server attaches the payment.
 *
 * That claim happens ONCE. It also LINKS the payer address, so every later
 * payment from it renews the membership with no second visit here — the first
 * version of this page required a fresh claim every month, which is not a
 * subscription so much as a chore.
 *
 * Perks are deliberately cosmetic or convenience. Nothing here may affect how a
 * robot drives or scores — that is a product rule, stated in the terms, and it
 * is the reason a ranked opponent never has to wonder whether they were outspent.
 * Every perk listed below is BUILT; do not add one here before it exists.
 */
export function Donate({ signedIn }: { signedIn: boolean }) {
  const { supporter, checked } = useAds();
  const [txn, setTxn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [price, setPrice] = useState<TierPrice | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [autoRenews, setAutoRenews] = useState(false);

  // Funnel step 1. Fires once per mount, and carries only WHETHER the visitor is
  // already a supporter — never who they are (see the privacy rule in analytics.ts).
  useEffect(() => {
    trackEvent('support_view', { supporter });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The price is SERVED, not hardcoded, so the number on this page can never
  // drift from the one `server/kofi.ts` actually charges — a page promising a
  // tier at a price the grant policy rejects is the worst possible bug here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (authEnabled && signedIn) {
        const e = await fetchEntitlements();
        if (cancelled) return;
        setUntil(e.supporterUntil);
        setAutoRenews(e.autoRenews);
        if (e.price) {
          setPrice(e.price);
          return;
        }
      }
      const p = await fetchPricing();
      if (!cancelled) setPrice(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const priceLabel = price
    ? `${price.currency} ${price.amount.toFixed(2)} / month`
    : 'see Ko-fi for the price';

  const claim = async (): Promise<void> => {
    const id = txn.trim();
    if (!id || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await claimKofiPayment(id);
      const date = r.supporterUntil ? new Date(r.supporterUntil).toLocaleDateString() : null;
      setUntil(r.supporterUntil);
      setAutoRenews(true); // a successful claim always links the payer address
      setMsg({
        kind: 'ok',
        text: date
          ? `Thank you - you're a supporter until ${date}. Ads are off, and future payments renew automatically.`
          : 'Thank you - your supporter benefits are active.',
      });
      setTxn('');
      trackEvent('support_claim_ok', { months: r.months });
    } catch (e) {
      // the MESSAGE, not the transaction id — the id identifies a payment and a
      // payer, and belongs nowhere near an analytics payload
      trackEvent('support_claim_fail', {
        reason: e instanceof Error ? e.message.slice(0, 60) : 'unknown',
      });
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Support</p>
      <h1 className="ds-h1">Support DSIM</h1>
      <p className="ds-sub">
        DSIM is free and stays free. Servers and a database are not - this is what keeps them
        running.
      </p>

      {/* The desktop build carries NO ads — AdSense does not permit serving inside
          an application wrapper — so a desktop player costs bandwidth and server
          time and returns nothing. Saying so plainly is both true and the most
          persuasive thing on this page; it is deliberately a statement of fact,
          not a guilt trip, and it never appears on the web where it would be a
          lie (the web build does show ads). */}
      {isElectron() && (
        <p className="ds-hint" style={{ marginBottom: 18 }}>
          You're on the desktop app, which never shows ads - supporting is the only way it
          pays for itself.
        </p>
      )}

      {checked && supporter && (
        <section className="ds-panel">
          <div className="ds-panel-h">
            <span className="ds-panel-title">You're a supporter</span>
            <span className="ds-count">thank you</span>
          </div>
          <div style={{ padding: 16 }}>
            <p className="ds-hint">
              Ads are off across the site and your badge is live
              {until ? `, through ${new Date(until).toLocaleDateString()}` : ''}.
            </p>
            <p className="ds-hint" style={{ marginTop: 8 }}>
              {autoRenews
                ? 'Your Ko-fi payments renew this automatically - nothing to claim each month. Cancel any time from your Ko-fi account; you keep the benefits until the paid period ends.'
                : "This membership isn't linked to a Ko-fi account yet, so it won't renew on its own. Claim a payment below to link it."}
            </p>
          </div>
        </section>
      )}

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Supporter</span>
          <span className="ds-count">{priceLabel}</span>
        </div>
        <div style={{ padding: 16 }}>
          <ul className="ds-perks">
            <li>No advertising, anywhere on the site</li>
            <li>A supporter badge on your profile, the leaderboards, and the lobby</li>
            <li>
              {MAX_SAVED_STARTS_SUPPORTER} saved start positions per side, up from{' '}
              {MAX_SAVED_STARTS}
            </li>
            <li>Cosmetic chassis colours in the robot builder</li>
          </ul>
          <p className="ds-hint" style={{ marginTop: 12 }}>
            Supporter perks are cosmetic or convenience only. They never affect how a robot drives
            or scores - ranked stays decided by driving.
          </p>
          <a
            className="ds-cta"
            href={LINKS.kofi}
            target="_blank"
            rel="noreferrer"
            style={{ marginTop: 16 }}
            onClick={() => trackEvent('support_kofi_click')}
          >
            Support on Ko-fi ↗
          </a>
        </div>
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Already paid?</span>
          <span className="ds-count">claim it once</span>
        </div>
        <div style={{ padding: 16 }}>
          <p className="ds-hint">
            Ko-fi bills through PayPal, so the email on your payment often isn't the one on your
            DSIM account. Paste the transaction ID from your Ko-fi receipt and we'll attach it -
            just once. After that, every renewal is applied automatically.
          </p>
          {!authEnabled || !signedIn ? (
            <p className="ds-hint" style={{ marginTop: 12 }}>
              Sign in first - a membership has to attach to an account.
            </p>
          ) : (
            <>
              <div className="ds-claim-row">
                <input
                  className="ds-input"
                  value={txn}
                  onChange={(e) => setTxn(e.target.value)}
                  placeholder="Ko-fi transaction ID"
                  aria-label="Ko-fi transaction ID"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void claim();
                  }}
                />
                <button className="ds-btn primary" onClick={() => void claim()} disabled={busy || !txn.trim()}>
                  {busy ? 'Checking…' : 'Claim'}
                </button>
              </div>
              {msg && (
                <p className={`ds-claim-msg ${msg.kind}`} role="status">
                  {msg.text}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">One-off</span>
          <span className="ds-count">no account needed</span>
        </div>
        <div style={{ padding: 16 }}>
          {/* Two sentences, because the second one only makes sense with a real
              number in it. When the price hasn't loaded (server asleep, or an
              older server with no /api/pricing), `priceLabel` is the words "see
              Ko-fi for the price" — splicing that into "a tip of ___ or more"
              produces a sentence that reads like a bug, so it is omitted rather
              than filled with a placeholder. */}
          <p className="ds-hint">
            Prefer to just buy the project a coffee? One-off tips go through the same Ko-fi page.
            {price
              ? ` A tip of ${price.currency} ${price.amount.toFixed(2)} or more can be claimed above for membership - larger tips buy proportionally more months, and anything below that is gratefully received as a plain tip with nothing to claim.`
              : ' A tip at or above the monthly price can be claimed above for membership; anything below it is gratefully received as a plain tip, with nothing to claim.'}
          </p>
        </div>
      </section>
    </>
  );
}
