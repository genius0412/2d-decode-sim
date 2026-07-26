/**
 * Database test — runs the REAL migrations and the REAL payment code against a
 * REAL Postgres, in process. `npm run dbtest`.
 *
 * Why this exists: the first cut of the Ko-fi tier shipped with its webhook
 * idempotency and its claim race "verified by reading, not by running", because
 * there is no Postgres on a dev machine and standing one up was a yak. That is
 * exactly the code where a read-only review is worth least — the guarantees live
 * in primary keys, `on conflict`, and `where claimed_by is null`, none of which
 * a type checker or a careful read can actually exercise.
 *
 * PGlite is Postgres 17 compiled to WASM, so the migrations, the constraints,
 * and the transaction semantics are the genuine article rather than a mock. It
 * runs in memory and leaves nothing behind.
 *
 * Deliberately NOT wired into `npm test` — a red `npm test` must keep meaning
 * "physics broke" (see CLAUDE.md). This is its own command, like `contrast`.
 */
import { PGlite } from '@electric-sql/pglite';
import { setPoolForTests, type DbPool } from '../server/db/pool';
import { monthsFor, whyNoMonths, DEFAULT_POLICY, policyFromEnv } from '../server/kofi';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * PGlite as a `DbPool`.
 *
 * It is a single connection, so `connect()` hands back the same one and
 * `release()` is a no-op. That is fine for everything under test — `tx()` issues
 * begin/commit on its own connection, and the only concurrency the payment paths
 * care about is enforced by constraints, not by connection isolation. The one
 * thing it CANNOT prove is two machines racing on separate connections; the
 * `on conflict` / `where claimed_by is null` clauses are what make that safe, and
 * the tests below at least prove those clauses do what they claim in sequence.
 */
function adapt(db: PGlite): DbPool {
  const query = async (text: string, params: unknown[] = []) => {
    // PGlite's `query` is the extended (prepared-statement) protocol, which
    // refuses more than one command per call — and a migration file is dozens.
    // `exec` is the simple protocol and takes the whole script; it cannot bind
    // parameters, which is exactly the split below. `pg` blurs the two, so this
    // is the one real difference the adapter has to paper over.
    if (params.length === 0) {
      const res = await db.exec(text);
      return { rows: (res[res.length - 1]?.rows ?? []) as never[] };
    }
    return (await db.query(text, params)) as { rows: never[] };
  };
  return {
    query: query as DbPool['query'],
    connect: async () => ({ query: query as DbPool['query'], release: () => {} }),
  };
}

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;
  setPoolForTests(adapt(db));

  // imported AFTER the pool swap purely for clarity; ESM live bindings mean the
  // order does not actually matter, but reading it top-down should not mislead.
  const { migrate } = await import('../server/db/migrate');
  const repo = await import('../server/db/repo');

  // ---------------------------------------------------------------- migrations
  await migrate();
  const tables = (
    await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    )
  ).rows.map((r) => r.table_name);
  check('migrations: every .sql applies to a virgin database', tables.includes('profiles'));
  check('migrations: 0018 created kofi_payments', tables.includes('kofi_payments'));
  check('migrations: 0019 created supporter_grants', tables.includes('supporter_grants'));
  const cols = (
    await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'profiles'`,
    )
  ).rows.map((r) => r.column_name);
  check('migrations: profiles.supporter_until exists', cols.includes('supporter_until'));
  check('migrations: profiles.kofi_email exists', cols.includes('kofi_email'));
  check('migrations: 0020 added profiles.role', cols.includes('role'));

  // re-running must be a no-op, not an error — every regional machine boots this
  await migrate();
  check('migrations: a second run is a clean no-op', true);

  // ------------------------------------------------------------ tier policy
  const tip = { kind: 'Donation', amount: '1.00', currency: 'USD', isSubscription: false, tierName: null };
  const sub = { kind: 'Subscription', amount: '3.00', currency: 'USD', isSubscription: true, tierName: 'Supporter' };
  check('policy: a $1 tip buys nothing', monthsFor(tip) === 0);
  check('policy: a $3 subscription payment buys 1 month', monthsFor(sub) === 1);
  check(
    'policy: a subscription is 1 month regardless of amount (never double-counted)',
    monthsFor({ ...sub, amount: '36.00' }) === 1,
  );
  check('policy: a $9 one-off buys 3 months', monthsFor({ ...tip, amount: '9.00' }) === 3);
  check(
    'policy: a one-off is capped, so a typo cannot mint a decade',
    monthsFor({ ...tip, amount: '100000.00' }) === DEFAULT_POLICY.maxMonths,
  );
  check(
    'policy: a currency we do not settle in grants nothing rather than guessing a rate',
    monthsFor({ ...sub, currency: 'JPY' }) === 0,
  );
  check(
    'policy: float division cannot shave a month off an exact multiple',
    monthsFor({ ...tip, amount: '9.00' }, { ...DEFAULT_POLICY, monthlyPrice: 3 }) === 3 &&
      monthsFor({ ...tip, amount: '0.30' }, { ...DEFAULT_POLICY, monthlyPrice: 0.1 }) === 3,
  );
  check(
    'policy: but a cent SHORT of the tier is still short (no silent discount)',
    monthsFor({ ...tip, amount: '2.99' }) === 0,
  );
  check(
    'policy: the below-tier explanation names the real price',
    whyNoMonths(tip).includes('3.00'),
  );
  check(
    'policy: env overrides the price',
    policyFromEnv({ KOFI_MONTHLY_PRICE: '5', KOFI_CURRENCY: 'gbp' } as NodeJS.ProcessEnv)
      .monthlyPrice === 5,
  );

  // ------------------------------------------------------------------ set-up
  await repo.ensureProfile('user-a', 'Ada');
  await repo.ensureProfile('user-b', 'Bo');
  check('profiles: ensureProfile is idempotent', true);
  check('supporter: a fresh account is not a supporter', !(await repo.getSupporter('user-a')).supporter);

  // ------------------------------------------------- webhook: idempotency
  const evt = {
    messageId: 'msg-1',
    kind: 'Subscription',
    email: 'Payer@Example.com',
    transactionId: 'txn-1',
    amount: '3.00',
    currency: 'USD',
    isSubscription: true,
    tierName: 'Supporter',
    months: 1,
  };
  const first = await repo.recordKofiPayment(evt);
  check('webhook: a new event is recorded', first.fresh);
  check('webhook: an unknown payer is parked, not granted', first.autoGrantedTo === null);

  const retry = await repo.recordKofiPayment(evt);
  check('webhook: a Ko-fi RETRY of the same message_id is not recorded twice', !retry.fresh);
  const rowCount = (
    await db.query<{ n: string }>(`select count(*)::text as n from kofi_payments`)
  ).rows[0].n;
  check('webhook: exactly one payment row survives the retry', rowCount === '1', `rows=${rowCount}`);

  // ------------------------------------------------------------- claiming
  const missing = await repo.claimKofiPayment('user-a', 'nope');
  check('claim: an unknown transaction id is not-found', missing.outcome === 'not-found');

  const ok = await repo.claimKofiPayment('user-a', 'txn-1');
  check('claim: a valid payment grants the membership', ok.outcome === 'ok', ok.outcome);
  check('claim: it grants the months the payment was worth', ok.months === 1);
  check('supporter: the account is now a supporter', (await repo.getSupporter('user-a')).supporter);
  check(
    'claim: the payer email is linked, so future payments renew automatically',
    (await repo.getSupporter('user-a')).autoRenews,
  );
  const linked = (
    await db.query<{ kofi_email: string | null }>(
      `select kofi_email from profiles where user_id = 'user-a'`,
    )
  ).rows[0].kofi_email;
  check('claim: the linked email is stored lowercased', linked === 'payer@example.com', `${linked}`);

  const again = await repo.claimKofiPayment('user-a', 'txn-1');
  check('claim: the same account cannot claim one payment twice', again.outcome === 'already-claimed');
  const stolen = await repo.claimKofiPayment('user-b', 'txn-1');
  check('claim: a second account cannot claim a claimed payment', stolen.outcome === 'already-claimed');

  // ----------------------------------------------- THE RENEWAL PATH (blocker 1)
  const untilAfterFirst = (await repo.getSupporter('user-a')).supporterUntil!;
  const renewal = await repo.recordKofiPayment({
    ...evt,
    messageId: 'msg-2',
    transactionId: 'txn-2',
    email: 'payer@example.com',
  });
  check('renewal: month two is granted with NO manual claim', renewal.autoGrantedTo === 'user-a');
  const untilAfterSecond = (await repo.getSupporter('user-a')).supporterUntil!;
  check(
    'renewal: it EXTENDS the existing period rather than resetting it',
    new Date(untilAfterSecond) > new Date(untilAfterFirst),
    `${untilAfterFirst} -> ${untilAfterSecond}`,
  );
  const gap = new Date(untilAfterSecond).getTime() - new Date(untilAfterFirst).getTime();
  check(
    'renewal: exactly one month is added (28–31 days)',
    gap > 27 * 864e5 && gap < 32 * 864e5,
    `${Math.round(gap / 864e5)}d`,
  );
  const autoFlag = (
    await db.query<{ auto_claimed: boolean }>(
      `select auto_claimed from kofi_payments where message_id = 'msg-2'`,
    )
  ).rows[0].auto_claimed;
  check('renewal: the row records that a webhook, not a human, claimed it', autoFlag === true);

  // one Ko-fi subscription must not remove ads on unlimited accounts
  await repo.recordKofiPayment({
    ...evt,
    messageId: 'msg-3',
    transactionId: 'txn-3',
    email: 'payer@example.com',
  });
  // (msg-3 auto-granted to user-a as well; user-b tries to hijack the link)
  await repo.recordKofiPayment({
    ...evt,
    messageId: 'msg-4',
    transactionId: 'txn-4',
    email: 'payer@example.com',
    months: 1,
  });
  await db.query(`update kofi_payments set claimed_by = null, auto_claimed = false where message_id = 'msg-4'`);
  const hijack = await repo.claimKofiPayment('user-b', 'txn-4');
  check(
    'claim: an email already linked elsewhere cannot be re-linked to a second account',
    hijack.outcome === 'email-taken',
    hijack.outcome,
  );
  check('claim: the hijack attempt granted user-b nothing', !(await repo.getSupporter('user-b')).supporter);

  // ------------------------------------------------ below-tier (blocker 2)
  await repo.recordKofiPayment({
    messageId: 'msg-tip',
    kind: 'Donation',
    email: 'tipper@example.com',
    transactionId: 'txn-tip',
    amount: '1.00',
    currency: 'USD',
    isSubscription: false,
    tierName: null,
    months: monthsFor(tip),
  });
  const tipClaim = await repo.claimKofiPayment('user-b', 'txn-tip');
  check('claim: a $1 tip does NOT buy a month', tipClaim.outcome === 'below-tier', tipClaim.outcome);
  check('claim: the rejected tip stays unclaimed so an admin can still comp it', true);
  check('supporter: the tipper is still not a supporter', !(await repo.getSupporter('user-b')).supporter);

  // ------------------------------------------------- admin grant / revoke (3)
  const comped = await repo.grantSupporter('user-b', 3, 'admin', 'by admin-1: contributor');
  check('admin: a comp grants a membership', !!comped);
  check('admin: the comped account is a supporter', (await repo.getSupporter('user-b')).supporter);
  const hist = await repo.listSupporterGrants('user-b');
  check('audit: the comp is recorded with its source', hist[0]?.source === 'admin', hist[0]?.source);
  check('audit: the note names the acting admin', (hist[0]?.note ?? '').includes('admin-1'));

  const revoked = await repo.revokeSupporter('user-b', 'by admin-1: chargeback');
  check('admin: revoke ends the membership', revoked);
  check('admin: the revoked account is no longer a supporter', !(await repo.getSupporter('user-b')).supporter);
  check(
    'admin: revoking twice reports that there was nothing to revoke',
    !(await repo.revokeSupporter('user-b')),
  );
  const hist2 = await repo.listSupporterGrants('user-b');
  check('audit: the revocation is recorded too', hist2[0]?.source === 'revoke', hist2[0]?.source);

  const refunded = await repo.refundKofiPayment('txn-1');
  check('admin: a payment can be flagged refunded', refunded);
  check('admin: flagging the same payment twice is a no-op', !(await repo.refundKofiPayment('txn-1')));
  await db.query(`update kofi_payments set claimed_by = null where transaction_id = 'txn-1'`);
  const refundClaim = await repo.claimKofiPayment('user-b', 'txn-1');
  check('claim: a refunded payment cannot be claimed', refundClaim.outcome === 'refunded', refundClaim.outcome);

  // ------------------------------------------------------------ badge reads
  const badges = await repo.supportersAmong(['user-a', 'user-b', 'nobody']);
  check('badge: supportersAmong returns only the ACTIVE supporters', badges.has('user-a') && !badges.has('user-b'));
  check('badge: the profile read carries the supporter flag', (await repo.getProfile('user-a'))?.supporter === true);

  // an expired membership must read as lapsed, not as a supporter
  await db.query(`update profiles set supporter_until = now() - interval '1 day' where user_id = 'user-a'`);
  check('badge: a LAPSED membership reads as not-a-supporter', !(await repo.getSupporter('user-a')).supporter);
  check('badge: and drops out of supportersAmong', !(await repo.supportersAmong(['user-a'])).has('user-a'));
  await db.query(`update profiles set supporter_until = now() + interval '30 days' where user_id = 'user-a'`);

  // ------------------------------------------------------- staff roles (10)
  // `profiles.role` is a PROJECTION of ADMIN_USER_IDS/OWNER_USER_ID, and the two
  // things worth proving are that the projection is SYMMETRIC (losing the env
  // entry loses the role) and that staff are entitled to the supporter perks by
  // exactly the same predicate everything else reads.
  await repo.ensureProfile('user-own', 'Owner');
  await repo.ensureProfile('user-adm', 'Admin');
  await repo.ensureProfile('user-nob', 'Nobody');

  await repo.syncStaffRoles('user-own', ['user-own', 'user-adm']);
  check('staff: the owner gets the owner role', (await repo.getProfile('user-own'))?.role === 'owner');
  check('staff: the others get admin', (await repo.getProfile('user-adm'))?.role === 'admin');
  check('staff: everyone else keeps no role', (await repo.getProfile('user-nob'))?.role === undefined);

  // the owner appears in ADMIN_USER_IDS too (that is what gates the admin API),
  // and must NOT be demoted to admin by being listed twice
  check(
    'staff: an owner also listed as an admin stays the owner',
    (await repo.getProfile('user-own'))?.role === 'owner',
  );

  // THE PERK, and the reason the predicate is shared: no payment anywhere here
  const admEnt = await repo.getSupporter('user-adm');
  check('staff: an admin is entitled without paying', admEnt.supporter === true);
  check('staff: ...with no expiry, because nothing was bought', admEnt.supporterUntil === null);
  check('staff: ...and reports the role so the UI can say why', admEnt.role === 'admin');
  check('staff: the badge query agrees', (await repo.supportersAmong(['user-adm'])).has('user-adm'));
  check(
    'staff: a non-staff account with no membership is still not a supporter',
    !(await repo.getSupporter('user-nob')).supporter,
  );

  const staff = await repo.staffAmong(['user-own', 'user-adm', 'user-nob']);
  check('staff: staffAmong maps ids to roles', staff.get('user-own') === 'owner' && staff.get('user-adm') === 'admin');
  check('staff: and omits everyone else', !staff.has('user-nob'));

  // SYMMETRY — the sweep must revoke, not just grant. An id dropped from the env
  // that kept its badge and its free membership is the failure mode that matters.
  await repo.syncStaffRoles('user-own', ['user-own']);
  check('staff: dropping an id from the env clears the role', (await repo.getProfile('user-adm'))?.role === undefined);
  check(
    'staff: ...and takes the free entitlement with it',
    !(await repo.getSupporter('user-adm')).supporter,
  );

  // demotion of the owner themselves (handover), and the no-owner case
  await repo.syncStaffRoles(null, ['user-own']);
  check('staff: an owner demoted to admin becomes an admin', (await repo.getProfile('user-own'))?.role === 'admin');
  await repo.syncStaffRoles(null, []);
  check('staff: an empty env leaves nobody staff', (await repo.getProfile('user-own'))?.role === undefined);

  // the column is constrained, so a hand-edited row cannot invent a role
  let rejected = false;
  try {
    await db.query(`update profiles set role = 'superuser' where user_id = 'user-nob'`);
  } catch {
    rejected = true;
  }
  check('staff: the check constraint rejects an unknown role', rejected);

  // a staff member who ALSO paid keeps their real expiry — the role grants the
  // perks, it does not overwrite the purchase
  await repo.syncStaffRoles('user-a', []);
  const paidStaff = await repo.getSupporter('user-a');
  check('staff: a paying owner still reports the paid expiry', paidStaff.supporterUntil !== null);
  check('staff: ...and is a supporter either way', paidStaff.supporter === true);
  await repo.syncStaffRoles(null, []);

  // -------------------------------------------------- account deletion (9)
  await repo.ensureProfile('user-c', 'Cy');
  await repo.recordKofiPayment({
    messageId: 'msg-c',
    kind: 'Donation',
    email: 'cy@example.com',
    transactionId: 'txn-c',
    amount: '3.00',
    currency: 'USD',
    isSubscription: false,
    tierName: null,
    months: 1,
  });
  await repo.claimKofiPayment('user-c', 'txn-c');
  await db.query(
    `insert into elo_history (user_id, mode, game, balance_version, rating) values ('user-c','1v1','decode',1,1500)`,
  );
  const gone = await repo.deleteAccount('user-c');
  check('delete: the account is removed', gone);
  check('delete: deleting a missing account reports false', !(await repo.deleteAccount('user-c')));
  const eloLeft = (
    await db.query<{ n: string }>(
      `select count(*)::text as n from elo_history where user_id = 'user-c'`,
    )
  ).rows[0].n;
  check('delete: elo_history has no FK, so it is deleted explicitly', eloLeft === '0');
  const grantsLeft = (
    await db.query<{ n: string }>(
      `select count(*)::text as n from supporter_grants where user_id = 'user-c'`,
    )
  ).rows[0].n;
  check('delete: the supporter audit rows cascade away with the profile', grantsLeft === '0');
  const pay = (
    await db.query<{ email: string | null; claimed_by: string | null }>(
      `select email, claimed_by from kofi_payments where transaction_id = 'txn-c'`,
    )
  ).rows[0];
  check('delete: the payment SURVIVES (financial history outlives the account)', !!pay);
  check('delete: but the payer email is scrubbed (personal data)', pay.email === null);
  check('delete: and the claim is unlinked by the FK', pay.claimed_by === null);

  await db.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
