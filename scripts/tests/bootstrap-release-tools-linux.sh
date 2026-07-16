#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

test "$(uname -s)" = "Linux" || {
  echo "bootstrap-release-tools: Linux is required" >&2
  exit 2
}
test "$(uname -m)" = "x86_64" || {
  echo "bootstrap-release-tools: x86_64 is required" >&2
  exit 2
}
test "$(id -u)" -ne 0 || {
  echo "bootstrap-release-tools: refuse to install release tools as root" >&2
  exit 2
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TOOLS_ROOT="${STOCKS_RELEASE_TOOLS_ROOT:-$HOME/.cache/stocks-release-tools}"
DOWNLOADS="$TOOLS_ROOT/downloads"
BUILD="$TOOLS_ROOT/build"
NODE_VERSION="20.20.2"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256="df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d"
NODE_HOME="$TOOLS_ROOT/node-v${NODE_VERSION}-linux-x64"
PG_VERSION="14.22"
PG_ARCHIVE="postgresql-${PG_VERSION}.tar.bz2"
PG_SHA256="f57938ad30067077720277f6d7db05aafc07d1545efd2ed82f199ba828a7ad34"
PG_SOURCE="$TOOLS_ROOT/postgresql-${PG_VERSION}"
PG_BUILD="$BUILD/postgresql-${PG_VERSION}"
PG_HOME="$TOOLS_ROOT/postgresql-${PG_VERSION}-install"
PYTHON_VENV="$TOOLS_ROOT/python-3.11-release"
PYTHON_EXECUTABLE="${STOCKS_RELEASE_PYTHON:-python3}"
REQUIREMENTS="$ROOT/scripts/tests/requirements-release-linux-x86_64.txt"

mkdir -p "$DOWNLOADS" "$BUILD"

download_verified() {
  local url="$1"
  local destination="$2"
  local expected="$3"
  if test ! -f "$destination"; then
    local temporary="${destination}.part.$$"
    trap 'rm -f "$temporary"' RETURN
    curl --fail --location --proto '=https' --tlsv1.2 \
      --retry 3 --retry-delay 2 --output "$temporary" "$url"
    printf '%s  %s\n' "$expected" "$temporary" | sha256sum --check --status
    mv "$temporary" "$destination"
    trap - RETURN
  fi
  printf '%s  %s\n' "$expected" "$destination" | sha256sum --check --status
}

download_verified \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
  "$DOWNLOADS/$NODE_ARCHIVE" \
  "$NODE_SHA256"
if test ! -x "$NODE_HOME/bin/node"; then
  tar -xJf "$DOWNLOADS/$NODE_ARCHIVE" -C "$TOOLS_ROOT"
fi
test "$($NODE_HOME/bin/node --version)" = "v${NODE_VERSION}"
for binary in npm npx; do
  test -x "$NODE_HOME/bin/$binary" || {
    echo "bootstrap-release-tools: Node archive is missing $binary" >&2
    exit 2
  }
done

download_verified \
  "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/${PG_ARCHIVE}" \
  "$DOWNLOADS/$PG_ARCHIVE" \
  "$PG_SHA256"
if test ! -x "$PG_HOME/bin/postgres"; then
  if test ! -x "$PG_SOURCE/configure"; then
    tar -xjf "$DOWNLOADS/$PG_ARCHIVE" -C "$TOOLS_ROOT"
  fi
  mkdir -p "$PG_BUILD"
  (
    cd "$PG_BUILD"
    "$PG_SOURCE/configure" \
      --prefix="$PG_HOME" \
      --without-icu \
      --without-readline \
      --without-zlib
    make -j"$(getconf _NPROCESSORS_ONLN)"
    make install
  )
fi
test "$($PG_HOME/bin/postgres --version)" = "postgres (PostgreSQL) ${PG_VERSION}"
for binary in psql initdb pg_ctl createdb dropdb; do
  test -x "$PG_HOME/bin/$binary" || {
    echo "bootstrap-release-tools: PostgreSQL install is missing $binary" >&2
    exit 2
  }
done

test -r "$REQUIREMENTS"
test "$($PYTHON_EXECUTABLE -c 'import platform, sys; print(platform.python_implementation() + " " + ".".join(map(str, sys.version_info[:2])))')" = "CPython 3.11" || {
  echo "bootstrap-release-tools: CPython 3.11 is required" >&2
  exit 2
}
if test ! -x "$PYTHON_VENV/bin/python"; then
  "$PYTHON_EXECUTABLE" -m venv "$PYTHON_VENV"
fi
test "$($PYTHON_VENV/bin/python -c 'import platform, sys; print(platform.python_implementation() + " " + ".".join(map(str, sys.version_info[:2])))')" = "CPython 3.11"
"$PYTHON_VENV/bin/python" -m pip install \
  --disable-pip-version-check \
  --require-hashes \
  --only-binary=:all: \
  --requirement "$REQUIREMENTS"

printf 'NODE_HOME=%s\nPG_HOME=%s\nPYTHON_VENV=%s\n' \
  "$NODE_HOME" "$PG_HOME" "$PYTHON_VENV"
