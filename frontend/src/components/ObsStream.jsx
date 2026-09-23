import React, { useEffect, useRef, useState } from "react";
import { api, API } from "@/lib/api";
import { Video, VideoOff, Volume2, VolumeX, Maximize2, Loader2, Copy, RefreshCw, ShieldCheck, ShieldOff, Eye, EyeOff, RadioTower, Camera, Monitor, Square, ChevronDown, ChevronUp, Activity } from "lucide-react";
import { toast } from "sonner";

/**
 * WHEP-based OBS stream viewer.
 *
 * Polls /api/stream/status until a publisher is live, then opens a WebRTC
 * subscription against POST /api/whep. Automatically retries on network drops
 * and cleans up its RTCPeerConnection + Location resource on unmount.
 */
export function ObsStream({ compact = false, canPublish = false }) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const locationRef = useRef(null);
  // Auto-reconnect state for the WHEP viewer. Attempts reset when we reach
  // "connected"; each failure schedules a backoff retry (up to 15s) with a
  // freshly-fetched ICE server list so the viewer survives TURN allocation
  // expiry (600s) and transient network hiccups.
  const reconnectRef = useRef({ attempt: 0, timer: null, unmounted: false });
  const [status, setStatus] = useState({ publisher_connected: false, viewer_count: 0, tracks: [] });
  const [state, setState] = useState("idle"); // idle | connecting | live | error | waiting
  const [iceState, setIceState] = useState("");
  const [needsTap, setNeedsTap] = useState(false); // iOS Safari autoplay-blocked
  const [muted, setMuted] = useState(true);
  const [showPublish, setShowPublish] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState(null);   // live WebRTC diagnostics
  const [showStats, setShowStats] = useState(false);
  const statsTimerRef = useRef(null);
  const statsPrevRef = useRef(null);          // last sample, for computing deltas
  // External WHEP endpoint (e.g. MediaMTX). When set, the viewer connects to it
  // directly instead of gating on the built-in /api/stream/status presence.
  const [whepConfigUrl, setWhepConfigUrl] = useState("");

  // Fetch the stream config once on mount to learn the external WHEP URL (if any).
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/stream/ice-servers`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled && j && typeof j.whepUrl === "string") setWhepConfigUrl(j.whepUrl.trim()); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Poll publisher presence (built-in server only — external WHEP is probed
  // directly by the connect loop instead).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/stream/status`);
        const s = await r.json();
        if (cancelled) return;
        setStatus(s);
      } catch (_) { /* status polls fail silently */ }
    };
    tick();
    const iv = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const teardown = async () => {
    if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
    statsPrevRef.current = null;
    setStats(null);
    try {
      if (locationRef.current) {
        await fetch(locationRef.current, { method: "DELETE" }).catch(() => {});
        locationRef.current = null;
      }
    } catch (_) { /* teardown errors are safe to ignore */ }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch (_) { /* pc already closed */ }
      pcRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const scheduleReconnect = (reason) => {
    const r = reconnectRef.current;
    if (r.unmounted) return;
    // Don't stack timers; the state change may fire twice (ICE + PC).
    if (r.timer) return;
    r.attempt = Math.min(r.attempt + 1, 6);
    const delay = Math.min(15000, 800 * 2 ** (r.attempt - 1));
    setState("waiting");
    setError(`Stream link dropped (${reason}) — retrying in ${Math.round(delay / 1000)}s…`);
    r.timer = setTimeout(async () => {
      r.timer = null;
      if (r.unmounted) return;
      // Built-in relay: only reconnect if a publisher is still live upstream.
      // External WHEP (MediaMTX): the built-in status can't see it, so just
      // retry the connection — MediaMTX reports its own availability.
      if (!whepConfigUrl) {
        try {
          const s = await fetch(`${API}/stream/status`).then((x) => x.json());
          if (!s.publisher_connected) {
            setState("idle");
            setError("");
            return;
          }
        } catch (_) { /* status check errors — retry regardless */ }
      }
      await connect();
    }, delay);
  };

  const connect = async () => {
    await teardown();
    setError("");
    setNeedsTap(false);
    setIceState("");
    setState("connecting");
    // Ask the backend for a fresh ICE server config (public STUN + Cloudflare
    // TURN if the owner has enabled it). Falls back to a static STUN pair so
    // the connect flow keeps working even if the endpoint is unreachable.
    let iceServers = [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
    ];
    let whepUrl = "";  // external WHEP endpoint (e.g. MediaMTX); blank = built-in /api/whep
    try {
      const r = await fetch(`${API}/stream/ice-servers`);
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.iceServers) && j.iceServers.length) {
          iceServers = j.iceServers;
        }
        if (typeof j.whepUrl === "string" && j.whepUrl.trim()) {
          whepUrl = j.whepUrl.trim();
        }
      }
    } catch (_) { /* keep static fallback */ }
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
    });
    pcRef.current = pc;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    const stream = new MediaStream();
    pc.ontrack = (ev) => {
      stream.addTrack(ev.track);
      const el = videoRef.current;
      if (el && el.srcObject !== stream) {
        el.srcObject = stream;
        // iOS Safari refuses to autoplay a media element that receives its
        // srcObject after mount unless we explicitly kick .play() AND it's
        // muted. Enforce both on the DOM node.
        el.muted = true;
        el.setAttribute("playsinline", "");
        el.playsInline = true;
        const p = el.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            // Autoplay blocked — most commonly iOS Safari. Show a Tap-to-Play
            // overlay so the next user gesture starts playback.
            setNeedsTap(true);
          });
        }
      }
    };
    pc.oniceconnectionstatechange = () => {
      setIceState(pc.iceConnectionState);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        setState("live");
        // Reset reconnect backoff on a healthy connection.
        reconnectRef.current.attempt = 0;
      } else if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        scheduleReconnect("ICE " + pc.iceConnectionState);
      }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        setState((s) => (s === "live" ? "waiting" : s));
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          scheduleReconnect("PC " + pc.connectionState);
        }
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Wait for ICE gathering to complete (max 2s) so the offer contains all
      // candidates. Some WHEP servers (aiortc-based) don't yet trickle
      // properly from a browser; sending a naked offer means the media path
      // can only work when both peers are already on the same NAT.
      await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        let done = false;
        const finish = () => { if (done) return; done = true; pc.removeEventListener("icegatheringstatechange", onChange); resolve(); };
        const onChange = () => { if (pc.iceGatheringState === "complete") finish(); };
        pc.addEventListener("icegatheringstatechange", onChange);
        setTimeout(finish, 2000);
      });
      // Use the configured external WHEP endpoint (e.g. MediaMTX) when set,
      // otherwise the built-in aiortc relay at /api/whep.
      const whepEndpoint = whepUrl || `${API}/whep`;
      const res = await fetch(whepEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      });
      if (!res.ok) {
        // 409 (built-in) or 404 (MediaMTX path idle) = no publisher yet.
        // Treat as "waiting" and retry rather than a hard error.
        if (res.status === 409 || res.status === 404) {
          setState("waiting");
          setError("No live stream yet. Start the publisher to begin.");
          await teardown();
          if (whepConfigUrl) scheduleReconnect("waiting for stream");
          return;
        }
        setState("error");
        setError(`WHEP handshake failed (${res.status})`);
        await teardown();
        return;
      }
      const answer = await res.text();
      const loc = res.headers.get("Location");
      if (loc) locationRef.current = loc.startsWith("http") ? loc : `${window.location.origin}${loc}`;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      // Fallback: if ICE hasn't connected within 12s, surface the failure so
      // the user sees a useful message instead of an infinite "buffering".
      setTimeout(() => {
        if (pcRef.current === pc && pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") {
          setState("waiting");
          setError((prev) => prev || `ICE timed out in state \"${pc.iceConnectionState}\". If you're on cellular, the host must open UDP 50000-50099.`);
        }
      }, 12000);
    } catch (e) {
      setState("error");
      setError(e.message || "Could not connect to stream.");
      await teardown();
    }
  };

  // Auto-connect when publisher goes live, and drop when it goes offline.
  useEffect(() => {
    // External WHEP (MediaMTX): the built-in /api/stream/status can't see that
    // publisher, so don't gate on it. Attempt the connection directly once; the
    // retry loop handles "not publishing yet" until the stream appears.
    if (whepConfigUrl) {
      if (state === "idle") connect();
      return;
    }
    // Built-in relay: gate on the backend's publisher presence as before.
    if (status.publisher_connected && state === "idle") {
      connect();
    }
    if (!status.publisher_connected && (state === "live" || state === "connecting")) {
      // Publisher gone — cancel any pending retry and go quiet.
      if (reconnectRef.current.timer) { clearTimeout(reconnectRef.current.timer); reconnectRef.current.timer = null; }
      reconnectRef.current.attempt = 0;
      teardown();
      setState("idle");
    }
  }, [status.publisher_connected, whepConfigUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live WebRTC diagnostics: poll getStats() once a second while the stream is
  // live and fold the raw report into a small readout (relay type, packet
  // loss, jitter, fps, bitrate). Deltas are computed against the previous
  // sample so packet-loss % and bitrate reflect the last second, not the
  // whole session.
  useEffect(() => {
    if (state !== "live") {
      if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
      return;
    }
    const sample = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      let report;
      try { report = await pc.getStats(); } catch { return; }

      let inbound = null;      // inbound-rtp (video)
      let pairId = null;       // selected candidate-pair id
      let selectedPair = null;
      const candidates = {};   // id -> candidate stat

      report.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
        if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
        if (s.type === "candidate-pair" && s.selected) selectedPair = s; // Firefox marks selected here
        if (s.type === "local-candidate" || s.type === "remote-candidate") candidates[s.id] = s;
      });
      if (pairId) {
        report.forEach((s) => { if (s.id === pairId) selectedPair = s; });
      }

      // Resolve the ICE path type from the local candidate of the active pair.
      let pathType = "unknown";
      if (selectedPair) {
        const local = candidates[selectedPair.localCandidateId];
        const remote = candidates[selectedPair.remoteCandidateId];
        const lt = local?.candidateType;
        const rt = remote?.candidateType;
        // relay on either end = media is going through TURN
        if (lt === "relay" || rt === "relay") pathType = "relay (TURN)";
        else if (lt === "srflx" || rt === "srflx" || lt === "prflx" || rt === "prflx") pathType = "srflx (STUN)";
        else if (lt === "host" && rt === "host") pathType = "host (direct/LAN)";
        else if (lt || rt) pathType = `${lt || "?"} / ${rt || "?"}`;
      }

      const prev = statsPrevRef.current;
      const now = (inbound && inbound.timestamp) || performance.now();
      let lossPct = null, kbps = null, fps = null, jitterMs = null;

      if (inbound) {
        fps = inbound.framesPerSecond != null ? Math.round(inbound.framesPerSecond) : null;
        jitterMs = inbound.jitter != null ? Math.round(inbound.jitter * 1000) : null;
        if (prev && prev.inbound) {
          const dt = (now - prev.now) / 1000;
          const dRecv = (inbound.packetsReceived || 0) - (prev.inbound.packetsReceived || 0);
          const dLost = (inbound.packetsLost || 0) - (prev.inbound.packetsLost || 0);
          const total = dRecv + dLost;
          lossPct = total > 0 ? Math.max(0, (dLost / total) * 100) : 0;
          const dBytes = (inbound.bytesReceived || 0) - (prev.inbound.bytesReceived || 0);
          if (dt > 0) kbps = Math.round((dBytes * 8) / dt / 1000);
        }
      }
      statsPrevRef.current = { inbound, now };
      setStats({
        pathType,
        lossPct: lossPct != null ? Number(lossPct.toFixed(1)) : null,
        kbps,
        fps,
        jitterMs,
        freezeCount: inbound?.freezeCount ?? null,
      });
    };
    sample();
    statsTimerRef.current = setInterval(sample, 1000);
    return () => { if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; } };
  }, [state]);

  useEffect(() => () => {
    reconnectRef.current.unmounted = true;
    if (reconnectRef.current.timer) { clearTimeout(reconnectRef.current.timer); reconnectRef.current.timer = null; }
    teardown();
  }, []);

  const toggleMute = () => {
    setMuted((m) => {
      const el = videoRef.current;
      if (el) el.muted = !m ? true : false;
      // ^ inversion: new muted state = !current-muted
      return !m;
    });
  };
  const fullscreen = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
  };

  const kickPlay = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = true; // stays muted so iOS accepts the gesture-driven play
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    setNeedsTap(false);
  };

  const label = (() => {
    if (needsTap) return "TAP TO PLAY";
    if (state === "live") return "LIVE";
    if (state === "connecting") return "CONNECTING…";
    if (iceState && ["checking", "new"].includes(iceState)) return "ICE " + iceState.toUpperCase();
    if (state === "error") return "ERROR";
    if (status.publisher_connected) return "STARTING…";
    return "OFFLINE";
  })();
  const live = state === "live" && !needsTap;

  return (
    <div className={`hud-panel overflow-hidden ${compact ? "" : ""}`} data-testid="obs-stream-card">
      <div className="flex items-center justify-between px-4 pt-4">
        <h3 className="font-display font-black uppercase tracking-[0.08em] text-sm flex items-center gap-2">
          <Video size={16} className="text-[var(--kink-purple)]" /> OBS Stream
        </h3>
        <span
          data-testid="obs-stream-status"
          className={`inline-flex items-center gap-1.5 font-mono-data text-[10px] tracking-[0.15em] px-2 py-1 border ${
            live
              ? "border-[var(--kink-purple)]/50 text-[var(--kink-purple)]"
              : "border-[var(--kink-overlay)] text-[var(--kink-muted)]"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-[var(--kink-purple)] pulse-dot" : "bg-[var(--kink-muted)]"}`} />
          {label}
        </span>
      </div>

      <div className="relative mt-3 aspect-video bg-black">
        <video
          ref={videoRef}
          data-testid="obs-stream-video"
          autoPlay
          playsInline
          webkit-playsinline="true"
          muted
          onClick={needsTap ? kickPlay : undefined}
          className="w-full h-full object-contain"
        />
        {needsTap && (
          <button
            onClick={kickPlay}
            data-testid="obs-stream-tap"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center bg-[rgba(0,0,0,0.7)] hover:bg-[rgba(0,0,0,0.55)] transition-colors"
          >
            <div className="h-14 w-14 rounded-full bg-[var(--kink-purple)] flex items-center justify-center">
              <Video size={26} className="text-[var(--kink-base)]" />
            </div>
            <span className="font-display text-xs tracking-[0.15em] text-white">TAP TO PLAY</span>
            <span className="font-mono-data text-[10px] text-[var(--kink-muted)]">iOS blocks WebRTC autoplay</span>
          </button>
        )}
        {!live && !needsTap && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6 bg-[rgba(0,0,0,0.6)]">
            {state === "connecting" || (status.publisher_connected && iceState && iceState !== "failed") ? (
              <Loader2 className="animate-spin text-[var(--kink-purple)]" size={26} />
            ) : (
              <VideoOff className="text-[var(--kink-muted)]" size={26} />
            )}
            <p className="font-mono-data text-xs text-[var(--kink-text-2)] max-w-xs">
              {state === "error" || (state === "waiting" && error)
                ? error
                : status.publisher_connected
                  ? (iceState ? `Negotiating (${iceState})…` : "Buffering the live feed…")
                  : "No OBS stream is being sent yet."}
            </p>
            {iceState && !live && (
              <span data-testid="obs-stream-ice-state" className="font-mono-data text-[10px] text-[var(--kink-muted)]">
                ICE: {iceState}
              </span>
            )}
            {(state === "error" || state === "waiting") && (
              <button
                onClick={connect}
                data-testid="obs-stream-retry"
                className="font-mono-data text-[11px] tracking-[0.15em] border border-[var(--kink-overlay)] px-3 py-1.5 hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)] transition-colors"
              >
                RETRY
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="font-mono-data text-[11px] text-[var(--kink-muted)] truncate">
          {live ? (
            <>tracks: <span className="text-[var(--kink-text-2)]">{status.tracks.join(", ") || "video"}</span> · viewers: <span className="text-[var(--kink-text-2)]">{status.viewer_count}</span></>
          ) : (
            "Waiting for a publisher…"
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowStats((s) => !s)}
            data-testid="obs-stream-toggle-stats"
            title="WebRTC diagnostics"
            className={`p-1.5 border transition-colors ${
              showStats
                ? "border-[var(--kink-purple)]/50 text-[var(--kink-purple)]"
                : "border-[var(--kink-overlay)] hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)]"
            }`}
          >
            <Activity size={14} />
          </button>
          <button
            onClick={toggleMute}
            data-testid="obs-stream-mute"
            title={muted ? "Unmute" : "Mute"}
            className="p-1.5 border border-[var(--kink-overlay)] hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)] transition-colors"
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <button
            onClick={fullscreen}
            data-testid="obs-stream-fullscreen"
            title="Fullscreen"
            className="p-1.5 border border-[var(--kink-overlay)] hover:border-[var(--kink-purple)]/50 hover:text-[var(--kink-purple)] transition-colors"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {/* WebRTC diagnostics readout */}
      {showStats && (
        <div className="border-t border-[var(--kink-overlay)] px-4 py-3" data-testid="obs-stream-stats">
          {!live || !stats ? (
            <p className="font-mono-data text-[11px] text-[var(--kink-muted)]">
              {live ? "Gathering stats…" : "Diagnostics appear once the stream is live."}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
              <Diag label="PATH" value={stats.pathType}
                    warn={stats.pathType?.startsWith("relay")} />
              <Diag label="PACKET LOSS" value={stats.lossPct != null ? `${stats.lossPct}%` : "—"}
                    warn={stats.lossPct != null && stats.lossPct >= 2}
                    bad={stats.lossPct != null && stats.lossPct >= 5} />
              <Diag label="JITTER" value={stats.jitterMs != null ? `${stats.jitterMs} ms` : "—"}
                    warn={stats.jitterMs != null && stats.jitterMs >= 30}
                    bad={stats.jitterMs != null && stats.jitterMs >= 80} />
              <Diag label="FPS" value={stats.fps != null ? String(stats.fps) : "—"}
                    warn={stats.fps != null && stats.fps > 0 && stats.fps < 20} />
              <Diag label="BITRATE" value={stats.kbps != null ? `${stats.kbps} kbps` : "—"} />
              <Diag label="FREEZES" value={stats.freezeCount != null ? String(stats.freezeCount) : "—"}
                    warn={stats.freezeCount != null && stats.freezeCount > 0} />
            </div>
          )}
          {live && stats && stats.pathType?.startsWith("relay") && (
            <p className="font-mono-data text-[10px] text-[var(--kink-text-2)] mt-2.5 leading-snug">
              Media is going through the TURN relay — expect higher latency/jitter than a direct connection. This is normal off the home network.
            </p>
          )}
        </div>
      )}

      {canPublish && (
        <div className="border-t border-[var(--kink-overlay)]">
          <button
            onClick={() => setShowPublish((s) => !s)}
            data-testid="obs-stream-toggle-publish"
            className="w-full flex items-center justify-between px-4 py-3 font-mono-data text-[11px] tracking-[0.15em] text-[var(--kink-text-2)] hover:text-[var(--kink-purple)] transition-colors"
          >
            <span className="flex items-center gap-1.5"><RadioTower size={13} /> PUBLISH FROM THIS BROWSER</span>
            {showPublish ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {showPublish && (
            <div className="px-4 pb-4">
              <BrowserPublishSection />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Browser-based WHIP publisher, embedded as a collapsible section inside
 * the OBS Stream panel. Uses the browser's native RTCPeerConnection (which
 * handles RFC 8840 Link-header ICE servers correctly) so streaming works
 * without OBS. Owner picks camera+mic OR screen share, clicks Go Live, and
 * the browser negotiates a WebRTC session with the backend. Separate from
 * the WHEP viewer above it — this captures and sends local media, while
 * the viewer receives whatever is currently live (including this browser's
 * own outgoing feed once connected, as an end-to-end check).
 */
// One cell in the WebRTC diagnostics grid. Colours the value amber on `warn`
// and red on `bad` so a glance surfaces a degraded stream.
function Diag({ label, value, warn = false, bad = false }) {
  const color = bad ? "var(--kink-danger)" : warn ? "#FFB020" : "var(--kink-text-2)";
  return (
    <div>
      <p className="font-display text-[9px] tracking-[0.18em] text-[var(--kink-muted)]">{label}</p>
      <p className="font-mono-data text-sm tabular-nums truncate" style={{ color }}>{value}</p>
    </div>
  );
}

function BrowserPublishSection() {
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const resourceUrlRef = useRef(null);

  const [source, setSource] = useState("camera"); // "camera" | "screen"
  const [status, setStatus] = useState("idle");   // idle | preparing | connecting | live | error
  const [bitrateKbps, setBitrateKbps] = useState(0);
  const [maxBitrateKbps, setMaxBitrateKbps] = useState(4000); // adjustable cap (1080p-friendly default)
  const [pubStats, setPubStats] = useState({ fps: null, width: null, height: null, limited: null });
  const bitrateTimerRef = useRef(null);
  const lastStatsRef = useRef({ bytes: 0, ts: 0 });
  const iceRefreshTimerRef = useRef(null);

  // Quality presets (label + kbps cap). "Auto" leaves the cap high so WebRTC's
  // own congestion control decides — useful on a strong local network.
  const QUALITY_PRESETS = [
    { label: "480p",  kbps: 1200 },
    { label: "720p",  kbps: 2500 },
    { label: "1080p", kbps: 4000 },
    { label: "1080p+",kbps: 8000 },
  ];

  useEffect(() => {
    return () => { void stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanup = async () => {
    if (bitrateTimerRef.current) { clearInterval(bitrateTimerRef.current); bitrateTimerRef.current = null; }
    if (iceRefreshTimerRef.current) { clearInterval(iceRefreshTimerRef.current); iceRefreshTimerRef.current = null; }
    if (pcRef.current) {
      try { pcRef.current.getSenders().forEach(s => { try { s.track && s.track.stop(); } catch { /* noop */ } }); } catch { /* noop */ }
      try { pcRef.current.close(); } catch { /* noop */ }
      pcRef.current = null;
    }
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
      streamRef.current = null;
    }
    // Best-effort DELETE so the backend releases the publisher slot immediately.
    const url = resourceUrlRef.current;
    resourceUrlRef.current = null;
    if (url) {
      try {
        await fetch(url, { method: "DELETE", credentials: "omit" });
      } catch { /* noop */ }
    }
  };

  const stop = async () => {
    await cleanup();
    setStatus("idle");
    setBitrateKbps(0);
    setPubStats({ fps: null, width: null, height: null, limited: null });
    lastStatsRef.current = { bytes: 0, ts: 0 };
  };

  // Re-apply the bitrate cap to a live sender (no reconnect needed).
  const applyBitrateCap = async (kbps) => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (!videoSender) return;
      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      params.encodings[0].maxFramerate = 30;
      params.degradationPreference = "maintain-framerate";
      await videoSender.setParameters(params);
    } catch (e) {
      console.warn("could not update bitrate cap:", e);
    }
  };

  // When the cap changes mid-stream, push it to the encoder immediately.
  useEffect(() => {
    if (status === "live") void applyBitrateCap(maxBitrateKbps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxBitrateKbps]);

  const start = async () => {
    setStatus("preparing");
    try {
      // 1) Pull ICE servers (STUN + Cloudflare TURN if configured).
      const { data: iceCfg } = await api.get("/stream/ice-servers");
      const iceServers = (iceCfg && iceCfg.iceServers) || [];

      // 2) Pull the current WHIP publish token (auth for POST /api/whip).
      let token = "";
      try {
        const { data: tok } = await api.get("/stream/token");
        token = (tok && tok.enabled ? (tok.token || "") : "").trim();
      } catch { /* token endpoint requires auth — main dashboard is authed already */ }

      // 3) Capture media. Request 1080p30 with `ideal` so the browser gives
      // the best it can and gracefully falls back on weaker cameras/displays
      // instead of failing outright.
      const media = source === "screen"
        ? await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: true,
          })
        : await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
            audio: true,
          });
      streamRef.current = media;

      // 4) Peer connection with our ICE servers.
      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      for (const track of media.getTracks()) {
        // Hint the encoder to favour smooth motion over crisp detail. For a
        // live cam/scene feed "motion" reduces freezes when bandwidth dips;
        // screen-share uses "detail" (text stays legible) but still gets the
        // bitrate cap + framerate priority below.
        if (track.kind === "video") {
          try { track.contentHint = source === "screen" ? "detail" : "motion"; } catch { /* noop */ }
        }
        pc.addTrack(track, media);
      }

      // Cap the outbound video bitrate and tell the encoder to hold framerate
      // (drop resolution first) when the network can't keep up. Without this
      // the encoder runs unbounded, overshoots the uplink, and congestion
      // control stalls it — which shows up as freezes on every viewer.
      try {
        const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (videoSender) {
          const params = videoSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate = maxBitrateKbps * 1000;
          params.encodings[0].maxFramerate = 30;
          params.degradationPreference = "maintain-framerate";
          await videoSender.setParameters(params);
        }
      } catch (e) {
        console.warn("could not set publisher encoding params:", e);
      }

      pc.addEventListener("connectionstatechange", () => {
        const s = pc.connectionState;
        if (s === "connected") setStatus("live");
        else if (s === "failed" || s === "disconnected" || s === "closed") {
          if (status !== "idle") toast.error(`Stream ${s}`);
          void stop();
        }
      });

      // 5) Offer + WHIP POST.
      const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      setStatus("connecting");

      // Wait for ICE gathering to complete (2s max) — non-trickle mode so all
      // candidates are in the offer we POST.
      await waitForIceGathering(pc, 2000);

      const backendBase = process.env.REACT_APP_BACKEND_URL || window.location.origin;
      const headers = { "Content-Type": "application/sdp" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch(`${backendBase.replace(/\/+$/, "")}/api/whip`, {
        method: "POST",
        headers,
        body: pc.localDescription.sdp,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`WHIP ${resp.status}: ${detail.slice(0, 200) || resp.statusText}`);
      }
      resourceUrlRef.current = resp.headers.get("Location") || null;
      const answerSdp = await resp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      // 6) Poll outbound video bitrate + quality metrics.
      lastStatsRef.current = { bytes: 0, ts: performance.now() };
      bitrateTimerRef.current = setInterval(async () => {
        if (!pcRef.current) return;
        const stats = await pcRef.current.getStats();
        let bytes = 0, outbound = null;
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && r.kind === "video") { bytes += r.bytesSent || 0; outbound = r; }
        });
        const now = performance.now();
        const last = lastStatsRef.current;
        if (last.ts) {
          const kbps = Math.max(0, ((bytes - last.bytes) * 8) / (now - last.ts));
          setBitrateKbps(Math.round(kbps));
        }
        lastStatsRef.current = { bytes, ts: now };
        if (outbound) {
          setPubStats({
            fps: outbound.framesPerSecond != null ? Math.round(outbound.framesPerSecond) : null,
            width: outbound.frameWidth ?? null,
            height: outbound.frameHeight ?? null,
            // "bandwidth" | "cpu" | "none" — why the encoder is scaling down, if it is
            limited: outbound.qualityLimitationReason ?? null,
          });
        }
      }, 1000);

      // Cloudflare TURN allocations expire at ~600s and creds are typically
      // valid for 1h. Refresh both every 9 minutes and trigger an ICE restart
      // so long-running sessions never drop when the current allocation dies.
      iceRefreshTimerRef.current = setInterval(async () => {
        try {
          if (!pcRef.current) return;
          const { data } = await api.get("/stream/ice-servers");
          const fresh = (data && data.iceServers) || [];
          if (!fresh.length) return;
          pcRef.current.setConfiguration({ iceServers: fresh });
          pcRef.current.restartIce();
          // Push the renegotiated offer back to the WHIP resource so aiortc
          // sees the new ufrag/pwd and swaps its ICE agent state.
          const offer = await pcRef.current.createOffer({ iceRestart: true });
          await pcRef.current.setLocalDescription(offer);
          await waitForIceGathering(pcRef.current, 2000);
          const url = resourceUrlRef.current;
          if (url) {
            await fetch(url, {
              method: "PATCH",
              headers: { "Content-Type": "application/sdp" },
              body: pcRef.current.localDescription.sdp,
            }).catch(() => { /* server may not support offer PATCH — best-effort */ });
          }
        } catch (e) {
          console.warn("ICE refresh failed:", e);
        }
      }, 9 * 60 * 1000);

      toast.success("Live from browser");
    } catch (err) {
      console.error("browser publisher failed:", err);
      toast.error(err.message || "Could not start stream");
      await cleanup();
      setStatus("error");
    }
  };

  const busy = status === "preparing" || status === "connecting";
  const live = status === "live" || status === "connecting" || status === "preparing";

  return (
    <div data-testid="browser-publisher-card">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono-data text-[11px] text-[var(--kink-muted)]">
          No OBS needed — grants camera + mic (or a screen share) and pushes straight to the control page over WebRTC.
        </span>
        <span
          data-testid="browser-publisher-status"
          className={`shrink-0 ml-3 inline-flex items-center gap-1.5 font-mono-data text-[10px] tracking-[0.15em] px-2 py-1 border ${
            status === "live"
              ? "border-[var(--kink-success,#4ade80)]/50 text-[var(--kink-success,#4ade80)]"
              : status === "error"
                ? "border-[var(--kink-danger)]/50 text-[var(--kink-danger)]"
                : "border-[var(--kink-overlay)] text-[var(--kink-muted)]"
          }`}
        >
          {status.toUpperCase()}
        </span>
      </div>

      {!live && (
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => setSource("camera")}
            data-testid="browser-publisher-source-camera"
            className={`flex-1 inline-flex items-center justify-center gap-1.5 border px-3 py-2 font-mono-data text-[11px] transition-colors ${
              source === "camera"
                ? "border-[var(--kink-purple)] text-[var(--kink-purple)]"
                : "border-[var(--kink-overlay)] hover:border-[var(--kink-purple)]/50"
            }`}
          >
            <Camera size={13} /> CAMERA + MIC
          </button>
          <button
            type="button"
            onClick={() => setSource("screen")}
            data-testid="browser-publisher-source-screen"
            className={`flex-1 inline-flex items-center justify-center gap-1.5 border px-3 py-2 font-mono-data text-[11px] transition-colors ${
              source === "screen"
                ? "border-[var(--kink-purple)] text-[var(--kink-purple)]"
                : "border-[var(--kink-overlay)] hover:border-[var(--kink-purple)]/50"
            }`}
          >
            <Monitor size={13} /> SCREEN + AUDIO
          </button>
        </div>
      )}

      {/* Quality / bitrate cap — adjustable before AND during the stream. */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono-data text-[10px] tracking-[0.15em] text-[var(--kink-muted)]">QUALITY CAP</span>
          <span className="font-mono-data text-[11px] text-[var(--kink-text-2)]" data-testid="browser-publisher-cap-value">
            {maxBitrateKbps} kbps
          </span>
        </div>
        <div className="flex gap-1.5 mb-2">
          {QUALITY_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setMaxBitrateKbps(p.kbps)}
              data-testid={`browser-publisher-quality-${p.label.toLowerCase()}`}
              className={`flex-1 py-1.5 font-mono-data text-[11px] border transition-colors ${
                maxBitrateKbps === p.kbps
                  ? "border-[var(--kink-purple)] text-[var(--kink-purple)]"
                  : "border-[var(--kink-overlay)] text-[var(--kink-text-2)] hover:border-[var(--kink-purple)]/40"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          type="range"
          min={500}
          max={8000}
          step={250}
          value={maxBitrateKbps}
          onChange={(e) => setMaxBitrateKbps(Number(e.target.value))}
          data-testid="browser-publisher-cap-slider"
          className="w-full accent-[var(--kink-purple)]"
        />
      </div>

      {!live ? (
        <button
          onClick={start}
          disabled={busy}
          data-testid="browser-publisher-start"
          className="w-full inline-flex items-center justify-center gap-2 bg-[var(--kink-purple)] text-[var(--kink-base)] font-display font-bold tracking-[0.1em] py-2.5 active:scale-95 transition-transform disabled:opacity-40"
        >
          {busy ? <><Loader2 className="animate-spin" size={14} /> STARTING…</> : <><Video size={14} /> GO LIVE</>}
        </button>
      ) : (
        <button
          onClick={stop}
          data-testid="browser-publisher-stop"
          className="w-full inline-flex items-center justify-center gap-2 border border-[var(--kink-danger)] text-[var(--kink-danger)] font-display font-bold tracking-[0.1em] py-2.5 active:scale-95 transition-transform"
        >
          <Square size={14} /> STOP STREAM
        </button>
      )}

      {status === "live" && (
        <div className="mt-3 pt-3 border-t border-[var(--kink-overlay)]" data-testid="browser-publisher-readout">
          <div className="grid grid-cols-3 gap-x-4 gap-y-2">
            <div>
              <p className="font-display text-[9px] tracking-[0.18em] text-[var(--kink-muted)]">BITRATE</p>
              <p className="font-mono-data text-sm tabular-nums text-[var(--kink-text-2)]" data-testid="browser-publisher-bitrate">
                {bitrateKbps} <span className="text-[10px] text-[var(--kink-muted)]">kbps</span>
              </p>
            </div>
            <div>
              <p className="font-display text-[9px] tracking-[0.18em] text-[var(--kink-muted)]">RESOLUTION</p>
              <p className="font-mono-data text-sm tabular-nums text-[var(--kink-text-2)]">
                {pubStats.width && pubStats.height ? `${pubStats.width}×${pubStats.height}` : "—"}
              </p>
            </div>
            <div>
              <p className="font-display text-[9px] tracking-[0.18em] text-[var(--kink-muted)]">FPS</p>
              <p className="font-mono-data text-sm tabular-nums text-[var(--kink-text-2)]">
                {pubStats.fps != null ? pubStats.fps : "—"}
              </p>
            </div>
          </div>
          {pubStats.limited && pubStats.limited !== "none" && (
            <p className="font-mono-data text-[10px] mt-2.5 leading-snug" style={{ color: "#FFB020" }} data-testid="browser-publisher-limited">
              {pubStats.limited === "bandwidth"
                ? "Encoder is scaling down for bandwidth — lower the quality cap if it's stuttering, or the network can't carry this rate."
                : pubStats.limited === "cpu"
                  ? "Encoder is CPU-limited on this device — lower the quality cap or close other apps."
                  : `Quality limited: ${pubStats.limited}`}
            </p>
          )}
        </div>
      )}

      {status === "error" && (
        <p className="mt-3 font-mono-data text-[11px] text-[var(--kink-danger)] flex items-center gap-1.5">
          <VideoOff size={12} /> Could not start. Check camera permission + try again.
        </p>
      )}
    </div>
  );
}

/**
 * Owner-facing helper card: shows the WHIP endpoint to paste into OBS, an
 * optional bearer publish token (view/generate/rotate/clear), and copy shortcuts.
 */
function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; pc.removeEventListener("icegatheringstatechange", onChange); resolve(); };
    const onChange = () => { if (pc.iceGatheringState === "complete") finish(); };
    pc.addEventListener("icegatheringstatechange", onChange);
    setTimeout(finish, timeoutMs);
  });
}
