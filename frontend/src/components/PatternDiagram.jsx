import React, { useEffect, useRef, useState } from "react";
import { getPattern } from "@/lib/vibrationPatterns";

// Animated VIRTUAL DEVICE view of an OSSM pattern program: a vertical rail with
// a toolhead (carriage) that physically slides back and forth, so you can SEE
// the motion instead of reading a chart. It is driven by the same four-axis
// math ControlConsole.runProgram uses:
//   speed     — the pattern's intensity(t): how FAST the toolhead reciprocates
//   depth     — slow ~14s sine: the TOP of travel (how far in the stroke reaches)
//   stroke    — ~9s sine: the LENGTH of each stroke (top .. top-stroke)
//   sensation — very slow ~19s sine: shown as a glow intensity on the head
// Shapes are normalised 0..1; the owner's live limits scale them at runtime,
// but the visual communicates the SHAPE of the motion.

function axisValue(key, pat, t) {
  switch (key) {
    case "speed": return Math.min(1, Math.max(0, pat.intensityAt(t * 1000)));
    case "depth": return 0.5 - 0.5 * Math.cos((t % 14) / 14 * 2 * Math.PI);
    case "stroke": return 0.5 - 0.5 * Math.cos((t % 9) / 9 * 2 * Math.PI);
    case "sensation": return 0.5 - 0.5 * Math.cos((t % 19) / 19 * 2 * Math.PI);
    default: return 0;
  }
}

// Tiny inline speed-only sparkline for the program picker buttons (unchanged).
function buildSparkPoints(pat, seconds, w, h, pad = 1) {
  const steps = 100;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * seconds;
    const v = Math.min(1, Math.max(0, pat.intensityAt(t * 1000)));
    const x = pad + (i / steps) * (w - pad * 2);
    const y = pad + (1 - v) * (h - pad * 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

// Speed-only sparkline. `fill` makes it span the container width (used inside the
// program cards); otherwise it renders at a fixed pixel size. The viewBox stays
// in internal units, so the polyline math is unchanged either way.
export function PatternSparkline({ patternId, seconds = 12, width = 64, height = 20, fill = false }) {
  const pat = getPattern(patternId);
  if (!pat) return null;
  return (
    <svg
      width={fill ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={fill ? "block w-full" : "shrink-0"}
      aria-hidden="true"
    >
      <polyline
        points={buildSparkPoints(pat, seconds, width, height)}
        fill="none" stroke="var(--kink-purple)" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" opacity="0.85"
      />
    </svg>
  );
}

// Animated virtual-device diagram. Runs its own rAF clock so the toolhead moves
// in real time, mirroring the pattern's reciprocation. When `running` is false
// the head parks at the retracted end and the clock is idle, so the picker can
// show the device at rest before a program is started.
export function PatternDiagram({ patternId, name, running = true, mode = "running" }) {
  const pat = getPattern(patternId);
  const wrapRef = useRef(null);
  const [{ pos, top, bottom, speed, sensation }, setFrame] = useState({
    pos: 0, top: 1, bottom: 0, speed: 0, sensation: 0,
  });

  useEffect(() => {
    if (!pat || !running) {
      // Parked / at rest: head retracted, no animation clock.
      setFrame({ pos: 0, top: 1, bottom: 0, speed: 0, sensation: 0 });
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    // phase accumulates reciprocation cycles; its rate is set by live speed so
    // the head strokes faster when the pattern's speed is high.
    let phase = 0;
    let last = start;
    const loop = (now) => {
      const t = (now - start) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const speed01 = axisValue("speed", pat, t);
      const depth01 = axisValue("depth", pat, t);
      const stroke01 = axisValue("stroke", pat, t);
      const sens01 = axisValue("sensation", pat, t);
      // top of travel = depth; bottom = depth - stroke (clamped to >=0).
      const top = depth01;
      const bottom = Math.max(0, depth01 - stroke01 * depth01);
      // reciprocation: 0.2..~2.2 strokes/sec across the speed range.
      phase += dt * (0.2 + speed01 * 2.0);
      const osc = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI); // 0..1 within the stroke
      const pos = bottom + osc * (top - bottom);
      setFrame({ pos, top, bottom, speed: speed01, sensation: sens01 });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pat, patternId, running]);

  if (!pat) return null;

  // Geometry: a horizontal rail. 0 = fully retracted (left), 1 = deepest (right).
  const W = 320, H = 96, railY = H / 2, railX0 = 44, railX1 = W - 26;
  const railLen = railX1 - railX0;
  const x = (v) => railX0 + v * railLen;
  const headX = x(pos);
  const glow = 3 + sensation * 7;

  return (
    <div className="border border-[var(--kink-overlay)] bg-[var(--kink-base)] p-3" data-testid="pattern-diagram" ref={wrapRef}>
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 font-mono-data text-[11px] text-[var(--kink-text-2)]">
          {mode === "preview" && (
            <span className="px-1.5 py-0.5 border border-[var(--kink-purple)]/50 text-[var(--kink-purple)] text-[9px] uppercase tracking-wide">
              Preview
            </span>
          )}
          {mode === "running" && (
            <span className="px-1.5 py-0.5 border border-[var(--kink-purple)] text-[var(--kink-purple)] text-[9px] uppercase tracking-wide">
              Running
            </span>
          )}
          {name ? `${name}` : "Virtual device"}
        </span>
        <span className="font-mono-data text-[9px] text-[var(--kink-muted)]">
          {mode === "rest" ? "at rest" : `speed ${Math.round(speed * 100)}%`}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ height: 104 }} className="block">
        <defs>
          <linearGradient id="kk-shaft" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d9d2e4" />
            <stop offset="0.5" stopColor="#b8afc6" />
            <stop offset="1" stopColor="#8a8196" />
          </linearGradient>
          <radialGradient id="kk-tip" cx="0.35" cy="0.35" r="0.75">
            <stop offset="0" stopColor="#c99bff" />
            <stop offset="1" stopColor="var(--kink-purple)" />
          </radialGradient>
        </defs>

        {/* motor housing at the retracted end */}
        <rect x={6} y={railY - 20} width={30} height={40} rx={4} fill="var(--kink-overlay)" stroke="var(--kink-muted)" strokeWidth="0.5" />
        <rect x={11} y={railY - 12} width={20} height={24} rx={2} fill="none" stroke="var(--kink-muted)" strokeWidth="0.5" opacity="0.6" />
        <text x={21} y={railY + 30} textAnchor="middle" fontSize="7" fill="var(--kink-muted)" fontFamily="monospace">OSSM</text>

        {/* rail (guide rods) */}
        <line x1={railX0} y1={railY - 5} x2={railX1} y2={railY - 5} stroke="var(--kink-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
        <line x1={railX0} y1={railY + 5} x2={railX1} y2={railY + 5} stroke="var(--kink-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />

        {/* stroke-range band (bottom..top of current travel) */}
        <line x1={x(bottom)} y1={railY} x2={x(top)} y2={railY} stroke="var(--kink-purple)" strokeWidth="5" strokeLinecap="round" opacity="0.28" />
        {/* end markers for the travel range */}
        <line x1={x(bottom)} y1={railY - 12} x2={x(bottom)} y2={railY + 12} stroke="#ffb454" strokeWidth="1.5" opacity="0.7" />
        <line x1={x(top)} y1={railY - 12} x2={x(top)} y2={railY + 12} stroke="#4ea1ff" strokeWidth="1.5" opacity="0.7" />

        {/* connecting rod from motor to the carriage */}
        <line x1={36} y1={railY} x2={headX - 8} y2={railY} stroke="#6f6780" strokeWidth="3" strokeLinecap="round" />

        {/* ---- realistic toolhead: carriage block + shaft + rounded tip ---- */}
        <g style={{ filter: `drop-shadow(0 0 ${glow}px var(--kink-purple))` }}>
          {/* carriage clamp riding the rail */}
          <rect x={headX - 8} y={railY - 10} width={12} height={20} rx={3} fill="#5a5368" stroke="#8a8196" strokeWidth="0.75" />
          {/* shaft */}
          <rect x={headX + 2} y={railY - 6} width={26} height={12} rx={6} fill="url(#kk-shaft)" stroke="#7c7488" strokeWidth="0.5" />
          {/* rounded tip / attachment */}
          <ellipse cx={headX + 30} cy={railY} rx={9} ry={9} fill="url(#kk-tip)" stroke="#fff" strokeWidth="0.75" />
          <ellipse cx={headX + 27} cy={railY - 3} rx={2.5} ry={2} fill="#fff" opacity="0.5" />
        </g>
      </svg>
      <div className="flex items-center justify-between font-mono-data text-[9px] text-[var(--kink-muted)] mt-1.5">
        <span><span style={{ color: "#ffb454" }}>▮</span> bottom of stroke</span>
        <span>depth &amp; stroke set the travel band · sensation = glow</span>
        <span><span style={{ color: "#4ea1ff" }}>▮</span> deepest</span>
      </div>
    </div>
  );
}
