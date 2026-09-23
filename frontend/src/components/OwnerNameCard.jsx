import React, { useEffect, useState } from "react";
import { UserCog, Loader2, Pencil, X, Check } from "lucide-react";
import { api, formatApiErrorDetail } from "@/lib/api";
import { toast } from "sonner";

/**
 * Lets the owner change the display name they appear under in chat,
 * reactions, and the "is typing…" indicator. Persisted server-side
 * (db.settings.owner_name) so it survives a backend restart, and applied
 * immediately to the live Hub (backend/server.py: Hub.owner_name) so new
 * messages/reactions use it right away — existing chat history keeps
 * whatever name was in effect when it was sent, same as renaming a guest.
 */
export function OwnerNameCard({ onChanged }) {
  const [name, setName] = useState("Owner");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const load = async () => {
    try {
      const { data } = await api.get("/stream/owner-name");
      const fetched = data?.name || "Owner";
      setName(fetched);
      onChanged?.(fetched);
    } catch (_) {
      // keep default
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (trimmed.length < 2) return;
    setSaving(true);
    try {
      const { data } = await api.put("/stream/owner-name", { name: trimmed });
      setName(data.name);
      setEditing(false);
      toast.success(`Now chatting as "${data.name}"`);
      onChanged?.(data.name);
    } catch (err) {
      toast.error(formatApiErrorDetail(err?.response?.data?.detail));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hud-panel p-5 sm:p-6" data-testid="owner-name-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-black uppercase tracking-[0.08em] text-lg flex items-center gap-2">
          <UserCog size={18} className="text-[var(--kink-purple)]" /> Chat Name
        </h2>
      </div>

      <p className="text-[var(--kink-text-2)] text-sm mb-4">
        The name you appear under in session chat, reactions, and typing indicators.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="animate-spin text-[var(--kink-purple)]" size={20} />
        </div>
      ) : editing ? (
        <form onSubmit={save} className="space-y-3" data-testid="owner-name-form">
          <div>
            <label htmlFor="owner-name-input" className="font-display text-[10px] tracking-[0.2em] text-[var(--kink-muted)] block mb-1">
              DISPLAY NAME
            </label>
            <input
              id="owner-name-input"
              data-testid="owner-name-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Owner"
              autoComplete="off"
              maxLength={24}
              autoFocus
              className="w-full bg-transparent border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-sm focus:outline-none focus:border-[var(--kink-purple)]/50"
              required
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="submit"
              disabled={saving || draft.trim().length < 2}
              data-testid="owner-name-save"
              className="flex-1 bg-[var(--kink-purple)] text-[var(--kink-base)] font-display font-bold tracking-[0.1em] py-2.5 active:scale-95 transition-transform disabled:opacity-40 inline-flex items-center justify-center gap-2"
            >
              {saving ? <><Loader2 className="animate-spin" size={14} /> SAVING…</> : <><Check size={14} /> SAVE</>}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="owner-name-cancel"
              className="inline-flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-[11px] hover:border-[var(--kink-text-2)] hover:text-[var(--kink-text-2)] transition-colors disabled:opacity-40"
            >
              <X size={13} /> CANCEL
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <code className="block flex-1 bg-[var(--kink-base)] border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-sm text-[var(--kink-text-2)]" data-testid="owner-name-value">
            {name}
          </code>
          <button
            onClick={() => { setEditing(true); setDraft(name); }}
            data-testid="owner-name-edit"
            className="inline-flex items-center gap-1.5 border border-[var(--kink-overlay)] px-3 py-2 font-mono-data text-[11px] hover:border-[var(--kink-purple)] hover:text-[var(--kink-purple)] transition-colors"
          >
            <Pencil size={13} /> CHANGE
          </button>
        </div>
      )}
    </div>
  );
}
