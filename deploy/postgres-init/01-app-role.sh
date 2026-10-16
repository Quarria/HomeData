#!/bin/sh
set -eu
escaped_password=$(printf "%s" "$POSTGRES_APP_PASSWORD" | sed "s/'/''/g")
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --command="CREATE ROLE homedata_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${escaped_password}';"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --command='GRANT CONNECT ON DATABASE homedata TO homedata_app; GRANT USAGE, CREATE ON SCHEMA public TO homedata_app;'
