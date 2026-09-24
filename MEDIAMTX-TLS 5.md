# TLS for MediaMTX — HTTPS front so the app can embed the stream

The Kinkology app is served over HTTPS. Browsers block an HTTPS page from
calling an `http://` endpoint (mixed content), so the MediaMTX WHEP endpoint
must be HTTPS before the app's viewer can use it. This puts **Caddy** on the VPS
as a reverse proxy in front of MediaMTX — Caddy auto-gets a Let's Encrypt cert
and terminates TLS, proxying to MediaMTX's plain HTTP port.

```
Browser (HTTPS) ──▶ Caddy :443 (TLS, auto-cert) ──▶ MediaMTX :8889 (HTTP)
                     on the VPS
```

Prerequisite: a **DNS name pointing at the VPS** (`85.190.108.159`). Caddy needs
a hostname to get a certificate — you can't get a public TLS cert for a bare IP.

---

## PART A — Point a subdomain at the VPS

You already use `tg30.ddns.net`. Create a **separate subdomain for the stream**
so it's independent of your home IP:

- **If your DDNS provider supports subdomains / a second host:** create
  `stream.tg30.ddns.net` (or any name) pointing at `85.190.108.159`.
- **If not:** register a cheap domain (or use a free one from DuckDNS/etc.) and
  add an **A record** → `85.190.108.159`. Example with DuckDNS: `kinkstream.duckdns.org`.

Verify it resolves to the VPS before continuing:

```bash
dig +short stream.tg30.ddns.net    # should print 85.190.108.159
```

The rest of this guide uses `stream.tg30.ddns.net` — swap in your actual name.

---

## PART B — Install Caddy on the VPS

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
```

---

## PART C — Configure Caddy to front MediaMTX

MediaMTX serves WHEP over HTTP on :8889. Caddy will terminate TLS on :443 and
proxy to it.

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
stream.tg30.ddns.net {
    # Reverse-proxy the WebRTC/WHEP HTTP endpoint. WHEP is plain HTTP
    # (SDP over POST) so a normal reverse_proxy works.
    reverse_proxy 127.0.0.1:8889
}
EOF

sudo systemctl restart caddy
sudo systemctl status caddy --no-pager
```

Caddy automatically requests a Let's Encrypt certificate for
`stream.tg30.ddns.net` on first start. Watch it succeed:

```bash
sudo journalctl -u caddy -n 30 --no-pager | grep -iE 'certificate|obtain|error'
```

You want to see it obtained a certificate. If it errors about the challenge,
see the firewall note below.

---

## PART D — Firewall: open 80 and 443

Caddy needs **80** (for the ACME HTTP challenge / redirect) and **443** (HTTPS):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

Open **80/tcp and 443/tcp** in the VPS provider's cloud firewall too. Port 80
must be reachable for Let's Encrypt to issue the cert — if it's blocked, the
cert request fails.

> Note: the WebRTC MEDIA still flows over UDP 8189 directly to MediaMTX (not
> through Caddy) — Caddy only fronts the HTTP signalling/SDP. So keep 8189/udp
> open as before. Caddy is just for the TLS handshake on the WHEP URL.

---

## PART E — Test HTTPS

Open in a browser:

```
https://stream.tg30.ddns.net/live_webrtc
```

- Padlock shows secure ✅
- The stream plays (with OBS publishing) ✅

If both, TLS is working.

---

## PART F — Point Kinkology at the HTTPS WHEP URL

In the Kinkology admin → **Base URLs** panel → **EXTERNAL WHEP URL**:

```
https://stream.tg30.ddns.net/live_webrtc/whep
```

(or `https://stream.tg30.ddns.net/live/whep` for the video-only, lowest-latency
path). Save. Reload a viewer — it now connects to MediaMTX over HTTPS, no
mixed-content block, no built-in relay.

---

## Troubleshooting

- **Cert won't issue:** port 80 not reachable from the internet (cloud firewall).
  Let's Encrypt's HTTP-01 challenge needs inbound 80. Confirm with
  `sudo journalctl -u caddy -f` while restarting Caddy.
- **502 Bad Gateway from Caddy:** MediaMTX isn't running or isn't on :8889.
  Check `sudo systemctl status mediamtx` and `sudo ss -tlnp | grep 8889`.
- **Page loads but video is black over HTTPS:** the WebRTC media (UDP 8189) is
  blocked even though the HTTPS signalling works — open 8189/udp in both ufw and
  the cloud firewall.
- **Mixed content still blocked:** make sure the WHEP URL in the admin is
  `https://` (not `http://`) and matches the Caddy hostname exactly.

---

## Optional: also proxy the WHIP publish path

If you later want to publish over WHIP (instead of RTMP) via HTTPS, the same
Caddy site already proxies it — MediaMTX serves WHIP at
`https://stream.tg30.ddns.net/live/whip`. RTMP ingest (port 1935) is unaffected
by Caddy and continues to work as-is for OBS.
