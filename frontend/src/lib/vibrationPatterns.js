// Vibration pattern presets for toy playback.
//
// Each pattern is a pure function of elapsed time (ms) -> intensity (0..1).
// Keeping them stateless functions of `t` means the engine that drives them
// (see useToys.startPattern) can be a dumb setInterval loop: it just feeds
// in `Date.now() - startTime` and forwards whatever comes out to every
// connected toy. Pause/resume, and switching patterns, both fall out for
// free since nothing but `t` is remembered between ticks.

export const VIBRATION_PATTERNS = [
  {
    id: "pulse",
    label: "Pulse",
    description: "Sharp on/off pulses",
    tickMs: 150,
    intensityAt: (t) => ((t % 800) < 400 ? 0.9 : 0),
  },
  {
    id: "wave",
    label: "Wave",
    description: "Smooth rise and fall",
    tickMs: 150,
    intensityAt: (t) => {
      const phase = (t % 3000) / 3000;
      return 0.2 + 0.75 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    },
  },
  {
    id: "escalation",
    label: "Escalation",
    description: "Steady climb, then reset",
    tickMs: 150,
    intensityAt: (t) => Math.min(1, (t % 8000) / 8000),
  },
  {
    id: "heartbeat",
    label: "Heartbeat",
    description: "Lub-dub double pulse",
    tickMs: 100,
    intensityAt: (t) => {
      const phase = t % 1200;
      if (phase < 150) return 0.9;
      if (phase < 300) return 0.15;
      if (phase < 420) return 0.7;
      return 0.1;
    },
  },
  {
    id: "rolling",
    label: "Rolling",
    description: "Fast triangle ramp",
    tickMs: 150,
    intensityAt: (t) => {
      const phase = (t % 1000) / 1000;
      return phase < 0.5 ? phase * 2 : 2 - phase * 2;
    },
  },
  {
    id: "earthquake",
    label: "Earthquake",
    description: "Random jitter bursts",
    tickMs: 250,
    // Not actually a function of t (it's randomized each tick), but keeping
    // the same signature means the engine doesn't need a special case.
    intensityAt: () => 0.3 + Math.random() * 0.7,
  },

  // --- Stroking-focused patterns ---
  // Longer, rhythmic sinusoidal strokes rather than buzzy pulses: the shape
  // suggests up/down motion, with distinct pace and depth characters.
  {
    id: "slow_stroke",
    label: "Slow Stroke",
    description: "Long, deep sinusoidal strokes",
    tickMs: 120,
    intensityAt: (t) => {
      // ~4s full cycle, floor of 0.15 so it never fully stops mid-stroke.
      const phase = (t % 4000) / 4000;
      return 0.15 + 0.8 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    },
  },
  {
    id: "edging_stroke",
    label: "Edging Stroke",
    description: "Builds, then eases off at the peak",
    tickMs: 120,
    intensityAt: (t) => {
      // ~9s cycle: a long climb to near-full, a brief plateau, then a sharp
      // drop back down — the classic tease-and-deny shape.
      const phase = (t % 9000) / 9000;
      if (phase < 0.7) return 0.2 + (phase / 0.7) * 0.75;      // long climb to ~0.95
      if (phase < 0.8) return 0.95;                             // hold at the edge
      return 0.95 - ((phase - 0.8) / 0.2) * 0.75;              // ease back off
    },
  },
  {
    id: "quick_strokes",
    label: "Quick Strokes",
    description: "Fast, short punchy strokes",
    tickMs: 90,
    intensityAt: (t) => {
      // ~0.9s cycle, asymmetric: fast up-beat, slower release — feels like a
      // brisk stroke rather than a symmetric buzz.
      const phase = (t % 900) / 900;
      return phase < 0.35 ? 0.3 + (phase / 0.35) * 0.65 : 0.95 - ((phase - 0.35) / 0.65) * 0.65;
    },
  },

  // --- Anal-play-focused patterns ---
  // Emphasis on steady, deep, sustained pressure and slow swells rather than
  // sharp on/off pulses, which suit this kind of play better.
  {
    id: "deep_fill",
    label: "Deep Fill",
    description: "Slow swell to sustained deep pressure",
    tickMs: 150,
    intensityAt: (t) => {
      // ~12s cycle: slow rise, a long held plateau at high intensity, gentle release.
      const phase = (t % 12000) / 12000;
      if (phase < 0.35) return 0.25 + (phase / 0.35) * 0.65;   // slow swell to ~0.9
      if (phase < 0.8) return 0.9;                              // sustained deep hold
      return 0.9 - ((phase - 0.8) / 0.2) * 0.55;               // gentle release to ~0.35
    },
  },
  {
    id: "throb",
    label: "Throb",
    description: "Deep steady base with slow pulsing swells",
    tickMs: 130,
    intensityAt: (t) => {
      // A high floor (0.4) so pressure never drops away, with a slow ~2.4s
      // sinusoidal throb layered on top — full but rhythmic.
      const phase = (t % 2400) / 2400;
      return 0.4 + 0.5 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    },
  },
  {
    id: "waves_deep",
    label: "Deep Waves",
    description: "Rolling deep waves, never fully off",
    tickMs: 130,
    intensityAt: (t) => {
      // Two overlaid slow sines (~5s and ~7s) so the swells never repeat
      // predictably; clamped to a 0.3 floor for constant presence.
      const a = 0.5 - 0.5 * Math.cos((t % 5000) / 5000 * 2 * Math.PI);
      const b = 0.5 - 0.5 * Math.cos((t % 7000) / 7000 * 2 * Math.PI);
      return Math.min(1, 0.3 + 0.6 * ((a + b) / 2));
    },
  },
];

export function getPattern(id) {
  return VIBRATION_PATTERNS.find((p) => p.id === id) || null;
}
