import { useEffect, useState, useCallback } from "react";
import { Trash2, RefreshCw } from "lucide-react";
import { api, fmtTime } from "@/lib/api";
import { toast } from "sonner";

/**
 * SessionHistory — admin panel summarising past turns. Each ended turn writes a
 * recap (who, how long, avg/peak speed, chat + reaction totals) to the backend
 * `session_history` collection; this panel shows a roll-up header plus a
 * per-turn list, newest first. Read-only apart from deleting a row.
 */
function fmtWhen(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return iso;
  }
}

const REASON_LABEL = {
  time_up: "time up",
  ended: "ended by owner",
  skipped: "skipped",
  disconnected: "disconnected",
};

function Stat({ label, value }) {
  return (
    <div className="flex flex-col items-center px-2 py-2 border border-[var(--kink-overlay)] bg-[var(--kink-base)]">
      <span className="font-mono-data font-bold tabular-nums text-lg text-[var(--kink-purple)] leading-none">
        {value}
      </span>
      <span className="font-mono-data text-[9px] uppercase tracking-wide text-[var(--kink-muted)] mt-1 text-center">
        {label}
      </span>
    </div>
  );
}

export function SessionHistory() {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/session-history");
      setRows(Array.isArray(data?.sessions) ? data.sessions : []);
      setSummary(data?.summary || null);
    } catch (_) {
      /* leave as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (id) => {
    try {
      await api.delete(`/session-history/${id}`);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (_) {
      toast.error("Could not delete history entry.");
    }
  };

  return (
    <div className="space-y-3" data-testid="session-history">
      <div className="flex items-center justify-between">
        <span className="font-mono-data text-[11px] text-[var(--kink-muted)]">
          {rows.length} recorded {rows.length === 1 ? "turn" : "turns"}
        </span>
        <button
          onClick={load}
          data-testid="history-refresh"
          title="Refresh"
          className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {summary && rows.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
          <Stat label="Turns" value={summary.total_turns} />
          <Stat label="Total time" value={fmtTime(summary.total_seconds)} />
          <Stat label="Avg turn" value={fmtTime(summary.avg_turn_seconds)} />
          <Stat label="Peak speed" value={`${summary.peak_speed_percent}%`} />
          <Stat label="Reactions" value={summary.total_reactions} />
        </div>
      )}

      {loading ? (
        <p className="font-mono-data text-[11px] text-[var(--kink-muted)] py-4 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="font-mono-data text-[11px] text-[var(--kink-muted)] py-4 text-center">
          No sessions yet. Each turn is recorded automatically when it ends.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div
              key={r.id}
              data-testid={`history-${r.id}`}
              className="group flex items-center justify-between px-3 py-2 border border-[var(--kink-overlay)] bg-[var(--kink-base)]"
            >
              <div className="min-w-0">
                <span className="block text-sm text-white truncate">
                  {r.label}
                  <span className="ml-2 font-mono-data text-[10px] text-[var(--kink-muted)]">
                    {REASON_LABEL[r.reason] || r.reason}
                  </span>
                </span>
                <span className="block font-mono-data text-[10px] text-[var(--kink-muted)]">
                  {fmtWhen(r.created_at)} · {fmtTime(r.used_seconds)}
                  {" · "}avg {r.avg_speed_percent}% / peak {r.peak_speed_percent}%
                  {r.reactions_total > 0 ? ` · ${r.reactions_total} reactions` : ""}
                  {r.chat_count > 0 ? ` · ${r.chat_count} chat` : ""}
                </span>
              </div>
              <button
                onClick={() => remove(r.id)}
                data-testid={`history-delete-${r.id}`}
                title="Delete this entry"
                className="p-1.5 text-[var(--kink-muted)] hover:text-[var(--kink-red,#ff5c73)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
