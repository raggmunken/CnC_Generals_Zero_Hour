/**
 * Sound. Everything here is client-side: the sim sends no audio events, the
 * client derives them from the same snapshot diffs that drive visual effects.
 *
 * Three rules shape the design:
 *
 *  - The browser refuses audio before the first user gesture, so the
 *    AudioContext is created lazily on the first pointer/key event and every
 *    play() before that is simply dropped.
 *  - An RTS produces dozens of overlapping shots a second. Each sound has a
 *    minimum retrigger interval and a hard cap on simultaneous voices, and
 *    off-screen events are attenuated by distance and then dropped entirely
 *    past a cutoff -- without this, one tank battle is white noise.
 *  - The samples are synthesised here rather than shipped. The game cannot use
 *    the original C&C audio, and a pack of recorded samples is a licensing
 *    question, a few hundred KB in the repo and a generated file that can go
 *    missing. Noise through a swept filter plus a falling sine is what a shell
 *    burst is anyway, and it costs a few milliseconds at unlock.
 */

export type SfxName =
  | "rifle"
  | "cannon"
  | "rocket"
  | "explosion"
  | "bigexplosion"
  | "build"
  | "harvest"
  | "click";

const NAMES: SfxName[] = [
  "rifle", "cannon", "rocket", "explosion", "bigexplosion", "build", "harvest", "click",
];

// -- synthesis --------------------------------------------------------------

/**
 * Seeded, so a sound is the same on every load. Sample-accurate reproducibility
 * is not the point; not having the rifle land differently each refresh is.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000 * 2 - 1;
  };
}

/** One-pole lowpass coefficient for a cutoff in Hz. */
function poleFor(cutoffHz: number, rate: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / rate);
}

interface Recipe {
  seconds: number;
  /** Peak amplitude before the master gain. */
  gain: number;
  /** Filtered-noise body: cutoff sweeps from `from` Hz to `to` Hz. */
  noise?: { from: number; to: number; decay: number; attack?: number };
  /** Sine body: pitch sweeps from `from` Hz to `to` Hz. */
  tone?: { from: number; to: number; decay: number; attack?: number; mix: number };
  /** Amplitude modulation, for granular textures like ore being loaded. */
  wobbleHz?: number;
  /** A second blip, delayed, for two-note UI sounds. */
  blip?: { at: number; hz: number; decay: number; mix: number };
}

/**
 * The whole pack in one table. Every sound is a filtered noise burst, a swept
 * sine, or both -- which covers gunfire, explosions and UI blips between them,
 * and keeps the differences between them legible as numbers.
 */
const RECIPES: Record<SfxName, Recipe> = {
  rifle: {
    seconds: 0.13, gain: 0.55,
    noise: { from: 5200, to: 900, decay: 0.022 },
    tone: { from: 220, to: 90, decay: 0.03, mix: 0.35 },
  },
  cannon: {
    seconds: 0.4, gain: 0.95,
    noise: { from: 2400, to: 260, decay: 0.07 },
    tone: { from: 150, to: 44, decay: 0.1, mix: 0.9 },
  },
  rocket: {
    // Slow attack: the whoosh has to build, or it reads as another gunshot.
    seconds: 0.5, gain: 0.75,
    noise: { from: 700, to: 3400, decay: 0.16, attack: 0.05 },
    tone: { from: 90, to: 130, decay: 0.2, attack: 0.04, mix: 0.4 },
  },
  explosion: {
    seconds: 0.75, gain: 1.0,
    noise: { from: 3000, to: 190, decay: 0.17, attack: 0.004 },
    tone: { from: 95, to: 32, decay: 0.26, mix: 0.85 },
  },
  bigexplosion: {
    seconds: 1.2, gain: 1.0,
    noise: { from: 2200, to: 120, decay: 0.34, attack: 0.008 },
    tone: { from: 66, to: 22, decay: 0.45, mix: 1.0 },
  },
  build: {
    seconds: 0.32, gain: 0.5,
    tone: { from: 660, to: 660, decay: 0.05, attack: 0.004, mix: 1 },
    blip: { at: 0.11, hz: 990, decay: 0.06, mix: 1 },
  },
  harvest: {
    seconds: 0.38, gain: 0.6,
    noise: { from: 1500, to: 300, decay: 0.13, attack: 0.01 },
    wobbleHz: 26,
  },
  click: {
    seconds: 0.05, gain: 0.4,
    noise: { from: 6000, to: 3000, decay: 0.006 },
    tone: { from: 1300, to: 1000, decay: 0.01, mix: 0.7 },
  },
};

/** Attack-then-exponential-decay envelope, in [0, 1]. */
function envelope(t: number, attack: number, decay: number): number {
  const rise = attack > 0 ? Math.min(1, t / attack) : 1;
  return rise * Math.exp(-t / decay);
}

function render(ctx: BaseAudioContext, name: SfxName): AudioBuffer {
  const r = RECIPES[name];
  const rate = ctx.sampleRate;
  const n = Math.max(1, Math.round(r.seconds * rate));
  const buf = ctx.createBuffer(1, n, rate);
  const out = buf.getChannelData(0);
  // Seed from the name so each sound is stable and none shares another's noise.
  const rng = makeRng([...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));

  let lp = 0;
  let phase = 0;
  let blipPhase = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const u = i / n;
    let v = 0;

    if (r.noise) {
      // Sweeping the cutoff is what turns a hiss into a burst: bright at the
      // crack, dull as it rolls away.
      const cutoff = r.noise.from + (r.noise.to - r.noise.from) * u;
      lp += (rng() - lp) * poleFor(cutoff, rate);
      v += lp * envelope(t, r.noise.attack ?? 0.001, r.noise.decay);
    }
    if (r.tone) {
      phase += (2 * Math.PI * (r.tone.from + (r.tone.to - r.tone.from) * u)) / rate;
      v += Math.sin(phase) * envelope(t, r.tone.attack ?? 0.002, r.tone.decay) * r.tone.mix;
    }
    if (r.blip && t >= r.blip.at) {
      blipPhase += (2 * Math.PI * r.blip.hz) / rate;
      v += Math.sin(blipPhase) * envelope(t - r.blip.at, 0.004, r.blip.decay) * r.blip.mix;
    }
    if (r.wobbleHz) v *= 0.55 + 0.45 * Math.sin(2 * Math.PI * r.wobbleHz * t);

    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }

  // Normalise, then apply the recipe gain, so the table's numbers are relative
  // loudness rather than an accident of how the maths happened to land.
  const k = peak > 0 ? r.gain / peak : 0;
  for (let i = 0; i < n; i++) out[i] = out[i]! * k;
  // Fade the last 3ms: a buffer that ends mid-swing clicks on every play.
  const tail = Math.min(n, Math.round(0.003 * rate));
  for (let i = 0; i < tail; i++) out[n - tail + i] = out[n - tail + i]! * (1 - i / tail);
  return buf;
}

/** Milliseconds before the same sound may start again. */
const RETRIGGER_MS: Record<SfxName, number> = {
  rifle: 90,
  cannon: 120,
  rocket: 120,
  explosion: 120,
  bigexplosion: 200,
  build: 400,
  harvest: 800,
  click: 40,
};

/** Simultaneous voices of one sound; extras are dropped, not queued. */
const MAX_VOICES: Record<SfxName, number> = {
  rifle: 6,
  cannon: 5,
  rocket: 5,
  explosion: 4,
  bigexplosion: 2,
  build: 2,
  harvest: 2,
  click: 3,
};

/** World-unit distance from the viewport centre at which a sound is silent. */
const HEARING_RANGE = 45;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private lastPlay = new Map<SfxName, number>();
  private voices = new Map<SfxName, number>();
  private loading = false;

  muted = typeof localStorage !== "undefined" && localStorage.getItem("rts-muted") === "1";

  /**
   * Create/resume the context and start fetching samples. Must be called from
   * a user gesture; calling it repeatedly is cheap and safe.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    if (!this.loading) {
      this.loading = true;
      for (const name of NAMES) {
        try {
          this.buffers.set(name, render(this.ctx, name));
        } catch {
          /* a sound that will not render simply never plays */
        }
      }
    }
  }

  /** How many samples are rendered and playable (tests and debugging). */
  get loadedCount(): number {
    return this.buffers.size;
  }

  /**
   * Shape of each rendered sample, for tests. Synthesised audio fails silently
   * -- a recipe that produces nothing, or clips into a buzz, plays without
   * error -- so the numbers have to be checkable from outside.
   */
  debugStats(): Array<{ name: SfxName; seconds: number; peak: number; rms: number }> {
    const out = [];
    for (const [name, buf] of this.buffers) {
      const d = buf.getChannelData(0);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i]!);
        if (v > peak) peak = v;
        sum += d[i]! * d[i]!;
      }
      out.push({
        name,
        seconds: Number(buf.duration.toFixed(3)),
        peak: Number(peak.toFixed(3)),
        rms: Number(Math.sqrt(sum / d.length).toFixed(4)),
      });
    }
    return out;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem("rts-muted", this.muted ? "1" : "0");
    } catch {
      /* private mode: mute works for the session only */
    }
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime);
    }
    return this.muted;
  }

  /**
   * Play a sound positioned in the world. volume falls off with distance from
   * the viewport centre; events beyond HEARING_RANGE are silent.
   */
  playAt(name: SfxName, x: number, y: number, viewCX: number, viewCY: number, volume = 1, rate = 1): void {
    const dist = Math.hypot(x - viewCX, y - viewCY);
    if (dist > HEARING_RANGE) return;
    const atten = 1 - dist / HEARING_RANGE;
    this.play(name, volume * atten * atten, rate);
  }

  /** Play a sound at a fixed volume (UI sounds, anything at the camera). */
  play(name: SfxName, volume = 1, rate = 1): void {
    if (!this.ctx || !this.master || this.muted) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    const now = performance.now();
    const last = this.lastPlay.get(name) ?? -Infinity;
    if (now - last < RETRIGGER_MS[name]) return;
    const active = this.voices.get(name) ?? 0;
    if (active >= MAX_VOICES[name]) return;
    this.lastPlay.set(name, now);
    this.voices.set(name, active + 1);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // Small random detune keeps repeated shots from phasing into a beat.
    src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
    const gain = this.ctx.createGain();
    gain.gain.value = Math.min(1, volume);
    src.connect(gain);
    gain.connect(this.master);
    src.onended = () => this.voices.set(name, (this.voices.get(name) ?? 1) - 1);
    src.start();
  }
}
