import { useEffect, useState, useCallback } from "react";
import { Play, Square, Trash2, RefreshCw, Star } from "lucide-react";
import { api, fmtTime } from "@/lib/api";
import { toast } from "sonner";

/**
 * SessionRecordings — admin panel listing saved telemetry recordings of past
 * turns. The owner can replay one back to the device (reproducing the original
 * speed/depth/stroke/sensation timing), stop an in-progress replay, or delete a
 * recording. Replay is refused server-side while a guest is active.
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

export function SessionRecordings({ featuredId = null }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/recordings");
      setItems(Array.isArray(data) ? data : []);
    } catch (_) {
      /* leave list as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const replay = async (id) => {
    setBusy(true);
    try {
      await api.post(`/recordings/${id}/replay`, { speed: 1.0 });
      toast.success("Replaying recording to the device.");
    } catch (e) {
      const detail = e?.response?.data?.detail;
      toast.error(detail || "Could not start replay.");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      await api.post("/recordings/replay/stop");
      toast.info("Replay stopped.");
    } catch (_) {
      toast.error("Could not stop replay.");
    }
  };

  const remove = async (id) => {
    try {
      await api.delete(`/recordings/${id}`);
      setItems((prev) => prev.filter((r) => r.id !== id));
    } catch (_) {
      toast.error("Could not delete recording.");
    }
  };

  const feature = async (id) => {
    const isFeatured = featuredId === id;
    try {
      if (isFeatured) {
        await api.post(`/recordings/none/feature`, { featured: false });
        toast.info("Cleared featured session.");
      } else {
        await api.post(`/recordings/${id}/feature`, { featured: true });
        toast.success("Set as featured session — guests can see it.");
      }
    } catch (_) {
      toast.error("Could not update featured session.");
    }
  };

  return (
    <div className="space-y-3" data-testid="session-recordings">
      <div className="flex items-center justify-between">
        <span className="font-mono-data text-[11px] text-[var(--kink-muted)]">
          {items.length} saved {items.length === 1 ? "recording" : "recordings"}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={stop}
            data-testid="recording-stop-replay"
            title="Stop any replay in progress"
            className="flex items-center gap-1 px-2 py-1 border border-[var(--kink-overlay)] text-[var(--kink-text-2)] text-xs hover:border-[var(--kink-red,#ff5c73)] hover:text-[var(--kink-red,#ff5c73)] transition-colors"
          >
            <Square size={11} /> Stop
          </button>
          <button
            onClick={load}
            data-testid="recording-refresh"
            title="Refresh list"
            className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {loading ? (
        <p className="font-mono-data text-[11px] text-[var(--kink-muted)] py-4 text-center">Loading…</p>
      ) : items.length === 0 ? (
        <p className="font-mono-data text-[11px] text-[var(--kink-muted)] py-4 text-center">
          No recordings yet. A turn where the device moved is saved automatically when it ends.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((r) => (
            <div
              key={r.id}
              data-testid={`recording-${r.id}`}
              className="group flex items-center justify-between px-3 py-2 border border-[var(--kink-overlay)] bg-[var(--kink-base)]"
            >
              <div className="min-w-0">
                <span className="block text-sm text-white truncate">{r.label}</span>
                <span className="block font-mono-data text-[10px] text-[var(--kink-muted)]">
                  {fmtWhen(r.created_at)} · {fmtTime(r.duration_seconds)}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => feature(r.id)}
                  data-testid={`recording-feature-${r.id}`}
                  title={featuredId === r.id ? "Featured — click to unfeature" : "Feature this session for guests"}
                  className={`p-1.5 transition-colors ${
                    featuredId === r.id
                      ? "text-[var(--kink-purple)]"
                      : "text-[var(--kink-muted)] hover:text-[var(--kink-purple)] opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <Star size={14} fill={featuredId === r.id ? "currentColor" : "none"} />
                </button>
                <button
                  onClick={() => replay(r.id)}
                  disabled={busy}
                  data-testid={`recording-replay-${r.id}`}
                  title="Replay to device"
                  className="p-1.5 text-[var(--kink-purple)] hover:text-white disabled:opacity-40 transition-colors"
                >
                  <Play size={14} />
                </button>
                <button
                  onClick={() => remove(r.id)}
                  data-testid={`recording-delete-${r.id}`}
                  title="Delete recording"
                  className="p-1.5 text-[var(--kink-muted)] hover:text-[var(--kink-red,#ff5c73)] opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
