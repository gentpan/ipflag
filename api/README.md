# IP Flag Geo API

The service exposes the extension-compatible normalized response shape:

- `GET /domain/example.com`
- `GET /ip/8.8.8.8`
- `GET /health`

DB-IP Lite city and ASN MMDB files are loaded from `data/dbip-city-lite.mmdb`
and `data/dbip-asn-lite.mmdb`. They are monthly, CC BY 4.0 databases and must
be attributed in web pages that use their results. If an IP2Location BIN is
available, set `IP2LOCATION_DB_PATH`; it is queried first and DB-IP fills
missing fields.

Environment variables:

- `PORT` (default `4320`)
- `HOST` (default `127.0.0.1`)
- `DBIP_MMDB_PATH`
- `IP2LOCATION_DB_PATH`
- `RATE_LIMIT` (requests per minute per client, default `120`)
