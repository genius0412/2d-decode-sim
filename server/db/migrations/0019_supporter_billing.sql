-- Supporter billing, round 2: automatic RENEWAL and amount-aware grants.
--
-- 0018 shipped a manual-claim-only model: the buyer pasted a Ko-fi transaction id
-- and got exactly one month, for any payment of any size. Two defects followed
-- from that, and this migration is what fixes them.
--
-- 1. A MONTHLY membership never renewed. Ko-fi sends each cycle as a fresh
--    webhook with a new message_id and a new transaction id, and nothing tied it
--    back to the account that claimed cycle one — so the supporter silently
--    lapsed and had to re-claim by hand every month. `profiles.kofi_email` is the
--    link: the first manual claim records WHO paid, and every later payment from
--    that same address is granted automatically.
--
--    The index is UNIQUE so one Ko-fi subscription cannot feed several accounts.
--    Partial (`where kofi_email is not null`) because almost no profile has one.
--    Emails are stored already-lowercased by the repo, so a plain unique index is
--    the right comparison — no case-folding expression to keep in sync.
--
-- 2. Grants were amount-blind: a $1 tip bought the same month as the tier. The
--    columns below record what a payment was actually WORTH so the decision is
--    auditable after the fact, rather than recomputed from env that may since
--    have changed. `months = 0` is a real, meaningful value — the payment was
--    recorded and is claimable-by-nobody (a thank-you tip below the tier).
--
-- Purely ADDITIVE (add column if not exists), so rolling back to a server without
-- it is safe: 0018's columns are all still present and still mean what they did.

alter table profiles add column if not exists kofi_email text;

create unique index if not exists profiles_kofi_email_idx
  on profiles (kofi_email)
  where kofi_email is not null;

-- Ko-fi's membership tier name ('Supporter'), null for one-off tips and shop orders
alter table kofi_payments add column if not exists tier_name text;

-- months this payment was worth when it landed. 0 = below the supporter tier.
alter table kofi_payments add column if not exists months integer not null default 0;

-- true when the webhook attached this to an account by matching profiles.kofi_email,
-- false when a human pasted the transaction id. Purely for support/audit: "why does
-- this person have a membership?" should be answerable from the row.
alter table kofi_payments add column if not exists auto_claimed boolean not null default false;

-- Chargebacks and refunds. Set by an admin; the entitlement itself is revoked
-- separately (supporter_until is a running instant, not a derived value), but the
-- payment row must record that this money went away or the next audit re-grants it.
alter table kofi_payments add column if not exists refunded_at timestamptz;

-- Every change to supporter_until, including admin comps and revocations. Small,
-- append-only, and the only way to answer "who gave this account a membership and
-- when" once both a webhook and an admin can write the same field.
create table if not exists supporter_grants (
  id          bigserial   primary key,
  user_id     text        not null references profiles(user_id) on delete cascade,
  -- 'kofi' | 'admin' | 'revoke'
  source      text        not null,
  -- months added; negative or zero for a revocation
  months      integer     not null,
  -- supporter_until AFTER this change (null when revoked)
  until       timestamptz,
  -- admin user id, ko-fi message id, or a free-text reason
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists supporter_grants_user_idx
  on supporter_grants (user_id, created_at desc);
