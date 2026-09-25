#!/usr/bin/env bash
#
# No-IP DDNS updater for kinkology.ddns.net (and any other ddns.net hostnames).
#
# WHY: on Sep 24 the site was unreachable for 11h because the DDNS record went
# stale — nothing was keeping kinkology.ddns.net pointed at the VPS. This script
# re-asserts the record on a schedule so it can never drift again. No-IP also
# EXPIRES a hostname that isn't updated for ~30 days, so a periodic update also
# keeps the free hostname alive.
#
# It calls No-IP's update API (https://www.noip.com/integrate/request), which is
# a simple authenticated HTTPS GET. It updates to the IP No-IP sees as the
# source of the request (the VPS's own public IP) unless you pass myip.
#
# CREDENTIALS: never hardcode them. Put them in /etc/kinkology-ddns.env (root
# only, chmod 600):
#     NOIP_USER=your-noip-username-or-DDNS-key
#     NOIP_PASS=your-noip-password-or-DDNS-key-password
#     NOIP_HOSTS=kinkology.ddns.net,streamtg30.ddns.net
# No-IP recommends creating a "DDNS Key" (Dynamic DNS > DDNS Keys) and using that
# as USER/PASS instead of your account login — it's scoped to DNS updates only.
#
# INSTALL (on the VPS):
#   1. sudo install -m 755 ddns-update.sh /usr/local/bin/ddns-update.sh
#   2. sudoedit /etc/kinkology-ddns.env   # add the three lines above
#      sudo chmod 600 /etc/kinkology-ddns.env
#   3. Test once:  sudo /usr/local/bin/ddns-update.sh
#   4. Cron every 5 min (as root):  sudo crontab -e
#        */5 * * * * /usr/local/bin/ddns-update.sh >> /var/log/kinkology-ddns.log 2>&1
#
set -euo pipefail

ENV_FILE="${DDNS_ENV_FILE:-/etc/kinkology-ddns.env}"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "[$(date -Is)] ERROR: env file $ENV_FILE not found/readable." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${NOIP_USER:?NOIP_USER not set in $ENV_FILE}"
: "${NOIP_PASS:?NOIP_PASS not set in $ENV_FILE}"
: "${NOIP_HOSTS:?NOIP_HOSTS not set in $ENV_FILE (comma-separated hostnames)}"

# No-IP wants a descriptive User-Agent (they rate-limit generic ones).
UA="KinkologyDDNS/1.0 admin@kinkology"

# One request can carry multiple comma-separated hostnames.
resp="$(curl -fsS \
  --user "${NOIP_USER}:${NOIP_PASS}" \
  --user-agent "$UA" \
  "https://dynupdate.no-ip.com/nic/update?hostname=${NOIP_HOSTS}" || true)"

echo "[$(date -Is)] update ${NOIP_HOSTS} -> ${resp:-<no response>}"

# Interpret the No-IP response codes.
case "$resp" in
  good*|nochg*)
    # good = updated, nochg = already correct. Both are success.
    exit 0
    ;;
  nohost*|badauth*|badagent*|abuse*|"911"*)
    echo "[$(date -Is)] ERROR from No-IP: $resp (check credentials/hostname)" >&2
    exit 2
    ;;
  *)
    echo "[$(date -Is)] WARNING: unexpected No-IP response: $resp" >&2
    exit 0  # don't hard-fail the cron on an unknown-but-non-error reply
    ;;
esac
