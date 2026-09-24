import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * SystemHealth — admin operational panel. Polls /api/metrics every 15s and
 * shows process uptime, DB status, live session/queue counts, and host memory
 * (when the backend has psutil). Gives the owner an at-a-glance "is it healthy"
 * view so problems are visible before users report them.
 */
function fmtUptime(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Stat({ label, value, tone = "normal" }) {
  const color =
    tone === "good" ? "var(--kink-green, #46d38a)"
    : tone === "bad" ? "var(--kink-red, #ff5c73)"
    : "var(--kink-text)";
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
      <span className="text-sm text-[var(--kink-text-2)]">{label}</span>
      <span className="font-mono-data text-sm" style={{ color }}>{value}</span>
    </div>
  );
}

export function SystemHealth() {
  const [m, setM] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const { data } = await api.get("/metrics");
        if (!cancelled) { setM(data); setErr(""); }
      } catch (e) {
        if (!cancelled) setErr("metrics unavailable");
      } finally {
        if (!cancelled) timer = setTimeout(poll, 15000);
      }
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  if (err && !m) {
    return <div className="text-sm text-[var(--kink-red,#ff5c73)]" data-testid="system-health-error">{err}</div>;
  }
  if (!m) {
    return <div className="text-sm text-[var(--kink-text-2)]">Loading health…</div>;
  }

  const dbOk = m.db?.ok;
  const hostOk = m.session?.host_connected;
  const memWarn = m.memory && m.memory.percent_used >= 90;

  return (
    <div className="space-y-1" data-testid="system-health-panel">
      <Stat
        label="Status"
        value={m.status === "ok" ? "Healthy" : "Degraded"}
        tone={m.status === "ok" ? "good" : "bad"}
      />
      <Stat label="Uptime" value={fmtUptime(m.uptime_seconds)} />
      <Stat label="Database" value={dbOk ? "Connected" : "DOWN"} tone={dbOk ? "good" : "bad"} />
      <Stat label="Host device" value={hostOk ? "Connected" : "Offline"} tone={hostOk ? "good" : "normal"} />
      <Stat label="Active session" value={m.session?.active?.label ? "In progress" : "Idle"} />
      <Stat label="Queue length" value={m.session?.queue_length ?? 0} />
      <Stat label="Connected clients" value={m.session?.connected_clients ?? 0} />
      {m.memory && (
        <Stat
          label="Host memory used"
          value={`${m.memory.percent_used}% (${m.memory.available_mb}MB free)`}
          tone={memWarn ? "bad" : "normal"}
        />
      )}
      {m.db?.users != null && <Stat label="Registered admins" value={m.db.users} />}
    </div>
  );
}
