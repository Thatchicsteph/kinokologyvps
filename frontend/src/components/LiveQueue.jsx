import React from "react";
import { fmtTime } from "@/lib/api";
import { MicOff, Mic, ChevronUp, ChevronDown, Plus } from "lucide-react";

export function LiveQueue({ active, queue, you, onMute, onMove, onExtend }) {
  const rows = [];
  if (active) {
    rows.push({
      key: "active", label: active.label || "Guest", isActive: true,
      sub: fmtTime(active.remaining_seconds),
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
            {/* Quick +time on the active turn */}
            {r.isActive && onExtend && (
              <button
                type="button"
                onClick={() => onExtend(5)}
                data-testid="queue-extend-5"
                title="Add 5 minutes to this turn"
                className="flex items-center gap-0.5 px-1.5 py-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors"
              >
                <Plus size={12} /><span className="font-mono-data text-[11px]">5m</span>
              </button>
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
            <span className={`font-mono-data text-sm tabular-nums ${r.isActive ? "text-[var(--kink-purple)]" : "text-[var(--kink-muted)]"}`}>
              {r.sub}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
