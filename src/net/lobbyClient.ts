import type { DodgeVerdict } from '../dodge';
import type { GameId } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { Transport } from './transport';
import { getAuthToken } from '../lib/authClient';
import { setServerNotice } from './notice';
import { appChannel, appBuild } from './env';
import {
  encodeMsg,
  decodeServerMsg,
  CLIENT_CAPS,
  type LobbyPlayer,
  type PlayerIntro,
  type PlayerPatch,
  type QueueMode,
  type RoomConfig,
} from './protocol';

export interface MatchStart {
  seed: number;
  setups: RobotSetup[];
  yourRobotId: number;
  /** which game the match plays (DECODE by default) — passed to the ServerSession */
  game?: GameId;
  /** ranked rooms only: drives the pre-match ELO intro overlay */
  ranked?: boolean;
  intros?: PlayerIntro[];
  /** the Fly region hosting the match (for the "matched on …" HUD chip) */
  region?: string;
}

/**
 * Client-side lobby over the game-server socket. Replaces the old Supabase
 * Realtime presence/signaling lobby: the server is authoritative for the roster
 * and the host, so this is a thin relay — join a room, patch your own state,
 * render the server's roster, and (host) press start. At `matchStart` the
 * caller mints a ServerSession that TAKES OVER this same transport.
 */
type Handlers = {
  roster: (players: LobbyPlayer[], hostId: string) => void;
  matchStart: (m: MatchStart) => void;
  queued: (mode: QueueMode, size: number, need: number) => void;
  /** ranked match found on a `?mm=1` connection: reconnect to `?room=<room>` (the
   * server routes it to `hostRegion`) to actually play */
  matchAssigned: (room: string, hostRegion: string, mode: QueueMode) => void;
  /** ranked pre-match strategy window opened: switch to the strategy screen. Live
   * changes ride the existing `update`/`roster`; a `matchStart` follows on ready. */
  strategyStart: (deadline: number, yourRobotId: number, mode: QueueMode, intros: PlayerIntro[]) => void;
  error: (message: string) => void;
  /** a staged RANKED pairing was cancelled and this is what it cost. Arrives just BEFORE
   *  the `error` that tears the screen down, so the UI can show the reason alongside it. */
  dodgeVerdict: (yours: DodgeVerdict | null, others: DodgeVerdict[]) => void;
  closed: () => void;
};

export class LobbyClient {
  clientId = '';
  hostId = '';
  players: LobbyPlayer[] = [];
  private readonly handlers: Partial<Handlers> = {};

  constructor(readonly transport: Transport) {
    transport.onMessage((d) => this.onMessage(d));
    // a transient drop auto-reconnects (see below); only a give-up is terminal
    transport.onFail(() => this.handlers.closed?.());
  }

  on<K extends keyof Handlers>(event: K, cb: Handlers[K]): void {
    this.handlers[event] = cb;
  }

  /** join (or create) a room; (re)sends on open AND on any reconnect. `config`
   * (set only by the room CREATOR) picks versus vs. record-chasing. Attaches the
   * Neon Auth JWT (if signed in) so the server attributes the run. */
  join(room: string, player: Omit<LobbyPlayer, 'clientId'>, config?: RoomConfig): void {
    const doJoin = async (): Promise<void> => {
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(
        encodeMsg({ t: 'join', room, player, config, authToken, caps: CLIENT_CAPS, channel: appChannel() }),
      );
    };
    this.transport.onOpen(() => void doJoin());
    this.transport.onReopen(() => void doJoin());
  }

  /** SPECTATE a live match read-only. (Re)sends on open + reconnect. `matchStart`
   * arrives with yourRobotId -1 → build a spectator ServerSession from it. */
  spectate(room: string): void {
    const doSpectate = async (): Promise<void> => {
      // The token is sent for ONE purpose: if the server verifies it as an admin,
      // this watcher is left out of the visible spectator count (moderation — see
      // Room.hideSpectator). For everyone else it changes nothing at all, so it is
      // attached unconditionally rather than gated on the client believing it is
      // an admin, which would just be a claim the server has to re-check anyway.
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(encodeMsg({ t: 'spectate', room, caps: CLIENT_CAPS, authToken }));
    };
    this.transport.onOpen(() => void doSpectate());
    this.transport.onReopen(() => void doSpectate());
  }

  /** change our own alliance / start pose / ready / spec */
  update(patch: PlayerPatch): void {
    this.transport.send(encodeMsg({ t: 'update', patch }));
  }

  /** host only: begin the match */
  start(): void {
    this.transport.send(encodeMsg({ t: 'start' }));
  }

  /** enter the ranked queue on this `?mm=1` connection. On a match the server sends
   * `matchAssigned` (reconnect to the host region). (Re)sends on open + reconnect,
   * with the auth JWT. `homeRegion`/`accessMs` are the client's network position (so
   * the matchmaker can pick a fair host); `noWiden` ⇒ never widen past my region. */
  queue(
    mode: QueueMode,
    player: Omit<LobbyPlayer, 'clientId'>,
    homeRegion: string,
    accessMs: number,
    noWiden?: boolean,
    game?: GameId,
    /** "play a friend": queue under a challenge token so the server pairs us with
     * the person we challenged instead of the open pool (see ui/challenge.ts) */
    party?: { token: string; format: string; partyOnly: boolean },
  ): void {
    const doQueue = async (): Promise<void> => {
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(
        encodeMsg({
          t: 'queue', mode, player, authToken, homeRegion, accessMs, noWiden, game,
          caps: CLIENT_CAPS, channel: appChannel(), build: appBuild(),
          party: party?.token, partyFormat: party?.format, partyOnly: party?.partyOnly,
        }),
      );
    };
    this.transport.onOpen(() => void doQueue());
    this.transport.onReopen(() => void doQueue());
  }

  /** widen the search radius now (impatient player) */
  expandSearch(): void {
    this.transport.send(encodeMsg({ t: 'expandSearch' }));
  }

  leaveQueue(): void {
    this.transport.send(encodeMsg({ t: 'leaveQueue' }));
  }

  isHost(): boolean {
    return this.clientId !== '' && this.clientId === this.hostId;
  }

  dispose(): void {
    this.transport.close();
  }

  private onMessage(data: string): void {
    const m = decodeServerMsg(data);
    if (m.t === 'welcome') {
      this.clientId = m.clientId;
    } else if (m.t === 'roster') {
      this.players = m.players;
      this.hostId = m.hostId;
      this.handlers.roster?.(m.players, m.hostId);
    } else if (m.t === 'matchStart') {
      this.handlers.matchStart?.(m);
    } else if (m.t === 'queued') {
      this.handlers.queued?.(m.mode, m.size, m.need);
    } else if (m.t === 'matchAssigned') {
      this.handlers.matchAssigned?.(m.room, m.hostRegion, m.mode);
    } else if (m.t === 'strategyStart') {
      this.handlers.strategyStart?.(m.deadline, m.yourRobotId, m.mode, m.intros);
    } else if (m.t === 'error') {
      this.handlers.error?.(m.message);
    } else if (m.t === 'dodgeVerdict') {
      this.handlers.dodgeVerdict?.(m.yours, m.others);
    } else if (m.t === 'serverNotice') {
      setServerNotice(m.message ? { kind: m.kind, message: m.message, until: m.until } : null);
    }
  }
}
