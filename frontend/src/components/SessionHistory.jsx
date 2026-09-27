import { useEffect, useState, useCallback, useMemo } from "react";
import { Trash2, RefreshCw, Download, Search, X } from "lucide-react";
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

// Escape a single CSV cell: quote it and double any embedded quotes, so commas,
// quotes and newlines inside a label never break the columns.
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

// Serialize the given rows to a CSV string and trigger a browser download.
function downloadCsv(rows) {
  const headers = [
    "When", "Label", "Reason", "Used (s)", "Avg speed %", "Peak speed %", "Reactions", "Chat",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([
      r.created_at || "",
      r.label || "",
      REASON_LABEL[r.reason] || r.reason || "",
      r.used_seconds ?? "",
      r.avg_speed_percent ?? "",
      r.peak_speed_percent ?? "",
      r.reactions_total ?? "",
      r.chat_count ?? "",
    ].map(csvCell).join(","));
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `session-history-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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
  const [query, setQuery] = useState("");
  const [reasonFilter, setReasonFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

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

  // Client-side filter: text matches label or reason label; reason dropdown
  // narrows to one end-reason; the from/to dates bound the turn's day
  // (inclusive both ends). Applied to both the list and the CSV export.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // from = start of the from-day; to = start of the day AFTER the to-day, so
    // the whole to-day counts. Both parsed as local dates from the YYYY-MM-DD inputs.
    const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const toMs = toDate ? new Date(`${toDate}T00:00:00`).getTime() + 86400000 : null;
    return rows.filter((r) => {
      if (reasonFilter !== "all" && r.reason !== reasonFilter) return false;
      if (fromMs != null || toMs != null) {
        const t = r.created_at ? new Date(r.created_at).getTime() : NaN;
        if (Number.isNaN(t)) return false;
        if (fromMs != null && t < fromMs) return false;
        if (toMs != null && t >= toMs) return false;
      }
      if (!q) return true;
      const hay = `${r.label || ""} ${REASON_LABEL[r.reason] || r.reason || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, reasonFilter, fromDate, toDate]);

  // Reasons actually present in the data, for the dropdown options.
  const reasonOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.reason).filter(Boolean))),
    [rows]
  );

  const exportCsv = () => {
    if (filtered.length === 0) {
      toast.error("Nothing to export with the current filter.");
      return;
    }
    downloadCsv(filtered);
    toast.success(`Exported ${filtered.length} ${filtered.length === 1 ? "turn" : "turns"} to CSV.`);
  };

  return (
    <div className="space-y-3" data-testid="session-history">
      <div className="flex items-center justify-between">
        <span className="font-mono-data text-[11px] text-[var(--kink-muted)]">
          {filtered.length === rows.length
            ? `${rows.length} recorded ${rows.length === 1 ? "turn" : "turns"}`
            : `${filtered.length} of ${rows.length} turns`}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={exportCsv}
            data-testid="history-export"
            title="Export shown turns to CSV"
            className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors"
          >
            <Download size={13} />
          </button>
          <button
            onClick={load}
            data-testid="history-refresh"
            title="Refresh"
            className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--kink-muted)] pointer-events-none"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search label…"
              data-testid="history-search"
              className="w-full pl-7 pr-2 py-1.5 font-mono-data text-[11px] text-white bg-[var(--kink-base)] border border-[var(--kink-overlay)] focus:border-[var(--kink-purple)] outline-none placeholder:text-[var(--kink-muted)]"
            />
          </div>
          <select
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
            data-testid="history-reason-filter"
            className="py-1.5 px-2 font-mono-data text-[11px] text-white bg-[var(--kink-base)] border border-[var(--kink-overlay)] focus:border-[var(--kink-purple)] outline-none shrink-0"
          >
            <option value="all">All reasons</option>
            {reasonOptions.map((r) => (
              <option key={r} value={r}>{REASON_LABEL[r] || r}</option>
            ))}
          </select>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono-data text-[10px] uppercase tracking-wide text-[var(--kink-muted)] shrink-0">From</span>
          <input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            data-testid="history-from-date"
            className="flex-1 min-w-0 py-1.5 px-2 font-mono-data text-[11px] text-white bg-[var(--kink-base)] border border-[var(--kink-overlay)] focus:border-[var(--kink-purple)] outline-none"
          />
          <span className="font-mono-data text-[10px] uppercase tracking-wide text-[var(--kink-muted)] shrink-0">To</span>
          <input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            data-testid="history-to-date"
            className="flex-1 min-w-0 py-1.5 px-2 font-mono-data text-[11px] text-white bg-[var(--kink-base)] border border-[var(--kink-overlay)] focus:border-[var(--kink-purple)] outline-none"
          />
          {(fromDate || toDate) && (
            <button
              onClick={() => { setFromDate(""); setToDate(""); }}
              data-testid="history-clear-dates"
              title="Clear date range"
              className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors shrink-0"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

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
      ) : filtered.length === 0 ? (
        <p className="font-mono-data text-[11px] text-[var(--kink-muted)] py-4 text-center">
          No turns match this filter.
        </p>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((r) => (
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
