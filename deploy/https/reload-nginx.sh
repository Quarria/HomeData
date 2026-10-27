#!/bin/sh
set -eu
cd /home/homedata/app/current/deploy
# Renewing a certificate must not start a site intentionally stopped for maintenance.
if ! docker compose --env-file .env ps --status running --services web | grep -qx web; then
  exit 0
fi
docker compose --env-file .env exec -T web nginx -t
docker compose --env-file .env exec -T web nginx -s reload
