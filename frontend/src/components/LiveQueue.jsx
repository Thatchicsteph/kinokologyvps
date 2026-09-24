import React from "react";
import { fmtTime } from "@/lib/api";
import { MicOff, Mic } from "lucide-react";

export function LiveQueue({ active, queue, you, onMute }) {
  const rows = [];
  if (active) {
    rows.push({
      key: "active", label: active.label || "Guest", isActive: true,
      sub: fmtTime(active.remaining_seconds),
      code: active.code, muted: !!active.muted,
    });
  }
  (queue || []).forEach((q, i) =>
    rows.push({ key: `q-${i}`, label: q.label || "Guest", isActive: false, sub: `#${q.position} in line` })
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
          <div className="flex items-center gap-3">
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
            <span className={`font-mono-data text-sm tabular-nums ${r.isActive ? "text-[var(--kink-purple)]" : "text-[var(--kink-muted)]"}`}>
              {r.sub}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
