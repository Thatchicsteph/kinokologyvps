import React, { useEffect, useRef, useState } from "react";
import { Reorder } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { useBleHost } from "@/hooks/useBleHost";
import { useHeartRate } from "@/hooks/useHeartRate";
import { useToys } from "@/hooks/useToys";
import { ControlConsole } from "@/components/ControlConsole";
import { CalibrationPanel } from "@/components/CalibrationPanel";
import { LiveQueue } from "@/components/LiveQueue";
import { TwoFactorPanel } from "@/components/TwoFactorPanel";
import { RecentActivity } from "@/components/RecentActivity";
import { SystemHealth } from "@/components/SystemHealth";
import { HeartRateSync } from "@/components/HeartRateSync";
import { ToysPanel } from "@/components/ToysPanel";
import { ObsStream } from "@/components/ObsStream";
import { OwnerNameCard } from "@/components/OwnerNameCard";
import { ChatPanel } from "@/components/ChatPanel";
import { FloatingReactions } from "@/components/FloatingReactions";
import { ReactionBar } from "@/components/ReactionBar";
import { ShareSpectatorLink } from "@/components/ShareSpectatorLink";
import { ThemePicker } from "@/components/ThemePicker";
import { applyTheme } from "@/components/ThemeSync";
import { fmtTime } from "@/lib/api";
import { webBluetoothSupported } from "@/lib/ossm";
import { PATTERNS } from "@/lib/ossm";
import { PROGRAMS } from "@/components/ControlConsole";
import { LogOut, Bluetooth, BluetoothConnected, Power, SkipForward, Plus, Copy, Trash2, Ban, Clock, Activity, Ticket, Sliders, Heart, Eye, Settings2, GripVertical, EyeOff, X, ChevronUp, ChevronDown, MessageSquare, Zap, Columns2 } from "lucide-react";
import kinkologyMark from "@/assets/kinkology-mark.png";
import { toast } from "sonner";

function StatusPill({ ok, okText, offText }) {
  return (
    <span className={`inline-flex items-center gap-2 font-mono-data text-xs px-3 py-1.5 border ${
      ok ? "border-[var(--kink-purple)]/40 text-[var(--kink-purple)]" : "border-[var(--kink-overlay)] text-[var(--kink-muted)]"
    }`}>
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-[var(--kink-purple)] pulse-dot" : "bg-[var(--kink-muted)]"}`} />
      {ok ? okText : offText}
    </span>
  );
}

// ------------------------------------------------------------------
// Panel layout: which optional dashboard panels are shown, how many
// grid columns to arrange them into (1-5), and their order. Purely a
// client-side display preference — stored in localStorage (not synced
// to the backend), same idea as browser-local UI state elsewhere in
// the app. Only the video always renders at the top of wherever it's
// placed; nothing else is fixed.
//
// Every panel lives in one "zone": zone 0 is the full-width row above
// the grid; zones 1..N are the N equal-width grid columns the owner
// picked. Any panel can be moved into any zone — including OBS Stream,
// Device Activity, and Toy Control, which default to zone 0 (full
// width) but aren't locked there.
// ------------------------------------------------------------------
const PANEL_LAYOUT_STORAGE_KEY = "kinkology_admin_panel_layout_v5";
const PANEL_COLLAPSE_STORAGE_KEY = "kinkology_admin_panel_collapsed_v1";
const PANEL_WIDTH_STORAGE_KEY = "kinkology_admin_panel_width_v1";
const MIN_GRID_COLUMNS = 1;
const MAX_GRID_COLUMNS = 5;
const DEFAULT_GRID_COLUMNS = 3;
const TOP_ZONE = 0;

// Static (not template-built) so Tailwind's class scanner can see them.
const GRID_COLS_CLASS = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
};

// Static so Tailwind's scanner sees them. A wide (span-2) panel occupies two
// grid columns; capped at the current column count so it never overflows.
const COL_SPAN_CLASS = {
  1: "",
  2: "lg:col-span-2",
};

const PANEL_DEFS = {
  "obs-stream": { label: "OBS Stream" },
  "device-activity": { label: "Device Activity" },
  "toy-control": { label: "Toy Control" },
  "live-session": { label: "Live Session" },
  "recent-activity": { label: "Recent Activity" },
  "system-health": { label: "System Health" },
  "theme-picker": { label: "Theme Picker" },
  "owner-name": { label: "Chat Name" },
  "live-overlay": { label: "Live Overlay" },
  "two-factor": { label: "Two-Factor Auth" },
  "base-urls": { label: "Base URLs" },
  "safety-limits": { label: "Safety Limits" },
  "heart-rate-sync": { label: "Heart Rate Sync" },
  "new-access-code": { label: "New Access Code" },
  "issued-codes": { label: "Issued Codes" },
};

const ALL_PANEL_IDS = Object.keys(PANEL_DEFS);

// zones[0] = full-width row; zones[1] / zones[2] = the two default grid
// columns. Total zone count is always 1 (top) + columnCount (grid).
const DEFAULT_PANEL_ORDER = {
  zones: [
    ["obs-stream", "device-activity", "toy-control"],
    ["live-session", "recent-activity", "heart-rate-sync"],
    ["theme-picker", "owner-name", "live-overlay", "base-urls"],
    ["safety-limits", "two-factor", "new-access-code", "issued-codes"],
  ],
};

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

// Total zones = 1 (top) + columnCount. Folds any zones beyond that
// count into the last one (so shrinking the column count never hides
// a panel), dedupes ids across zones, and appends any panel missing
// from the saved layout (e.g. one added by an app update) into zone 0.
function sanitizeZones(rawZones, columnCount) {
  const totalZones = 1 + columnCount;
  let zones = (Array.isArray(rawZones) ? rawZones : []).map((z) => (Array.isArray(z) ? [...z] : []));
  while (zones.length > totalZones) {
    const overflow = zones.pop();
    zones[zones.length - 1] = [...zones[zones.length - 1], ...overflow];
  }
  while (zones.length < totalZones) zones.push([]);
  const seen = new Set();
  zones = zones.map((zone) => zone.filter((id) => {
    if (!ALL_PANEL_IDS.includes(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }));
  for (const id of ALL_PANEL_IDS) {
    if (!seen.has(id)) { zones[0].push(id); seen.add(id); }
  }
  return zones;
}

function defaultLayout(columnCount = DEFAULT_GRID_COLUMNS) {
  return { columnCount, order: { zones: sanitizeZones(DEFAULT_PANEL_ORDER.zones, columnCount) }, hidden: [] };
}

function loadPanelLayout() {
  try {
    const raw = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const columnCount = clamp(Number(parsed?.columnCount) || DEFAULT_GRID_COLUMNS, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);
    const order = { zones: sanitizeZones(parsed?.order?.zones, columnCount) };
    const hidden = Array.isArray(parsed?.hidden) ? parsed.hidden.filter((id) => PANEL_DEFS[id]) : [];
    return { columnCount, order, hidden };
  } catch (_) {
    return defaultLayout();
  }
}

function usePanelLayout() {
  const [layout, setLayout] = useState(loadPanelLayout);

  useEffect(() => {
    try { localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch (_) {}
  }, [layout]);

  const setColumnCount = (n) => {
    const columnCount = clamp(n, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);
    setLayout((l) => ({ ...l, columnCount, order: { zones: sanitizeZones(l.order.zones, columnCount) } }));
  };
  const setZoneOrder = (zoneIndex, ids) => {
    setLayout((l) => {
      const zones = l.order.zones.map((z, i) => (i === zoneIndex ? ids : z));
      return { ...l, order: { zones } };
    });
  };
  const moveToZone = (id, fromZone, toZone) => {
    setLayout((l) => {
      if (toZone < 0 || toZone >= l.order.zones.length || toZone === fromZone) return l;
      const zones = l.order.zones.map((z) => [...z]);
      zones[fromZone] = zones[fromZone].filter((x) => x !== id);
      zones[toZone] = [...zones[toZone], id];
      return { ...l, order: { zones } };
    });
  };
  const toggleHidden = (id) => {
    setLayout((l) => ({
      ...l,
      hidden: l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id],
    }));
  };
  const resetLayout = () => setLayout(defaultLayout());

  return { layout, setColumnCount, setZoneOrder, moveToZone, toggleHidden, resetLayout };
}

// Per-panel collapsed state (shrink a panel to just its header). Stored in
// localStorage, keyed by panel id, like the layout preference.
function usePanelCollapse() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const raw = localStorage.getItem(PANEL_COLLAPSE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(PANEL_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsed)); } catch (_) {}
  }, [collapsed]);
  const toggle = (id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  return { collapsed, toggle };
}

// Per-panel width span (1 or 2 grid columns). Stored in localStorage, keyed by
// panel id. A panel set to span 2 occupies two columns of the grid.
function usePanelWidth() {
  const [widths, setWidths] = useState(() => {
    try {
      const raw = localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, JSON.stringify(widths)); } catch (_) {}
  }, [widths]);
  // Cycle 1 -> 2 -> 1
  const cycle = (id) => setWidths((w) => ({ ...w, [id]: (w[id] === 2 ? 1 : 2) }));
  return { widths, cycle };
}

// Wraps a rendered admin panel and makes its title clickable to shrink/expand.
// No chevron buttons — clicking the name toggles the panel. Collapsed: the
// panel body is hidden and replaced by a clickable title bar. Expanded: a
// transparent clickable strip sits across the top of the panel (over its own
// title area) so clicking the heading collapses it. `title` is the label from
// PANEL_DEFS.
function CollapsiblePanel({ id, title, collapsed, onToggle, children }) {
  if (collapsed) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggle(id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(id); } }}
        data-testid={`panel-collapse-${id}`}
        title="Click to expand"
        className="hud-panel px-5 sm:px-6 py-4 flex items-center cursor-pointer select-none hover:text-[var(--kink-purple)] transition-colors"
      >
        <span className="font-display font-black uppercase tracking-[0.08em] text-sm text-[var(--kink-text-2)]">
          {title}
        </span>
      </div>
    );
  }
  return (
    <div className="relative" data-testid={`panel-collapse-${id}`}>
      {/* Transparent clickable strip over the panel's TITLE (left side only).
          Panel titles are left-aligned and header action buttons (e.g. Live
          Session's SKIP/STOP) are right-aligned, so covering only the left
          ~60% catches the heading without blocking those controls. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggle(id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(id); } }}
        data-testid={`panel-collapse-toggle-${id}`}
        title="Click title to shrink"
        className="absolute top-0 left-0 h-14 z-10 cursor-pointer"
        style={{ width: "60%", background: "transparent" }}
      />
      {children}
    </div>
  );
}

function ColumnEditor({ title, ids, hidden, onReorder, onToggle, zoneIndex, zoneCount, onMove, widths, onToggleWidth }) {
  const movable = typeof onMove === "function" && zoneCount > 1;
  return (
    <div className="mb-5">
      <h3 className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)] mb-2">{title}</h3>
      <Reorder.Group axis="y" values={ids} onReorder={onReorder} className="space-y-1.5">
        {ids.map((id) => {
          const def = PANEL_DEFS[id];
          if (!def) return null;
          const isHidden = hidden.includes(id);
          return (
            <Reorder.Item
              key={id}
              value={id}
              data-testid={`panel-row-${id}`}
              className={`flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 cursor-grab active:cursor-grabbing select-none bg-[var(--kink-base)] ${isHidden ? "opacity-50" : ""}`}
            >
              <GripVertical size={14} className="text-[var(--kink-muted)] shrink-0" />
              <span className="flex-1 font-mono-data text-sm truncate">{def.label}</span>
              {movable && (
                <>
                  <button
                    type="button"
                    onClick={() => onMove(id, zoneIndex, zoneIndex - 1)}
                    disabled={zoneIndex === 0}
                    data-testid={`panel-move-left-${id}`}
                    title="Move to previous column"
                    className="shrink-0 p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors disabled:opacity-20 disabled:hover:text-[var(--kink-muted)]"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(id, zoneIndex, zoneIndex + 1)}
                    disabled={zoneIndex === zoneCount - 1}
                    data-testid={`panel-move-right-${id}`}
                    title="Move to next column"
                    className="shrink-0 p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors disabled:opacity-20 disabled:hover:text-[var(--kink-muted)]"
                  >
                    →
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => onToggle(id)}
                data-testid={`panel-toggle-${id}`}
                title={isHidden ? "Show panel" : "Hide panel"}
                className={`shrink-0 p-1 transition-colors ${isHidden ? "text-[var(--kink-muted)] hover:text-[var(--kink-purple)]" : "text-[var(--kink-purple)] hover:text-[var(--kink-muted)]"}`}
              >
                {isHidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              {typeof onToggleWidth === "function" && (
                <button
                  type="button"
                  onClick={() => onToggleWidth(id)}
                  data-testid={`panel-width-${id}`}
                  title={widths?.[id] === 2 ? "Single width" : "Double width (span 2 columns)"}
                  className={`shrink-0 p-1 transition-colors ${widths?.[id] === 2 ? "text-[var(--kink-purple)]" : "text-[var(--kink-muted)] hover:text-[var(--kink-purple)]"}`}
                >
                  <Columns2 size={15} />
                </button>
              )}
            </Reorder.Item>
          );
        })}
        {ids.length === 0 && (
          <p className="font-mono-data text-[11px] text-[var(--kink-muted)] italic px-1 py-1">Empty — move a panel here.</p>
        )}
      </Reorder.Group>
    </div>
  );
}

function PanelCustomizer({ open, onClose, layout, setColumnCount, setZoneOrder, moveToZone, toggleHidden, resetLayout, widths, onToggleWidth }) {
  if (!open) return null;
  const columnNums = Array.from({ length: MAX_GRID_COLUMNS - MIN_GRID_COLUMNS + 1 }, (_, i) => i + MIN_GRID_COLUMNS);
  const zoneCount = layout.order.zones.length; // 1 (top) + columnCount
  return (
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/70 p-4 overflow-y-auto"
      onClick={onClose}
      data-testid="panel-customizer-backdrop"
    >
      <div
        className="hud-panel w-full max-w-3xl p-5 sm:p-6 my-8"
        onClick={(e) => e.stopPropagation()}
        data-testid="panel-customizer"
      >
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2">
            <Settings2 size={18} className="text-[var(--kink-purple)]" /> Customize Panels
          </h2>
          <button onClick={onClose} data-testid="panel-customizer-close" className="text-[var(--kink-muted)] hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
        <p className="text-[var(--kink-text-2)] text-sm mb-4">
          Drag to reorder within a column, use ← / → to move any panel — including the stream, device, and toy panels — into another column, toggle the eye to hide one. Only visible to you — this browser remembers your layout.
        </p>

        <div className="mb-5">
          <h3 className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)] mb-2">GRID COLUMNS</h3>
          <div className="flex gap-2" data-testid="column-count-picker">
            {columnNums.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setColumnCount(n)}
                data-testid={`column-count-${n}`}
                className={`h-9 w-9 font-mono-data text-sm border transition-colors ${
                  layout.columnCount === n
                    ? "border-[var(--kink-purple)] bg-[var(--kink-purple)] text-[var(--kink-base)] font-bold"
                    : "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)]"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <ColumnEditor
          title="TOP (FULL-WIDTH)"
          ids={layout.order.zones[TOP_ZONE]}
          hidden={layout.hidden}
          onReorder={(ids) => setZoneOrder(TOP_ZONE, ids)}
          onToggle={toggleHidden}
          zoneIndex={TOP_ZONE}
          zoneCount={zoneCount}
          onMove={moveToZone}
        />

        <div className={`grid gap-x-6 sm:grid-cols-2 ${layout.columnCount >= 3 ? "lg:grid-cols-3" : ""}`}>
          {layout.order.zones.slice(1).map((ids, gridIdx) => {
            const zoneIndex = gridIdx + 1;
            return (
              <ColumnEditor
                key={`grid-col-${gridIdx}`}
                title={`COLUMN ${gridIdx + 1}`}
                ids={ids}
                hidden={layout.hidden}
                onReorder={(newIds) => setZoneOrder(zoneIndex, newIds)}
                onToggle={toggleHidden}
                zoneIndex={zoneIndex}
                zoneCount={zoneCount}
                onMove={moveToZone}
                widths={widths}
                onToggleWidth={layout.columnCount >= 2 ? onToggleWidth : undefined}
              />
            );
          })}
        </div>

        <button
          onClick={resetLayout}
          data-testid="panel-customizer-reset"
          className="font-mono-data text-[11px] text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors underline underline-offset-2"
        >
          Reset to default layout
        </button>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const bleRef = useRef(null);
  const toys = useToys({
    onStatusChange: ({ available, pattern }) => {
      // Owner side is the single source of truth for whether toys exist.
      // Push it up to the backend so guests know whether to render the toys UI.
      bleRef.current?.sendHostMessage({ type: "toys_status", available, pattern });
    },
  });
  const [toysLocked, setToysLocked] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [ownerName, setOwnerName] = useState("Owner");
  const [presence, setPresence] = useState(null);
  const [reactions, setReactions] = useState([]);
  const ble = useBleHost({
    onCommand: toys.handleCommand,
    onToyCommand: toys.applyRemoteCommand,
    onToysLock: (locked) => {
      setToysLocked(locked);
      if (locked) toys.stopAllToys();
    },
    onChatHistory: (msgs) => setChatMsgs(msgs),
    onChatMsg: (m) => setChatMsgs((prev) => [...prev, m].slice(-50)),
    onChatCleared: () => setChatMsgs([]),
    onPresence: (p) => setPresence(p),
    onReaction: (r) => setReactions((prev) => [...prev.slice(-24), r]),
    onChatReact: (msg) => setChatMsgs((prev) => prev.map((m) => (m.id === msg.msg_id ? { ...m, reactions: msg.reactions } : m))),
    onChatDelete: (msgId) => setChatMsgs((prev) => prev.filter((m) => m.id !== msgId)),
    onTheme: (t) => applyTheme(t),
  });
  bleRef.current = ble;
  const hr = useHeartRate();

  const [codes, setCodes] = useState([]);
  const [state, setState] = useState({ active: null, queue: [], queue_length: 0, host_connected: false, device_state: "" });
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState(10);
  const [viewOnly, setViewOnly] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [deviceShrunk, setDeviceShrunk] = useState(false);
  const [limits, setLimits] = useState({ min_depth: 0, max_speed: 100, hr_cutoff: 0, toy_length_mm: 0, rail_travel_mm: 300, max_depth: 100, manual_max_depth: null });
  const [savingLimits, setSavingLimits] = useState(false);
  const [urls, setUrls] = useState({ local_url: "", public_url: "", whep_external_url: "" });
  const [savingUrls, setSavingUrls] = useState(false);
  const [overlayConfig, setOverlayConfig] = useState({
    panels: ["header", "timer", "heartrate", "speed", "depth", "stroke", "sensation"],
    layout: "2col",
  });
  const [savingOverlay, setSavingOverlay] = useState(false);
  const { layout, setColumnCount, setZoneOrder, moveToZone, toggleHidden, resetLayout } = usePanelLayout();
  const { collapsed: panelCollapsed, toggle: togglePanelCollapse } = usePanelCollapse();
  const { widths: panelWidths, cycle: cyclePanelWidth } = usePanelWidth();
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const pollRef = useRef(null);

  const loadCodes = async () => {
    try { const { data } = await api.get("/codes"); setCodes(data); } catch (e) {}
  };
  const loadState = async () => {
    try { const { data } = await api.get("/session/state"); setState(data); } catch (e) {}
  };
  const loadLimits = async () => {
    try {
      const { data } = await api.get("/settings");
      setLimits({
        min_depth: data.min_depth, max_speed: data.max_speed, hr_cutoff: data.hr_cutoff ?? 0,
        toy_length_mm: data.toy_length_mm ?? 0, rail_travel_mm: data.rail_travel_mm ?? 300,
        max_depth: data.max_depth ?? 100, manual_max_depth: data.manual_max_depth ?? null,
      });
      setUrls({ local_url: data.local_url || "", public_url: data.public_url || "", whep_external_url: data.whep_external_url || "" });
      if (data.overlay_config) {
        setOverlayConfig({
          panels: data.overlay_config.panels || ["header", "timer", "heartrate", "speed", "depth", "stroke", "sensation"],
          layout: data.overlay_config.layout || "2col",
        });
      }
    } catch (e) {}
  };
  const saveOverlayConfig = async () => {
    setSavingOverlay(true);
    try {
      const { data } = await api.put("/overlay/config", overlayConfig);
      setOverlayConfig({ panels: data.panels, layout: data.layout });
      toast.success("Overlay config saved");
    } catch (e) { toast.error("Could not save overlay config"); }
    finally { setSavingOverlay(false); }
  };
  const saveUrls = async () => {
    setSavingUrls(true);
    try {
      const { data } = await api.put("/settings/urls", {
        local_url: urls.local_url.trim(), public_url: urls.public_url.trim(),
        whep_external_url: (urls.whep_external_url || "").trim(),
      });
      setUrls({ local_url: data.local_url || "", public_url: data.public_url || "", whep_external_url: data.whep_external_url || "" });
      toast.success("URLs saved");
    } catch (e) { toast.error("Could not save URLs"); }
    finally { setSavingUrls(false); }
  };
  const saveLimits = async () => {
    setSavingLimits(true);
    try {
      const { data } = await api.put("/settings", {
        min_depth: Number(limits.min_depth), max_speed: Number(limits.max_speed),
        hr_cutoff: Number(limits.hr_cutoff) || 0,
        toy_length_mm: Number(limits.toy_length_mm) || 0,
        rail_travel_mm: Number(limits.rail_travel_mm) || 300,
        manual_max_depth: limits.manual_max_depth === null || limits.manual_max_depth === "" ? null : Number(limits.manual_max_depth),
      });
      setLimits({
        min_depth: data.min_depth, max_speed: data.max_speed, hr_cutoff: data.hr_cutoff ?? 0,
        toy_length_mm: data.toy_length_mm ?? 0, rail_travel_mm: data.rail_travel_mm ?? 300,
        max_depth: data.max_depth ?? 100, manual_max_depth: data.manual_max_depth ?? null,
      });
      toast.success("Safety limits saved — enforced for all guests");
    } catch (e) { toast.error("Could not save limits"); }
    finally { setSavingLimits(false); }
  };

  useEffect(() => {
    loadCodes();
    loadState();
    loadLimits();
    pollRef.current = setInterval(loadState, 1000);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line
  }, []);

  // The host relay session (used to forward guest/owner commands + chat + toys
  // lock state) needs to be open the entire time the admin page is mounted —
  // chat + kill switch don't require an OSSM or toys to be present, and BLE
  // requires a user gesture to reconnect after refresh which we can't do
  // automatically.
  useEffect(() => {
    ble.openHostWs();
    return () => { ble.closeHostWs(); };
    // eslint-disable-next-line
  }, []);

  const createCode = async (e) => {
    e.preventDefault();
    try {
      await api.post("/codes", { label, minutes: viewOnly ? 0 : Number(minutes), view_only: viewOnly });
      setLabel("");
      setMinutes(10);
      setViewOnly(false);
      loadCodes();
      toast.success(viewOnly ? "View-only link created" : "Access code created");
    } catch (e) { toast.error("Could not create code"); }
  };

  const revoke = async (id) => { await api.post(`/codes/${id}/revoke`); loadCodes(); };
  const addMin = async (id) => { await api.post(`/codes/${id}/add-minutes`, { minutes: 10 }); loadCodes(); toast.success("+10 minutes"); };
  const del = async (id) => { await api.delete(`/codes/${id}`); loadCodes(); };
  const copyLink = (code) => {
    const base = (urls.public_url || window.location.origin).replace(/\/+$/, "");
    navigator.clipboard.writeText(`${base}/c/${code}`);
    toast.success("Guest link copied");
  };

  const stopAll = async () => { await api.post("/session/stop"); toast("Emergency stop sent", { icon: "⛔" }); };
  const skip = async () => { await api.post("/session/skip"); loadState(); toast("Skipped to next guest"); };

  const toggleToysLock = async () => {
    try {
      const { data } = await api.post(`/session/toys/${toysLocked ? "unlock" : "lock"}`);
      setToysLocked(data.locked);
      toast(data.locked ? "Guest toys LOCKED" : "Guest toys unlocked", { icon: data.locked ? "🔒" : "🔓" });
    } catch (e) { toast.error("Could not toggle toy lock"); }
  };

  const sendChat = (text) => ble.sendHostMessage({ type: "chat", text });
  const sendReaction = (emoji) => ble.sendHostMessage({ type: "reaction", emoji });
  const sendChatReact = (msgId, emoji) => ble.sendHostMessage({ type: "chat_react", msg_id: msgId, emoji });
  const sendChatDelete = (msgId) => ble.sendHostMessage({ type: "chat_delete", msg_id: msgId });
  const sendChatMute = (code, muted) => ble.sendHostMessage({ type: "chat_mute", code, muted });
  const sendQueueMove = (cid, direction) => ble.sendHostMessage({ type: "queue_move", cid, direction });
  const sendExtendActive = (minutes) => ble.sendHostMessage({ type: "extend_active", seconds: minutes * 60 });
  const clearChat = async () => {
    try { await api.delete("/session/chat"); toast("Chat cleared"); }
    catch (e) { toast.error("Could not clear chat"); }
  };

  const doLogout = async () => { await logout(); navigate("/admin/login"); };

  const panelNodes = {
    "obs-stream": (
      <div key="obs-stream-panel">
        <div className="relative" data-testid="obs-stream-with-reactions">
          <ObsStream />
          <FloatingReactions reactions={reactions} />
        </div>
        <ReactionBar onReact={sendReaction} disabled={!ble.wsConnected} />
      </div>
    ),
    "device-activity": (
      <div className="hud-panel p-5 sm:p-6" key="device-activity-panel">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2">
              <Bluetooth size={18} className="text-[var(--kink-purple)]" /> Device Host
              <button
                type="button"
                onClick={() => setDeviceShrunk((s) => !s)}
                data-testid="device-panel-shrink-button"
                title={deviceShrunk ? "Expand panel" : "Shrink panel"}
                aria-label={deviceShrunk ? "Expand device host panel" : "Shrink device host panel"}
                className="ml-1 shrink-0 p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors"
              >
                {deviceShrunk ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </button>
            </h2>
            {!deviceShrunk && (
              <p className="text-[var(--kink-text-2)] text-sm mt-1">
                This browser holds the Bluetooth link to your OSSM and relays guest commands.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 mt-3">
              <StatusPill ok={ble.connected} okText={`BLE · ${ble.deviceName}`} offText="BLE DISCONNECTED" />
              <StatusPill ok={ble.wsConnected} okText="BRIDGE ONLINE" offText="BRIDGE OFFLINE" />
              <span className={`inline-flex items-center gap-2 font-mono-data text-xs px-3 py-1.5 border ${
                hr.connected ? "border-[var(--kink-hr)]/50 text-[var(--kink-hr)]" : "border-[var(--kink-overlay)] text-[var(--kink-muted)]"
              }`} data-testid="hr-status">
                <Heart size={13} className={hr.connected ? "hr-pulse" : ""} fill={hr.connected ? "currentColor" : "none"} />
                {hr.connected ? `${hr.bpm} BPM` : "HR OFF"}
              </span>
              {ble.connected && state.device_state && (
                <span className="font-mono-data text-xs text-[var(--kink-muted)] max-w-[220px] truncate" title={state.device_state} data-testid="device-state-label">
                  STATE: {state.device_state}
                </span>
              )}
            </div>
            {!deviceShrunk && !webBluetoothSupported() && (
              <p className="font-mono-data text-xs text-[var(--kink-danger)] mt-3">
                ⚠ Web Bluetooth unavailable. Use Chrome, Edge, or Opera on desktop/Android.
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {hr.connected ? (
              <button onClick={hr.disconnect} data-testid="hr-disconnect-button" className="flex items-center gap-2 border border-[var(--kink-hr)]/50 text-[var(--kink-hr)] px-4 py-3 font-display text-xs tracking-[0.1em] active:scale-95 transition-transform">
                <Heart size={16} className="hr-pulse" fill="currentColor" /> {hr.bpm} BPM
              </button>
            ) : (
              <button onClick={hr.connect} data-testid="hr-connect-button" className="flex items-center gap-2 border border-[var(--kink-overlay)] px-4 py-3 font-display text-xs tracking-[0.1em] hover:border-[var(--kink-hr)]/50 hover:text-[var(--kink-hr)] transition-colors">
                <Heart size={16} /> HEART RATE
              </button>
            )}
            {(ble.connected || toys.connected) && (
              <button onClick={() => setShowTest((s) => !s)} data-testid="toggle-test-console" className="flex items-center gap-2 border border-[var(--kink-overlay)] px-4 py-3 font-display text-xs tracking-[0.1em] hover:border-[var(--kink-purple)]/40 transition-colors">
                <Sliders size={16} /> {showTest ? "HIDE" : "TEST"} CONTROLS
              </button>
            )}
            {ble.connected ? (
              <button onClick={ble.disconnect} data-testid="disconnect-device-button" className="flex items-center gap-2 bg-[var(--kink-danger)] text-white px-5 py-3 font-display font-bold tracking-[0.1em] active:scale-95 transition-transform">
                <Power size={16} /> DISCONNECT
              </button>
            ) : (
              <button onClick={ble.connect} data-testid="connect-device-button" className="flex items-center gap-2 bg-[var(--kink-purple)] text-[var(--kink-base)] px-5 py-3 font-display font-bold tracking-[0.1em] glow-purple active:scale-95 transition-transform">
                <BluetoothConnected size={16} /> CONNECT DEVICE
              </button>
            )}
          </div>
        </div>

        {!deviceShrunk && (ble.connected || toys.connected) && showTest && (
          <div className="mt-6 pt-6 border-t border-[var(--kink-overlay)] max-w-md" data-testid="owner-test-console">
            <p className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)] mb-4">
              OWNER TEST CONTROLS — DIRECT TO {ble.connected && toys.connected ? "DEVICE + TOYS" : ble.connected ? "DEVICE" : "TOYS"}
            </p>
            <ControlConsole onCommand={ble.writeCommand} limits={limits} />
          </div>
        )}
      </div>
    ),
    "toy-control": (
      <ToysPanel key="toy-control-panel" toys={toys} locked={toysLocked} onToggleLock={toggleToysLock} />
    ),
    "live-session": (
      <div className="hud-panel p-5 sm:p-6" key="live-session-panel">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2">
            <Activity size={18} className="text-[var(--kink-purple)]" /> Live Session
          </h2>
          <div className="flex gap-2">
            <button onClick={skip} disabled={!state.active} data-testid="skip-button" className="flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-xs hover:border-[var(--kink-purple)]/40 transition-colors disabled:opacity-40">
              <SkipForward size={14} /> SKIP
            </button>
            <button onClick={stopAll} data-testid="emergency-stop-button" className="flex items-center gap-1.5 bg-[var(--kink-danger)] text-white px-3 py-2 font-mono-data text-xs font-bold active:scale-95 transition-transform">
              <Power size={14} /> STOP
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <Stat label="IN CONTROL" value={state.active ? (state.active.label || "Guest") : "—"} />
          <Stat label="TIME LEFT" value={state.active ? fmtTime(state.active.remaining_seconds) : "--:--"} mono />
          <Stat label="IN QUEUE" value={String(state.queue_length)} mono />
        </div>

        {state.active && (state.telemetry?.active_program || state.telemetry?.pattern > 0) && (
          <div className="flex flex-wrap gap-2 mb-5" data-testid="session-program-badges">
            {state.telemetry?.active_program && (() => {
              const prog = PROGRAMS.find((p) => p.id === state.telemetry.active_program);
              return prog ? (
                <span className="flex items-center gap-1.5 font-mono-data text-xs px-3 py-1.5 border border-[var(--kink-purple)]/50 text-[var(--kink-purple)]" data-testid="session-active-program">
                  <Zap size={11} /> AUTO: {prog.name}
                  <span className="text-[var(--kink-muted)] ml-1">{prog.desc}</span>
                </span>
              ) : null;
            })()}
            {!state.telemetry?.active_program && state.telemetry?.pattern > 0 && (() => {
              const pat = PATTERNS.find((p) => p.idx === state.telemetry.pattern);
              return pat ? (
                <span className="flex items-center gap-1.5 font-mono-data text-xs px-3 py-1.5 border border-[var(--kink-overlay)] text-[var(--kink-text-2)]" data-testid="session-active-pattern">
                  PATTERN: {pat.name}
                </span>
              ) : null;
            })()}
          </div>
        )}

        <LiveQueue active={state.active} queue={state.queue} onMute={sendChatMute} onMove={sendQueueMove} onExtend={sendExtendActive} />

        <div className="mt-6 pt-6 border-t border-[var(--kink-overlay)]">
          <ChatPanel
            messages={chatMsgs}
            onSend={sendChat}
            onClear={clearChat}
            canClear
            selfLabel={ownerName}
            title="SESSION CHAT"
            presence={presence}
            onTyping={() => ble.sendHostMessage({ type: "typing" })}
            onReact={sendChatReact}
            onDelete={sendChatDelete}
          />
        </div>
      </div>
    ),
    "recent-activity": <RecentActivity key="recent-activity-panel" />,
    "system-health": <SystemHealth key="system-health-panel" />,
    "theme-picker": <ThemePicker key="theme-picker-panel" />,
    "owner-name": <OwnerNameCard key="owner-name-panel" onChanged={setOwnerName} />,
    "live-overlay": (() => {
      const OVERLAY_PANELS = [
        { id: "header",    label: "Header (logo + status)" },
        { id: "timer",     label: "Run / Session Timer" },
        { id: "heartrate", label: "Heart Rate" },
        { id: "program",   label: "Active Pattern / Program" },
        { id: "speed",     label: "Speed" },
        { id: "depth",     label: "Depth" },
        { id: "stroke",    label: "Stroke" },
        { id: "sensation", label: "Sensation" },
      ];
      const togglePanel = (id) => {
        setOverlayConfig((c) => ({
          ...c,
          panels: c.panels.includes(id) ? c.panels.filter((p) => p !== id) : [...c.panels, id],
        }));
      };
      const movePanel = (id, dir) => {
        setOverlayConfig((c) => {
          const idx = c.panels.indexOf(id);
          if (idx < 0) return c;
          const next = idx + dir;
          if (next < 0 || next >= c.panels.length) return c;
          const panels = [...c.panels];
          [panels[idx], panels[next]] = [panels[next], panels[idx]];
          return { ...c, panels };
        });
      };
      return (
        <div className="hud-panel p-5 sm:p-6" data-testid="overlay-link-card" key="live-overlay-panel">
          <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2 mb-2">
            <Activity size={18} className="text-[var(--kink-purple)]" /> Live Overlay
          </h2>
          <p className="text-[var(--kink-text-2)] text-sm mb-4">Real-time graphs of run time, speed, depth, stroke &amp; sensation. Add as an OBS browser source or open on any screen.</p>
          <div className="flex flex-wrap gap-2 mb-4">
            <button onClick={() => { const base = (urls.local_url || window.location.origin).replace(/\/+$/, ""); navigator.clipboard.writeText(`${base}/overlay`); toast.success("Overlay link copied"); }} data-testid="copy-overlay-link"
              className="flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-xs hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)] transition-colors">
              <Copy size={13} /> COPY LINK
            </button>
            <a href="/overlay" target="_blank" rel="noreferrer" data-testid="open-overlay-link"
              className="flex items-center gap-1.5 bg-[var(--kink-purple)] text-[var(--kink-base)] px-3 py-2 font-display font-bold text-xs tracking-[0.1em] active:scale-95 transition-transform">
              OPEN OVERLAY
            </a>
          </div>
          <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mb-6">Tip: append <span className="text-[var(--kink-text-2)]">?transparent=1</span> for a transparent OBS background.</p>

          {/* Overlay configuration */}
          <div className="pt-5 border-t border-[var(--kink-overlay)]">
            <h3 className="font-display font-black uppercase tracking-[0.08em] text-sm flex items-center gap-2 mb-1">
              <Settings2 size={15} className="text-[var(--kink-purple)]" /> Overlay Layout
            </h3>
            <p className="text-[var(--kink-text-2)] text-xs mb-3">Changes apply the next time the overlay page is opened or refreshed.</p>

            {/* Layout columns */}
            <div className="mb-4">
              <p className="font-display text-[10px] tracking-[0.15em] text-[var(--kink-muted)] mb-2">METRIC GRID</p>
              <div className="flex gap-2">
                {[["1col", "Single column"], ["2col", "Two columns"]].map(([val, lbl]) => (
                  <button
                    key={val}
                    data-testid={`overlay-layout-${val}`}
                    onClick={() => setOverlayConfig((c) => ({ ...c, layout: val }))}
                    className={`flex-1 py-2 font-mono-data text-xs border transition-colors ${
                      overlayConfig.layout === val
                        ? "border-[var(--kink-purple)] text-[var(--kink-purple)]"
                        : "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-purple)]/40"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* Panel visibility & order */}
            <div className="mb-4">
              <p className="font-display text-[10px] tracking-[0.15em] text-[var(--kink-muted)] mb-2">PANELS — toggle &amp; reorder</p>
              <div className="space-y-1.5" data-testid="overlay-panel-list">
                {OVERLAY_PANELS.map(({ id, label: lbl }) => {
                  const on = overlayConfig.panels.includes(id);
                  const idx = overlayConfig.panels.indexOf(id);
                  const last = overlayConfig.panels.length - 1;
                  return (
                    <div
                      key={id}
                      data-testid={`overlay-panel-row-${id}`}
                      className={`flex items-center gap-2 border px-3 py-2 text-sm transition-colors ${
                        on
                          ? "border-[var(--kink-overlay)] text-white"
                          : "border-[var(--kink-overlay)] text-[var(--kink-muted)] opacity-50"
                      }`}
                    >
                      {/* toggle */}
                      <button
                        type="button"
                        data-testid={`overlay-toggle-${id}`}
                        onClick={() => togglePanel(id)}
                        className="shrink-0 transition-colors"
                        title={on ? "Hide" : "Show"}
                      >
                        {on
                          ? <Eye size={15} className="text-[var(--kink-purple)]" />
                          : <EyeOff size={15} className="text-[var(--kink-muted)]" />}
                      </button>
                      <span className="flex-1 font-mono-data text-xs truncate">{lbl}</span>
                      {/* reorder — only enabled when visible */}
                      {on && (
                        <div className="flex gap-0.5 shrink-0">
                          <button
                            type="button"
                            data-testid={`overlay-move-up-${id}`}
                            disabled={idx <= 0}
                            onClick={() => movePanel(id, -1)}
                            className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors disabled:opacity-20"
                            title="Move up"
                          >
                            <ChevronUp size={13} />
                          </button>
                          <button
                            type="button"
                            data-testid={`overlay-move-down-${id}`}
                            disabled={idx >= last}
                            onClick={() => movePanel(id, 1)}
                            className="p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors disabled:opacity-20"
                            title="Move down"
                          >
                            <ChevronDown size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <button
              onClick={saveOverlayConfig}
              disabled={savingOverlay}
              data-testid="save-overlay-config-button"
              className="w-full bg-[var(--kink-purple)] text-[var(--kink-base)] font-display font-bold tracking-[0.1em] py-2.5 text-sm active:scale-95 transition-transform disabled:opacity-50"
            >
              {savingOverlay ? "SAVING…" : "SAVE OVERLAY CONFIG"}
            </button>
          </div>

          {/* Chat overlay section */}
          <div className="mt-6 pt-6 border-t border-[var(--kink-overlay)]">
            <h3 className="font-display font-black uppercase tracking-[0.08em] text-sm flex items-center gap-2 mb-2">
              <MessageSquare size={16} className="text-[var(--kink-purple)]" /> Live Chat Overlay
            </h3>
            <p className="text-[var(--kink-text-2)] text-sm mb-4">A read-only, always-updating view of the chat log — same idea as the overlay above. Add it as its own OBS browser source or open on any screen.</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => { const base = (urls.local_url || window.location.origin).replace(/\/+$/, ""); navigator.clipboard.writeText(`${base}/overlay/chat`); toast.success("Chat overlay link copied"); }} data-testid="copy-chat-overlay-link"
                className="flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-xs hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)] transition-colors">
                <Copy size={13} /> COPY LINK
              </button>
              <a href="/overlay/chat" target="_blank" rel="noreferrer" data-testid="open-chat-overlay-link"
                className="flex items-center gap-1.5 bg-[var(--kink-purple)] text-[var(--kink-base)] px-3 py-2 font-display font-bold text-xs tracking-[0.1em] active:scale-95 transition-transform">
                OPEN CHAT OVERLAY
              </a>
            </div>
          </div>
        </div>
      );
    })(),
    "two-factor": <TwoFactorPanel key="two-factor-panel" />,
    "base-urls": (
      <div className="hud-panel p-5 sm:p-6" data-testid="base-urls-card" key="base-urls-panel">
        <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2 mb-2">
          <Copy size={18} className="text-[var(--kink-purple)]" /> Base URLs
        </h2>
        <p className="text-[var(--kink-text-2)] text-sm mb-5">Guest links use the public URL; the overlay link uses the local URL.</p>
        <div className="space-y-4">
          <div>
            <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">LOCAL URL</label>
            <input type="text" value={urls.local_url} onChange={(e) => setUrls((u) => ({ ...u, local_url: e.target.value }))}
              data-testid="local-url-input" placeholder="http://localhost"
              className="w-full mt-2 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-2.5 font-mono-data text-sm outline-none focus:border-[var(--kink-purple)] transition-colors" />
          </div>
          <div>
            <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">GLOBAL / PUBLIC URL</label>
            <input type="text" value={urls.public_url} onChange={(e) => setUrls((u) => ({ ...u, public_url: e.target.value }))}
              data-testid="public-url-input" placeholder="https://your-domain.com"
              className="w-full mt-2 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-2.5 font-mono-data text-sm outline-none focus:border-[var(--kink-purple)] transition-colors" />
          </div>
          <div>
            <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">EXTERNAL WHEP URL</label>
            <input type="text" value={urls.whep_external_url} onChange={(e) => setUrls((u) => ({ ...u, whep_external_url: e.target.value }))}
              data-testid="whep-url-input" placeholder="https://stream.your-domain.com/live_webrtc/whep"
              className="w-full mt-2 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-2.5 font-mono-data text-sm outline-none focus:border-[var(--kink-purple)] transition-colors" />
            <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mt-1.5">Point viewers at an external media server (e.g. MediaMTX). Leave blank to use the built-in stream relay.</p>
          </div>
          <button onClick={saveUrls} disabled={savingUrls} data-testid="save-urls-button"
            className="w-full bg-[var(--kink-purple)] text-[var(--kink-base)] font-display font-bold tracking-[0.1em] py-3 active:scale-95 transition-transform disabled:opacity-50">
            {savingUrls ? "SAVING…" : "SAVE URLS"}
          </button>
        </div>
      </div>
    ),
    "safety-limits": (
      <div className="hud-panel p-5 sm:p-6" data-testid="safety-limits-card" key="safety-limits-panel">
        <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2 mb-2">
          <Sliders size={18} className="text-[var(--kink-purple)]" /> Safety Limits
        </h2>
        <p className="text-[var(--kink-text-2)] text-sm mb-5">Enforced server-side for every guest. No one can exceed these.</p>
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">MINIMUM DEPTH</label>
              <span className="font-mono-data text-lg font-bold text-[var(--kink-purple)]" data-testid="limit-min-depth-value">{limits.min_depth}</span>
            </div>
            <input
              type="range" min={0} max={100} step={1} value={limits.min_depth}
              onChange={(e) => setLimits((l) => ({ ...l, min_depth: Number(e.target.value) }))}
              data-testid="limit-min-depth"
              className="w-full accent-[var(--kink-purple)]"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">MAXIMUM DEPTH</label>
              <span className="font-mono-data text-lg font-bold text-[var(--kink-purple)]" data-testid="limit-max-depth-value">
                {limits.manual_max_depth != null ? limits.manual_max_depth : 100}
              </span>
            </div>
            <input
              type="range" min={0} max={100} step={1}
              value={limits.manual_max_depth != null ? limits.manual_max_depth : 100}
              onChange={(e) => setLimits((l) => ({ ...l, manual_max_depth: Number(e.target.value) }))}
              data-testid="limit-max-depth"
              className="w-full accent-[var(--kink-purple)]"
            />
            <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mt-1.5">
              Hard cap on depth for you and every guest. Set to 100 for no cap.
            </p>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">MAXIMUM SPEED</label>
              <span className="font-mono-data text-lg font-bold text-[var(--kink-danger)]" data-testid="limit-max-speed-value">{limits.max_speed}</span>
            </div>
            <input
              type="range" min={0} max={100} step={1} value={limits.max_speed}
              onChange={(e) => setLimits((l) => ({ ...l, max_speed: Number(e.target.value) }))}
              data-testid="limit-max-speed"
              className="w-full accent-[var(--kink-danger)]"
            />
          </div>
          <div className="pt-1 border-t border-[var(--kink-overlay)]">
            <div className="flex items-center justify-between mb-2 mt-4">
              <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">TOY LENGTH</label>
              <span className="font-mono-data text-lg font-bold text-[var(--kink-purple)]" data-testid="limit-toy-max-depth-value">
                {limits.toy_length_mm > 0 ? `caps depth at ${limits.max_depth}%` : "OFF"}
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1">
                <span className="font-mono-data text-[10px] text-[var(--kink-muted)] uppercase tracking-wide">
                  Toy length (mm)
                </span>
                <input
                  type="number"
                  min={0}
                  max={2000}
                  value={limits.toy_length_mm}
                  onChange={(e) => setLimits((l) => ({ ...l, toy_length_mm: Math.max(0, Number(e.target.value) || 0) }))}
                  className="bg-transparent border border-[var(--kink-overlay)] px-2 py-1.5 w-24 font-mono-data text-sm focus:outline-none focus:border-[var(--kink-purple)]/40"
                  data-testid="limit-toy-length-mm"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono-data text-[10px] text-[var(--kink-muted)] uppercase tracking-wide">
                  Rail full travel (mm)
                </span>
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={limits.rail_travel_mm}
                  onChange={(e) => setLimits((l) => ({ ...l, rail_travel_mm: Math.max(1, Number(e.target.value) || 1) }))}
                  className="bg-transparent border border-[var(--kink-overlay)] px-2 py-1.5 w-24 font-mono-data text-sm focus:outline-none focus:border-[var(--kink-purple)]/40"
                  data-testid="limit-rail-travel-mm"
                />
              </label>
            </div>
            <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mt-1.5">
              Every depth control — for you and every guest — is capped at this toy's insertable length. Set toy length to 0 to turn the cap off.
              {limits.manual_max_depth != null && " Currently overridden by the manual calibration below."}
            </p>
          </div>
          <CalibrationPanel
            connected={ble.connected}
            onCommand={ble.writeCommand}
            minDepth={limits.min_depth}
            manualMaxDepth={limits.manual_max_depth}
            onSetMin={(v) => setLimits((l) => ({ ...l, min_depth: v }))}
            onSetMax={(v) => setLimits((l) => ({ ...l, manual_max_depth: v }))}
          />
          <div className="pt-1 border-t border-[var(--kink-overlay)]">
            <div className="flex items-center justify-between mb-2 mt-4">
              <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)] flex items-center gap-1.5">
                <Heart size={13} className="text-[var(--kink-hr)]" /> HR SAFETY CUTOFF
              </label>
              <span className="font-mono-data text-lg font-bold text-[var(--kink-hr)]" data-testid="limit-hr-cutoff-value">
                {limits.hr_cutoff > 0 ? `${limits.hr_cutoff} BPM` : "OFF"}
              </span>
            </div>
            <input
              type="range" min={0} max={220} step={1} value={limits.hr_cutoff}
              onChange={(e) => setLimits((l) => ({ ...l, hr_cutoff: Number(e.target.value) }))}
              data-testid="limit-hr-cutoff"
              className="w-full accent-[var(--kink-hr)]"
            />
            <p className="font-mono-data text-[11px] text-[var(--kink-muted)] mt-1.5">
              Above this BPM the device force-stops and motion is blocked until it recovers. 0 = off.
            </p>
          </div>
          <button
            onClick={saveLimits}
            disabled={savingLimits}
            data-testid="save-limits-button"
            className="w-full bg-[var(--kink-purple)] text-[var(--kink-base)] font-display font-bold tracking-[0.1em] py-3 active:scale-95 transition-transform disabled:opacity-50"
          >
            {savingLimits ? "SAVING…" : "SAVE LIMITS"}
          </button>
        </div>
      </div>
    ),
    "heart-rate-sync": <HeartRateSync key="heart-rate-sync-panel" hr={hr} ble={ble} maxCap={limits.max_speed} cutoff={limits.hr_cutoff} />,
    "new-access-code": (
      <div className="hud-panel p-5 sm:p-6" key="new-access-code-panel">
        <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2 mb-5">
          <Ticket size={18} className="text-[var(--kink-purple)]" /> New Access Code
        </h2>
        <ShareSpectatorLink publicUrl={urls.public_url} onCodeCreated={loadCodes} />
        <form onSubmit={createCode} className="space-y-4" data-testid="create-code-form">
          <div>
            <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">GUEST LABEL (OPTIONAL)</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Alex" data-testid="code-label-input"
              className="w-full mt-2 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-2.5 outline-none focus:border-[var(--kink-purple)] transition-colors" />
          </div>
          <div>
            <label className="font-display text-xs tracking-[0.15em] text-[var(--kink-text-2)]">MINUTES OF CONTROL</label>
            <input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} data-testid="code-minutes-input"
              disabled={viewOnly}
              className="w-full mt-2 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-2.5 font-mono-data outline-none focus:border-[var(--kink-purple)] transition-colors disabled:opacity-40" />
          </div>
          <label
            className="flex items-center gap-3 text-sm text-[var(--kink-text-2)] cursor-pointer select-none"
            data-testid="code-view-only-row"
          >
            <input
              type="checkbox"
              checked={viewOnly}
              onChange={(e) => setViewOnly(e.target.checked)}
              data-testid="code-view-only-input"
              className="accent-[var(--kink-purple)] w-4 h-4"
            />
            <span>
              <span className="font-display text-xs tracking-[0.12em] block">VIEW-ONLY LINK</span>
              <span className="font-mono-data text-[10px] text-[var(--kink-muted)]">Stream + chat only. No control, no queue, no timer.</span>
            </span>
          </label>
          <button type="submit" data-testid="create-code-button" className="w-full flex items-center justify-center gap-2 bg-[var(--kink-purple)] text-[var(--kink-base)] font-display font-bold tracking-[0.1em] py-3 active:scale-95 transition-transform">
            <Plus size={16} /> GENERATE CODE
          </button>
        </form>
      </div>
    ),
    "issued-codes": (
      <div className="hud-panel p-5 sm:p-6" key="issued-codes-panel">
        <h3 className="font-display text-xs tracking-[0.2em] text-[var(--kink-text-2)] mb-4">ISSUED CODES ({codes.length})</h3>
        <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1" data-testid="codes-list">
          {codes.length === 0 && <p className="font-mono-data text-sm text-[var(--kink-muted)] py-4 text-center">No codes yet.</p>}
          {codes.map((c) => (
            <div key={c.id} data-testid={`code-${c.code}`} className={`border p-3 ${c.revoked ? "border-[var(--kink-overlay)] opacity-50" : "border-[var(--kink-overlay)]"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono-data font-bold text-xl tracking-[0.15em] text-[var(--kink-purple)]">{c.code}</span>
                <div className="flex items-center gap-1.5">
                  {c.view_only && <span data-testid={`view-only-badge-${c.code}`} className="font-mono-data text-[10px] text-[var(--kink-purple)] border border-[var(--kink-purple)]/40 px-2 py-0.5">VIEW ONLY</span>}
                  {c.revoked && <span className="font-mono-data text-[10px] text-[var(--kink-danger)] border border-[var(--kink-danger)]/40 px-2 py-0.5">REVOKED</span>}
                </div>
              </div>
              {c.label && <p className="text-sm text-[var(--kink-text-2)] mt-1">{c.label}</p>}
              {c.view_only ? (
                <div className="flex items-center gap-2 mt-2 font-mono-data text-xs text-[var(--kink-muted)]">
                  <Clock size={12} /> Spectator link — no timer
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 font-mono-data text-xs text-[var(--kink-muted)]">
                  <Clock size={12} /> {fmtTime(c.remaining_seconds)} left / {Math.round(c.granted_seconds / 60)}m granted
                </div>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                <IconBtn testid={`copy-${c.code}`} onClick={() => copyLink(c.code)} icon={Copy} text="LINK" />
                {!c.view_only && <IconBtn testid={`addmin-${c.code}`} onClick={() => addMin(c.id)} icon={Plus} text="10M" />}
                {!c.revoked && <IconBtn testid={`revoke-${c.code}`} onClick={() => revoke(c.id)} icon={Ban} text="REVOKE" danger />}
                <IconBtn testid={`delete-${c.code}`} onClick={() => del(c.id)} icon={Trash2} text="" danger />
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
  };

  return (
    <div className="relative z-10 min-h-screen max-w-[1800px] mx-auto px-5 sm:px-8 2xl:px-12 py-6">
      <header className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2.5">
          <img src={kinkologyMark} alt="Kinkology" style={{ height: 22, width: 22 }} className="rounded-sm" />
          <span className="font-display font-black tracking-[0.2em] text-lg">KINKOLOGY</span>
          <span className="font-mono-data text-xs text-[var(--kink-muted)] ml-2 hidden sm:inline">CONTROL DECK</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono-data text-xs text-[var(--kink-text-2)] hidden sm:inline">{user?.email}</span>
          <button onClick={() => setCustomizerOpen(true)} data-testid="open-panel-customizer" className="flex items-center gap-1.5 font-mono-data text-xs text-[var(--kink-text-2)] hover:text-[var(--kink-purple)] transition-colors">
            <Settings2 size={14} /> CUSTOMIZE
          </button>
          <button onClick={doLogout} data-testid="logout-button" className="flex items-center gap-1.5 font-mono-data text-xs text-[var(--kink-text-2)] hover:text-[var(--kink-danger)] transition-colors">
            <LogOut size={14} /> LOGOUT
          </button>
        </div>
      </header>

      {layout.order.zones[TOP_ZONE].filter((id) => !layout.hidden.includes(id)).map((id) => (
        <div className="mb-6" key={`top-${id}`}>
          <CollapsiblePanel id={id} title={PANEL_DEFS[id]?.label || id} collapsed={!!panelCollapsed[id]} onToggle={togglePanelCollapse}>
            {panelNodes[id]}
          </CollapsiblePanel>
        </div>
      ))}

      <div className={`grid gap-6 items-start ${GRID_COLS_CLASS[layout.columnCount] || GRID_COLS_CLASS[DEFAULT_GRID_COLUMNS]}`}>
        {layout.order.zones.slice(1)
          .flat()
          .filter((id) => !layout.hidden.includes(id))
          .map((id) => {
            // A wide panel spans 2 columns, but never more than the grid has.
            const span = (panelWidths[id] === 2 && layout.columnCount >= 2) ? 2 : 1;
            return (
              <div key={id} className={COL_SPAN_CLASS[span] || ""}>
                <CollapsiblePanel
                  id={id}
                  title={PANEL_DEFS[id]?.label || id}
                  collapsed={!!panelCollapsed[id]}
                  onToggle={togglePanelCollapse}
                >
                  {panelNodes[id]}
                </CollapsiblePanel>
              </div>
            );
          })}
      </div>

      <PanelCustomizer
        open={customizerOpen}
        onClose={() => setCustomizerOpen(false)}
        layout={layout}
        setColumnCount={setColumnCount}
        setZoneOrder={setZoneOrder}
        moveToZone={moveToZone}
        toggleHidden={toggleHidden}
        resetLayout={resetLayout}
        widths={panelWidths}
        onToggleWidth={cyclePanelWidth}
      />
    </div>
  );
}

function Stat({ label, value, mono }) {
  return (
    <div className="bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-4">
      <p className="font-display text-[10px] tracking-[0.15em] text-[var(--kink-muted)]">{label}</p>
      <p className={`mt-1.5 truncate ${mono ? "font-mono-data" : "font-display"} font-bold text-lg text-white`}>{value}</p>
    </div>
  );
}

function IconBtn({ onClick, icon: Icon, text, danger, testid }) {
  return (
    <button onClick={onClick} data-testid={testid} className={`flex items-center gap-1.5 border px-2.5 py-1.5 font-mono-data text-[11px] transition-colors ${
      danger ? "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-danger)] hover:text-[var(--kink-danger)]"
             : "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)]"
    }`}>
      <Icon size={13} /> {text}
    </button>
  );
}
