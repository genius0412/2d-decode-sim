import { useEffect, useState } from 'react';
import { serverCaps } from '../net/api';
import type { ChallengeFormat } from '../net/protocol';

export type { ChallengeFormat };

/**
 * The FORMAT a "Play a friend" challenge is issued in, and how each one resolves:
 *
 *  - `casual1v1` / `casual2v2` → a custom `versus` room (up to 4 drivers; the
 *    1v1-vs-2v2 split is emergent from how many join + alliance choice in the
 *    lobby, not a server flag). Unrated — a code-joined room never rates.
 *  - `duorecord` → a `record`/`duo` co-op run (2v0, opponent-free score attack).
 *  - `rated1v1` → NOT a room. Both sides hand the matchmaker the challenge token
 *    and it stages them a private ranked match, which is what makes it rate:
 *    `Room.ranked` is only ever set from a staged roster.
 *  - `ranked2v2` → the same token, but the two of you queue into the OPEN ranked
 *    2v2 pool as a premade and are kept on one alliance. You wait for two more
 *    like anybody else.
 *
 * The last two need a server that understands parties, which is not a given: one
 * Fly app serves every client build. They stay disabled until it says otherwise —
 * see `serverCaps`.
 */
interface FormatTile {
  format: ChallengeFormat;
  title: string;
  /** what actually happens, in the one line a player needs before committing */
  detail: string;
  /** server capability this format needs, if any */
  needs?: string;
}

const TILES: FormatTile[] = [
  { format: 'casual1v1', title: '1v1 · Casual', detail: 'Unrated. Straight into a private lobby.' },
  { format: 'rated1v1', title: '1v1 · Rated', detail: 'Counts for ELO. Just the two of you.', needs: 'party' },
  { format: 'casual2v2', title: '2v2 · Casual', detail: 'Unrated. Sort alliances in the lobby.' },
  { format: 'ranked2v2', title: '2v2 · Ranked', detail: 'Queue together as a team. Counts for ELO.', needs: 'party' },
  { format: 'duorecord', title: '2v0 · Co-op record', detail: 'No opponent. Chase a record together.' },
];

/**
 * The "Play a friend" challenge picker — chess.com's "New game" chooser, DECODE-
 * shaped. Sending NAVIGATES away (into the lobby, or into the queue for a rated
 * format), which unmounts this modal — so only a failed send ever lands back
 * here, where the reason is shown and the tiles re-enable.
 */
export function ChallengePicker({
  username,
  onPick,
  onClose,
}: {
  username: string;
  onPick: (format: ChallengeFormat) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<ChallengeFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the capability read lands. The gated tiles render DISABLED
  // meanwhile rather than hidden — appearing a beat late is fine, appearing out
  // of nowhere under a cursor that's already moving is not.
  const [caps, setCaps] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    void serverCaps().then((c) => {
      if (alive) setCaps(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  const pick = (format: ChallengeFormat): void => {
    setBusy(format);
    setError(null);
    void onPick(format).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Couldn’t send the challenge.');
      setBusy(null);
    });
  };

  return (
    <div
      className="ds-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Play a friend - @${username}`}
      onClick={busy ? undefined : onClose}
    >
      <div className="ds-modal ds-chal" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-h">
          <span className="ds-panel-title">Play @{username}</span>
          <button className="ds-btn ghost" onClick={onClose} aria-label="Close" disabled={!!busy}>
            ✕
          </button>
        </div>

        <div className="ds-chal-list">
          {TILES.map((t) => {
            const pendingCaps = !!t.needs && caps === null;
            const unsupported = !!t.needs && caps !== null && !caps.includes(t.needs);
            return (
              <button
                key={t.format}
                className="ds-opt"
                disabled={!!busy || pendingCaps || unsupported}
                title={unsupported ? 'This server build cannot run rated challenges yet.' : undefined}
                onClick={() => pick(t.format)}
              >
                <span className="ot">{t.title}</span>
                <span className="od">
                  {busy === t.format
                    ? 'Sending challenge…'
                    : unsupported
                      ? 'Not available on this server'
                      : t.detail}
                </span>
              </button>
            );
          })}
        </div>

        {error && <p className="ds-form-err">{error}</p>}
      </div>
    </div>
  );
}
