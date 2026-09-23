import React, { useEffect, useState } from "react";
import { Reorder } from "framer-motion";
import { GripVertical, EyeOff, Eye, Columns2, Settings2, X } from "lucide-react";

// ------------------------------------------------------------------
// Shared panel-layout engine used by BOTH the admin dashboard and the
// guest control page. Call createPanelLayout(config) once per page to get
// hooks + components bound to that page's own storage keys, panel set, and
// default arrangement. Each page persists its own layout independently.
//
// config:
//   storagePrefix : string  -- localStorage key namespace (e.g. "kinkology_admin")
//   panelDefs     : { [id]: { label } }
//   defaultOrder  : { zones: string[][] }   zone 0 = full-width top row
//   defaultColumns: number (1..5)
// ------------------------------------------------------------------

const MIN_GRID_COLUMNS = 1;
const MAX_GRID_COLUMNS = 5;
const TOP_ZONE = 0;

// Static (not template-built) so Tailwind's class scanner can see them.
const GRID_COLS_CLASS = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
};
const COL_SPAN_CLASS = { 1: "", 2: "lg:col-span-2", 3: "lg:col-span-3" };

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

export function createPanelLayout({ storagePrefix, panelDefs, defaultOrder, defaultColumns = 3, defaultWidths = {} }) {
  const LAYOUT_KEY = `${storagePrefix}_panel_layout_v1`;
  const COLLAPSE_KEY = `${storagePrefix}_panel_collapsed_v1`;
  const WIDTH_KEY = `${storagePrefix}_panel_width_v1`;
  const ALL_PANEL_IDS = Object.keys(panelDefs);
  const DEFAULT_GRID_COLUMNS = clamp(defaultColumns, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);

  // Fold overflow zones into the last, dedupe ids, append any missing panel.
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
    return { columnCount, order: { zones: sanitizeZones(defaultOrder.zones, columnCount) }, hidden: [] };
  }

  function loadPanelLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const columnCount = clamp(Number(parsed?.columnCount) || DEFAULT_GRID_COLUMNS, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);
      const order = { zones: sanitizeZones(parsed?.order?.zones, columnCount) };
      const hidden = Array.isArray(parsed?.hidden) ? parsed.hidden.filter((id) => panelDefs[id]) : [];
      return { columnCount, order, hidden };
    } catch (_) {
      return defaultLayout();
    }
  }

  function usePanelLayout() {
    const [layout, setLayout] = useState(loadPanelLayout);
    useEffect(() => {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) {}
    }, [layout]);
    const setColumnCount = (n) => {
      const columnCount = clamp(n, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);
      setLayout((l) => ({ ...l, columnCount, order: { zones: sanitizeZones(l.order.zones, columnCount) } }));
    };
    const setZoneOrder = (zoneIndex, ids) => {
      setLayout((l) => ({ ...l, order: { zones: l.order.zones.map((z, i) => (i === zoneIndex ? ids : z)) } }));
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
    const toggleHidden = (id) => setLayout((l) => ({
      ...l,
      hidden: l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id],
    }));
    const resetLayout = () => setLayout(defaultLayout());
    return { layout, setColumnCount, setZoneOrder, moveToZone, toggleHidden, resetLayout };
  }

  function usePanelCollapse() {
    const [collapsed, setCollapsed] = useState(() => {
      try {
        const raw = localStorage.getItem(COLLAPSE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (_) { return {}; }
    });
    useEffect(() => {
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (_) {}
    }, [collapsed]);
    const toggle = (id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
    return { collapsed, toggle };
  }

  function usePanelWidth() {
    const [widths, setWidths] = useState(() => {
      try {
        const raw = localStorage.getItem(WIDTH_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        // First visit (nothing saved): seed the page's default widths.
        if (parsed && typeof parsed === "object") return parsed;
        return { ...defaultWidths };
      } catch (_) { return { ...defaultWidths }; }
    });
    useEffect(() => {
      try { localStorage.setItem(WIDTH_KEY, JSON.stringify(widths)); } catch (_) {}
    }, [widths]);
    const cycle = (id) => setWidths((w) => {
      const cur = w[id] || 1;
      const next = cur >= 3 ? 1 : cur + 1;  // 1 -> 2 -> 3 -> 1
      return { ...w, [id]: next };
    });
    return { widths, cycle };
  }

  // Click title to shrink/expand. Collapsed: clean title bar. Expanded: a
  // transparent strip over the left of the header collapses on click.
  function CollapsiblePanel({ id, title, collapsed, onToggle, children }) {
    if (collapsed) {
      return (
        <div
          role="button" tabIndex={0}
          onClick={() => onToggle(id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(id); } }}
          data-testid={`panel-collapse-${id}`}
          title="Click to expand"
          className="hud-panel px-5 sm:px-6 py-4 flex items-center cursor-pointer select-none hover:text-[var(--kink-purple)] transition-colors"
        >
          <span className="font-display font-black uppercase tracking-[0.08em] text-sm text-[var(--kink-text-2)]">{title}</span>
        </div>
      );
    }
    return (
      <div className="relative" data-testid={`panel-collapse-${id}`}>
        <div
          role="button" tabIndex={0}
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
            const def = panelDefs[id];
            if (!def) return null;
            const isHidden = hidden.includes(id);
            return (
              <Reorder.Item
                key={id} value={id}
                data-testid={`panel-row-${id}`}
                className={`flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 cursor-grab active:cursor-grabbing select-none bg-[var(--kink-base)] ${isHidden ? "opacity-50" : ""}`}
              >
                <GripVertical size={14} className="text-[var(--kink-muted)] shrink-0" />
                <span className="flex-1 font-mono-data text-sm truncate">{def.label}</span>
                {movable && (
                  <>
                    <button type="button" onClick={() => onMove(id, zoneIndex, zoneIndex - 1)} disabled={zoneIndex === 0}
                      data-testid={`panel-move-left-${id}`} title="Move to previous column"
                      className="shrink-0 p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors disabled:opacity-20 disabled:hover:text-[var(--kink-muted)]">←</button>
                    <button type="button" onClick={() => onMove(id, zoneIndex, zoneIndex + 1)} disabled={zoneIndex === zoneCount - 1}
                      data-testid={`panel-move-right-${id}`} title="Move to next column"
                      className="shrink-0 p-1 text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors disabled:opacity-20 disabled:hover:text-[var(--kink-muted)]">→</button>
                  </>
                )}
                <button type="button" onClick={() => onToggle(id)}
                  data-testid={`panel-toggle-${id}`} title={isHidden ? "Show panel" : "Hide panel"}
                  className={`shrink-0 p-1 transition-colors ${isHidden ? "text-[var(--kink-muted)] hover:text-[var(--kink-purple)]" : "text-[var(--kink-purple)] hover:text-[var(--kink-muted)]"}`}>
                  {isHidden ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                {typeof onToggleWidth === "function" && (
                  <button type="button" onClick={() => onToggleWidth(id)}
                    data-testid={`panel-width-${id}`}
                    title={`Width: ${widths?.[id] || 1} column(s) — click to cycle (1 → 2 → 3)`}
                    className={`shrink-0 p-1 flex items-center gap-0.5 transition-colors ${(widths?.[id] || 1) > 1 ? "text-[var(--kink-purple)]" : "text-[var(--kink-muted)] hover:text-[var(--kink-purple)]"}`}>
                    <Columns2 size={15} />
                    <span className="font-mono-data text-[10px] leading-none">{widths?.[id] || 1}</span>
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
    const zoneCount = layout.order.zones.length;
    return (
      <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/70 p-4 overflow-y-auto"
        onClick={onClose} data-testid="panel-customizer-backdrop">
        <div className="hud-panel w-full max-w-3xl p-5 sm:p-6 my-8" onClick={(e) => e.stopPropagation()} data-testid="panel-customizer">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2">
              <Settings2 size={18} className="text-[var(--kink-purple)]" /> Customize Panels
            </h2>
            <button onClick={onClose} data-testid="panel-customizer-close" className="text-[var(--kink-muted)] hover:text-white transition-colors">
              <X size={18} />
            </button>
          </div>
          <p className="text-[var(--kink-text-2)] text-sm mb-4">
            Drag to reorder within a column, use ← / → to move a panel to another column, the eye to hide one, and the columns icon to make a panel double-width. Only visible to you — this browser remembers your layout.
          </p>
          <div className="mb-5">
            <h3 className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)] mb-2">GRID COLUMNS</h3>
            <div className="flex gap-2" data-testid="column-count-picker">
              {columnNums.map((n) => (
                <button key={n} type="button" onClick={() => setColumnCount(n)} data-testid={`column-count-${n}`}
                  className={`h-9 w-9 font-mono-data text-sm border transition-colors ${
                    layout.columnCount === n
                      ? "border-[var(--kink-purple)] bg-[var(--kink-purple)] text-[var(--kink-base)] font-bold"
                      : "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)]"
                  }`}>{n}</button>
              ))}
            </div>
          </div>
          <ColumnEditor title="TOP (FULL-WIDTH)" ids={layout.order.zones[TOP_ZONE]} hidden={layout.hidden}
            onReorder={(ids) => setZoneOrder(TOP_ZONE, ids)} onToggle={toggleHidden}
            zoneIndex={TOP_ZONE} zoneCount={zoneCount} onMove={moveToZone} />
          <div className={`grid gap-x-6 sm:grid-cols-2 ${layout.columnCount >= 3 ? "lg:grid-cols-3" : ""}`}>
            {layout.order.zones.slice(1).map((ids, gridIdx) => {
              const zoneIndex = gridIdx + 1;
              return (
                <ColumnEditor key={`grid-col-${gridIdx}`} title={`COLUMN ${gridIdx + 1}`} ids={ids} hidden={layout.hidden}
                  onReorder={(newIds) => setZoneOrder(zoneIndex, newIds)} onToggle={toggleHidden}
                  zoneIndex={zoneIndex} zoneCount={zoneCount} onMove={moveToZone}
                  widths={widths} onToggleWidth={layout.columnCount >= 2 ? onToggleWidth : undefined} />
              );
            })}
          </div>
          <button onClick={resetLayout} data-testid="panel-customizer-reset"
            className="font-mono-data text-[11px] text-[var(--kink-muted)] hover:text-[var(--kink-purple)] transition-colors underline underline-offset-2">
            Reset to default layout
          </button>
        </div>
      </div>
    );
  }

  // Renders the panels for a page given a nodes map { [id]: ReactNode }.
  function PanelGrid({ layout, panelNodes, collapsed, onToggleCollapse, widths, topExtra }) {
    return (
      <>
        {layout.order.zones[TOP_ZONE].filter((id) => !layout.hidden.includes(id)).map((id) => (
          <div className="mb-6" key={`top-${id}`}>
            <CollapsiblePanel id={id} title={panelDefs[id]?.label || id} collapsed={!!collapsed[id]} onToggle={onToggleCollapse}>
              {panelNodes[id]}
            </CollapsiblePanel>
          </div>
        ))}
        <div className={`grid gap-6 items-start ${GRID_COLS_CLASS[layout.columnCount] || GRID_COLS_CLASS[DEFAULT_GRID_COLUMNS]}`}>
          {layout.order.zones.slice(1).flat().filter((id) => !layout.hidden.includes(id)).map((id) => {
            // A panel may span up to 3 columns, but never more than the grid has.
            const want = widths?.[id] || 1;
            const span = Math.min(want, layout.columnCount, 3);
            return (
              <div key={id} className={COL_SPAN_CLASS[span] || ""}>
                <CollapsiblePanel id={id} title={panelDefs[id]?.label || id} collapsed={!!collapsed[id]} onToggle={onToggleCollapse}>
                  {panelNodes[id]}
                </CollapsiblePanel>
              </div>
            );
          })}
        </div>
        {topExtra}
      </>
    );
  }

  return { usePanelLayout, usePanelCollapse, usePanelWidth, CollapsiblePanel, ColumnEditor, PanelCustomizer, PanelGrid };
}
