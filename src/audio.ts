/** Official FIRST field-management sounds (as played at FTC/FRC events).
 * Files live in public/sounds/. */
export type Cue = 'start' | 'end' | 'resume' | 'warning' | 'match_result' | 'abort';

const FILES: Record<Cue, string> = {
  start: 'sounds/start.wav', // "Charge" — AUTO start
  end: 'sounds/end.wav', // buzzer — end of AUTO / end of match
  resume: 'sounds/resume.wav', // three bells — TELEOP start
  warning: 'sounds/warning.wav', // endgame warning (ENDGAME_START s left)
  match_result: 'sounds/match_result.wav',
  abort: 'sounds/abort.wav', // foghorn — match reset
};

/** the WAV cues were mixed hot; this is the fixed trim they've always played at,
 * now the ceiling the `game` slider scales rather than a static per-element volume */
const CUE_LEVEL = 0.55;

export class MatchAudio {
  private sounds = new Map<Cue, HTMLAudioElement>();
  /** master level 0–1; scales every category. 0 = no audio at all. */
  masterVolume = 1;
  /** the FIRST field-recording WAV cues */
  gameVolume = 1;
  /**
   * ONE LEVEL PER EMITTER. These used to be a single `sfxVolume` behind a slider
   * labelled "Beeping", which was three different mechanisms in a trench coat — the
   * launcher, the intake, the classifier gate and the countdown beep all moved
   * together, and the label only described the last of them. They are separate
   * sounds with genuinely different reasons to turn down (the shooter fires
   * constantly; the countdown beep is once a match), so they are separate levels.
   */
  shootVolume = 1;
  intakeVolume = 1;
  gateVolume = 1;
  beepVolume = 1;
  /** "your ranked match is ready" — its own level because it is the one sound that
   *  plays when you are deliberately NOT looking at the game, so it wants to be
   *  louder than the in-match effects rather than tied to them. */
  alertVolume = 1;
  /** announcer voice lines; at 0, countdowns fall back to beeps */
  voiceVolume = 1;

  private get muted(): boolean {
    return this.masterVolume <= 0;
  }

  /** effective level for a category, 0–1 */
  private gain(category: number): number {
    return Math.max(0, Math.min(1, this.masterVolume * category));
  }

  constructor() {
    const base = import.meta.env.BASE_URL ?? './';
    for (const [cue, file] of Object.entries(FILES) as [Cue, string][]) {
      const a = new Audio(base + file);
      a.preload = 'auto';
      a.volume = CUE_LEVEL;
      this.sounds.set(cue, a);
    }
  }

  play(cue: Cue): void {
    const level = this.gain(this.gameVolume);
    if (level <= 0) return;
    const a = this.sounds.get(cue);
    if (!a) return;
    // set per PLAY, not once at construction, so a slider move applies to the very
    // next cue instead of only after a reload
    a.volume = level * CUE_LEVEL;
    a.currentTime = 0;
    void a.play().catch(() => {
      /* browser blocks audio before first interaction — fine */
    });
  }

  private ctx: AudioContext | null = null;

  private keepAlive: { ctx: AudioContext; osc: OscillatorNode } | null = null;

  /** Keep the tab counted as "playing audio" so the browser does NOT throttle
   * background timers — required for smooth lockstep multiplayer when a player
   * unfocuses the tab (a throttled peer would stop feeding inputs and stall
   * everyone). A silent (gain 0) oscillator connected to the destination keeps
   * the AudioContext running; it is independent of the Sounds toggle. */
  startKeepAlive(): void {
    if (this.keepAlive) return;
    // called at match start, i.e. safely inside a user gesture — warm the effects
    // context here so the SFX sliders work even if the player starts fully muted
    this.ensureCtx();
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      void ctx.resume();
      this.keepAlive = { ctx, osc };
    } catch {
      /* no WebAudio — background throttling will apply, but the game still runs */
    }
  }

  stopKeepAlive(): void {
    if (!this.keepAlive) return;
    try {
      this.keepAlive.osc.stop();
      void this.keepAlive.ctx.close();
    } catch {
      /* ignore */
    }
    this.keepAlive = null;
  }

  /** Deliberately NOT gated on volume. A browser only lets an AudioContext start
   * from a user gesture, so refusing to build one while muted would mean raising
   * the slider mid-match finds no gesture left and stays silent until a reload.
   * Build it whenever we're asked; silence is enforced at the gain instead. */
  private ensureCtx(): AudioContext | null {
    try {
      this.ctx ??= new AudioContext();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** one tone with a pitch ramp and an exponential decay envelope. New nodes
   * per call, so rapid overlapping effects mix cleanly. */
  private tone(
    freq0: number,
    freq1: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    delay = 0,
    category = 1,
  ): void {
    // every synthesized effect funnels through tone/noiseBurst, so scaling here is
    // the only place a category level has to be applied. The caller passes WHICH
    // category, because one emitter (the gate) is built from several of these.
    const level = this.gain(category) * vol;
    if (level <= 0) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq0, t);
    if (freq1 !== freq0) osc.frequency.exponentialRampToValueAtTime(freq1, t + dur);
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  /** short countdown beep — fires instantly, always in sync with the visual */
  beep(freq = 780, dur = 0.14, vol = 0.35): void {
    this.tone(freq, freq, dur, 'square', vol, 0, this.beepVolume);
  }

  private noise: AudioBuffer | null = null;

  /** cached 0.25s white-noise buffer for percussive effects */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 0.25);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  /** filtered noise burst: the percussive part of the mechanical effects */
  private noiseBurst(
    freq0: number,
    freq1: number,
    dur: number,
    vol: number,
    q = 1.2,
    delay = 0,
    category = 1,
  ): void {
    const level = this.gain(category) * vol;
    if (level <= 0) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(freq0, t);
    if (freq1 !== freq0) bp.frequency.exponentialRampToValueAtTime(freq1, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(gain).connect(ctx.destination);
    src.start(t);
    src.stop(t + dur + 0.01);
  }

  /** launcher "thwump": a falling noise whoosh with a low pitch-drop body */
  sfxShoot(): void {
    this.noiseBurst(1800, 400, 0.13, 0.35, 1.2, 0, this.shootVolume);
    this.tone(240, 90, 0.11, 'sawtooth', 0.16, 0, this.shootVolume);
  }

  /** intake "slurp": one quick rising blip per swallowed artifact */
  sfxIntake(): void {
    this.tone(150, 330, 0.08, 'sine', 0.22, 0, this.intakeVolume);
  }

  /**
   * MATCH FOUND — a rising three-note chime, deliberately unlike anything the match
   * itself makes. It has to cut through whatever the player is doing (browsing, or
   * driving a practice run) and read as "come back now", so it is a melodic figure
   * rather than one of the percussive mechanism effects.
   */
  sfxMatchFound(): void {
    const v = this.alertVolume;
    this.tone(660, 660, 0.12, 'triangle', 0.34, 0, v);
    this.tone(880, 880, 0.12, 'triangle', 0.34, 0.13, v);
    this.tone(1320, 1320, 0.26, 'triangle', 0.3, 0.26, v);
  }

  /** classifier gate "clack-clunk": latch click, then the flap swinging open */
  sfxGate(): void {
    this.noiseBurst(2600, 2600, 0.03, 0.25, 3, 0, this.gateVolume);
    this.tone(520, 520, 0.05, 'square', 0.14, 0, this.gateVolume);
    this.tone(340, 300, 0.08, 'square', 0.16, 0.07, this.gateVolume);
  }

  private voice: SpeechSynthesisVoice | null = null;
  private voicePicked = false;

  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.voicePicked) return this.voice;
    try {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return null; // list not loaded yet — retry later
      this.voicePicked = true;
      // prefer the higher-quality natural voices when available
      this.voice =
        voices.find((v) => /Google US English/i.test(v.name)) ??
        voices.find((v) => /Natural|Online/i.test(v.name) && v.lang.startsWith('en')) ??
        voices.find((v) => /Mark|David|Guy/i.test(v.name) && v.lang.startsWith('en')) ??
        voices.find((v) => v.lang === 'en-US') ??
        null;
    } catch {
      this.voice = null;
    }
    return this.voice;
  }

  /** announcer voice, like the emcee at a real match ("3... 2... 1...").
   * `interrupt` cancels anything still being spoken so timing stays exact —
   * countdown numbers must land on the visual beat, never queue. */
  say(text: string, interrupt = false): void {
    if (this.muted) return;
    const level = this.gain(this.voiceVolume);
    try {
      // voice at 0 keeps the OLD toggle-off behaviour exactly: countdown numbers
      // still land on the visual beat, as beeps
      if (level <= 0 || !('speechSynthesis' in window)) {
        if (interrupt) this.beep();
        return;
      }
      if (interrupt) window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) u.voice = v;
      u.rate = 1.1;
      u.pitch = 0.95;
      u.volume = level * 0.9;
      window.speechSynthesis.speak(u);
    } catch {
      /* speech unavailable */
    }
  }

  stopSpeech(): void {
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}
