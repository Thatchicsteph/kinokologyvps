import { useCallback, useEffect, useRef, useState } from "react";
import { WS_BASE, API } from "@/lib/api";
import { OSSM } from "@/lib/ossm";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Tunables for the BLE write path / liveness
// ---------------------------------------------------------------------------
const FLUSH_MS = 40;               // max ~25 writes/sec; coalesces slider spam
const STALE_MS = 3000;             // no state change + no write in 3s => link dead
const MAX_WRITE_FAILS = 2;         // consecutive failed writes => reconnect
const RECONNECT_RETRY_MS = 1500;   // backoff between auto-reconnect attempts

export function useBleHost({ onCommand, onToyCommand, onToysLock, onChatMsg, onChatHistory, onChatCleared, onPresence, onReaction, onChatReact, onChatDelete, onChatMuted, onTheme } = {}) {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [wsConnected, setWsConnected] = useState(false);

  const cmdCharRef = useRef(null);
  const stateCharRef = useRef(null);
  const deviceRef = useRef(null);
  const wsRef = useRef(null);

  // Write-path state
  const lastCmdRef = useRef("");      // last command actually ACKed by device
  const pendingCmdRef = useRef(null); // latest command waiting to flush
  const flushTimerRef = useRef(null);
  const writingRef = useRef(false);   // backpressure: a write is in flight
  const failsRef = useRef(0);         // consecutive write failures
  const lastActivityRef = useRef(0);  // last time link showed any life
  const reconnectingRef = useRef(false);

  // ------------------------------------------------------------------
  // Host WebSocket (unchanged behaviour)
  // ------------------------------------------------------------------
  const openHostWs = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === 0 || wsRef.current.readyState === 1)) return;
    const token = localStorage.getItem("ossm_token");
    const ws = new WebSocket(`${WS_BASE}/api/ws/host?token=${token}`);
    wsRef.current = ws;
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "command" && msg.cmd) writeCommand(msg.cmd);
        else if (msg.type === "toy_command" && msg.cmd && onToyCommand) {
          try { onToyCommand(msg.cmd); } catch (e) { console.error("onToyCommand handler failed", e); }
        } else if (msg.type === "toys_lock" && onToysLock) {
          try { onToysLock(!!msg.locked); } catch (e) {}
        } else if (msg.type === "chat_history" && onChatHistory) {
          try { onChatHistory(msg.messages || []); } catch (e) {}
        } else if (msg.type === "chat_msg" && onChatMsg) {
          try { onChatMsg(msg.message); } catch (e) {}
        } else if (msg.type === "chat_cleared" && onChatCleared) {
          try { onChatCleared(); } catch (e) {}
        } else if (msg.type === "presence" && onPresence) {
          try { onPresence(msg); } catch (e) {}
        } else if (msg.type === "reaction" && onReaction) {
          try { onReaction(msg); } catch (e) {}
        } else if (msg.type === "chat_react" && onChatReact) {
          try { onChatReact(msg); } catch (e) {}
        } else if (msg.type === "chat_delete" && onChatDelete) {
          try { onChatDelete(msg.msg_id); } catch (e) {}
        } else if (msg.type === "chat_muted" && onChatMuted) {
          try { onChatMuted(msg.codes || []); } catch (e) {}
        } else if (msg.type === "theme" && onTheme) {
          try { onTheme(msg.theme); } catch (e) {}
        }
      } catch (e) {}
    };
  }, [onToyCommand, onToysLock, onChatMsg, onChatHistory, onChatCleared, onPresence, onReaction, onChatReact, onChatDelete, onChatMuted, onTheme]);

  const closeHostWs = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch (e) {}
      wsRef.current = null;
    }
    setWsConnected(false);
  }, []);

  // ------------------------------------------------------------------
  // Heartbeat / liveness
  // ------------------------------------------------------------------
  const beatRef = useRef(null);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    lastActivityRef.current = Date.now();
    beatRef.current = setInterval(async () => {
      // Link is considered alive if it ACKed a write recently OR we're mid-write.
      if (writingRef.current) { lastActivityRef.current = Date.now(); return; }
      const device = deviceRef.current;
      const char = stateCharRef.current;
      if (!device?.gatt?.connected || !char) { bleReconnect(); return; }
      try {
        // Read the state char as a cheap "is the link responding?" probe.
        const val = await char.readValue();
        const state = new TextDecoder().decode(val);
        lastActivityRef.current = Date.now();
        if (wsRef.current && wsRef.current.readyState === 1) {
          try { wsRef.current.send(JSON.stringify({ type: "device_state", state })); } catch (e) {}
        }
      } catch (e) {
        // Read failed — treat as stale and let the age check below decide.
      }
      if (Date.now() - lastActivityRef.current > STALE_MS) {
        bleReconnect();
      }
    }, 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (beatRef.current) { clearInterval(beatRef.current); beatRef.current = null; }
  }, []);

  // ------------------------------------------------------------------
  // GATT attach (shared by initial connect + auto-reconnect)
  // ------------------------------------------------------------------
  const attachGatt = useCallback(async (device) => {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(OSSM.SERVICE_UUID);
    cmdCharRef.current = await service.getCharacteristic(OSSM.COMMAND_UUID);

    // Best-effort state notifications.
    try {
      const stateChar = await service.getCharacteristic(OSSM.STATE_UUID);
      stateCharRef.current = stateChar;
      await stateChar.startNotifications();
      stateChar.addEventListener("characteristicvaluechanged", (e) => {
        lastActivityRef.current = Date.now();
        const val = new TextDecoder().decode(e.target.value);
        if (wsRef.current && wsRef.current.readyState === 1) {
          wsRef.current.send(JSON.stringify({ type: "device_state", state: val }));
        }
      });
    } catch (e) { /* state char optional */ }
  }, []);

  // ------------------------------------------------------------------
  // Auto-reconnect — replaces the "refresh the page" step
  // ------------------------------------------------------------------
  const bleReconnect = useCallback(async () => {
    const device = deviceRef.current;
    if (!device || reconnectingRef.current) return;
    reconnectingRef.current = true;
    console.info("BLE link looks stale — attempting in-page reconnect");
    try {
      if (device.gatt?.connected) { try { device.gatt.disconnect(); } catch (e) {} }
      cmdCharRef.current = null;
      stateCharRef.current = null;
      await new Promise((r) => setTimeout(r, 300)); // let the stack settle
      await attachGatt(device);
      failsRef.current = 0;
      lastActivityRef.current = Date.now();
      console.info("BLE link recovered automatically");
    } catch (e) {
      console.error("BLE auto-reconnect failed, retrying", e);
    } finally {
      reconnectingRef.current = false;
      if (deviceRef.current && !cmdCharRef.current) {
        setTimeout(bleReconnect, RECONNECT_RETRY_MS);
      }
    }
  }, [attachGatt]);

  // ------------------------------------------------------------------
  // Write path: coalesced + backpressured + ACKed
  // ------------------------------------------------------------------
  const flush = useCallback(async () => {
    if (writingRef.current) return;             // one write at a time
    const command = pendingCmdRef.current;
    if (!command) return;
    pendingCmdRef.current = null;
    const char = cmdCharRef.current;
    if (!char) return;

    writingRef.current = true;
    try {
      const data = new TextEncoder().encode(command);
      await char.writeValue(data);              // WITH response => real ACK
      lastCmdRef.current = command;
      failsRef.current = 0;
      lastActivityRef.current = Date.now();
    } catch (e) {
      console.error("BLE write failed", command, e);
      failsRef.current += 1;
      if (failsRef.current >= MAX_WRITE_FAILS) bleReconnect();
    } finally {
      writingRef.current = false;
    }
  }, [bleReconnect]);

  const writeCommand = useCallback((command) => {
    // Fires for every command regardless of OSSM connection state, so linked
    // toys (Lovense/etc via Intiface) still work even without an OSSM present.
    if (onCommand) { try { onCommand(command); } catch (e) { console.error("onCommand handler failed", e); } }

    // Owner-issued commands (test console) bypass the guest relay entirely,
    // so tell the backend directly or the /overlay telemetry never moves.
    const m = command.match(/^set:(speed|stroke|depth|sensation):(\d+)$/);
    if (m) {
      const ws = wsRef.current;
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: "owner_telemetry", [m[1]]: Number(m[2]) })); } catch (e) {}
      }
    }

    if (!command) return;
    if (command === lastCmdRef.current) return; // skip duplicates
    pendingCmdRef.current = command;            // keep only the LATEST
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        flush();
      }, FLUSH_MS);
    }
  }, [onCommand, flush]);

  // ------------------------------------------------------------------
  // Connection lifecycle
  // ------------------------------------------------------------------
  const onDisconnected = useCallback(() => {
    setConnected(false);
    cmdCharRef.current = null;
    stateCharRef.current = null;
    stopHeartbeat();
    // Host session is intentionally left open — toys may still be active.
    if (wsRef.current && wsRef.current.readyState === 1) {
      try { wsRef.current.send(JSON.stringify({ type: "ble_status", connected: false })); } catch (e) {}
    }
    toast.error("Device disconnected");
  }, [stopHeartbeat]);

  const connect = useCallback(async () => {
    if (!navigator.bluetooth) {
      toast.error("Web Bluetooth not supported. Use Chrome, Edge, or Opera.");
      return;
    }
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [OSSM.SERVICE_UUID] }],
        optionalServices: [OSSM.SERVICE_UUID],
      });
      deviceRef.current = device;
      device.addEventListener("gattserverdisconnected", onDisconnected);
      await attachGatt(device);
      setDeviceName(device.name || "OSSM");
      setConnected(true);
      startHeartbeat();
      toast.success(`Connected to ${device.name || "OSSM"}`);
    } catch (e) {
      if (e && e.name !== "NotFoundError") toast.error(`Connection failed: ${e.message}`);
    }
  }, [attachGatt, onDisconnected, startHeartbeat]);

  const disconnect = useCallback(() => {
    stopHeartbeat();
    if (deviceRef.current?.gatt?.connected) {
      try { deviceRef.current.gatt.disconnect(); } catch (e) {}
    }
    onDisconnected();
  }, [onDisconnected, stopHeartbeat]);

  const sendHostMessage = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }, []);

  // ------------------------------------------------------------------
  // Cleanup on unmount
  // ------------------------------------------------------------------
  useEffect(() => {
    return () => {
      stopHeartbeat();
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      if (deviceRef.current?.gatt?.connected) {
        try { deviceRef.current.gatt.disconnect(); } catch (e) {}
      }
      if (wsRef.current) { try { wsRef.current.close(); } catch (e) {} }
    };
  }, [stopHeartbeat]);

  return { connected, wsConnected, deviceName, connect, disconnect, writeCommand, sendHostMessage, openHostWs, closeHostWs };
}
