#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v postgres >/dev/null; then
  export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
fi
command -v initdb >/dev/null || { echo 'PostgreSQL binaries required.'; exit 1; }
cluster=$(mktemp -d "${TMPDIR:-/tmp}/cranberries-pg.XXXXXX")
port=$((56000 + RANDOM % 7000))
cleanup() { pg_ctl -D "$cluster" -m fast stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
initdb -D "$cluster" -A trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$cluster" -l "$cluster/server.log" -o "-p $port -h 127.0.0.1 -c wal_level=logical" start >/dev/null
psql -h 127.0.0.1 -p "$port" -d postgres -v ON_ERROR_STOP=1 -f test/bootstrap.sql -f sql/001_document_views.sql -f sql/002_longtext.sql -f sql/003_modified.sql -f test/legacy.sql -f sql/004_adaptors.sql -f sql/005_title.sql >/dev/null
# The same migrations must also install cleanly into a schema of their own.
node scripts/sql.js elsewhere | psql -h 127.0.0.1 -p "$port" -d postgres -v ON_ERROR_STOP=1 >/dev/null
DV_TEST_DATABASE_URL="postgres://$(id -un)@127.0.0.1:$port/postgres" npm run test:db
# The stopped cluster and log are retained in the temporary directory for diagnosis.
