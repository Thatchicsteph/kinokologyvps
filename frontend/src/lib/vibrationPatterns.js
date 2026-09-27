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

  // --- Additional variety patterns ---
  {
    id: "tease",
    label: "Tease",
    description: "Brief teasing taps with quiet gaps",
    tickMs: 120,
    intensityAt: (t) => {
      // ~2.5s cycle: a short strong tap, then a long near-silent gap.
      const phase = t % 2500;
      if (phase < 250) return 0.85;
      if (phase < 500) return 0.2;
      return 0.05;
    },
  },
  {
    id: "staircase",
    label: "Staircase",
    description: "Steps up in stages, then resets",
    tickMs: 150,
    intensityAt: (t) => {
      // 5 discrete steps over ~10s, each held for 2s, then back to the bottom.
      const step = Math.floor((t % 10000) / 2000); // 0..4
      return 0.2 + step * 0.2; // 0.2, 0.4, 0.6, 0.8, 1.0
    },
  },
  {
    id: "flutter",
    label: "Flutter",
    description: "Fast light flutter over a low base",
    tickMs: 70,
    intensityAt: (t) => {
      // Rapid ~4Hz flutter on a gentle 0.25 floor — light and constant.
      const phase = (t % 250) / 250;
      return 0.25 + 0.35 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    },
  },
  {
    id: "surge",
    label: "Surge",
    description: "Sudden surge, slow fade",
    tickMs: 120,
    intensityAt: (t) => {
      // ~3.5s cycle: instant jump to full, then a smooth exponential-ish fade.
      const phase = (t % 3500) / 3500;
      return 0.1 + 0.9 * Math.pow(1 - phase, 2);
    },
  },
  {
    id: "double_tap",
    label: "Double Tap",
    description: "Two quick taps, then a rest",
    tickMs: 90,
    intensityAt: (t) => {
      // ~1.6s cycle: tap, gap, tap, longer rest.
      const phase = t % 1600;
      if (phase < 160) return 0.9;
      if (phase < 320) return 0.1;
      if (phase < 480) return 0.9;
      return 0.05;
    },
  },
  {
    id: "relentless",
    label: "Relentless",
    description: "High sustained with a fast ripple",
    tickMs: 100,
    intensityAt: (t) => {
      // A high 0.7 floor with a quick ~1.2s ripple on top — intense and constant.
      const phase = (t % 1200) / 1200;
      return 0.7 + 0.25 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    },
  },

  // --- High-intensity patterns ---
  {
    id: "overdrive",
    label: "Overdrive",
    description: "Near-max hold with hard jolts",
    tickMs: 90,
    intensityAt: (t) => {
      // 0.85 floor with sharp jolts to full every ~700ms.
      return (t % 700) < 200 ? 1.0 : 0.85;
    },
  },
  {
    id: "hammer",
    label: "Hammer",
    description: "Fast pounding full-power beats",
    tickMs: 70,
    intensityAt: (t) => {
      // Rapid ~350ms hammer: hard on/off, staying strong.
      return (t % 350) < 175 ? 1.0 : 0.55;
    },
  },
  {
    id: "inferno",
    label: "Inferno",
    description: "Sustained max with rapid tremor",
    tickMs: 60,
    intensityAt: (t) => {
      // 0.8 floor with a very fast ~6Hz tremor riding near the top.
      const phase = (t % 165) / 165;
      return 0.8 + 0.2 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    },
  },
  {
    id: "crescendo_max",
    label: "Crescendo",
    description: "Hard climb to full, snap back, repeat",
    tickMs: 90,
    intensityAt: (t) => {
      // ~2.5s aggressive ramp from an already-high 0.6 to full, then snaps down.
      const phase = (t % 2500) / 2500;
      return 0.6 + 0.4 * phase;
    },
  },

  // --- Gentle patterns ---
  // Low ceilings and slow, soft movement — for warm-up, background, or teasing
  // at a whisper. None exceed ~0.5 intensity.
  {
    id: "breathe",
    label: "Breathe",
    description: "Slow, soft rise and fall",
    tickMs: 160,
    intensityAt: (t) => {
      // ~6s calm breath cycle, gentle floor, low ceiling (~0.45).
      const phase = (t % 6000) / 6000;
      return 0.1 + 0.35 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    },
  },
  {
    id: "whisper",
    label: "Whisper",
    description: "Faint constant hum",
    tickMs: 200,
    intensityAt: () => 0.18,
  },
  {
    id: "ripple_soft",
    label: "Soft Ripple",
    description: "Light, slow undulation",
    tickMs: 160,
    intensityAt: (t) => {
      // Two gentle slow sines overlaid, capped low for a soft shimmer.
      const a = 0.5 - 0.5 * Math.cos((t % 4500) / 4500 * 2 * Math.PI);
      const b = 0.5 - 0.5 * Math.cos((t % 6500) / 6500 * 2 * Math.PI);
      return 0.12 + 0.28 * ((a + b) / 2);
    },
  },
  {
    id: "lull",
    label: "Lull",
    description: "Soft taps with long calm gaps",
    tickMs: 180,
    intensityAt: (t) => {
      // ~5s cycle: a brief soft touch, then a long near-silent lull.
      const phase = t % 5000;
      if (phase < 400) return 0.4;
      if (phase < 800) return 0.15;
      return 0.06;
    },
  },
];

export function getPattern(id) {
  return VIBRATION_PATTERNS.find((p) => p.id === id) || null;
}

// Grouping for the picker UI. Ordered list of { key, label }; each pattern id
// maps to one key. Anything not listed falls into "classic" so a newly-added
// pattern still shows up rather than vanishing.
export const PATTERN_CATEGORIES = [
  { key: "classic", label: "Classic" },
  { key: "gentle", label: "Gentle" },
  { key: "stroking", label: "Stroking" },
  { key: "anal", label: "Anal Play" },
  { key: "intense", label: "High Intensity" },
];

const PATTERN_CATEGORY_BY_ID = {
  // classic (originals)
  pulse: "classic", wave: "classic", escalation: "classic",
  heartbeat: "classic", rolling: "classic", earthquake: "classic",
  tease: "classic", staircase: "classic", flutter: "classic",
  surge: "classic", double_tap: "classic",
  // gentle
  breathe: "gentle", whisper: "gentle", ripple_soft: "gentle", lull: "gentle",
  // stroking
  slow_stroke: "stroking", edging_stroke: "stroking", quick_strokes: "stroking",
  // anal play
  deep_fill: "anal", throb: "anal", waves_deep: "anal",
  // high intensity
  relentless: "intense", overdrive: "intense", hammer: "intense",
  inferno: "intense", crescendo_max: "intense",
};

export function categoryOf(id) {
  return PATTERN_CATEGORY_BY_ID[id] || "classic";
}

// Returns [{ key, label, patterns: [...] }] in PATTERN_CATEGORIES order,
// omitting any category that has no patterns.
export function getPatternsByCategory() {
  return PATTERN_CATEGORIES
    .map((c) => ({
      ...c,
      patterns: VIBRATION_PATTERNS.filter((p) => categoryOf(p.id) === c.key),
    }))
    .filter((c) => c.patterns.length > 0);
}
