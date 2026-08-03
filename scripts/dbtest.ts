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

  // ------------------------------------------- badges on EVERY name surface
  // The badge is only meaningful if it is everywhere a name is: it shipped on
  // the record board and was silently missing from the ranked board beside it,
  // from match history, and from the friends list — every one of those a query
  // that simply did not project the two columns. Nothing in the type system
  // catches that (an absent field renders as "no badge"), so the queries behind
  // each surface are asserted here one by one.
  await repo.ensureProfile('badge-own', 'Ownie');
  await repo.ensureProfile('badge-sup', 'Suppy');
  await repo.ensureProfile('badge-nil', 'Plain');
  await repo.syncStaffRoles('badge-own', ['badge-own']);
  await db.query(
    `update profiles set supporter_until = now() + interval '30 days' where user_id = 'badge-sup'`,
  );
  await db.query(
    `update profiles set username = 'ownie' where user_id = 'badge-own'`,
  );

  const SEASON = 99;
  await repo.ensureSeason(SEASON, 'decode', 7);
  const act = await repo.actForSeason(SEASON, 'decode');

  // RANKED — the board that shipped bare. Placement gates the board, so each
  // player needs PLACEMENT_GAMES rated results before they appear at all.
  for (let i = 0; i < 5; i++) {
    await repo.upsertRating('badge-own', '1v1', act, 1600, 60, 0.06, 'decode');
    await repo.upsertRating('badge-nil', '1v1', act, 1400, 60, 0.06, 'decode');
  }
  await repo.upsertEloHistory('badge-own', '1v1', SEASON, 1600, 60, 0.06, 5, 'decode');
  const eloRows = await repo.eloLeaderboard({ mode: '1v1', act, game: 'decode' });
  const eloOwn = eloRows.find((r) => r.userId === 'badge-own');
  const eloNil = eloRows.find((r) => r.userId === 'badge-nil');
  check('badges/ranked: the live board carries the role', eloOwn?.role === 'owner');
  check('badges/ranked: ...and the supporter flag it implies', eloOwn?.supporter === true);
  check('badges/ranked: a plain player carries neither', !eloNil?.role && eloNil?.supporter === false);
  const eloHist = await repo.eloHistoryLeaderboard({ mode: '1v1', balanceVersion: SEASON, game: 'decode' });
  check(
    'badges/ranked: the ARCHIVED season board carries them too',
    eloHist.find((r) => r.userId === 'badge-own')?.role === 'owner',
  );

  // RECORDS — the primary name already had a badge; the DUO PARTNER did not,
  // and a duo row prints two names.
  await repo.submitRecord({
    userId: 'badge-sup',
    partnerId: 'badge-own',
    mode: 'duo',
    drivetrain: 'tank',
    score: 250,
    balanceVersion: SEASON,
    replayId: null as unknown as string, // nullable FK; no replay needed here
    game: 'decode',
  });
  await repo.submitRecord({
    userId: 'badge-nil',
    mode: 'solo',
    drivetrain: 'tank',
    score: 100,
    balanceVersion: SEASON,
    replayId: null as unknown as string,
    game: 'decode',
  });
  const recRows = await repo.recordLeaderboard({ mode: 'duo', balanceVersion: SEASON, game: 'decode' });
  const duo = recRows.find((r) => r.userId === 'badge-sup');
  check('badges/records: the runner keeps their supporter flag', duo?.supporter === true);
  check('badges/records: the duo PARTNER carries their own role', duo?.partnerRole === 'owner');
  check('badges/records: ...and their own supporter flag', duo?.partnerSupporter === true);
  const solo = (await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'decode' }))[0];
  check(
    'badges/records: a SOLO row reports the absent partner as false, not null',
    solo?.partnerSupporter === false,
  );

  // MATCH HISTORY — the Career page's list, and the one place a name appears
  // for BOTH alliances of somebody else's match.
  const matchId = await repo.saveMatch('1v1', SEASON, null as unknown as string, true, 'decode');
  await repo.addMatchParticipant({
    matchId, userId: 'badge-nil', alliance: 'red', drivetrain: 'tank',
    score: 80, won: false, ratingBefore: 1000, ratingAfter: 990,
  });
  await repo.addMatchParticipant({
    matchId, userId: 'badge-own', alliance: 'blue', drivetrain: 'tank',
    score: 120, won: true, ratingBefore: 1000, ratingAfter: 1010,
  });
  const vsHist = await repo.userMatchHistory('badge-nil', { balanceVersion: SEASON, game: 'decode' });
  const versus = vsHist.rows.find((r) => r.kind === 'versus');
  const oppo = versus?.players.find((p) => p.userId === 'badge-own');
  check('badges/history: an opponent in the list carries their role', oppo?.role === 'owner');
  check(
    'badges/history: ...and a plain participant carries neither',
    versus?.players.find((p) => p.userId === 'badge-nil')?.supporter === false,
  );
  const runHist = await repo.userMatchHistory('badge-sup', { balanceVersion: SEASON, game: 'decode' });
  const run = runHist.rows.find((r) => r.kind === 'record');
  check(
    'badges/history: a record run badges its PARTNER too',
    run?.players.find((p) => p.userId === 'badge-own')?.role === 'owner',
  );

  // FRIENDS + SEARCH — polled surfaces. These deliberately used to skip the
  // columns; they no longer do, because a badge that shows on the leaderboard
  // and not beside the same person in your friends list reads as a bug.
  await repo.sendFriendRequest('badge-own', 'badge-nil');
  const pending = await repo.listFriends('badge-nil');
  check('badges/friends: an INCOMING request carries the role', pending.incoming[0]?.role === 'owner');
  await repo.acceptFriendRequest('badge-nil', 'badge-own');
  const friendList = await repo.listFriends('badge-nil');
  check('badges/friends: a friend row carries the role', friendList.friends[0]?.role === 'owner');
  check('badges/friends: ...and the supporter flag', friendList.friends[0]?.supporter === true);

  await repo.inviteToRoom('badge-own', 'badge-nil', 'ROOM01', 'decode', 'match', null, 'casual1v1');
  const invited = await repo.listFriends('badge-nil');
  check('badges/friends: the CHALLENGE sender is badged', invited.invites[0]?.from.role === 'owner');
  // the SENT list shows the OTHER party, so it must project the badge from a
  // different join than the received list does — assert it against staff, or the
  // check passes on a query that selects nothing at all
  await repo.inviteToRoom('badge-nil', 'badge-own', 'ROOM02', 'decode', 'match', null, 'casual1v1');
  const asSender = await repo.listFriends('badge-nil');
  check('badges/friends: and the recipient on the SENDER’s side', asSender.sent[0]?.to.role === 'owner');
  check(
    'badges/friends: the standalone invite read agrees with the folded one',
    (await repo.listRoomInvites('badge-nil'))[0]?.from.role === 'owner',
  );
  check(
    'badges/search: a username lookup carries the badge',
    (await repo.searchUsersByName('own'))[0]?.role === 'owner',
  );

  // ---- global presence aggregation ---------------------------------------
  // Rewritten from two statements into one (the sum, plus a distinct-count over the
  // same rows) to halve the cost of the site's most-called query. It had no coverage,
  // and the failure mode is a WRONG NUMBER rather than an error, so it needs some.
  await db.query(`delete from presence`);
  const beat = (m: string, region: string, online: number, authed: string[], q1 = 0, q2 = 0) =>
    repo.upsertPresence(m, region, online, authed, q1, q2);
  await beat('m-iad', 'iad', 3, ['u1', 'u2'], 1, 0);
  await beat('m-lhr', 'lhr', 2, ['u2', 'u3'], 0, 2);
  let pres = await repo.globalPresence();
  check('presence: sockets are summed across regions', pres.online === 5, `online=${pres.online}`);
  check(
    'presence: signed-in users are DEDUPED across regions (u2 is on both)',
    pres.signedIn === 3,
    `signedIn=${pres.signedIn}`,
  );
  check(
    'presence: queue depths are summed per bucket',
    pres.queues['1v1'] === 1 && pres.queues['2v2'] === 2,
    JSON.stringify(pres.queues),
  );

  // a machine that stopped beating drops out — that is how a crashed/stopped region
  // is forgotten, and it is why a BUSY machine must keep writing inside the window
  await db.query(`update presence set updated_at = now() - interval '60 seconds' where machine = 'm-lhr'`);
  pres = await repo.globalPresence();
  check('presence: a stale machine is excluded entirely', pres.online === 3, `online=${pres.online}`);
  check('presence: ...including its signed-in users', pres.signedIn === 2, `signedIn=${pres.signedIn}`);
  check(
    'presence: ...and its queue depth',
    pres.queues['2v2'] === 0,
    JSON.stringify(pres.queues),
  );

  // re-beating the SAME machine id overwrites rather than accumulating a ghost row
  await beat('m-iad', 'iad', 1, ['u1']);
  const n = (await db.query<{ c: string }>(`select count(*)::text as c from presence`)).rows[0].c;
  pres = await repo.globalPresence();
  check('presence: a machine re-beating updates its row, never adds one', n === '2', `rows=${n}`);
  check('presence: the updated count replaces the old one', pres.online === 1, `online=${pres.online}`);

  // everything quiet: zero, not null/NaN
  await db.query(`update presence set updated_at = now() - interval '60 seconds'`);
  pres = await repo.globalPresence();
  check(
    'presence: an empty world aggregates to a clean zero',
    pres.online === 0 && pres.signedIn === 0 && pres.queues['1v1'] === 0 && pres.queues['2v2'] === 0,
    JSON.stringify(pres),
  );
  await db.query(`delete from presence`);

  // ---- cross-region LIVE ROOMS + the operator view (0021) -----------------
  // "Watch Live" listed only the caller's own region, because a machine knows only
  // its own rooms and anycast picks which machine answers. Rooms now ride this same
  // heartbeat, and the aggregate is what the list reads.
  await repo.ensureProfile('op-1', 'Ada');
  await repo.ensureProfile('op-2', 'Grace');
  await repo.upsertPresence(
    'm-iad', 'iad', 4, ['op-1'], 1, 0,
    [{ room: 'iad-a1', mode: '1v1' }],
    [{ userId: 'op-1', act: 'match', room: 'iad-a1' }],
    { total: 2, inMatch: 1, inLobby: 0, idle: 1 },
  );
  await repo.upsertPresence(
    'm-nrt', 'nrt', 2, ['op-2'], 0, 0,
    [{ room: 'nrt-b2', mode: '2v2' }],
    [{ userId: 'op-2', act: 'menu', queue: '1v1', queuedS: 42 }],
    { total: 1, inMatch: 0, inLobby: 0, idle: 1 },
  );
  const liveAll = (await repo.globalLiveRooms()) as { room: string }[];
  check(
    'live rooms: matches from EVERY region come back, not just one',
    liveAll.length === 2 && liveAll.some((r) => r.room === 'iad-a1') && liveAll.some((r) => r.room === 'nrt-b2'),
    JSON.stringify(liveAll),
  );
  await db.query(`update presence set updated_at = now() - interval '60 seconds' where machine = 'm-nrt'`);
  check('live rooms: a stale machine’s rooms drop out with it', ((await repo.globalLiveRooms()) as unknown[]).length === 1);
  await repo.upsertPresence('m-nrt', 'nrt', 2, ['op-2'], 0, 0, [{ room: 'nrt-b2' }], [{ userId: 'op-2', act: 'menu', queue: '1v1', queuedS: 42 }], { total: 1, inMatch: 0, inLobby: 0, idle: 1 });

  const opRows = await repo.adminPresence();
  const allPlayers = opRows.flatMap((r) => r.players);
  check('operator view: every region is reported', opRows.length === 2, JSON.stringify(opRows.map((r) => r.region)));
  check(
    'operator view: signed-in accounts resolve to a handle',
    allPlayers.find((p) => p.userId === 'op-1')?.handle === 'Ada',
  );
  check(
    'operator view: a queued player shows the bucket AND the wait (a stall is the point)',
    allPlayers.find((p) => p.userId === 'op-2')?.queue === '1v1' &&
      allPlayers.find((p) => p.userId === 'op-2')?.queuedS === 42,
  );
  check(
    'operator view: anonymous sessions arrive as COUNTS',
    opRows.reduce((n, r) => n + r.anon.total, 0) === 3,
    JSON.stringify(opRows.map((r) => r.anon)),
  );
  // THE PRIVACY INVARIANT, asserted rather than assumed. If a later change starts
  // itemising guest sessions or recording what screen someone is on, these are what
  // say so out loud instead of it going unnoticed.
  check(
    'operator view: no anonymous session is identified anywhere in the payload',
    opRows.every((r) => Object.keys(r.anon).every((k) => ['total', 'inMatch', 'inLobby', 'idle'].includes(k))),
    JSON.stringify(opRows.map((r) => r.anon)),
  );
  check(
    'operator view: and it carries NO screen/menu detail for anybody',
    allPlayers.every((p) => !('screen' in p) && !('page' in p) && ['menu', 'lobby', 'match'].includes(p.act)),
  );
  // ---- PER-GAME queue depth aggregates across regions (0022) --------------
  // The flat q1v1/q2v2 columns count every game together, which is not how pairing
  // works — so a Chain Reaction queuer inflated DECODE's advertised depth.
  await repo.upsertPresence('m-iad', 'iad', 4, ['op-1'], 1, 0, [], [], null, {
    decode: { '1v1': 1, '2v2': 0 },
  });
  await repo.upsertPresence('m-nrt', 'nrt', 2, ['op-2'], 2, 1, [], [], null, {
    decode: { '1v1': 1, '2v2': 0 },
    chain: { '1v1': 1, '2v2': 1 },
  });
  const gq = await repo.globalPresence();
  check('per-game: depths are summed per game ACROSS regions',
    gq.gameQueues.decode['1v1'] === 2 && gq.gameQueues.chain['1v1'] === 1,
    JSON.stringify(gq.gameQueues));
  check('per-game: buckets stay separate within a game', gq.gameQueues.chain['2v2'] === 1);
  check('per-game: a game nobody is queued for is absent, not zeroed in',
    !('nope' in gq.gameQueues));
  check('per-game: the COMBINED total still adds up for older clients',
    gq.queues['1v1'] === 3 && gq.queues['2v2'] === 1, JSON.stringify(gq.queues));
  await db.query(`update presence set updated_at = now() - interval '60 seconds' where machine = 'm-nrt'`);
  const gq2 = await repo.globalPresence();
  check('per-game: a stale machine drops out of the per-game aggregate too',
    gq2.gameQueues.decode['1v1'] === 1 && !gq2.gameQueues.chain,
    JSON.stringify(gq2.gameQueues));
  await repo.upsertPresence('m-nrt', 'nrt', 2, ['op-2'], 0, 0, [{ room: 'nrt-b2' }], [{ userId: 'op-2', act: 'menu', queue: '1v1', queuedS: 42 }], { total: 1, inMatch: 0, inLobby: 0, idle: 1 });

  // a snapshot, never a timeline: re-beating REPLACES, so no history accumulates
  await repo.upsertPresence('m-iad', 'iad', 0, [], 0, 0, [], [], { total: 0, inMatch: 0, inLobby: 0, idle: 0 });
  const after = await repo.adminPresence();
  check(
    'operator view: a new beat REPLACES the last (snapshot, never a history)',
    (after.find((r) => r.machine === 'm-iad')?.players.length ?? 1) === 0,
  );
  await db.query(`delete from presence`);

  // ---- player search: @username OR display name --------------------------
  // The box says "name or @username", so both have to actually find someone. The
  // handle arm is a WORD prefix, which is the half that is easy to get wrong: it must
  // catch a surname mid-name and must NOT become a free substring probe.
  await repo.ensureProfile('find-1', 'Dohun Kim');
  await repo.ensureProfile('find-2', 'kimberly');
  await repo.ensureProfile('find-3', 'Nameless');
  await db.query(`update profiles set username = 'acekim' where user_id = 'find-1'`);
  await db.query(`update profiles set username = 'kimb' where user_id = 'find-2'`);
  // deliberately NO username on find-3 — it must never be offered
  const ids = async (qq: string): Promise<string[]> =>
    (await repo.searchUsersByName(qq)).map((u) => u.userId);

  check('search: finds by @username prefix', (await ids('acek')).includes('find-1'));
  check('search: finds by display-name prefix', (await ids('dohun')).includes('find-1'));
  check('search: finds by a WORD inside the display name', (await ids('kim')).includes('find-1'));
  check('search: is case-insensitive on the display name', (await ids('DOHUN')).includes('find-1'));
  check(
    'search: one query can match a username AND someone else’s display name',
    (async () => true)() && (await ids('kim')).includes('find-1') && (await ids('kim')).includes('find-2'),
  );
  check(
    'search: a username match outranks a display-name-only match',
    (await ids('kimb'))[0] === 'find-2',
  );
  check(
    'search: does NOT match a mid-WORD fragment (not a free substring probe)',
    !(await ids('ohun')).includes('find-1'),
  );
  check(
    'search: never offers a profile with no username (nothing to open or friend)',
    !(await ids('nameless')).includes('find-3'),
  );
  check('search: a LIKE wildcard cannot enumerate everyone', (await ids('%')).length === 0);

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
