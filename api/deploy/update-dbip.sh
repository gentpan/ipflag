#!/usr/bin/env bash
set -euo pipefail

data_dir="/opt/ipflag-api/current/data"
month="$(date -u +%Y-%m)"

install -d -o www-data -g www-data -m 0750 "$data_dir"

for database in city asn; do
  url="https://download.db-ip.com/free/dbip-${database}-lite-${month}.mmdb.gz"
  tmp="${data_dir}/dbip-${database}-lite-${month}.mmdb.gz.tmp"
  target="${data_dir}/dbip-${database}-lite-${month}.mmdb"
  curl --fail --location --silent --show-error --retry 3 "$url" -o "$tmp"
  gunzip -c "$tmp" > "${target}.tmp"
  rm -f "$tmp"
  chown www-data:www-data "${target}.tmp"
  chmod 0640 "${target}.tmp"
  mv "${target}.tmp" "$target"
  ln -sfn "$target" "${data_dir}/dbip-${database}-lite.mmdb"
done

chown -h www-data:www-data "${data_dir}/dbip-city-lite.mmdb"
systemctl try-restart ipflag-api.service
