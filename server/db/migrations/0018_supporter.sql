-- Supporter memberships (Ko-fi).
--
-- One nullable column on `profiles` rather than an entitlements table: supporter
-- status is a 1:1 fact about an account, which is exactly the pattern
-- 0003_profile_settings.sql and 0006_username.sql already established. An
-- expiry INSTANT rather than a boolean, because the membership is a recurring
-- subscription — storing "is a supporter" would need a nightly job to expire it,
-- whereas an instant lets every read answer the question itself with `now()`.
--
-- Ko-fi identifies buyers by email, which need not match the Neon Auth email, so
-- payments land in `kofi_payments` FIRST and are only attached to an account when
-- the buyer claims them. That table is also the idempotency guard: Ko-fi retries
-- webhooks, and `message_id` is its per-event unique id.
--
-- Purely ADDITIVE (add column if not exists / create table if not exists), so a
-- rollback to a server without this migration is safe.

alter table profiles add column if not exists supporter_until timestamptz;

-- index the expiry so "who is currently a supporter" stays cheap once the badge
-- is rendered on leaderboards (a scan per board row would not be)
create index if not exists profiles_supporter_idx
  on profiles (supporter_until)
  where supporter_until is not null;

create table if not exists kofi_payments (
  -- Ko-fi's own event id. PRIMARY KEY because Ko-fi retries delivery and we must
  -- never grant two months for one payment.
  message_id    text        primary key,
  -- 'Donation' | 'Subscription' | 'Shop Order' as reported by Ko-fi
  kind          text        not null,
  -- buyer email as Ko-fi reports it. Stored to match a claim, never displayed.
  email         text,
  -- Ko-fi's public transaction id, which is what the buyer pastes to claim
  transaction_id text,
  amount        numeric(10, 2),
  currency      text,
  -- is this a recurring subscription payment (vs a one-off tip)?
  is_subscription boolean   not null default false,
  -- the account that claimed this payment, once claimed
  claimed_by    text        references profiles(user_id) on delete set null,
  claimed_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- claim lookup is by transaction id, and it must be unique so two accounts cannot
-- race to claim the same payment
create unique index if not exists kofi_payments_txn_idx
  on kofi_payments (transaction_id)
  where transaction_id is not null;
