#!/bin/bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "Usage: sudo bash deploy/https/setup.sh DOMAIN EMAIL" >&2
  exit 2
fi
domain=$1
email=$2
if [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ || "$email" != *@* ]]; then
  echo "Invalid domain or email." >&2
  exit 2
fi
if [[ $EUID != 0 ]]; then
  echo "Run as root or with sudo." >&2
  exit 2
fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "$(pwd -P)" != /home/homedata/app/current/deploy ]]; then
  echo "This deployment uses /home/homedata/app/current/deploy. Adjust the renewal hook before using another path." >&2
  exit 2
fi
command -v certbot >/dev/null
command -v curl >/dev/null
test -f .env
test -f runtime.env
if [[ -f compose.override.yaml ]] && ! grep -q '^# Managed by HomeData HTTPS\.' compose.override.yaml; then
  echo "Existing custom Compose override found; merge it before setup." >&2
  exit 1
fi
if [[ -f compose.override.yaml ]] && grep -q 'nginx-https.conf' compose.override.yaml; then
  echo "HTTPS already configured. Use certbot renew and the installed deploy hook." >&2
  exit 1
fi

install -d -m 755 /home/docker/homedata/acme/.well-known/acme-challenge
install -d -m 755 /home/docker/homedata/tls
install -m 644 https/bootstrap.override.yaml compose.override.yaml
docker compose --env-file .env config --quiet
docker compose --env-file .env run --rm --no-deps web nginx -t
docker compose --env-file .env up -d --no-deps --no-build web

probe="homedata-$(date +%s)-$$"
probe_path="/home/docker/homedata/acme/.well-known/acme-challenge/$probe"
printf '%s' "$probe" > "$probe_path"
trap 'rm -f -- "$probe_path"' EXIT
actual=$(curl --fail --silent --show-error --location --max-time 30 \
  --retry 3 --retry-delay 1 --retry-connrefused \
  "http://$domain/.well-known/acme-challenge/$probe")
if [[ "$actual" != "$probe" ]]; then
  echo "Public ACME challenge did not reach this server. Check DNS, proxy rules and port 80." >&2
  exit 1
fi

# Prove reachability with the staging CA before requesting a production certificate.
certbot certonly --dry-run --webroot -w /home/docker/homedata/acme \
  --cert-name "$domain" -d "$domain" --email "$email" --agree-tos --non-interactive
certbot certonly --webroot -w /home/docker/homedata/acme \
  --cert-name "$domain" -d "$domain" --email "$email" --agree-tos --non-interactive
test -s "/etc/letsencrypt/live/$domain/fullchain.pem"
test -s "/etc/letsencrypt/live/$domain/privkey.pem"

sed "s/__TLS_DOMAIN__/$domain/g" https/nginx-https.conf.template \
  > /home/docker/homedata/tls/nginx-https.conf
chmod 644 /home/docker/homedata/tls/nginx-https.conf
install -m 644 https/compose.override.yaml compose.override.yaml
if ! docker compose --env-file .env config --quiet || \
   ! docker compose --env-file .env run --rm --no-deps web nginx -t; then
  install -m 644 https/bootstrap.override.yaml compose.override.yaml
  echo "HTTPS config validation failed; HTTP bootstrap config preserved." >&2
  exit 1
fi
if ! docker compose --env-file .env up -d --no-deps --no-build web; then
  install -m 644 https/bootstrap.override.yaml compose.override.yaml
  docker compose --env-file .env up -d --no-deps --no-build web
  echo "HTTPS start failed; restored HTTP entry point." >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 10 \
  --retry 5 --retry-delay 1 --retry-connrefused \
  --resolve "$domain:443:127.0.0.1" "https://$domain/api/v1/health/ready" > /dev/null

install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -m 750 https/reload-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/homedata-nginx
systemctl enable --now certbot.timer
certbot renew --cert-name "$domain" --dry-run --run-deploy-hooks --non-interactive
echo "HTTPS_SETUP_COMPLETE: verify public port 443 before switching Cloudflare to DNS-only."
