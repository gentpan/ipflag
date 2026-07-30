# IP Flag Geo API (legacy reference)

The production service is now the statically compiled Go implementation in
[`../api-go/`](../api-go/). This directory is retained as a reference adapter.

The service exposes the extension-compatible normalized response shape:

- `GET /domain/example.com`
- `GET /ip/8.8.8.8`
- `GET /health`

DB-IP Lite city and ASN MMDB files are loaded from `data/dbip-city-lite.mmdb`
and `data/dbip-asn-lite.mmdb`. The production Go API also adds SSL certificate
dates to domain responses and omits provider/source labels from public output.

Environment variables:

- `PORT` (default `4320`)
- `HOST` (default `127.0.0.1`)
- `DBIP_MMDB_PATH`
- `IP2LOCATION_DB_PATH`
- `RATE_LIMIT` (requests per minute per client, default `120`)
