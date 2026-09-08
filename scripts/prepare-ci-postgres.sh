#!/usr/bin/env bash
set -euo pipefail
umask 077

# Build only the pinned official source in this job's private temporary space.
# This never installs globally or gives the CI account access to Docker.
version=16.14
checksum=f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471
temporary_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
[[ "$temporary_parent" = /* && -d "$temporary_parent" ]]
build_root="$(mktemp -d "${temporary_parent%/}/kordi-ci-postgres.XXXXXX")"
[[ "$build_root" != *$'\n'* && "$build_root" != *$'\r'* ]]
chmod 700 "$build_root"
archive="$build_root/postgresql.tar.bz2"
build_log="$build_root/build.log"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 3 "https://ftp.postgresql.org/pub/source/v${version}/postgresql-${version}.tar.bz2" \
  --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 --check --status
tar -xjf "$archive" -C "$build_root"
(
  cd "$build_root/postgresql-$version"
  ./configure --prefix="$build_root/install" --without-icu --without-readline --without-zlib
  make -j2
  make install
) >"$build_log" 2>&1 || {
  printf '%s\n' 'PostgreSQL build failed; diagnostics remain in the private job temporary directory.' >&2
  exit 1
}
postgres_bin="$build_root/install/bin"
[[ "$("$postgres_bin/postgres" --version)" == "postgres (PostgreSQL) $version" ]]
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'KORDI_MIGRATION_PG_BIN=%s\n' "$postgres_bin" >> "$GITHUB_ENV"
fi
printf '%s\n' 'Pinned PostgreSQL 16.14 prepared in private job temporary space.'
