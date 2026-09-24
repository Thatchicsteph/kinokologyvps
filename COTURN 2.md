# Dedicated coturn TURN server — full setup

A self-hosted TURN relay for Kinkology's WebRTC stream. Use this when the
Cloudflare shared relay is too slow/throttled and home port-forwarding won't
give you a direct path. Both the publisher and every viewer connect **outbound**
to this server, so there is no inbound port-forwarding on your home network at
all — the whole home-router problem disappears.

The server is cheap to run: a relay just shuffles packets, so a tiny VPS is
plenty. What matters is **bandwidth allowance**, not CPU/RAM.

---

## 0. Pick and provision a VPS

- **Size:** the smallest tier anywhere (1 vCPU / 1 GB, even 512 MB) is enough.
- **Bandwidth is the real cost:** relayed 1080p ≈ ~8 Mbps per viewer (in+out).
  ~1 GB every ~17 min per viewer. Pick a plan with a large monthly transfer
  allowance (Hetzner 20 TB, Oracle free tier 10 TB, DO/Vultr 1–2 TB).
- **Location:** put it near your VIEWERS, not near you — that minimises the
  relay-hop latency.
- **OS:** Ubuntu 22.04 or 24.04 LTS (commands below assume this).

You will need:
- The VPS's **public IP** — referred to below as `YOUR_VPS_IP`.
- (Optional) a DNS name pointing at it, e.g. `turn.example.com`, if you want TLS.

---

## 1. Open the firewall ports

TURN needs these reachable from the internet. Do this in BOTH your VPS
provider's control-panel firewall AND the on-box firewall.

| Port | Proto | Purpose |
|------|-------|---------|
| 3478 | UDP + TCP | STUN/TURN (primary) |
| 5349 | UDP + TCP | TURN over TLS (helps viewers behind strict firewalls) |
| 49152–65535 | UDP | Relay media port range |

On-box with ufw (Ubuntu):

```bash
sudo ufw allow 22/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
sudo ufw enable
```

> Also add the same rules in your VPS provider's cloud firewall / security group
> — many providers block everything by default at the network edge.

---

## 2. Install coturn

```bash
sudo apt update
sudo apt install -y coturn
```

Enable the service so it starts on boot:

```bash
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

---

## 3. Choose a TURN password

We use static long-term credentials (`lt-cred-mech`): a fixed username and
password that Kinkology hands to each viewer. Simple and works with the TURN
env vars already wired into `docker-compose.yml` — no backend change.

Generate a strong password:

```bash
openssl rand -hex 24
```

Copy the output — this is your `TURN_PASSWORD`. You'll paste it into the config
below AND into Kinkology's `.env` as `STREAM_TURN_PASSWORD`. The username is
just `kinkology` (or anything you like, as long as it matches in both places).

> Prefer short-lived credentials over a static password? Skip this and ask me
> to "add the backend endpoint for time-limited TURN credentials" — that uses
> coturn's `use-auth-secret` mode instead. The static path here is the simplest
> and is fine for a private setup.

---

## 4. Write the coturn config

Back up the original, then write the config. This uses static credentials
(`lt-cred-mech`) so it matches the `.env` in step 8 with no code change.

First capture your values into shell variables (so nothing is left as a
placeholder — this is the step people get stuck on):

```bash
VPS_IP=$(curl -s ifconfig.me)
TURN_USER=kinkology
TURN_PASSWORD=$(openssl rand -hex 24)   # or reuse the one from step 3
echo "VPS_IP=$VPS_IP"
echo "TURN_USER=$TURN_USER"
echo "TURN_PASSWORD=$TURN_PASSWORD   <-- SAVE THIS for Kinkology's .env"
```

Then write the file with the values already substituted (unquoted `<<EOF` so the
variables expand):

```bash
sudo mv /etc/turnserver.conf /etc/turnserver.conf.orig 2>/dev/null || true
sudo bash -c "cat > /etc/turnserver.conf <<EOF
# --- Listening ---
listening-port=3478
tls-listening-port=5349

# Relay port range (must match the firewall rule in step 1).
min-port=49152
max-port=65535

# --- Identity ---
external-ip=$VPS_IP
realm=kinkology.turn

# --- Auth: static long-term credentials ---
lt-cred-mech
user=$TURN_USER:$TURN_PASSWORD

# --- Hardening ---
# Don't relay to private/loopback ranges — stops the relay being abused to
# reach internal services (SSRF-style). Keep these.
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

# No CLI / no old TLS.
no-cli
no-tlsv1
no-tlsv1_1

# Logs
verbose
log-file=/var/log/turnserver.log
simple-log
EOF"
```

Verify the values landed (no placeholders, real IP + credentials):

```bash
grep -E 'external-ip|^user=' /etc/turnserver.conf
```

You should see `external-ip=<your VPS IP>` and `user=kinkology:<hex password>`.

---

## 5. (Optional but recommended) TLS on 5349

TLS lets viewers behind corporate/hotel firewalls relay over what looks like
HTTPS. If you have a DNS name pointing at the VPS:

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d turn.example.com
```

Then add to `/etc/turnserver.conf`:

```
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

Certbot auto-renews; coturn re-reads certs on restart. Skip this whole step if
you don't have a domain — plain UDP/TCP 3478 works for most viewers.

---

## 6. Start it

```bash
sudo systemctl restart coturn
sudo systemctl enable coturn
sudo systemctl status coturn --no-pager
```

Check it's listening:

```bash
sudo ss -tulnp | grep -E '3478|5349'
```

You should see coturn (`turnserver`) bound on those ports.

---

## 7. Test the relay works

From ANY machine (your laptop is fine), test allocation with the standard
WebRTC TURN tester:

- Open <https://icetest.info/> or <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>
- Add a server:
  - **URI:** `turn:YOUR_VPS_IP:3478`
  - **Username:** `kinkology`
  - **Credential:** your `TURN_PASSWORD` from step 4
- Click "Gather candidates". If a candidate of type **`relay`** appears, the
  server is working and reachable — that's the whole test.
- Quicker CLI sanity check from the `coturn` package:
  `turnutils_uclient -v -u kinkology -w YOUR_TURN_PASSWORD YOUR_VPS_IP`
  — connection refused = firewall problem; a successful allocation = working.

---

## 8. Point Kinkology at it

The config in step 4 uses static credentials, so this is just three `.env`
lines — no code change. In Kinkology's `.env` (project root on your Mac, next to
`docker-compose.yml`):

```
STREAM_TURN_URL=turn:YOUR_VPS_IP:3478
STREAM_TURN_USERNAME=kinkology
STREAM_TURN_PASSWORD=<the TURN_PASSWORD from step 4>
```

Use your real VPS IP for `YOUR_VPS_IP`. These env vars are already wired into
`docker-compose.yml` and the backend, so just restart the stack:

```bash
docker compose down && docker compose up -d
```

Reconnect a remote viewer and check the diagnostics PATH — it should now relay
through YOUR server instead of Cloudflare's.

> **Want short-lived credentials instead of a static password?** That's more
> secure (a leaked credential expires in minutes). It needs coturn's
> `use-auth-secret` mode plus a small backend endpoint — ask me to "add the
> backend endpoint for time-limited TURN credentials" and I'll wire it in.

---

## 9. Confirm it's working

Reconnect a **remote** viewer (a phone on mobile data is the cleanest test) and
open the stream diagnostics (the activity icon). The **PATH** field should now
read `relay` pointing at YOUR server — and because it's a dedicated relay near
your viewers with no shared-tenant throttling, the quality should be markedly
better than Cloudflare's, and the 1080p / 4 Mbps settings become worth keeping.

---

## Cost & maintenance notes

- **Bandwidth is the meter.** Watch your VPS transfer allowance if you stream
  long sessions or many viewers. 1080p × 2 viewers × 1 hour ≈ ~7 GB.
- **Security:** the `denied-peer-ip` block above is important — without it an
  open TURN server can be abused to relay traffic to internal/other hosts. Keep
  it. Rotate the TURN password (step 4 + `.env`) if you ever suspect a leak.
- **Updates:** `sudo apt update && sudo apt upgrade coturn` periodically.
- coturn survives reboots via `systemctl enable coturn` (step 6).
