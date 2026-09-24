"""Connection Hub for the Kinkology realtime session.

Extracted verbatim from server.py to shrink that module. The Hub manages the
host WebSocket, guest clients, the control queue, the active turn clock, chat,
reactions, telemetry and the liveness ticker.

It depends on a handful of names owned by server.py (the Mongo handle, the
audit logger, and the command validators). Rather than import server.py — which
would be circular, since server.py imports this module — those are INJECTED once
at startup via init_hub(...). server.py calls init_hub(...) immediately before
constructing the Hub, so the module globals below are populated before any Hub
method runs. This keeps the exact runtime behaviour of the original inline class.
"""
import re
import time
import asyncio
import secrets
from typing import List, Optional, Dict
from datetime import datetime, timezone

from fastapi import WebSocket

# --- injected dependencies (populated by init_hub before Hub is instantiated) --
db = None                    # AsyncIOMotorClient database handle
logger = None                # logging.Logger
log_event = None             # async audit-log helper
is_valid_command = None      # BLE command validator
is_valid_toy_command = None  # toy command validator


def init_hub(*, database, log, audit_log_event, valid_command, valid_toy_command):
    """Inject the server-owned dependencies into this module. Must be called
    once, before Hub() is constructed. Idempotent."""
    global db, logger, log_event, is_valid_command, is_valid_toy_command
    db = database
    logger = log
    log_event = audit_log_event
    is_valid_command = valid_command
    is_valid_toy_command = valid_toy_command


class Hub:
    def __init__(self):
        self.host_ws: Optional[WebSocket] = None
        self.clients: Dict[str, dict] = {}   # client_id -> {ws, code, label}
        self.queue: List[str] = []
        self.active_id: Optional[str] = None
        self.active_start: Optional[float] = None
        self.active_remaining_start: int = 0
        # When the active guest disconnects, we freeze their turn clock during
        # the reconnect grace window so they aren't charged for time offline.
        # monotonic timestamp of the disconnect, or None while connected.
        self.active_paused_at: Optional[float] = None
        # Seconds of the current active turn that have already been written
        # back to the code's used_seconds in Mongo. tick() flushes the delta
        # every FLUSH_INTERVAL_S so a mid-turn backend restart preserves the
        # guest's remaining time (they auto-reconnect and pick up where they
        # left off, minus at most one flush interval).
        self.active_flushed: int = 0
        self.device_state: str = ""
        self.limits: dict = {"min_depth": 0, "max_speed": 100, "max_depth": 100}
        self.hr_cutoff: int = 0
        self.hr_over: bool = False
        self.pre_cutoff_speed: int = 0
        self.hr_target: int = 0
        self.hr_sync_enabled: bool = False
        self.overlay_ws: set = set()
        # Read-only WS clients watching the public chat overlay (OBS browser
        # source style, like overlay_ws above but for chat messages instead
        # of telemetry). No client_id / rate limiting needed since these
        # connections never send anything back — they only receive.
        self.chat_overlay_ws: set = set()
        self.telemetry: dict = {"speed": 0, "stroke": 0, "depth": 0, "sensation": 0, "pattern": 0}
        self.active_program: Optional[str] = None  # app-level auto program reported by guest
        self.hr: dict = {"bpm": 0, "connected": False}
        self.hr_sync: dict = {"enabled": False, "target": 120, "min_speed": 0,
                              "max_speed": 100, "response": 0.6, "ramp_up": 25.0,
                              "ramp_down": 50.0, "schedule": []}
        self.hr_sync_command: float = 0.0
        self.hr_sync_started: Optional[float] = None
        self.motion_accum: float = 0.0
        self.motion_start: Optional[float] = None
        # Toys (Lovense / Intiface) live on the owner's browser. We just track
        # what the owner reports so guests know whether the toy controls should
        # appear on their console. `toys_locked` is an owner-triggered kill
        # switch: while True, guest toy commands are dropped and the owner's
        # browser is told to stop all toys.
        self.toys_available: bool = False
        self.toys_pattern: Optional[str] = None
        self.toys_locked: bool = False
        # Display name the owner appears under in chat/reactions/typing
        # indicators. Defaults to "Owner"; changeable via the admin UI and
        # persisted in db.settings so it survives a restart.
        self.owner_name: str = "Owner"
        # In-memory chat: last 50 messages, oldest first. Each entry:
        #   {"id": str, "author": str, "role": "owner"|"guest", "text": str, "ts": iso}
        self.chat_msgs: List[dict] = []
        # Per-sender rate limit: 1 message / 1s minimum gap.
        self.chat_last_sent: Dict[str, float] = {}
        # Moderation: access codes the owner has muted in chat. A muted guest's
        # chat messages are silently dropped (they can still control/watch).
        # Keyed by access code so a mute survives a reconnect within the turn.
        self.muted_codes: set = set()
        # Presence: last-typing-at monotonic timestamps. Owner uses key "owner";
        # guests use their client id. A guest is "typing" if last-typing-at is
        # within TYPING_TTL_S seconds. Presence changes are broadcast to all.
        self.typing_at: Dict[str, float] = {}
        # Per-client session stats accumulator (drives the end-of-turn recap
        # sent to the guest when they get demoted). Keyed by client id.
        # Shape: {"reactions": {emoji: count}, "chat_count": int,
        #         "speed_samples": [int, ...], "started_at": monotonic,
        #         "granted_seconds": int}
        self.session_stats: Dict[str, dict] = {}
        # Reconnect grace: when the active guest disconnects (e.g. browser
        # refresh), we hold the session open for RECONNECT_GRACE_S seconds
        # instead of immediately ending the turn. Keyed by access-code so a
        # reconnect with the same code but a new WS/cid can cancel the timer.
        # Value: asyncio.Task running the grace coroutine.
        self.disconnect_grace: Dict[str, asyncio.Task] = {}
        self.lock = asyncio.Lock()

    TYPING_TTL_S = 4.0

    # Reactions rate limit: at most one burst per 400ms per client so a
    # spammer can't flood the room. Emojis are whitelisted server-side.
    REACTION_MIN_GAP_S = 0.4
    REACTION_WHITELIST = {"🔥", "💦", "😩", "👏", "😈", "💜", "🍑", "❤️"}

    async def broadcast_reaction(self, cid: Optional[str], emoji: str) -> None:
        """Relay a single reaction emoji to everyone (owner + all guests).
        `cid` is None when the owner reacts. Rate-limited per-sender AND
        per-emoji so a viewer switching 🔥→💦 back-to-back gets both, but
        holding 🔥 down at 30fps still gets throttled.
        """
        if emoji not in self.REACTION_WHITELIST:
            return
        key = cid or "owner"
        rl_key = f"react:{key}:{emoji}"
        now = time.monotonic()
        last = self.chat_last_sent.get(rl_key, 0.0)
        if now - last < self.REACTION_MIN_GAP_S:
            return
        self.chat_last_sent[rl_key] = now
        if cid:
            client = self.clients.get(cid)
            label = ("Guest" if client and client.get("auto_label") else (client["label"] if client else "Guest"))
        else:
            label = self.owner_name
        payload = {"type": "reaction", "id": secrets.token_hex(4), "emoji": emoji, "author": label, "ts": now}
        await self.send_to_host(payload)
        for c in list(self.clients.values()):
            await self._send(c["ws"], payload)
        # Fold into the sender's session recap counter if they're the active
        # guest — recap only cares about the person whose turn it is.
        if cid and cid == self.active_id:
            stats = self.session_stats.get(cid)
            if stats is not None:
                stats["reactions"][emoji] = stats["reactions"].get(emoji, 0) + 1

    def _current_typers(self) -> List[str]:
        """Labels of clients whose last typing ping is still fresh."""
        now = time.monotonic()
        cutoff = now - self.TYPING_TTL_S
        labels: List[str] = []
        for cid, ts in list(self.typing_at.items()):
            if ts < cutoff:
                # Expired — drop lazily.
                self.typing_at.pop(cid, None)
                continue
            if cid == "owner":
                labels.append(self.owner_name)
            else:
                client = self.clients.get(cid)
                if client:
                    labels.append(client["label"])
        return labels

    def _presence_payload(self) -> dict:
        return {
            "type": "presence",
            "owner_online": self.host_ws is not None,
            # Only expose the display label — never raw access codes for
            # auto-labelled clients (same rule the queue broadcast follows).
            "guests": [
                {"id": cid, "label": ("Guest" if c.get("auto_label") else c["label"])}
                for cid, c in self.clients.items()
            ],
            "typing": self._current_typers(),
        }

    async def broadcast_presence(self) -> None:
        payload = self._presence_payload()
        await self.send_to_host(payload)
        for c in list(self.clients.values()):
            await self._send(c["ws"], payload)

    async def broadcast_theme(self, theme: str) -> None:
        """Push a fresh theme to everyone connected. Guests + owner apply it
        to <html data-theme=…> so the UI reskins without a reload."""
        payload = {"type": "theme", "theme": theme}
        await self.send_to_host(payload)
        for c in list(self.clients.values()):
            await self._send(c["ws"], payload)

    async def toggle_chat_reaction(self, msg_id: str, emoji: str, author: str) -> None:
        """Toggle `emoji` reaction on chat message `msg_id` for `author`.
        Broadcast the updated reactions map. Whitelisted emojis only."""
        if emoji not in self.REACTION_WHITELIST:
            return
        if not msg_id or not author:
            return
        target = None
        for m in self.chat_msgs:
            if m.get("id") == msg_id:
                target = m
                break
        if target is None:
            return
        reactions = target.setdefault("reactions", {})
        authors = reactions.get(emoji, [])
        if author in authors:
            authors = [a for a in authors if a != author]
        else:
            authors = [*authors, author]
        if authors:
            reactions[emoji] = authors
        else:
            reactions.pop(emoji, None)
        payload = {
            "type": "chat_react",
            "msg_id": msg_id,
            "reactions": reactions,
        }
        await self.send_to_host(payload)
        for c in list(self.clients.values()):
            await self._send(c["ws"], payload)
        await self.push_chat_overlay(payload)

    async def delete_chat_message(self, msg_id: str) -> None:
        """Owner moderation: remove a chat message for everyone. Broadcasts a
        chat_delete event so all clients (and the chat overlay) drop it."""
        if not msg_id:
            return
        before = len(self.chat_msgs)
        self.chat_msgs = [m for m in self.chat_msgs if m.get("id") != msg_id]
        if len(self.chat_msgs) == before:
            return  # nothing removed
        payload = {"type": "chat_delete", "msg_id": msg_id}
        await self.send_to_host(payload)
        for c in list(self.clients.values()):
            await self._send(c["ws"], payload)
        await self.push_chat_overlay(payload)

    async def set_muted(self, code: str, muted: bool) -> None:
        """Owner moderation: mute/unmute an access code in chat. A muted guest
        keeps control/viewing but their chat messages are dropped."""
        code = (code or "").strip().upper()
        if not code:
            return
        if muted:
            self.muted_codes.add(code)
        else:
            self.muted_codes.discard(code)
        # Tell the host the current mute set so the admin UI can reflect it.
        await self.send_to_host({"type": "chat_muted", "codes": sorted(self.muted_codes)})

    @staticmethod
    def _clean_label(name: str) -> Optional[str]:
        """Shared sanitizer for any chat display name (guest nickname or
        owner name): strips anything but word chars/spaces/-.!?, caps at
        24 chars, and rejects anything left too short to be useful."""
        cleaned = re.sub(r"[^\w \-\.\!\?]", "", (name or "").strip())[:24].strip()
        return cleaned if len(cleaned) >= 2 else None

    async def set_client_nickname(self, cid: str, name: str) -> Optional[str]:
        """Sanitize + set a guest's nickname. Returns the final label or None
        if rejected. Broadcasts state + presence so labels update everywhere."""
        client = self.clients.get(cid)
        if client is None:
            return None
        cleaned = self._clean_label(name)
        if cleaned is None:
            return None
        client["label"] = cleaned
        client["auto_label"] = False
        await self.broadcast()
        await self.broadcast_presence()
        return cleaned

    async def set_owner_name(self, name: str) -> Optional[str]:
        """Sanitize + set the owner's own chat display name (shown as the
        author of owner chat messages, reactions, and the typing indicator).
        Returns the final name or None if rejected. Broadcasts presence so
        anyone currently seeing "Owner is typing…" picks up the new label."""
        cleaned = self._clean_label(name)
        if cleaned is None:
            return None
        self.owner_name = cleaned
        await self.broadcast_presence()
        return cleaned

    # ---- session recap ---------------------------------------------------
    def _init_stats(self, cid: str) -> None:
        client = self.clients.get(cid)
        code = client["code"] if client else ""
        self.session_stats[cid] = {
            "reactions": {},
            "chat_count": 0,
            "speed_samples": [],
            "started_at": time.monotonic(),
            "granted_seconds": self.active_remaining_start,
            "code": code,
        }

    def _record_speed_sample(self) -> None:
        """Log the current speed onto the active guest's recap accumulator.
        Called from tick() while a turn is running."""
        cid = self.active_id
        if not cid:
            return
        stats = self.session_stats.get(cid)
        if stats is None:
            return
        stats["speed_samples"].append(int(self.telemetry.get("speed", 0)))

    def _build_recap(self, cid: str) -> dict:
        stats = self.session_stats.get(cid) or {}
        samples = stats.get("speed_samples") or []
        moving = [s for s in samples if s > 0]
        reactions_by_emoji = stats.get("reactions") or {}
        top = sorted(reactions_by_emoji.items(), key=lambda kv: kv[1], reverse=True)[:3]
        elapsed = int(time.monotonic() - stats.get("started_at", time.monotonic()))
        used = min(elapsed, stats.get("granted_seconds", elapsed))
        return {
            "used_seconds": used,
            "granted_seconds": stats.get("granted_seconds", 0),
            "chat_count": stats.get("chat_count", 0),
            "reactions_total": sum(reactions_by_emoji.values()),
            "reactions_top": [{"emoji": e, "count": c} for e, c in top],
            "avg_speed_percent": int(sum(moving) / len(moving)) if moving else 0,
            "peak_speed_percent": max(samples) if samples else 0,
        }

    async def _emit_recap(self, cid: str, reason: str) -> None:
        client = self.clients.get(cid)
        if client is None:
            return
        try:
            recap = self._build_recap(cid)
            recap["reason"] = reason
            await self._send(client["ws"], {"type": "session_recap", "recap": recap})
        except Exception as e:
            logger.error(f"session_recap emit failed: {e}")

    async def mark_typing(self, cid: str) -> None:
        """Record that `cid` (or 'owner') is typing right now, and broadcast
        the updated presence payload so everyone sees the dots."""
        self.typing_at[cid] = time.monotonic()
        await self.broadcast_presence()

    def _update_motion(self, speed: int):
        now = time.monotonic()
        if speed > 0 and self.motion_start is None:
            self.motion_start = now
        elif speed == 0 and self.motion_start is not None:
            self.motion_accum += now - self.motion_start
            self.motion_start = None

    def reset_telemetry(self):
        self.telemetry = {"speed": 0, "stroke": 0, "depth": 0, "sensation": 0, "pattern": 0}
        self.active_program = None
        self.motion_accum = 0.0
        self.motion_start = None

    def telemetry_frame(self) -> dict:
        now = time.monotonic()
        run = self.motion_accum + (now - self.motion_start if self.motion_start else 0)
        session = int(now - self.active_start) if (self.active_id and self.active_start) else 0
        label = self.clients[self.active_id]["label"] if (self.active_id and self.active_id in self.clients) else None
        return {
            "type": "telemetry",
            "host_connected": self.host_ws is not None,
            "controller": label,
            "running": self.telemetry["speed"] > 0,
            "run_seconds": int(run),
            "session_seconds": session,
            "hr_bpm": int(self.hr.get("bpm", 0)),
            "hr_connected": bool(self.hr.get("connected", False)),
            "hr_cutoff": int(self.hr_cutoff),
            "hr_over": bool(self.hr_over),
            "hr_target": int(self.hr_target),
            "hr_sync_enabled": bool(self.hr_sync_enabled),
            "active_program": self.active_program,
            **self.telemetry,
        }

    async def push_telemetry(self):
        frame = self.telemetry_frame()
        for ws in list(self.overlay_ws):
            try:
                await ws.send_json(frame)
            except Exception:
                self.overlay_ws.discard(ws)

    async def push_chat_overlay(self, payload: dict):
        """Fan a chat event out to public chat-overlay viewers (OBS browser
        source). Mirrors push_telemetry's discard-on-failure pattern."""
        for ws in list(self.chat_overlay_ws):
            try:
                await ws.send_json(payload)
            except Exception:
                self.chat_overlay_ws.discard(ws)

    async def evaluate_hr_cutoff(self):
        """Force-stop and block motion when live BPM crosses the safety cutoff;
        resume automatically once BPM drops back below it."""
        cutoff = int(self.hr_cutoff or 0)
        bpm = int(self.hr.get("bpm", 0))
        if cutoff > 0 and self.hr.get("connected") and bpm >= cutoff:
            if not self.hr_over:
                self.hr_over = True
                self.pre_cutoff_speed = int(self.telemetry.get("speed", 0))
                await self.send_to_host({"type": "command", "cmd": "set:speed:0"})
                await self.send_to_host({"type": "command", "cmd": "go:menu"})
                self.telemetry["speed"] = 0
                self._update_motion(0)
                await log_event("security", "hr_cutoff_triggered", actor="system",
                                detail={"bpm": bpm, "cutoff": cutoff})
        elif self.hr_over and self.hr.get("connected") and bpm < cutoff:
            self.hr_over = False
            await log_event("security", "hr_cutoff_cleared", actor="system",
                            detail={"bpm": bpm, "cutoff": cutoff})
            resume_speed = self.clamp_command(f"set:speed:{self.pre_cutoff_speed}")[0]
            resume_speed = int(resume_speed.split(":")[-1])
            # The cutoff trip always sends go:menu, regardless of hr_sync_enabled,
            # so the resume must always send go:strokeEngine to bring the device
            # back — otherwise it stays parked on the menu screen forever.
            await self.send_to_host({"type": "command", "cmd": "go:strokeEngine"})
            # If HR Sync is driving speed itself, let its own control loop take it
            # from here; otherwise restore motion to where it was before the trip.
            if not self.hr_sync_enabled and resume_speed > 0:
                await self.send_to_host({"type": "command", "cmd": f"set:speed:{resume_speed}"})
                self.telemetry["speed"] = resume_speed
                self._update_motion(resume_speed)
            await log_event("security", "hr_cutoff_resumed", actor="system",
                            detail={"bpm": bpm, "cutoff": cutoff,
                                     "speed": resume_speed if not self.hr_sync_enabled else self.telemetry.get("speed", 0)})
            self.pre_cutoff_speed = 0

    def clamp_command(self, cmd: str) -> list[str]:
        # Heart-rate safety cutoff: while over the limit, no motion is allowed.
        if self.hr_over and (cmd.startswith("set:speed:") or cmd == "go:strokeEngine"):
            return ["set:speed:0"]
        m = re.match(r'^set:(depth|speed|stroke):(\d+)$', cmd)
        if not m:
            return [cmd]
        kind, val = m.group(1), int(m.group(2))
        min_depth = self.limits.get("min_depth", 0)
        max_depth = self.limits.get("max_depth", 100)
        if kind == "depth" and val < min_depth:
            val = min_depth
            cmd = f'set:depth:{val}'
        elif kind == "depth" and val > max_depth:
            val = max_depth
            cmd = f'set:depth:{val}'
        if kind == "speed" and val > self.limits.get("max_speed", 100):
            return [f'set:speed:{self.limits["max_speed"]}']
        # Firmware convention: top of stroke = depth, bottom of stroke =
        # depth - stroke. Depth is clamped above; stroke must also be capped
        # so it can't pull the bottom of travel below min_depth.
        if kind == "stroke":
            current_depth = self.telemetry.get("depth", max_depth)
            max_stroke = max(0, current_depth - min_depth)
            if val > max_stroke:
                return [f'set:stroke:{max_stroke}']
            return [cmd]
        if kind == "depth":
            # If the (possibly just-clamped) depth would now put the bottom
            # of the current stroke below min_depth, correct the stroke too.
            out = [cmd]
            current_stroke = self.telemetry.get("stroke", 0)
            max_stroke = max(0, val - min_depth)
            if current_stroke > max_stroke:
                out.append(f'set:stroke:{max_stroke}')
            return out
        return [cmd]

    def active_remaining(self) -> int:
        if self.active_id is None or self.active_start is None:
            return 0
        # While paused (guest disconnected, within grace), the clock is frozen
        # at the disconnect moment so no turn time is consumed while offline.
        ref = self.active_paused_at if self.active_paused_at is not None else time.monotonic()
        elapsed = ref - self.active_start
        return max(0, int(self.active_remaining_start - elapsed))

    async def _send(self, ws: Optional[WebSocket], payload: dict):
        if ws is None:
            return
        try:
            await ws.send_json(payload)
        except Exception:
            pass

    async def send_to_host(self, payload: dict):
        await self._send(self.host_ws, payload)

    async def code_remaining(self, code: str) -> int:
        doc = await db.access_codes.find_one({"code": code})
        if not doc or doc.get("revoked"):
            return 0
        return max(0, int(doc.get("granted_seconds", 0) - doc.get("used_seconds", 0)))

    async def promote(self):
        """Promote next queued client to active if slot is free."""
        while self.active_id is None and self.queue:
            cid = self.queue[0]
            client = self.clients.get(cid)
            if client is None:
                self.queue.pop(0)
                continue
            remaining = await self.code_remaining(client["code"])
            if remaining <= 0:
                self.queue.pop(0)
                await self._send(client["ws"], {"type": "expired"})
                continue
            self.queue.pop(0)
            self.active_id = cid
            self.active_start = time.monotonic()
            self.active_remaining_start = remaining
            self.active_flushed = 0
            self.active_paused_at = None
            self._init_stats(cid)
            self.reset_telemetry()
            await log_event("session", "guest_active", actor=f"guest:{client['label']}",
                            target=client["code"], detail={"remaining_seconds": remaining})
            break

    async def end_active(self, reason: str = "ended"):
        if self.active_id is None:
            return
        cid = self.active_id
        client = self.clients.get(cid)
        # Cancel any pending reconnect grace timer for this code.
        if client:
            grace_task = self.disconnect_grace.pop(client.get("code", ""), None)
            if grace_task:
                grace_task.cancel()
        # If the turn ended while paused (grace expired), count only up to the
        # disconnect moment — the guest isn't charged for the grace window.
        ref = self.active_paused_at if self.active_paused_at is not None else time.monotonic()
        elapsed = int(ref - (self.active_start or ref))
        consumed = min(elapsed, self.active_remaining_start)
        # Only write the seconds we haven't already flushed via the periodic
        # ticker — otherwise we double-count and the guest loses time.
        delta = max(0, consumed - self.active_flushed)
        if client:
            await db.access_codes.update_one(
                {"code": client["code"]},
                {"$inc": {"used_seconds": delta},
                 "$set": {"last_used_at": datetime.now(timezone.utc).isoformat()}},
            )
            # Ship the end-of-turn recap BEFORE we flip the guest into
            # spectator mode so the card renders while they still have context.
            await self._emit_recap(cid, reason)
            # When the guest's time runs out, we DON'T disconnect them anymore
            # — they demote to view-only spectators (still see the stream, chat,
            # and presence). For all other reasons the socket stays too; the
            # frontend handles the `turn_ended` message.
            if reason == "time_up":
                client["expired"] = True
                await self._send(client["ws"], {"type": "turn_ended", "reason": reason, "keep_connection": True})
            else:
                await self._send(client["ws"], {"type": "turn_ended", "reason": reason})
            await log_event("session", "turn_ended", actor=f"guest:{client['label']}",
                            target=client["code"], detail={"reason": reason, "seconds": consumed})
        # Safety: stop the device between turns
        await self.send_to_host({"type": "command", "cmd": "set:speed:0"})
        await self.send_to_host({"type": "command", "cmd": "go:menu"})
        self.active_id = None
        self.active_start = None
        self.active_remaining_start = 0
        self.active_flushed = 0
        self.active_paused_at = None
        # Drop the recap accumulator for this turn now that we've emitted it.
        self.session_stats.pop(cid, None)
        self.reset_telemetry()
        await self.push_telemetry()

    RECONNECT_GRACE_S = 20  # seconds before a disconnected active guest loses their turn

    async def _grace_expire(self, code: str):
        """Called after RECONNECT_GRACE_S if the guest hasn't reconnected.
        Sends a gentle stop to the minimum depth instead of go:menu so the
        device doesn't snap to the physical home position."""
        await asyncio.sleep(self.RECONNECT_GRACE_S)
        async with self.lock:
            self.disconnect_grace.pop(code, None)
            if self.active_id is None:
                return  # already ended by something else (skip, emergency stop, etc.)
            # Check the active client is still the one we're timing out for
            active_client = self.clients.get(self.active_id)
            if active_client and active_client.get("code") == code:
                min_depth = self.limits.get("min_depth", 0)
                # Soft stop: hold at min_depth instead of snapping to menu/home
                await self.send_to_host({"type": "command", "cmd": "set:speed:0"})
                await self.send_to_host({"type": "command", "cmd": f"set:depth:{min_depth}"})
                await self.end_active("disconnected")
                await self.promote()
                await self.broadcast()

    async def add_client(self, cid: str, ws: WebSocket, code: str, label: str, auto_label: bool = False, view_only: bool = False):
        # If a grace timer is running for this code, the guest refreshed their
        # browser — cancel the timer and restore them as the active controller
        # without touching the device position.
        grace_task = self.disconnect_grace.pop(code, None)
        if grace_task is not None:
            grace_task.cancel()
            # Re-link this new cid to the existing active session.
            # The old cid has already been removed from self.clients by
            # remove_client, so we just register the new one and skip
            # the normal queue → promote flow.
            self.clients[cid] = {
                "ws": ws, "code": code, "label": label,
                "auto_label": auto_label,
                "view_only": view_only,
                "expired": False,
            }
            # Swap active_id to the new cid so commands flow again.
            self.active_id = cid
            # Un-freeze the turn clock: shift active_start forward by however
            # long they were disconnected, so the paused seconds don't count.
            if self.active_paused_at is not None and self.active_start is not None:
                paused_for = time.monotonic() - self.active_paused_at
                self.active_start += paused_for
            self.active_paused_at = None
            # Tell the new WS immediately so the frontend restores its control
            # UI without waiting for the next broadcast cycle.
            remaining = self.active_remaining()
            await self._send(ws, {
                "type": "reconnected",
                "remaining_seconds": remaining,
                **self.telemetry_frame(),
            })
            await log_event("session", "guest_reconnected", actor=f"guest:{label}", target=code)
            return
        # auto_label is True when the owner didn't set a custom label for this
        # access code, so `label` fell back to the raw code itself. That raw
        # code must never be shown to *other* guests (only to the owner/host,
        # who already has it on the Manage Codes panel).
        # view_only clients bypass the control queue entirely — they see the
        # stream and chat but can't send commands. `expired` tracks control
        # codes whose time ran out mid-session; those stay connected as
        # spectators (same UX as view_only from that point on).
        self.clients[cid] = {
            "ws": ws, "code": code, "label": label,
            "auto_label": auto_label,
            "view_only": view_only,
            "expired": False,
        }
        # View-only clients are never queued and never become active.
        if not view_only and cid not in self.queue and cid != self.active_id:
            self.queue.append(cid)
        await log_event("session", "guest_joined", actor=f"guest:{label}", target=code)
        if not view_only:
            await self.promote()
        await self.broadcast_presence()

    async def remove_client(self, cid: str):
        if cid in self.queue:
            self.queue.remove(cid)
        if self.active_id == cid:
            client = self.clients.get(cid)
            code = client["code"] if client else None
            # Stop the device immediately — we can't tell a refresh from a
            # deliberate close, so the machine must never keep running
            # unattended. The grace period preserves session state so a
            # browser refresh can resume; it does NOT keep the machine moving.
            await self.send_to_host({"type": "command", "cmd": "set:speed:0"})
            self._update_motion(0)  # stop the run-time accumulator too
            # Freeze the turn clock at this moment so the guest isn't charged
            # for time spent disconnected during the grace window.
            if self.active_paused_at is None:
                self.active_paused_at = time.monotonic()
            # Remove from clients map immediately (the WS is gone) but don't
            # end the turn yet — start a grace period so a browser refresh
            # reconnects cleanly and can resume from the paused state.
            self.clients.pop(cid, None)
            self.typing_at.pop(cid, None)
            if code and code not in self.disconnect_grace:
                task = asyncio.create_task(self._grace_expire(code))
                self.disconnect_grace[code] = task
            await self.broadcast_presence()
            return
        self.clients.pop(cid, None)
        self.typing_at.pop(cid, None)
        await self.broadcast_presence()

    async def handle_command(self, cid: str, cmd: str):
        if cid != self.active_id:
            return
        if not is_valid_command(cmd):
            return
        # meta:program commands are state-only — they are NOT forwarded to the
        # host/device. They just record what auto-program the guest is running
        # so the overlay and admin can show it.
        if cmd.startswith("meta:program:"):
            slug = cmd.split(":", 2)[2]
            self.active_program = slug if slug else None
            await self.push_telemetry()
            return
        for out_cmd in self.clamp_command(cmd):
            m = re.match(r'^set:(speed|stroke|depth|sensation):(\d+)$', out_cmd)
            if m:
                self.telemetry[m.group(1)] = int(m.group(2))
                if m.group(1) == "speed":
                    self._update_motion(int(m.group(2)))
            pm = re.match(r'^set:pattern:(\d+)$', out_cmd)
            if pm:
                self.telemetry["pattern"] = int(pm.group(1))
            await self.send_to_host({"type": "command", "cmd": out_cmd})
        await self.push_telemetry()

    async def handle_toy_command(self, cid: str, cmd: str):
        """Relay a toy command from the active guest to the owner's browser.
        Owner-side `useToys` interprets it against the actual Intiface client."""
        if cid != self.active_id:
            return
        if not is_valid_toy_command(cmd):
            return
        if not self.toys_available:
            return  # owner isn't hosting any toys — silently drop
        if self.toys_locked:
            return  # owner has paused guest toy control
        if cmd.startswith("toy:pattern:"):
            self.toys_pattern = cmd.split(":", 2)[2]
        elif cmd == "toy:stop" or cmd.startswith("toy:vibrate:"):
            # A direct nudge or stop clears the "running pattern" indicator.
            self.toys_pattern = None
        await self.send_to_host({"type": "toy_command", "cmd": cmd})

    CHAT_MAX_LEN = 250
    CHAT_HISTORY = 50
    CHAT_MIN_GAP = 1.0  # seconds between messages from the same sender

    def _rate_limit(self, sender_id: str) -> bool:
        now = time.monotonic()
        last = self.chat_last_sent.get(sender_id, 0.0)
        if now - last < self.CHAT_MIN_GAP:
            return False
        self.chat_last_sent[sender_id] = now
        return True

    async def _append_chat(self, author: str, role: str, text: str, sender_id: str) -> Optional[dict]:
        text = (text or "").strip()
        if not text:
            return None
        if len(text) > self.CHAT_MAX_LEN:
            text = text[: self.CHAT_MAX_LEN]
        if not self._rate_limit(sender_id):
            return None
        msg = {
            "id": secrets.token_hex(6),
            "author": author,
            "role": role,
            "text": text,
            "ts": datetime.now(timezone.utc).isoformat(),
            # Reactions: {emoji: [author_label, …]}. Toggled per-viewer via
            # the `chat_react` WS event.
            "reactions": {},
        }
        self.chat_msgs.append(msg)
        if len(self.chat_msgs) > self.CHAT_HISTORY:
            self.chat_msgs = self.chat_msgs[-self.CHAT_HISTORY :]
        # Fan out to everyone connected.
        frame = {"type": "chat_msg", "message": msg}
        await self.send_to_host(frame)
        for c in list(self.clients.values()):
            await self._send(c["ws"], frame)
        await self.push_chat_overlay(frame)
        # Bump per-session chat count so the recap picks it up.
        if role == "guest":
            cid = sender_id[2:] if sender_id.startswith("g:") else sender_id
            stats = self.session_stats.get(cid)
            if stats is not None:
                stats["chat_count"] = stats.get("chat_count", 0) + 1
        return msg

    async def handle_guest_chat(self, cid: str, text: str):
        client = self.clients.get(cid)
        if not client:
            return
        # Moderation: silently drop chat from a muted access code.
        if client.get("code", "").upper() in self.muted_codes:
            return
        author = self._safe_label(client)
        await self._append_chat(author=author, role="guest", text=text, sender_id=f"g:{cid}")

    async def handle_owner_chat(self, text: str):
        await self._append_chat(author=self.owner_name, role="owner", text=text, sender_id="owner")

    def client_status(self, cid: str) -> dict:
        client = self.clients.get(cid)
        # View-only or time-expired clients are permanent spectators — they
        # never queue and never gain control, but stay connected to watch.
        if client and (client.get("view_only") or client.get("expired")):
            return {"status": "spectator", "position": -1, "remaining_seconds": 0}
        if cid == self.active_id:
            return {"status": "active", "position": 0, "remaining_seconds": self.active_remaining()}
        if cid in self.queue:
            return {"status": "waiting", "position": self.queue.index(cid) + 1,
                    "remaining_seconds": 0}
        return {"status": "idle", "position": -1, "remaining_seconds": 0}

    @staticmethod
    def _safe_label(c: dict) -> str:
        # What other guests are allowed to see: never the raw access code.
        return "Guest" if c.get("auto_label") else c["label"]

    def public_state(self, for_guests: bool = False) -> dict:
        active_label = None
        if self.active_id and self.active_id in self.clients:
            active_client = self.clients[self.active_id]
            active_label = self._safe_label(active_client) if for_guests else active_client["label"]
        queue_view = []
        for i, cid in enumerate(self.queue):
            c = self.clients.get(cid)
            if c:
                label = self._safe_label(c) if for_guests else c["label"]
                queue_view.append({"label": label, "position": i + 1})
        return {
            "host_connected": self.host_ws is not None,
            "device_state": self.device_state,
            "active": {"label": active_label, "remaining_seconds": self.active_remaining()} if self.active_id else None,
            "queue": queue_view,
            "queue_length": len(self.queue),
            "limits": self.limits,
            "toys": {"available": self.toys_available, "pattern": self.toys_pattern, "locked": self.toys_locked},
            "telemetry": {
                "speed": self.telemetry.get("speed", 0),
                "depth": self.telemetry.get("depth", 0),
                "stroke": self.telemetry.get("stroke", 0),
                "sensation": self.telemetry.get("sensation", 0),
                "pattern": self.telemetry.get("pattern", 0),
                "active_program": self.active_program,
            },
        }

    async def broadcast(self):
        # host sees real labels (owner already has codes on Manage Codes)
        host_base = self.public_state(for_guests=False)
        await self.send_to_host({"type": "state", **host_base})
        # guests only ever see sanitized labels for OTHER people in the
        # queue/active slot — their own code is never echoed back to anyone
        # but themselves via the top-level "label" field below.
        guest_base = self.public_state(for_guests=True)
        for cid, c in list(self.clients.items()):
            payload = {"type": "state", **guest_base, "you": self.client_status(cid), "label": c["label"]}
            await self._send(c["ws"], payload)

    # Flush active-turn elapsed time to Mongo this often. A backend restart
    # (or crash) loses at most this many seconds of the guest's remaining
    # time — they auto-reconnect after and pick up the rest.
    FLUSH_INTERVAL_S = 5
    CLIENT_PING_INTERVAL_S = 15  # how often to probe each guest WS for liveness

    async def _flush_active_used_seconds(self) -> None:
        """Persist unwritten elapsed seconds of the current turn.
        Called every FLUSH_INTERVAL_S from tick(); reads state without the
        Hub lock (already held by the caller).
        """
        if self.active_id is None or self.active_start is None:
            return
        client = self.clients.get(self.active_id)
        if client is None:
            return
        elapsed = int(time.monotonic() - self.active_start)
        consumed = min(elapsed, self.active_remaining_start)
        delta = consumed - self.active_flushed
        if delta <= 0:
            return
        try:
            await db.access_codes.update_one(
                {"code": client["code"]},
                {"$inc": {"used_seconds": delta},
                 "$set": {"last_used_at": datetime.now(timezone.utc).isoformat()}},
            )
            self.active_flushed = consumed
        except Exception as e:
            logger.error(f"used_seconds flush failed: {e}")

    async def tick(self):
        async with self.lock:
            # While a turn is paused (guest disconnected, in grace window) the
            # clock is frozen — don't expire the turn or flush used seconds.
            paused = self.active_paused_at is not None
            if not paused and self.active_id is not None and self.active_remaining() <= 0:
                await self.end_active("time_up")
                await self.promote()
            # Persist the running clock so a restart doesn't hand the guest
            # back all their spent time.
            if not paused and self.active_id is not None and self.active_start is not None:
                elapsed = int(time.monotonic() - self.active_start)
                if elapsed - self.active_flushed >= self.FLUSH_INTERVAL_S:
                    await self._flush_active_used_seconds()
            # Snapshot the current speed onto the active guest's recap
            # accumulator once per tick so we can compute avg/peak later.
            self._record_speed_sample()
            await self.broadcast()
            await self.push_telemetry()
            # Probe guest connections for liveness at a fixed interval.
            # Remote clients that dropped without a clean TCP FIN (mobile
            # network switch, tab crash, silent NAT expiry) never raise
            # WebSocketDisconnect. Attempting a small send catches them.
            now = time.monotonic()
            stale_cids = []
            for cid, client in list(self.clients.items()):
                last_ping = client.get("_last_ping", 0)
                if now - last_ping >= self.CLIENT_PING_INTERVAL_S:
                    client["_last_ping"] = now
                    try:
                        await client["ws"].send_json({"type": "ping"})
                    except Exception:
                        stale_cids.append(cid)
            for cid in stale_cids:
                logger.info(f"evicting stale client {cid} (liveness ping failed)")
                await self.remove_client(cid)
            if stale_cids:
                await self.broadcast()
