import React, { useEffect, useRef, useState } from "react";
import { cmd } from "@/lib/ossm";
import { ChevronDown, ChevronUp, MapPin, Flag, Square } from "lucide-react";

// Low, steady speed used only to jog while calibrating.
const JOG_SPEED = 25;
// Stroke amplitude used while jogging. Some stroker firmwares clamp or
// silently ignore strokes below a minimum threshold — too small and the
// engine accepts the command but never actually produces motion. This is
// bigger than a first attempt at "barely moving" (8%) specifically because
// that turned out to produce no visible motion at all; 20% is comfortably
// above any typical minimum while still small relative to full travel.
const JOG_STROKE = 20;
// The protocol has no "move-to-position-and-hold" command — only "run a
// stroking pattern continuously while speed > 0". So a STEP press is
// implemented as a brief pulse: speed goes to JOG_SPEED just long enough
// for the engine to move toward the new depth, then we cut speed back to
// 0 automatically. That gives a jog/step feel (nudge, then hold still)
// instead of the pattern looping back and forth forever between presses.
const JOG_PULSE_MS = 350;

/**
 * Manual range calibration.
 *
 * Instead of measuring the toy + rail in mm, the owner can jog the real
 * device with the toy mounted: set a starting (min) point, then nudge it
 * forward one STEP at a time — watching the actual hardware — until it's
 * sitting right at the physical max endpoint, and lock that in.
 *
 * Uses the exact same working mode-entry sequence as the Test Console's
 * "start" (go:strokeEngine + pattern + stroke + sensation) so movement is
 * guaranteed. Each STEP then pulses speed on just long enough to nudge
 * toward the new depth and auto-stops — since the firmware only knows how
 * to "run continuously while speed > 0", not "move to X and hold". STOP
 * JOG is a manual backstop that cuts speed back to 0 immediately.
 * Nothing here is persisted until the parent's "SAVE LIMITS" button is
 * pressed.
 */
export function CalibrationPanel({ connected, onCommand, onSetMin, onSetMax, minDepth = 0, manualMaxDepth = null }) {
  const [testDepth, setTestDepth] = useState(minDepth || 0);
  const [step, setStep] = useState(5);
  const [jogActive, setJogActive] = useState(false);
  const jogActiveRef = useRef(false);
  // Timer for the in-flight pulse (speed>0 window). Cleared/replaced on
  // every new STEP so back-to-back presses don't stack up stop commands.
  const pulseTimeoutRef = useRef(null);

  // Always call the LATEST onCommand, without making effects re-fire their
  // cleanup every time onCommand's identity happens to change (it can, via
  // useBleHost -> useToys). Re-running that cleanup used to send a stray
  // STOP to the real device on ordinary re-renders, stomping on normal
  // control any time calibration had been used once.
  const onCommandRef = useRef(onCommand);
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  const send = async (command) => { await onCommandRef.current?.(command); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // If the device disconnects mid-calibration, don't leave stale "active" state.
  useEffect(() => {
    if (!connected) {
      if (pulseTimeoutRef.current) { clearTimeout(pulseTimeoutRef.current); pulseTimeoutRef.current = null; }
      jogActiveRef.current = false;
      setJogActive(false);
    }
  }, [connected]);

  // Only stop the device on a REAL unmount, not on every onCommand identity change.
  useEffect(() => () => {
    if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);
    if (jogActiveRef.current) send(cmd.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Puts the engine into stroke mode with fixed pattern/stroke/sensation.
  // This only needs to happen once per session — after that, jogging is
  // just depth changes plus a speed pulse.
  const ensureEngineReady = async () => {
    if (jogActiveRef.current) return;
    jogActiveRef.current = true; // claim immediately so rapid double-clicks don't re-enter
    await send(cmd.goStrokeEngine());
    await wait(150); // let the mode switch land before sending motion params
    await send(cmd.pattern(0)); // Simple Stroke — predictable, no extra sensation-driven variance
    await send(cmd.sensation(0));
    await send(cmd.stroke(JOG_STROKE));
    setJogActive(true);
  };

  const stopJog = () => {
    if (pulseTimeoutRef.current) { clearTimeout(pulseTimeoutRef.current); pulseTimeoutRef.current = null; }
    send(cmd.stop());
    jogActiveRef.current = false;
    setJogActive(false);
  };

  const jogTo = async (v) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    setTestDepth(clamped);
    if (!connected) return;
    await ensureEngineReady();

    // Cancel any pulse still winding down from a previous STEP so rapid
    // presses don't queue up multiple stop timers.
    if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);

    await send(cmd.depth(clamped));
    await send(cmd.speed(JOG_SPEED));
    pulseTimeoutRef.current = setTimeout(() => {
      send(cmd.stop());
      pulseTimeoutRef.current = null;
    }, JOG_PULSE_MS);
  };


  return (
    <div className="pt-1 border-t border-[var(--kink-overlay)]" data-testid="calibration-panel">
      <div className="flex items-center justify-between mb-2 mt-4">
        <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">
          CALIBRATE RANGE (JOG &amp; SET)
        </label>
        {manualMaxDepth != null && (
          <span className="font-mono-data text-[11px] text-[var(--kink-purple)]" data-testid="calibration-manual-badge">
            MANUAL MAX: {manualMaxDepth}%
          </span>
        )}
      </div>


      {!connected ? (
        <p className="font-mono-data text-[11px] text-[var(--kink-muted)]">
          Connect the device to jog it live and calibrate endpoints.
        </p>
      ) : (
        <>
          <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mb-3">
            Mount the toy, then jog to the shallowest point you want and set it as MIN.
            Keep stepping forward until the device is right at the physical end of travel, then set it as MAX.
            {jogActive && " Each STEP gives the device a brief nudge toward the new depth, then it holds still — use STOP JOG if it ever keeps moving."}
          </p>

          <div className="flex items-center justify-between mb-3">
            <span className="font-mono-data text-[10px] text-[var(--kink-muted)] uppercase tracking-wide">Test depth</span>
            <span className="font-mono-data text-2xl font-bold text-[var(--kink-purple)]" data-testid="calibration-test-depth-value">
              {testDepth}%
            </span>
          </div>

          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              onClick={() => jogTo(testDepth - step)}
              disabled={testDepth <= 0}
              data-testid="calibration-step-down"
              className="flex items-center gap-1 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-xs hover:border-[var(--kink-purple)]/40 transition-colors disabled:opacity-40"
            >
              <ChevronDown size={14} /> STEP
            </button>
            <button
              type="button"
              onClick={() => jogTo(testDepth + step)}
              disabled={testDepth >= 100}
              data-testid="calibration-step-up"
              className="flex items-center gap-1 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-xs hover:border-[var(--kink-purple)]/40 transition-colors disabled:opacity-40"
            >
              STEP <ChevronUp size={14} />
            </button>
            <label className="flex items-center gap-1.5 ml-auto">
              <span className="font-mono-data text-[10px] text-[var(--kink-muted)] uppercase tracking-wide">step</span>
              <input
                type="number"
                min={1}
                max={25}
                value={step}
                onChange={(e) => setStep(Math.min(25, Math.max(1, Number(e.target.value) || 1)))}
                data-testid="calibration-step-size"
                className="bg-transparent border border-[var(--kink-overlay)] px-2 py-1.5 w-14 font-mono-data text-sm focus:outline-none focus:border-[var(--kink-purple)]/40"
              />
              <span className="font-mono-data text-[10px] text-[var(--kink-muted)]">%</span>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onSetMin?.(testDepth)}
              data-testid="calibration-set-min"
              className="flex items-center gap-1.5 border border-[var(--kink-purple)]/50 text-[var(--kink-purple)] px-3 py-2 font-display text-xs tracking-[0.1em] active:scale-95 transition-transform"
            >
              <MapPin size={14} /> SET AS MIN
            </button>
            <button
              type="button"
              onClick={() => onSetMax?.(testDepth)}
              data-testid="calibration-set-max"
              className="flex items-center gap-1.5 border border-[var(--kink-danger)]/50 text-[var(--kink-danger)] px-3 py-2 font-display text-xs tracking-[0.1em] active:scale-95 transition-transform"
            >
              <Flag size={14} /> SET AS MAX
            </button>
            {jogActive && (
              <button
                type="button"
                onClick={stopJog}
                data-testid="calibration-stop-jog"
                className="flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-xs hover:border-[var(--kink-danger)]/50 hover:text-[var(--kink-danger)] transition-colors"
              >
                <Square size={12} /> STOP JOG
              </button>
            )}
            {manualMaxDepth != null && (
              <button
                type="button"
                onClick={() => onSetMax?.(null)}
                data-testid="calibration-clear-max"
                className="flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-xs text-[var(--kink-muted)] hover:text-[var(--kink-text-2)] transition-colors"
              >
                CLEAR (use toy-length calc)
              </button>
            )}
          </div>

          <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mt-3">
            Setting MIN or MAX only updates the values below — click SAVE LIMITS to enforce them for every guest.
          </p>
        </>
      )}
    </div>
  );
}
