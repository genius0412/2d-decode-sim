/**
 * Ko-fi payment policy — how much membership a payment buys.
 *
 * Deliberately a PURE module with no database and no environment reads at import
 * time, because this is the one piece of the payment path that decides what
 * someone gets for their money and it therefore has to be testable on its own
 * (`scripts/dbtest.ts` exercises it directly). Everything stateful lives in
 * `db/repo.ts`; everything protocol-shaped lives in `api.ts`.
 *
 * The rule this replaces granted one month for ANY Ko-fi event, so a one-dollar
 * thank-you tip bought exactly what the subscription did.
 */

/** the fields of a Ko-fi webhook payload this policy actually reads */
export interface KofiPayment {
  /** 'Donation' | 'Subscription' | 'Shop Order' */
  kind: string;
  /** decimal string in the CREATOR's currency, e.g. "5.00" */
  amount: string | null;
  /** ISO 4217, e.g. "USD" */
  currency: string | null;
  /** true for a recurring membership payment (first or renewal) */
  isSubscription: boolean;
  /** membership tier name, e.g. "Supporter". Null for tips and shop orders. */
  tierName: string | null;
}

export interface KofiPolicy {
  /** the monthly price of the supporter tier, in `currency` */
  monthlyPrice: number;
  /** the currency Ko-fi settles in for this page */
  currency: string;
  /** cap on months a single one-off payment can buy */
  maxMonths: number;
}

/** Ko-fi settles in the creator's chosen currency, so these are page settings. */
export const DEFAULT_POLICY: KofiPolicy = { monthlyPrice: 3, currency: 'USD', maxMonths: 24 };

/** read the policy from env, falling back to the defaults above */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): KofiPolicy {
  const price = Number(env.KOFI_MONTHLY_PRICE);
  const max = Number(env.KOFI_MAX_MONTHS);
  return {
    monthlyPrice: Number.isFinite(price) && price > 0 ? price : DEFAULT_POLICY.monthlyPrice,
    currency: (env.KOFI_CURRENCY || DEFAULT_POLICY.currency).toUpperCase(),
    maxMonths: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_POLICY.maxMonths,
  };
}

/**
 * How many months of membership this payment is worth. `0` means "recorded, but
 * it buys nothing" — a tip below the tier price, or a payment in a currency this
 * page does not settle in.
 *
 * A SUBSCRIPTION payment is always worth exactly one month regardless of amount:
 * it IS the billing cycle, and Ko-fi has already decided what the buyer agreed
 * to. Reading the amount there would double-count an annual tier or under-grant
 * a discounted one.
 *
 * A ONE-OFF payment (tip or shop order) buys `floor(amount / monthlyPrice)`
 * months, so someone who prefers to pay for half a year in one go can, without
 * needing a second tier. Capped so a typo or a very generous tip cannot mint a
 * decade of membership that no one can revoke by cancelling.
 *
 * Currency mismatches grant NOTHING rather than guessing an exchange rate. Ko-fi
 * settles in one currency per page, so this should never fire in practice; if it
 * does, an admin comp is the correct remedy and the payment row is still there.
 */
export function monthsFor(p: KofiPayment, policy: KofiPolicy = DEFAULT_POLICY): number {
  const currency = (p.currency ?? '').toUpperCase();
  if (currency && currency !== policy.currency) return 0;

  if (p.isSubscription) return 1;

  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  // The epsilon is on the QUOTIENT, and it is tiny on purpose. It guards one
  // thing only: binary floating point, where an exact 9.00 / 3.00 can land at
  // 2.9999999999999996 and floor to two months instead of three. It is NOT a
  // grace on the price — $2.99 is below a $3.00 tier and buys nothing, which is
  // the honest answer and the one the claim message explains.
  const months = Math.floor(amount / policy.monthlyPrice + 1e-9);
  return Math.max(0, Math.min(policy.maxMonths, months));
}

/** a human explanation for a payment that bought nothing — shown on the claim form */
export function whyNoMonths(p: KofiPayment, policy: KofiPolicy = DEFAULT_POLICY): string {
  const currency = (p.currency ?? '').toUpperCase();
  if (currency && currency !== policy.currency) {
    return `That payment was in ${currency}, and memberships are priced in ${policy.currency}. Email us and we'll sort it out.`;
  }
  return `Thank you for the tip! It's below the ${policy.currency} ${policy.monthlyPrice.toFixed(2)} monthly tier, so it doesn't start a membership.`;
}
