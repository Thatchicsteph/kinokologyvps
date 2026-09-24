import React, { useEffect, useRef, useState } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { Gauge, Ruler, Waves, Move3d, Power, Square, Zap, Lock, Bookmark, Trash2 } from "lucide-react";
import { PATTERNS, cmd } from "@/lib/ossm";
import { loadPresets, savePreset, deletePreset } from "@/lib/guestPresets";

const ICONS = { speed: Gauge, depth: Move3d, stroke: Ruler, sensation: Waves };

const CONTROL_DESCRIPTIONS = {
  speed: "Increases the speed of the attachment. Speed must be above 0% for the OSSM to move. When paused, increasing speed will resume movement automatically.",
  depth: "Controls the depth of penetration.",
  stroke: "Controls the length of each stroke. Low = shorter strokes. High = longer strokes.",
  sensation: "Controls the feel of the motion. Low = gentle and smooth. High = more intense and aggressive.",
};

// App-level automated motion programs. Each returns targets given elapsed seconds.
export const PROGRAMS = [
  { id: "wave",    name: "Wave",        desc: "Smooth speed swell" },
  { id: "buildup", name: "Build-Up",    desc: "Slow ramp, repeat" },
  { id: "tease",   name: "Tease / Edge",desc: "Bursts then pause" },
  { id: "pulse",   name: "Depth Pulse", desc: "Oscillating depth" },
  { id: "surge",   name: "Surge",       desc: "Fast in, slow out" },
  { id: "random",  name: "Random",      desc: "Shifts every few sec" },
];

function ControlSlider({ id, label, value, onChange, disabled, danger, min = 0, max = 100, limitNote }) {
  const Icon = ICONS[id];
  const color = danger ? "var(--kink-danger)" : "var(--kink-purple)";
  return (
    <div className={`px-1 ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={16} style={{ color }} />
          <span className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">{label}</span>
          {limitNote && (
            <span className="flex items-center gap-1 font-mono-data text-[10px] text-[var(--kink-muted)]">
              <Lock size={10} /> {limitNote}
            </span>
          )}
        </div>
        <span className="font-mono-data text-xl font-bold tabular-nums" style={{ color }} data-testid={`value-${id}`}>
          {value}
        </span>
      </div>
      {CONTROL_DESCRIPTIONS[id] && (
        <p className="font-mono-data text-[11px] leading-snug text-[var(--kink-muted)] mb-3" data-testid={`desc-${id}`}>
          {CONTROL_DESCRIPTIONS[id]}
        </p>
      )}
      <SliderPrimitive.Root
        className="relative flex w-full touch-none select-none items-center h-6"
        min={min}
        max={max}
        step={1}
        value={[Math.min(max, Math.max(min, value))]}
        onValueChange={(v) => onChange(v[0])}
        data-testid={`slider-${id}`}
      >
        <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-[var(--kink-overlay)]">
          <SliderPrimitive.Range className="absolute h-full rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          className="block h-6 w-6 rounded-full border-2 bg-[var(--kink-raised)] transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2"
          style={{ borderColor: color, boxShadow: `0 0 8px ${color}` }}
        />
      </SliderPrimitive.Root>
    </div>
  );
}

export function ControlConsole({ onCommand, disabled = false, autoStart = false, limits = { min_depth: 0, max_speed: 100, max_depth: 100 }, initialState = null }) {
  const minDepth = limits?.min_depth ?? 0;
  const maxSpeed = limits?.max_speed ?? 100;
  const maxDepth = Math.min(100, Math.max(minDepth, limits?.max_depth ?? 100));

  const [running, setRunning] = useState(false);
  const [activeProgram, setActiveProgram] = useState(null);
  const [state, setState] = useState(() => ({
    speed: 0,
    depth: Math.max(initialState?.depth ?? 0, minDepth),
    stroke: initialState?.stroke ?? 0,
    sensation: initialState?.sensation ?? 0,
  }));
  const [pattern, setPattern] = useState(initialState?.pattern ?? 0);
  const [presets, setPresets] = useState(() => loadPresets());
  const [presetName, setPresetName] = useState("");
  const [presetErr, setPresetErr] = useState("");
  const throttle = useRef({});
  const progRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const clampSpeed = (v) => Math.min(maxSpeed, Math.max(0, Math.round(v)));
  const clampDepth = (v) => Math.min(maxDepth, Math.max(minDepth, Math.round(v)));
  // Firmware convention: top of stroke = depth, bottom of stroke = depth - stroke.
  // Depth alone is already clamped to [minDepth, maxDepth], but a large stroke
  // can still pull the bottom of travel below minDepth — cap stroke so it can't.
  const clampStroke = (v, depth = stateRef.current.depth) =>
    Math.min(Math.max(0, depth - minDepth), Math.max(0, Math.round(v)));

  useEffect(() => () => { if (progRef.current) clearInterval(progRef.current); }, []);

  // Auto-start on mount when explicitly requested (guest view only) so the
  // console begins running as soon as a guest's turn goes active, without
  // needing a manual press of START. Not used for the owner's console.
  useEffect(() => {
    if (autoStart && !disabled) startManual();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep depth above owner's min at all times
  useEffect(() => {
    if (state.depth < minDepth) setState((s) => ({ ...s, depth: minDepth }));
    // eslint-disable-next-line
  }, [minDepth]);

  // whenever the toy's cap tightens (admin lowers toy length/rail travel),
  // pull depth back under it immediately — including mid-run
  useEffect(() => {
    if (state.depth > maxDepth) {
      setState((s) => ({ ...s, depth: maxDepth }));
      if (running) onCommand(cmd.depth(maxDepth));
    }
    // eslint-disable-next-line
  }, [maxDepth]);

  // whenever depth (or minDepth) moves, re-check that the current stroke
  // still keeps the bottom of travel at or above minDepth — covers the case
  // where depth drops (e.g. an auto program, or admin tightening minDepth)
  // after stroke was already set safely.
  useEffect(() => {
    const safeStroke = clampStroke(stateRef.current.stroke, state.depth);
    if (safeStroke !== stateRef.current.stroke) {
      setState((s) => ({ ...s, stroke: safeStroke }));
      if (running) onCommand(cmd.stroke(safeStroke));
    }
    // eslint-disable-next-line
  }, [state.depth, minDepth]);

  const sendThrottled = (key, builder, v) => {
    const now = Date.now();
    if (!throttle.current[key] || now - throttle.current[key] > 90) {
      throttle.current[key] = now;
      onCommand(builder(v));
    }
  };

  const stopProgram = () => {
    if (progRef.current) { clearInterval(progRef.current); progRef.current = null; }
    setActiveProgram(null);
    onCommand("meta:program:");  // empty slug = no program active
  };

  const setParam = (key, builder) => (v) => {
    if (activeProgram) stopProgram(); // manual touch takes over
    if (key === "depth") v = clampDepth(v);
    if (key === "speed") v = clampSpeed(v);
    if (key === "stroke") v = clampStroke(v, stateRef.current.depth);
    setState((s) => ({ ...s, [key]: v }));
    if (key === "speed" && !running) return;
    sendThrottled(key, builder, v);
  };

  const selectPattern = (idx) => {
    setPattern(idx);
    onCommand(cmd.pattern(idx));
  };

  // --- Presets: save the current settings, recall a saved snapshot ----------
  const saveCurrentPreset = () => {
    setPresetErr("");
    const { presets: next, error } = savePreset(presetName, {
      speed: stateRef.current.speed,
      depth: stateRef.current.depth,
      stroke: stateRef.current.stroke,
      sensation: stateRef.current.sensation,
      pattern,
    });
    if (error) { setPresetErr(error); return; }
    setPresets(next);
    setPresetName("");
  };

  const removePreset = (id) => setPresets(deletePreset(id));

  // Recall applies a preset's values through the SAME clamp + command path a
  // manual slider move uses, so owner safety limits (min/max depth, toy cap,
  // stroke floor) are always re-enforced — a stale preset can never exceed
  // limits the owner has since tightened. Any running auto-program is stopped.
  const recallPreset = (preset) => {
    if (disabled || !preset?.values) return;
    if (activeProgram) stopProgram();
    const v = preset.values;
    const depth = clampDepth(v.depth);
    const stroke = clampStroke(v.stroke, depth);
    const speed = clampSpeed(v.speed);
    const sensation = Math.min(100, Math.max(0, Math.round(Number(v.sensation) || 0)));
    const pat = Number.isFinite(Number(v.pattern)) ? Number(v.pattern) : pattern;

    setState((s) => ({ ...s, depth, stroke, sensation, speed }));
    setPattern(pat);

    // Push to the device only while running, mirroring setParam's behaviour.
    onCommand(cmd.pattern(pat));
    onCommand(cmd.depth(depth));
    onCommand(cmd.stroke(stroke));
    onCommand(cmd.sensation(sensation));
    if (running) onCommand(cmd.speed(speed));
  };

  const stopAll = () => {
    stopProgram();
    onCommand(cmd.stop());
    setState((s) => ({ ...s, speed: 0 }));
    setRunning(false);
  };

  const startManual = () => {
    const startDepth = clampDepth(state.depth);
    const startStroke = clampStroke(state.stroke, startDepth);
    onCommand(cmd.goStrokeEngine());
    onCommand(cmd.pattern(pattern));
    onCommand(cmd.depth(startDepth));
    onCommand(cmd.stroke(startStroke));
    onCommand(cmd.sensation(state.sensation));
    // Engage the stroke engine but honour a 0 speed — the device stays still
    // until the guest deliberately raises speed (rather than auto-jumping to 30).
    const startSpeed = clampSpeed(state.speed);
    setState((s) => ({ ...s, depth: startDepth, stroke: startStroke, speed: startSpeed }));
    onCommand(cmd.speed(startSpeed));
    setRunning(true);
  };

  const toggleRun = () => (running ? stopAll() : startManual());

  const runProgram = (pid) => {
    if (activeProgram === pid) { stopAll(); return; }
    stopProgram();
    onCommand(`meta:program:${pid}`);
    onCommand(cmd.goStrokeEngine());
    onCommand(cmd.pattern(pattern));
    onCommand(cmd.sensation(stateRef.current.sensation));
    setRunning(true);
    setActiveProgram(pid);
    const start = Date.now();
    const rnd = { last: 0, speed: 40, depth: Math.min(maxDepth, Math.max(60, minDepth)) };
    progRef.current = setInterval(() => {
      const t = (Date.now() - start) / 1000;
      let speed = stateRef.current.speed;
      let depth = stateRef.current.depth;
      let sendDepth = false;
      switch (pid) {
        case "wave":
          speed = 50 + 35 * Math.sin(t * 0.5); break;
        case "buildup": {
          const c = t % 22; speed = 12 + (c / 22) * 78; break;
        }
        case "tease": {
          const c = t % 9; speed = c < 5.5 ? 72 : 0; break;
        }
        case "pulse": {
          speed = 45;
          depth = minDepth + (maxDepth - minDepth) * (0.5 + 0.5 * Math.sin(t * 0.8));
          sendDepth = true; break;
        }
        case "surge": {
          const c = (t % 4) / 4; speed = 90 * (1 - c) + 10; break;
        }
        case "random": {
          if (t - rnd.last > 3) {
            rnd.last = t;
            rnd.speed = 20 + Math.random() * 60;
            rnd.depth = minDepth + Math.random() * (maxDepth - minDepth);
          }
          speed = rnd.speed; depth = rnd.depth; sendDepth = true; break;
        }
        default: break;
      }
      speed = clampSpeed(speed);
      depth = clampDepth(depth);
      setState((s) => ({ ...s, speed, depth }));
      onCommand(cmd.speed(speed));
      if (sendDepth) onCommand(cmd.depth(depth));
    }, 250);
  };

  const speedNote = maxSpeed < 100 ? `max ${maxSpeed}` : null;
  const depthNoteParts = [];
  if (minDepth > 0) depthNoteParts.push(`min ${minDepth}`);
  if (maxDepth < 100) depthNoteParts.push(`toy max ${maxDepth}`);
  const depthNote = depthNoteParts.length ? depthNoteParts.join(" · ") : null;
  const maxStroke = Math.max(0, state.depth - minDepth);
  const strokeNote = maxStroke < 100 ? `max ${maxStroke} at this depth` : null;

  return (
    <div className="space-y-8" data-testid="control-console">
      <div className="space-y-7">
        <ControlSlider id="speed" label="SPEED" value={state.speed} onChange={setParam("speed", cmd.speed)} disabled={disabled} danger max={maxSpeed} limitNote={speedNote} />
        <ControlSlider id="depth" label="DEPTH" value={state.depth} onChange={setParam("depth", cmd.depth)} disabled={disabled} min={minDepth} max={maxDepth} limitNote={depthNote} />
        <ControlSlider id="stroke" label="STROKE" value={state.stroke} onChange={setParam("stroke", cmd.stroke)} disabled={disabled} max={maxStroke} limitNote={strokeNote} />
        <ControlSlider id="sensation" label="SENSATION" value={state.sensation} onChange={setParam("sensation", cmd.sensation)} disabled={disabled} />
      </div>

      <div className={disabled ? "opacity-40 pointer-events-none" : ""}>
        <span className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)] block mb-3">PATTERN</span>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
          {PATTERNS.map((p) => (
            <button
              key={p.idx}
              onClick={() => selectPattern(p.idx)}
              data-testid={`pattern-${p.idx}`}
              className={`text-left px-3 py-2.5 border text-sm transition-colors duration-200 ${
                pattern === p.idx
                  ? "border-[var(--kink-purple)] bg-[var(--kink-purple)]/[0.08] text-white"
                  : "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-purple)]/40"
              }`}
            >
              <span className="block text-sm font-medium">{p.name}</span>
              {p.desc && (
                <span className="block font-mono-data text-[10px] text-[var(--kink-muted)] mt-0.5">{p.desc}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className={disabled ? "opacity-40 pointer-events-none" : ""} data-testid="presets-section">
        <span className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)] flex items-center gap-2 mb-3">
          <Bookmark size={14} className="text-[var(--kink-purple)]" /> MY PRESETS
        </span>
        {presets.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
            {presets.map((p) => (
              <div
                key={p.id}
                className="group relative border border-[var(--kink-overlay)] hover:border-[var(--kink-purple)]/40 transition-colors"
              >
                <button
                  onClick={() => recallPreset(p)}
                  data-testid={`preset-recall-${p.id}`}
                  title={`Recall "${p.name}" — speed ${p.values.speed}, depth ${p.values.depth}, stroke ${p.values.stroke}, sensation ${p.values.sensation}`}
                  className="w-full text-left px-3 py-2.5 pr-8 text-sm text-[var(--kink-text-2)] hover:text-white"
                >
                  <span className="block font-medium truncate">{p.name}</span>
                  <span className="block font-mono-data text-[10px] text-[var(--kink-muted)] mt-0.5">
                    S{p.values.speed} · D{p.values.depth} · St{p.values.stroke}
                  </span>
                </button>
                <button
                  onClick={() => removePreset(p.id)}
                  data-testid={`preset-delete-${p.id}`}
                  title="Delete preset"
                  className="absolute top-1.5 right-1.5 p-1 text-[var(--kink-muted)] hover:text-[var(--kink-red,#ff5c73)] opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={presetName}
            onChange={(e) => { setPresetName(e.target.value); setPresetErr(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") saveCurrentPreset(); }}
            placeholder="Name this preset…"
            maxLength={40}
            data-testid="preset-name-input"
            className="flex-1 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-2 text-sm text-white placeholder:text-[var(--kink-muted)] focus:border-[var(--kink-purple)]/60 focus:outline-none"
          />
          <button
            onClick={saveCurrentPreset}
            data-testid="preset-save"
            className="px-3 py-2 border border-[var(--kink-purple)]/60 text-[var(--kink-purple)] text-sm hover:bg-[var(--kink-purple)]/[0.08] transition-colors whitespace-nowrap"
          >
            Save current
          </button>
        </div>
        {presetErr && (
          <p className="font-mono-data text-[11px] text-[var(--kink-red,#ff5c73)] mt-2">{presetErr}</p>
        )}
        {presets.length === 0 && !presetErr && (
          <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mt-2">
            Set the sliders how you like, name it, and save — recall it any time. Saved in this browser only.
          </p>
        )}
      </div>

      <div className={disabled ? "opacity-40 pointer-events-none" : ""}>
        <span className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)] flex items-center gap-2 mb-3">
          <Zap size={14} className="text-[var(--kink-purple)]" /> AUTO PROGRAMS
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PROGRAMS.map((p) => (
            <button
              key={p.id}
              onClick={() => runProgram(p.id)}
              data-testid={`program-${p.id}`}
              className={`text-left px-3 py-2.5 border transition-colors duration-200 ${
                activeProgram === p.id
                  ? "border-[var(--kink-purple)] bg-[var(--kink-purple)]/[0.12] text-white glow-purple"
                  : "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-purple)]/40"
              }`}
            >
              <span className="block text-sm font-medium">{p.name}</span>
              <span className="block font-mono-data text-[10px] text-[var(--kink-muted)] mt-0.5">{p.desc}</span>
            </button>
          ))}
        </div>
        {activeProgram && (
          <p className="font-mono-data text-xs text-[var(--kink-purple)] mt-3" data-testid="program-active-note">
            ▶ Running "{PROGRAMS.find((p) => p.id === activeProgram)?.name}" — move any slider or press STOP to take manual control.
          </p>
        )}
      </div>

      <button
        onClick={toggleRun}
        disabled={disabled}
        data-testid="start-stop-button"
        className={`w-full h-20 flex items-center justify-center gap-3 font-display text-xl tracking-[0.2em] font-black transition-transform active:scale-95 disabled:opacity-40 ${
          running
            ? "bg-[var(--kink-danger)] text-white pulse-danger"
            : "bg-[var(--kink-purple)] text-[var(--kink-base)] glow-purple"
        }`}
      >
        {running ? <Square size={22} fill="currentColor" /> : <Power size={22} />}
        {running ? "STOP" : "START"}
      </button>
    </div>
  );
}
