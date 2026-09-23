import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { WS_BASE } from "@/lib/api";
import { ChatPanel } from "@/components/ChatPanel";
import kinkologyMark from "@/assets/kinkology-mark.png";

/**
 * Public, read-only chat feed — same idea as Overlay.jsx (telemetry) but for
 * chat, meant to be dropped into OBS as a browser source or opened on a
 * second screen. No login, no code: it only ever receives messages over
 * /api/ws/chat-overlay, it can't post any.
 */
export default function ChatOverlay() {
  const [params] = useSearchParams();
  const transparent = params.has("transparent");

  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws;
    let retry;
    const connect = () => {
      ws = new WebSocket(`${WS_BASE}/api/ws/chat-overlay`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); retry = setTimeout(connect, 1500); };
      ws.onerror = () => {};
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "chat_history") {
            setMessages(msg.messages || []);
          } else if (msg.type === "chat_msg") {
            setMessages((prev) => [...prev, msg.message].slice(-50));
          } else if (msg.type === "chat_react") {
            setMessages((prev) => prev.map((m) => (m.id === msg.msg_id ? { ...m, reactions: msg.reactions } : m)));
          } else if (msg.type === "chat_cleared") {
            setMessages([]);
          }
        } catch (e) {}
      };
    };
    connect();
    return () => { if (retry) clearTimeout(retry); if (ws) ws.close(); };
  }, []);

  return (
    <div
      data-testid="chat-overlay-root"
      className="min-h-screen w-full p-6 sm:p-8 font-sans"
      style={{ background: transparent ? "transparent" : "var(--kink-base)" }}
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <img src={kinkologyMark} alt="Kinkology" style={{ height: 22, width: 22 }} className="rounded-sm" />
          <span className="font-display font-black tracking-[0.25em] text-lg">KINKOLOGY CHAT</span>
        </div>
        <span className="flex items-center gap-2 font-mono-data text-xs" data-testid="chat-overlay-status">
          <span className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-[var(--kink-purple)] pulse-dot" : "bg-[var(--kink-danger)]"}`} />
          {connected ? "LIVE" : "OFFLINE"}
        </span>
      </div>

      <div
        className="hud-panel p-5 sm:p-6"
        style={transparent ? { background: "rgba(22,22,24,0.72)", backdropFilter: "blur(10px)" } : {}}
      >
        <ChatPanel
          messages={messages}
          title="LIVE CHAT"
          readOnly
        />
      </div>
    </div>
  );
}
