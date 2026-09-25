import React, { useState } from "react";
import { fmtTime } from "@/lib/api";
import { MicOff, Mic, ChevronUp, ChevronDown, Plus, Minus } from "lucide-react";

export function LiveQueue({ active, queue, you, onMute, onMove, onExtend }) {
  const [extendMins, setExtendMins] = useState(5);
  // Colour-code the active guest's remaining time: red under 30s, amber under 2min, else purple.
  const timeColor = (sec) => {
    if (sec == null) return "text-[var(--kink-purple)]";
    if (sec <= 30) return "text-[var(--kink-red,#ff5c73)]";
    if (sec <= 120) return "text-[#ffb454]";
    return "text-[var(--kink-purple)]";
  };
  const rows = [];
  if (active) {
    rows.push({
      key: "active", label: active.label || "Guest", isActive: true,
      sub: fmtTime(active.remaining_seconds),
      remainSec: active.remaining_seconds,
      code: active.code, muted: !!active.muted,
    });
  }
  const qlen = (queue || []).length;
  (queue || []).forEach((q, i) =>
    rows.push({
      key: `q-${i}`, label: q.label || "Guest", isActive: false,
      sub: `#${q.position} in line`, cid: q.cid, qIndex: i, qLen: qlen,
    })
  );

  return (
    <div className="space-y-2" data-testid="live-queue">
      {rows.length === 0 && (
        <p className="font-mono-data text-sm text-[var(--kink-muted)] py-6 text-center">
          No one connected.
        </p>
      )}
      {rows.map((r) => (
        <div
          key={r.key}
          data-testid={`queue-item-${r.key}`}
          className={`flex items-center justify-between px-4 py-3 border transition-colors duration-200 ${
            r.isActive
              ? "border-[var(--kink-purple)]/50 bg-[var(--kink-purple)]/[0.06]"
              : "border-[var(--kink-overlay)] bg-[var(--kink-base)]"
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                r.isActive ? "bg-[var(--kink-purple)] pulse-dot glow-purple" : "bg-[var(--kink-muted)]"
              }`}
            />
            <span className={`truncate font-medium ${r.isActive ? "text-white" : "text-[var(--kink-text-2)]"}`}>
              {r.label}
            </span>
            {r.muted && (
              <span className="font-mono-data text-[10px] uppercase tracking-wide text-[var(--kink-red,#ff5c73)]">muted</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Queue reorder (waiting guests only) */}
            {!r.isActive && onMove && r.cid && (
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => onMove(r.cid, -1)}
                  disabled={r.qIndex === 0}
                  data-testid={`queue-up-${r.cid}`}
                  title="Move up"
                  className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onMove(r.cid, 1)}
                  disabled={r.qIndex === r.qLen - 1}
                  data-testid={`queue-down-${r.cid}`}
                  title="Move down"
                  className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            )}
            {/* Adjust time on the active turn (positive adds, negative reduces) */}
            {r.isActive && onExtend && (
              <div className="flex items-center" data-testid="queue-extend">
                <input
                  type="number"
                  min={-120}
                  max={120}
                  value={extendMins}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "" || raw === "-") { setExtendMins(raw); return; }
                    const v = parseInt(raw, 10);
                    setExtendMins(Number.isNaN(v) ? "" : Math.max(-120, Math.min(120, v)));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter" && extendMins) onExtend(extendMins); }}
                  data-testid="queue-extend-input"
                  aria-label="Minutes to add or subtract"
                  className="w-12 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-1.5 py-1 text-center font-mono-data text-[11px] text-white focus:border-[var(--kink-purple)]/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => extendMins && onExtend(Number(extendMins))}
                  disabled={!extendMins || Number(extendMins) === 0}
                  data-testid="queue-extend-apply"
                  title={Number(extendMins) < 0
                    ? `Remove ${Math.abs(Number(extendMins))} minute(s) from this turn`
                    : `Add ${Number(extendMins) || 0} minute(s) to this turn`}
                  className="flex items-center gap-0.5 px-1.5 py-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] disabled:opacity-30 transition-colors"
                >
                  {Number(extendMins) < 0
                    ? <Minus size={12} />
                    : <Plus size={12} />}
                  <span className="font-mono-data text-[11px]">m</span>
                </button>
              </div>
            )}
            {r.isActive && onMute && r.code && (
              <button
                type="button"
                onClick={() => onMute(r.code, !r.muted)}
                data-testid="queue-mute-toggle"
                title={r.muted ? "Unmute this guest in chat" : "Mute this guest in chat"}
                className={`p-1 transition-colors ${
                  r.muted
                    ? "text-[var(--kink-red,#ff5c73)] hover:text-white"
                    : "text-[var(--kink-muted)] hover:text-[var(--kink-purple)]"
                }`}
              >
                {r.muted ? <MicOff size={14} /> : <Mic size={14} />}
              </button>
            )}
            <span className={`font-mono-data text-sm tabular-nums ${
              r.isActive
                ? `${timeColor(r.remainSec)}${r.remainSec != null && r.remainSec <= 30 ? " animate-pulse font-semibold" : ""}`
                : "text-[var(--kink-muted)]"
            }`}>
              {r.sub}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
