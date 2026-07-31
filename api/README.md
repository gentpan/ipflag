# IP Flag Geo API (legacy reference)

The production service is now the statically compiled Go implementation in
[`../api-go/`](../api-go/). This directory is retained as a reference adapter.

The service exposes the extension-compatible normalized response shape:

- `GET /domain/example.com`
- `GET /ip/8.8.8.8`
- `GET /health`

This legacy Node adapter is not deployed. The production Go API uses MaxMind
GeoLite2 City and ASN MMDB files and adds SSL certificate dates to domain
responses while omitting provider/source labels from public output.

Environment variables:

- `PORT` (default `4320`)
- `HOST` (default `127.0.0.1`)
- `DBIP_MMDB_PATH`
- `IP2LOCATION_DB_PATH`
- `RATE_LIMIT` (requests per minute per client, default `120`)
