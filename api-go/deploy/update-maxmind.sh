#!/usr/bin/env bash
set -euo pipefail

data_dir="/opt/ipflag-api/current/data"
credentials_file="/etc/ipflag-api/maxmind.env"

if [[ ! -r "$credentials_file" ]]; then
  echo "MaxMind credentials file is missing: $credentials_file" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$credentials_file"
: "${MAXMIND_ACCOUNT_ID:?MAXMIND_ACCOUNT_ID is required}"
: "${MAXMIND_LICENSE_KEY:?MAXMIND_LICENSE_KEY is required}"

work_dir="$(mktemp -d /tmp/ipflag-maxmind.XXXXXX)"
trap 'rm -rf "$work_dir"' EXIT

install -d -o www-data -g www-data -m 0750 "$data_dir"

for edition in City ASN; do
  database="GeoLite2-${edition}"
  archive="$work_dir/${database}.tar.gz"
  extract_dir="$work_dir/${database}"
  url="https://download.maxmind.com/geoip/databases/${database}/download?suffix=tar.gz"

  curl --fail --location --silent --show-error --retry 3 \
    --user "${MAXMIND_ACCOUNT_ID}:${MAXMIND_LICENSE_KEY}" \
    "$url" -o "$archive"
  mkdir -p "$extract_dir"
  tar -xzf "$archive" -C "$extract_dir"

  source_file="$(find "$extract_dir" -type f -name "${database}.mmdb" -print -quit)"
  if [[ -z "$source_file" ]]; then
    echo "${database}.mmdb was not found in the downloaded archive" >&2
    exit 1
  fi

  target="$data_dir/${database}.mmdb"
  install -o www-data -g www-data -m 0640 "$source_file" "${target}.tmp"
  mv "${target}.tmp" "$target"
done

systemctl try-restart ipflag-api.service
echo "MaxMind GeoLite2 City and ASN databases updated"
