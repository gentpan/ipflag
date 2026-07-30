# IP Flag Geo API

The service exposes the extension-compatible normalized response shape:

- `GET /domain/example.com`
- `GET /ip/8.8.8.8`
- `GET /health`

DB-IP Lite city MMDB is loaded from `data/dbip-city-lite.mmdb`. It is a
monthly, CC BY 4.0 database and must be attributed in web pages that use its
results. If an IP2Location BIN is available, set `IP2LOCATION_DB_PATH`; it is
queried first and DB-IP fills missing fields.

Environment variables:

- `PORT` (default `4320`)
- `HOST` (default `127.0.0.1`)
- `DBIP_MMDB_PATH`
- `IP2LOCATION_DB_PATH`
- `RATE_LIMIT` (requests per minute per client, default `120`)
