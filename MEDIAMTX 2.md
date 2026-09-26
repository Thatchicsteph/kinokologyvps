# MediaMTX media server — full setup (RTMP in → WebRTC out)

A proper media server on your VPS that fixes the choppy relayed WebRTC. Instead
of every viewer holding a live peer connection through the app's aiortc relay,
you publish **one** clean stream (RTMP — the same protocol that streams fine to
Twitch/YouTube from your machine) into MediaMTX, and MediaMTX fans it out to any
number of watchers over **WebRTC/WHEP** with ~0.5s latency.

```
Publisher (OBS, RTMP)  ─────▶  MediaMTX on VPS  ─────▶  watchers (WebRTC/WHEP)
   one clean upload            does the fan-out          low latency, robust
```

Why this beats the current setup: MediaMTX is a purpose-built Go media server.
The publisher sends one stream (not a peer connection per viewer), and MediaMTX's
WebRTC stack is far more robust than the app's Python aiortc relay. Your uplink
already proved it can push clean RTMP, so the weak link — per-viewer aiortc
relay — is removed entirely.

Runs on the SAME VPS as coturn (85.190.108.159). MediaMTX is a single binary,
near-zero idle cost.

---

## PART A — Install MediaMTX on the VPS

SSH in:

```bash
ssh administrator@85.190.108.159
```

### A1. Download the binary

Grab the latest linux release (check https://github.com/bluenviron/mediamtx/releases
for the current version; this uses a recent one):

```bash
cd /tmp
ARCH=$(uname -m); case "$ARCH" in x86_64) MMX=amd64;; aarch64) MMX=arm64v8;; *) MMX=amd64;; esac
VER=$(curl -s https://api.github.com/repos/bluenviron/mediamtx/releases/latest | grep -oP '"tag_name": "\K[^"]+')
curl -sL "https://github.com/bluenviron/mediamtx/releases/download/${VER}/mediamtx_${VER}_linux_${MMX}.tar.gz" -o mediamtx.tar.gz
tar -xzf mediamtx.tar.gz
sudo mv mediamtx /usr/local/bin/
sudo mkdir -p /etc/mediamtx
sudo mv mediamtx.yml /etc/mediamtx/mediamtx.yml
mediamtx --version
```

### A2. Write the config

This enables RTMP ingest + WebRTC (WHEP) playback, sets the public IP so remote
watchers get a reachable ICE candidate, and protects publishing with a password.

```bash
PUBLISH_PASS=$(openssl rand -hex 16)
echo "SAVE THIS  ->  RTMP publish password: $PUBLISH_PASS"

sudo tee /etc/mediamtx/mediamtx.yml >/dev/null <<EOF
# ---- Global ----
logLevel: info
logDestinations: [stdout]

# ---- RTMP ingest (publisher pushes here) ----
rtmp: yes
rtmpAddress: :1935

# ---- WebRTC playback (watchers pull here) ----
webrtc: yes
webrtcAddress: :8889
# Advertise the VPS public IP so remote watchers get a usable ICE candidate.
webrtcAdditionalHosts: [85.190.108.159]
# Use your coturn as the ICE server for watchers too (already running on 3478).
webrtcICEServers2:
  - url: turn:85.190.108.159:3478
    username: kinkology
    password: PASTE_COTURN_PASSWORD_HERE

# ---- HLS off (WebRTC-only for low latency) ----
hls: no
rtsp: no
srt: no

# ---- Paths (streams) ----
pathDefaults:
  # Anyone can watch; only the publisher (with the pass) can push.
  readUser:
  readPass:
  publishUser: kinkology
  publishPass: $PUBLISH_PASS

paths:
  # The stream key watchers/publisher use: /live
  live:
EOF
```

Then paste your **coturn** password (from the COTURN.md setup) into the
`webrtcICEServers2` block:

```bash
sudo sed -i "s/PASTE_COTURN_PASSWORD_HERE/YOUR_COTURN_PASSWORD/" /etc/mediamtx/mediamtx.yml
grep -E 'publishPass|password:' /etc/mediamtx/mediamtx.yml   # verify both are real
```

### A3. Run MediaMTX as a service

```bash
sudo tee /etc/systemd/system/mediamtx.service >/dev/null <<'EOF'
[Unit]
Description=MediaMTX media server
After=network.target

[Service]
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx
sudo systemctl status mediamtx --no-pager
```

### A4. Open the firewall

```bash
sudo ufw allow 1935/tcp      # RTMP ingest
sudo ufw allow 8889/tcp      # WebRTC signalling (WHEP) + HTTP
sudo ufw allow 8189/udp      # WebRTC media (MediaMTX default UDP mux)
sudo ufw reload
```

Also open these same ports (1935/tcp, 8889/tcp, 8189/udp) in your **VPS
provider's cloud firewall**.

> MediaMTX muxes all WebRTC media over UDP 8189 by default — much simpler than
> coturn's wide range. It can also reuse coturn (configured above) for viewers
> on hard NATs.

---

## PART B — Point the publisher at MediaMTX (RTMP)

You publish with OBS (or any RTMP encoder) — the same clean path that works to
other sites.

**In OBS → Settings → Stream:**
- **Service:** Custom
- **Server:** `rtmp://85.190.108.159:1935/live`
- **Stream Key:** `?user=kinkology&pass=YOUR_PUBLISH_PASS`
  (from step A2 — MediaMTX reads credentials from the stream key query string)

Set the bitrate in OBS to whatever streams cleanly for you elsewhere (e.g.
4000–6000 kbps at 1080p — since only ONE upload leg exists now, you're not
double-paying a relay, so you can push higher quality here).

Start streaming. Confirm MediaMTX received it:

```bash
sudo journalctl -u mediamtx -n 20 --no-pager
```
You should see a line like `[RTMP] [conn] opened` / `is publishing to path 'live'`.

---

## PART C — Watch page (WebRTC/WHEP from MediaMTX)

MediaMTX serves a ready-made WebRTC player. Test it immediately in a browser:

```
http://85.190.108.159:8889/live
```

That's the built-in player — if it plays with low latency from a remote network,
the server side is done. For production you'd embed MediaMTX's WHEP endpoint in
Kinkology's viewer page instead of the app's own `/api/whep`:

- **WHEP URL:** `http://85.190.108.159:8889/live/whep`
- The browser does a standard WHEP handshake (same shape as the app's current
  `ObsStream.jsx` viewer — POST an SDP offer, get an answer).

> **TLS note:** browsers block mixed content — an HTTPS Kinkology page can't
> embed an HTTP WHEP endpoint. Either put MediaMTX behind your Caddy with a TLS
> cert (recommended), or serve the watch page over HTTP for testing. Ask me to
> "wire MediaMTX WHEP into the Kinkology viewer with TLS via Caddy" when you're
> ready to integrate it into the app UI.

---

## PART D — How this changes the app

- **Control commands** (the device driving) stay exactly as they are — that's a
  separate WebSocket path, unaffected.
- **Video** moves off the app's aiortc WHIP/WHEP relay onto MediaMTX. The app's
  overlay/viewer pages get pointed at MediaMTX's WHEP URL instead of `/api/whep`.
- coturn stays useful — MediaMTX uses it (configured in A2) for watchers behind
  hard NATs.

This is the standard broadcast architecture (one ingest, server fan-out) and
directly leverages the clean RTMP upload you confirmed works.

---

## Test checklist

1. `systemctl status mediamtx` → active (running)
2. OBS streaming to `rtmp://85.190.108.159:1935/live` → journalctl shows publish
3. Open `http://85.190.108.159:8889/live` from a REMOTE network (phone on mobile
   data) → plays smoothly, low latency
4. If smooth → integrate the WHEP URL into Kinkology's viewer (Part C TLS note)

## Cost / notes

- MediaMTX idles near-zero CPU/RAM; the cost is bandwidth (one upload in, N
  streams out — the VPS serves the fan-out, so watch your transfer allowance).
- Because there's ONE upload leg (not a relay round-trip per viewer), you can run
  higher quality than the relayed WebRTC allowed — push 1080p from OBS if your
  uplink handles it (it does — you stream fine to other sites).
- Latency: WebRTC/WHEP from MediaMTX is ~0.5s, fine for live control.
