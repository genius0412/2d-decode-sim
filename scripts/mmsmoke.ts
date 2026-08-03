/**
 * Matchmaker verification — `npm run test:mm`.
 *
 * Deterministic, in-process, no DB and no sockets: `Matchmaker` takes an injected
 * clock and an injected `stage`, so a whole pairing round is a function call and
 * the staged roster is just an object to assert on.
 *
 * This exists because of "play a friend". Party pairing is the one piece of
 * matchmaking whose failure modes are all SILENT — a party split across alliances,
 * a closed challenge quietly matched against a stranger for rating, a friend left
 * waiting because their partner was consumed by an open group — and the only other
 * way to exercise it is two real accounts on two machines against the live server.
 * The open-queue cases are covered too, so this doubles as a regression net for the
 * pairing rewrite that party units required.
 *
 * `npm test` stays the SIM smoke check (a red `npm test` must keep meaning
 * "physics broke"), so this is its own script.
 */
import { Matchmaker, groupUnits, allianceOrder, type QueueEntry } from '../server/matchmaking';
import type { PendingMatch } from '../server/matchTypes';
import type { QueueMode, ServerMsg } from '../src/net/protocol';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/** a queue entry with everything the matchmaker reads and nothing it doesn't */
function entry(id: string, mode: QueueMode, opts: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    send: () => {},
    player: { name: id, teamName: '', teamNumber: 0 } as QueueEntry['player'],
    userId: `u-${id}`,
    mode,
    homeRegion: 'iad',
    accessMs: 10,
    build: 'test-build',
    enqueuedAt: 0,
    expandBumps: 0,
    ...opts,
  };
}

/**
 * Enqueue everyone, then let the staging microtasks land.
 *
 * `enqueue` matches synchronously but STAGES asynchronously (`assign` awaits the
 * intro-ELO reads and the stage write), so reading `staged` on the next line sees
 * an empty array whether or not a match was made. Every assertion below waits.
 */
async function pair(
  entries: QueueEntry[],
): Promise<{ mm: Matchmaker; staged: PendingMatch[] }> {
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({
    // frozen clock: the search radius never widens on its own, so a cross-region
    // pairing only happens if the code deliberately skips the gate
    now: () => 0,
    stage: async (m) => {
      staged.push(m);
    },
  });
  for (const e of entries) mm.enqueue(e);
  await new Promise((r) => setTimeout(r, 0));
  return { mm, staged };
}

/** who ended up on which alliance, by entry id */
const alliancesOf = (m: PendingMatch | undefined): Record<string, string> =>
  Object.fromEntries((m?.roster ?? []).map((r) => [r.name, r.alliance]));
const namesOf = (m: PendingMatch | undefined): string =>
  (m?.roster ?? []).map((r) => r.name).sort().join(',');

// ---- unit grouping (the primitive everything else rests on) -----------------
{
  const a = entry('a', '2v2', { party: 'tok', partySize: 2 });
  const b = entry('b', '2v2');
  const c = entry('c', '2v2', { party: 'tok', partySize: 2 });
  const units = groupUnits([a, b, c]);
  check('units: a party is one unit', units.length === 2, `got ${units.length}`);
  check('units: party members share a unit', units[0].length === 2 && units[0][0].id === 'a');
  check('units: a party keeps its FIRST member place in line', units[1][0].id === 'b');
}
{
  // 2v2: one premade + two solos. The index split is positional (i < half ⇒ red),
  // so the party has to come out contiguous AND front-loaded.
  const g = [
    entry('s1', '2v2'),
    entry('p1', '2v2', { party: 't', partySize: 2 }),
    entry('s2', '2v2'),
    entry('p2', '2v2', { party: 't', partySize: 2 }),
  ];
  const ids = allianceOrder(g).map((e) => e.id);
  check('allianceOrder: premade lands in one half', ids[0].startsWith('p') && ids[1].startsWith('p'), ids.join(','));
}
{
  const g = [entry('a', '1v1'), entry('b', '1v1')];
  check('allianceOrder: no parties ⇒ FIFO untouched', allianceOrder(g) === g);
}

// ---- open queue: the pre-existing behaviour must not have moved -------------
{
  const { staged } = await pair([entry('a', '1v1')]);
  check('open 1v1: one waiter does not match', staged.length === 0);
}
{
  const { staged } = await pair([entry('a', '1v1'), entry('b', '1v1')]);
  check('open 1v1: two waiters pair', staged.length === 1);
  check('open 1v1: staged ranked', staged[0]?.ranked === true);
  check('open 1v1: one per alliance', new Set(staged[0]?.roster.map((r) => r.alliance)).size === 2);
}
{
  const { staged } = await pair(['a', 'b', 'c', 'd'].map((id) => entry(id, '2v2')));
  check('open 2v2: four waiters pair', staged.length === 1);
  check('open 2v2: two per alliance', staged[0]?.roster.filter((r) => r.alliance === 'red').length === 2);
}
{
  // different builds never share an authoritative match (desync guard)
  const { staged } = await pair([
    entry('a', '1v1', { build: 'sha-1' }),
    entry('b', '1v1', { build: 'sha-2' }),
  ]);
  check('open: mixed builds never pair', staged.length === 0);
}
{
  // the radius gate still bites for strangers: with the clock frozen at enqueue
  // time the ceiling is zero, so a cross-region pair must wait
  const { staged } = await pair([
    entry('a', '1v1', { homeRegion: 'iad' }),
    entry('b', '1v1', { homeRegion: 'syd' }),
  ]);
  check('open: cross-region strangers wait for the radius', staged.length === 0);
}

// ---- closed party (rated 1v1 challenge) ------------------------------------
{
  const { staged } = await pair([entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true })]);
  check('closed 1v1: challenger alone waits', staged.length === 0);
}
{
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: the pair matches', staged.length === 1);
  check('closed 1v1: rated', staged[0]?.ranked === true);
  const al = alliancesOf(staged[0]);
  check('closed 1v1: opponents, not teammates', !!al['a'] && al['a'] !== al['b'], JSON.stringify(al));
}
{
  // THE important one: a closed party is unreachable from the open pool. A stranger
  // waiting in 1v1 must never be pulled into somebody's friend challenge, and the
  // challenger must never be spent on the stranger.
  const half = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('x', '1v1'),
  ]);
  check('closed 1v1: a stranger cannot be pulled in', half.staged.length === 0);

  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('x', '1v1'),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: pairs with its own partner, not the stranger', staged.length === 1);
  check('closed 1v1: exactly the challenged pair', namesOf(staged[0]) === 'a,b', namesOf(staged[0]));
}
{
  // a challenge crosses any distance — the two already chose each other, so the
  // widening schedule has nothing to say about it
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, homeRegion: 'syd' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, homeRegion: 'lhr' }),
  ]);
  check('closed 1v1: ignores the search radius', staged.length === 1);
}
{
  // ...but NOT the compatibility bucket. Two friends on different builds run
  // different code; matching them would desync the match, challenge or not.
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, build: 'sha-1' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, build: 'sha-2' }),
  ]);
  check('closed 1v1: mixed builds still refuse', staged.length === 0);
}
{
  // two different challenges in flight at once must not cross-pair
  const cross = await pair([
    entry('a', '1v1', { party: 't1', partySize: 2, partyOnly: true }),
    entry('c', '1v1', { party: 't2', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: separate tokens never cross-pair', cross.staged.length === 0);

  const { staged } = await pair([
    entry('a', '1v1', { party: 't1', partySize: 2, partyOnly: true }),
    entry('c', '1v1', { party: 't2', partySize: 2, partyOnly: true }),
    entry('d', '1v1', { party: 't2', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: the second challenge resolves on its own token', staged.length === 1);
  check('closed 1v1: right pair matched', namesOf(staged[0]) === 'c,d', namesOf(staged[0]));
}

// ---- premade party (ranked 2v2 with a friend) ------------------------------
{
  const { staged } = await pair([
    entry('p1', '2v2', { party: 'tok', partySize: 2 }),
    entry('p2', '2v2', { party: 'tok', partySize: 2 }),
  ]);
  check('premade 2v2: a party of two does not fill a 4-slot match', staged.length === 0);
}
{
  const { staged } = await pair([
    entry('p1', '2v2', { party: 'tok', partySize: 2 }),
    entry('p2', '2v2', { party: 'tok', partySize: 2 }),
    entry('s1', '2v2'),
    entry('s2', '2v2'),
  ]);
  check('premade 2v2: fills from the open pool', staged.length === 1);
  const al = alliancesOf(staged[0]);
  check('premade 2v2: the party plays TOGETHER', !!al['p1'] && al['p1'] === al['p2'], JSON.stringify(al));
  check('premade 2v2: the solos are the opponents', al['s1'] === al['s2'] && al['s1'] !== al['p1'], JSON.stringify(al));
}
{
  const { staged } = await pair([
    entry('a1', '2v2', { party: 'ta', partySize: 2 }),
    entry('b1', '2v2', { party: 'tb', partySize: 2 }),
    entry('a2', '2v2', { party: 'ta', partySize: 2 }),
    entry('b2', '2v2', { party: 'tb', partySize: 2 }),
  ]);
  check('premade 2v2: two premades pair', staged.length === 1);
  const al = alliancesOf(staged[0]);
  check(
    'premade 2v2: each premade keeps its own alliance',
    !!al['a1'] && al['a1'] === al['a2'] && al['b1'] === al['b2'] && al['a1'] !== al['b1'],
    JSON.stringify(al),
  );
}
{
  // a premade must be added all-or-nothing: with only one slot left it is skipped
  // rather than half-taken, which would strand its other member
  const { staged } = await pair([
    entry('s1', '2v2'),
    entry('s2', '2v2'),
    entry('s3', '2v2'),
    entry('p1', '2v2', { party: 'tok', partySize: 2 }),
    entry('p2', '2v2', { party: 'tok', partySize: 2 }),
  ]);
  check('premade 2v2: a group forms', staged.length === 1);
  const inGroup = staged[0]?.roster.filter((r) => r.name.startsWith('p')).length ?? 0;
  check('premade 2v2: party is all-in or all-out', inGroup === 0 || inGroup === 2, `${inGroup} of 2 — ${namesOf(staged[0])}`);
  const al = alliancesOf(staged[0]);
  if (inGroup === 2) {
    check('premade 2v2: and still on one alliance', al['p1'] === al['p2'], JSON.stringify(al));
  }
}

// ---- NEAREST-FIRST pairing (what makes the fast radius safe) ----------------
// The radius no longer buys locality by refusing to look — it opens same-continent
// immediately and worldwide within 6s. Locality is bought here instead, by picking
// the CLOSEST eligible opponent rather than the first one in the queue that fits.
// Under the old first-fit rule these were one knob, so matching faster necessarily
// meant matching worse; if this regresses, that trade quietly comes back.
{
  // the anchor is in iad; a far opponent (nrt, 164) is ahead of a near one (lhr, 76)
  // in the queue. First-fit would take nrt purely for being earlier.
  const { staged } = await pair([
    entry('anchor', '1v1', { homeRegion: 'iad' }),
    entry('far', '1v1', { homeRegion: 'nrt' }),
    entry('near', '1v1', { homeRegion: 'lhr' }),
  ]);
  check('nearest-first: the CLOSER opponent wins over the earlier one',
    namesOf(staged[0]) === 'anchor,near', namesOf(staged[0]));
}
{
  // ...and a same-region opponent beats everyone, however late they queued
  const { staged } = await pair([
    entry('anchor', '1v1', { homeRegion: 'iad' }),
    entry('cross', '1v1', { homeRegion: 'syd' }),
    entry('local', '1v1', { homeRegion: 'iad' }),
  ]);
  check('nearest-first: a same-region opponent still wins at a wide radius',
    namesOf(staged[0]) === 'anchor,local', namesOf(staged[0]));
  check('nearest-first: ...and the match hosts in that shared region', staged[0]?.hostRegion === 'iad');
}
{
  // FIFO fairness survives it: equally-close candidates are taken in queue order,
  // because a tie does NOT displace the incumbent
  const { staged } = await pair([
    entry('anchor', '1v1', { homeRegion: 'iad' }),
    entry('first', '1v1', { homeRegion: 'iad' }),
    entry('second', '1v1', { homeRegion: 'iad' }),
  ]);
  check('nearest-first: a TIE goes to whoever waited longer', namesOf(staged[0]) === 'anchor,first', namesOf(staged[0]));
}
{
  // The radius still MEANS something: the worst pair on the map is held back on the
  // first attempt, so a wide-open queue never instantly commits someone to a distant
  // match that a few seconds of waiting might have improved. (lhr↔syd is 251ms
  // direct, but the gate reads `bestHost`'s SPREAD — 148 — because the minimax host
  // lands on sjc in the middle. 148 is the worst spread any pair can produce, which
  // is why one widening step now covers the entire map.)
  const { staged } = await pair([
    entry('a', '1v1', { homeRegion: 'lhr' }),
    entry('b', '1v1', { homeRegion: 'syd' }),
  ]);
  check('radius: the worst-case pair is NOT taken on the first attempt', staged.length === 0);
}
{
  // ...but nobody is stranded — once the radius has opened (here via two expand
  // bumps, which the frozen test clock lets us reach directly) it does match.
  const { staged } = await pair([
    entry('a', '1v1', { homeRegion: 'lhr', expandBumps: 2 }),
    entry('b', '1v1', { homeRegion: 'syd', expandBumps: 2 }),
  ]);
  check('radius: ...and DOES match once widened (nobody is stranded)', staged.length === 1);
}

// ---- a challenge must be queued under the CHALLENGE'S game -------------------
// The matchmaker buckets by game so a Chain Reaction queuer can never be paired
// into a DECODE room. That rule is correct, and it is also what made a cross-game
// challenge silently impossible: a challenge is accepted from wherever the
// recipient already is, and the client queued under the game it was CURRENTLY in
// rather than the one the challenge names. The closed pair then sat in two
// different buckets waiting for each other, with nothing on either screen to say
// why. These pin both halves — the bucket rule stays strict, and the fix is that
// both entries carry the challenge's own game.
{
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'decode' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'chain' }),
  ]);
  check('challenge: a pair split across GAMES never stages (bucket rule holds)', staged.length === 0);
}
{
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'chain' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'chain' }),
  ]);
  check('challenge: both sides on the challenge’s game DO pair', staged.length === 1);
  check('challenge: ...and the room is staged for that game', staged[0]?.game === 'chain', String(staged[0]?.game));
}

// ---- the one-live-game guard must not forfeit a staged ranked match ----------
// `Room.stagedFor` is the predicate that lets a matchmaker-staged join through
// the "you already have a game in progress" refusal. Without it, being matched
// out of a BACKGROUND queue while a solo record run was still in flight was an
// automatic forfeit: the run's slot is held for the reconnect grace, so the join
// that pays ELO is the one that gets refused. It must answer for exactly the
// roster and nobody else — a random code-joiner must still be turned away.
{
  const { Room } = await import('../server/room');
  const roster = [
    { userId: 'u-a', name: 'a', alliance: 'red' as const, startIndex: 0, introElo: null },
    { userId: 'u-b', name: 'b', alliance: 'blue' as const, startIndex: 0, introElo: null },
  ] as never;
  const plain = new Room('plain', () => {}, { kind: 'versus' }, undefined as never);
  check('stagedFor: an ordinary room is staged for nobody', !plain.stagedFor('u-a'));
  const staged = new Room('iad-1v1x', () => {}, { kind: 'versus' }, undefined as never);
  staged.applyPending({ code: 'iad-1v1x', hostRegion: 'iad', mode: '1v1', seed: 1, roster, ranked: true });
  check('stagedFor: a staged ranked room answers for its roster', staged.stagedFor('u-a') && staged.stagedFor('u-b'));
  check('stagedFor: ...and for nobody else (a code-guesser is still refused)', !staged.stagedFor('u-stranger'));
}

// ---- queue depth is PER GAME ------------------------------------------------
// Pairing buckets by game, so a combined count advertised a pool the reader could
// never match from: one Chain Reaction queuer made every DECODE menu read "1V1 1".
{
  const { mm } = await pair([
    entry('d1', '1v1', { game: 'decode' }),
    entry('c1', '1v1', { game: 'chain' }),
    entry('c2', '2v2', { game: 'chain' }),
  ]);
  const byGame = mm.queueSizesByGame();
  check('per-game depth: DECODE counts only its own queuer', byGame.decode?.['1v1'] === 1, JSON.stringify(byGame));
  check('per-game depth: Chain Reaction counts only its own', byGame.chain?.['1v1'] === 1);
  check('per-game depth: ...in each bucket separately', byGame.chain?.['2v2'] === 1 && byGame.decode?.['2v2'] === 0);
  check('per-game depth: a game with nobody waiting has no entry at all', !byGame.nope);
  // the combined shape stays correct too — older clients still read it
  check('per-game depth: the combined total is unchanged for old clients', mm.queueSizes()['1v1'] === 2);
}
{
  // a CLOSED challenge is not an open pool in either shape
  const { mm } = await pair([
    entry('p1', '1v1', { game: 'decode', party: 'tok', partySize: 2, partyOnly: true }),
  ]);
  check('per-game depth: a closed challenge is not advertised as available',
    (mm.queueSizesByGame().decode?.['1v1'] ?? 0) === 0);
}

// ---- the operator view of the queue -----------------------------------------
// A depth count cannot distinguish "nobody is queueing" from "everybody is queueing
// and nothing is pairing", which is exactly the failure an operator gets called
// about. The bucket + the WAIT is what separates them. Ranked requires an account,
// so every row here already belongs to a signed-in player — there is no guest data
// in this surface by construction.
{
  const { mm } = await pair([entry('a', '1v1'), entry('x', '2v2')]);
  const q = mm.queuedPlayers(30_000);
  check('operator queue: reports each waiting account', q.length === 2, JSON.stringify(q));
  check('operator queue: with its bucket', q.find((e) => e.userId === 'u-a')?.mode === '1v1');
  check('operator queue: and how long it has been waiting', q.find((e) => e.userId === 'u-a')?.waitedS === 30);
  check('operator queue: an anonymous entry cannot appear (ranked needs an account)',
    q.every((e) => !!e.userId));
}

// ---- queue depth reporting --------------------------------------------------
{
  const { mm } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('x', '1v1'),
  ]);
  const sizes = mm.queueSizes();
  check('queueSizes: closed parties are not advertised as available', sizes['1v1'] === 1, String(sizes['1v1']));
}
{
  // a closed waiter is told about its OWN party, not the open pool it can't join
  const seen: ServerMsg[] = [];
  await pair([
    entry('x1', '1v1'),
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, send: (m) => seen.push(m) }),
  ]);
  const last = seen.filter((m) => m.t === 'queued').pop();
  check('queued: a challenge reports 1/2, not the open depth', last?.t === 'queued' && last.size === 1, JSON.stringify(last));
}

// ---- report ----------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ matchmaker: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ matchmaker: ${passed} checks passed`);
