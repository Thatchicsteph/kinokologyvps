import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BACKEND_URL, WS_BASE, fmtTime } from "@/lib/api";
import { Sparkline } from "@/components/Sparkline";
import { Gauge, Ruler, Waves, Move3d, Activity, Heart, Zap } from "lucide-react";
import kinkologyMark from "@/assets/kinkology-mark.png";
import { PATTERNS } from "@/lib/ossm";
import { PROGRAMS } from "@/components/ControlConsole";

// Smoothly tween a displayed number toward its live target so the overlay
// gauges glide instead of snapping when a new telemetry frame lands. Uses
// requestAnimationFrame with an ease-out curve; snaps instantly for tiny
// deltas so it always settles exactly on the target (no lingering fractions).
function useEased(target, ms = 320) {
  const [shown, setShown] = useState(target);
  const ref = useRef({ from: target, to: target, start: 0, raf: 0 });
  useEffect(() => {
    const s = ref.current;
    if (Math.abs(target - s.to) < 0.5) return; // already heading there
    s.from = shown;
    s.to = target;
    s.start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - s.start) / ms);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const v = s.from + (s.to - s.from) * eased;
      setShown(Math.abs(s.to - v) < 0.5 ? s.to : v);
      if (t < 1) s.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(s.raf);
    s.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(s.raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ms]);
  return Math.round(shown);
}

const METRICS = [
  { key: "speed",     label: "SPEED",     color: "#FF2A5F", icon: Gauge,   panelId: "speed"     },
  { key: "depth",     label: "DEPTH",     color: "#C7C9D1", icon: Move3d,  panelId: "depth"     },
  { key: "stroke",    label: "STROKE",    color: "#FFB020", icon: Ruler,   panelId: "stroke"    },
  { key: "sensation", label: "SENSATION", color: "#A855F7", icon: Waves,   panelId: "sensation" },
];

const CAP = 120;
const HR_COLOR = "#FF4D6D";
const HR_TARGET_COLOR = "#C7C9D1";

// One metric gauge (speed/depth/stroke/sensation). The displayed % is eased
// toward the live value so it glides on stream instead of snapping. The
// sparkline is a history plot and is already smooth, so it uses the raw value.
function MetricPanel({ metric, value, history, glassStyle }) {
  const eased = useEased(value);
  return (
    <div
      data-testid={`overlay-metric-${metric.key}`}
      className="hud-panel p-5"
      style={glassStyle}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <metric.icon size={16} style={{ color: metric.color }} />
          <span className="font-display text-xs tracking-[0.18em]" style={{ color: metric.color }}>{metric.label}</span>
        </div>
        <span className="font-mono-data font-extrabold text-3xl tabular-nums" style={{ color: metric.color }} data-testid={`overlay-value-${metric.key}`}>
          {eased}
          <span className="text-sm text-[var(--kink-muted)] ml-0.5">%</span>
        </span>
      </div>
      <Sparkline data={history} color={metric.color} id={metric.key} height={72} />
    </div>
  );
}

// Default config — used until the fetch resolves.
const DEFAULT_CONFIG = {
  panels: ["header", "timer", "heartrate", "program", "speed", "depth", "stroke", "sensation"],
  layout: "2col",
};

export default function Overlay() {
  const [params] = useSearchParams();
  const transparent = params.has("transparent");

  // URL param overrides: ?panels=speed,depth,heartrate  ?layout=1col
  const paramPanels = params.get("panels");
  const paramLayout = params.get("layout");

  const [config, setConfig] = useState(DEFAULT_CONFIG);

  const [frame, setFrame] = useState({
    speed: 0, depth: 0, stroke: 0, sensation: 0, pattern: 0, active_program: null,
    run_seconds: 0, session_seconds: 0, running: false, replaying: false,
    controller: null, host_connected: false,
    hr_bpm: 0, hr_connected: false, hr_cutoff: 0, hr_over: false,
    hr_target: 0, hr_sync_enabled: false,
  });
  const [history, setHistory] = useState({
    speed: [], depth: [], stroke: [], sensation: [], hr: [],
  });
  const [connected, setConnected] = useState(false);
  const latest = useRef(frame);
  latest.current = frame;

  // Fetch overlay config from backend (public endpoint — no auth needed).
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/overlay/config`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          setConfig({
            panels: paramPanels ? paramPanels.split(",").map((s) => s.trim()) : data.panels,
            layout: paramLayout || data.layout,
          });
        } else if (paramPanels || paramLayout) {
          setConfig({
            panels: paramPanels ? paramPanels.split(",").map((s) => s.trim()) : DEFAULT_CONFIG.panels,
            layout: paramLayout || DEFAULT_CONFIG.layout,
          });
        }
      })
      .catch(() => {
        if (paramPanels || paramLayout) {
          setConfig({
            panels: paramPanels ? paramPanels.split(",").map((s) => s.trim()) : DEFAULT_CONFIG.panels,
            layout: paramLayout || DEFAULT_CONFIG.layout,
          });
        }
      });
  }, [paramPanels, paramLayout]);

  // WebSocket: receive live telemetry frames.
  useEffect(() => {
    let ws;
    let retry;
    const connect = () => {
      ws = new WebSocket(`${WS_BASE}/api/ws/overlay`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); retry = setTimeout(connect, 1500); };
      ws.onerror = () => {};
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "telemetry") setFrame(msg);
        } catch (e) {}
      };
    };
    connect();
    return () => { if (retry) clearTimeout(retry); if (ws) ws.close(); };
  }, []);

  // Sample rolling history at 500ms for smooth sparklines.
  useEffect(() => {
    const iv = setInterval(() => {
      const f = latest.current;
      setHistory((h) => {
        const push = (arr, v) => {
          const next = arr.concat(v);
          return next.length > CAP ? next.slice(next.length - CAP) : next;
        };
        return {
          speed:     push(h.speed,     f.speed),
          depth:     push(h.depth,     f.depth),
          stroke:    push(h.stroke,    f.stroke),
          sensation: push(h.sensation, f.sensation),
          hr:        push(h.hr,        f.hr_bpm || 0),
        };
      });
    }, 500);
    return () => clearInterval(iv);
  }, []);

  const show = (panelId) => config.panels.includes(panelId);
  const glassStyle = transparent ? { background: "rgba(22,22,24,0.72)", backdropFilter: "blur(10px)" } : {};

  // Metric panels — rendered in the order they appear in config.panels.
  const metricPanelsOrdered = METRICS.filter((m) => show(m.panelId)).sort(
    (a, b) => config.panels.indexOf(a.panelId) - config.panels.indexOf(b.panelId),
  );

  const gridClass = config.layout === "1col" ? "" : "sm:grid-cols-2";

  return (
    <div
      data-testid="overlay-root"
      className="min-h-screen w-full p-6 sm:p-8 font-sans"
      style={{ background: transparent ? "transparent" : "var(--kink-base)" }}
    >
      {/* Header */}
      {show("header") && (
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <img src={kinkologyMark} alt="Kinkology" style={{ height: 22, width: 22 }} className="rounded-sm" />
            <span className="font-display font-black tracking-[0.25em] text-lg">KINKOLOGY LIVE</span>
          </div>
          <div className="flex items-center gap-5">
            {frame.replaying && (
              <span
                className="flex items-center gap-2 font-mono-data text-xs uppercase tracking-wide text-[var(--kink-purple)]"
                data-testid="overlay-replaying"
              >
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--kink-purple)] pulse-dot" />
                Replaying
              </span>
            )}
            {frame.controller && (
              <span className="font-mono-data text-sm text-[var(--kink-text-2)]" data-testid="overlay-controller">
                CTRL: <span className="text-white">{frame.controller}</span>
              </span>
            )}
            <span className="flex items-center gap-2 font-mono-data text-xs" data-testid="overlay-status">
              <span className={`h-2.5 w-2.5 rounded-full ${connected && frame.host_connected ? "bg-[var(--kink-purple)] pulse-dot" : "bg-[var(--kink-danger)]"}`} />
              {connected ? (frame.host_connected ? "LIVE" : "NO DEVICE") : "OFFLINE"}
            </span>
          </div>
        </div>
      )}

      {/* Run time banner */}
      {show("timer") && (
        <div className="hud-panel px-6 py-5 mb-6 flex flex-wrap items-center justify-between gap-4" style={glassStyle}>
          <div className="flex items-center gap-3">
            <Activity size={20} className={frame.running ? "text-[var(--kink-purple)]" : "text-[var(--kink-muted)]"} />
            <div>
              <p className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)]">RUN TIME</p>
              <p className="font-mono-data font-extrabold text-4xl sm:text-5xl tabular-nums leading-none text-[var(--kink-purple)] text-glow-purple" data-testid="overlay-runtime">
                {fmtTime(frame.run_seconds)}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)]">SESSION</p>
            <p className="font-mono-data font-bold text-2xl tabular-nums text-white" data-testid="overlay-session">{fmtTime(frame.session_seconds)}</p>
          </div>
        </div>
      )}

      {/* Active program / pattern */}
      {show("program") && (frame.active_program || frame.pattern > 0) && (() => {
        const prog = frame.active_program ? PROGRAMS.find((p) => p.id === frame.active_program) : null;
        const pat = !prog ? PATTERNS.find((p) => p.idx === frame.pattern) : null;
        if (!prog && !pat) return null;
        return (
          <div
            data-testid="overlay-program"
            className="hud-panel px-6 py-4 mb-6 flex items-center gap-3"
            style={glassStyle}
          >
            <Zap size={18} className="text-[var(--kink-purple)] shrink-0" />
            <div className="min-w-0">
              {prog ? (
                <>
                  <p className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)]">AUTO PROGRAM</p>
                  <p className="font-mono-data font-bold text-lg text-[var(--kink-purple)] truncate" data-testid="overlay-program-name">
                    {prog.name}
                    <span className="text-sm font-normal text-[var(--kink-muted)] ml-2">{prog.desc}</span>
                  </p>
                </>
              ) : (
                <>
                  <p className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)]">PATTERN</p>
                  <p className="font-mono-data font-bold text-lg text-white truncate" data-testid="overlay-pattern-name">
                    {pat.name}
                    {pat.desc && <span className="text-sm font-normal text-[var(--kink-muted)] ml-2">{pat.desc}</span>}
                  </p>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Heart rate */}
      {show("heartrate") && (
        <div
          data-testid="overlay-hr"
          className="hud-panel px-6 py-5 mb-6"
          style={glassStyle}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <Heart
                size={22}
                style={{ color: HR_COLOR }}
                className={frame.hr_connected && frame.hr_bpm > 0 ? "hr-pulse" : ""}
                fill={frame.hr_connected && frame.hr_bpm > 0 ? "currentColor" : "none"}
              />
              <span className="font-display text-xs tracking-[0.18em]" style={{ color: HR_COLOR }}>HEART RATE</span>
              {!frame.hr_connected && (
                <span className="font-mono-data text-[11px] text-[var(--kink-muted)]" data-testid="overlay-hr-waiting">waiting for monitor…</span>
              )}
              {frame.hr_over && (
                <span className="font-mono-data text-[11px] tracking-[0.12em] px-2 py-0.5 border border-[var(--kink-hr)] text-[var(--kink-hr)] pulse-dot" data-testid="overlay-hr-cutoff">
                  CUTOFF {frame.hr_cutoff}
                </span>
              )}
              {frame.hr_sync_enabled && frame.hr_target > 0 && (
                <span
                  className="font-mono-data text-[11px] tracking-[0.12em] px-2 py-0.5 border"
                  style={{ borderColor: HR_TARGET_COLOR, color: HR_TARGET_COLOR }}
                  data-testid="overlay-hr-target-badge"
                >
                  TARGET {frame.hr_target}
                </span>
              )}
            </div>
            <div className="text-right">
              <span className="font-mono-data font-extrabold text-4xl tabular-nums" style={{ color: HR_COLOR }} data-testid="overlay-hr-value">
                {frame.hr_connected ? frame.hr_bpm : "--"}
                <span className="text-sm text-[var(--kink-muted)] ml-1">BPM</span>
              </span>
              {frame.hr_sync_enabled && frame.hr_target > 0 && (
                <p className="font-mono-data text-xs tabular-nums" style={{ color: HR_TARGET_COLOR }} data-testid="overlay-hr-target-value">
                  target {frame.hr_target} BPM
                </p>
              )}
            </div>
          </div>
          <Sparkline
            data={history.hr}
            color={HR_COLOR}
            id="hr"
            height={72}
            max={200}
            refValue={frame.hr_sync_enabled && frame.hr_target > 0 ? frame.hr_target : null}
            refColor={HR_TARGET_COLOR}
          />
        </div>
      )}

      {/* Metric graphs — order and visibility driven by config */}
      {metricPanelsOrdered.length > 0 && (
        <div className={`grid gap-5 ${gridClass}`}>
          {metricPanelsOrdered.map((m) => (
            <MetricPanel
              key={m.key}
              metric={m}
              value={frame[m.key]}
              history={history[m.key]}
              glassStyle={glassStyle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
