# IP Flag Go API

Go implementation of the IP Flag geolocation API. It serves `/domain/:domain`
and `/ip/:ip` (query parameters are also accepted), resolves geolocation
through [ipapi.is](https://ipapi.is), and adds an SSL certificate summary to
domain lookups.

The service intentionally does not expose a provider/source field in its
public response.

## Data source

[ipapi.is](https://ipapi.is) is the only source. There is no local database and
no fallback: `IPAPI_IS_KEY` is required and the service refuses to start
without it. When the upstream cannot answer, neither can this API — the
request returns 404 and the extension shows no flag.

## Caching

Lookups are cached in a SQLite table next to the service, so a 30 day TTL
survives restarts and deploys and the database handles durability, expiry and
eviction instead of hand-rolled file juggling. A NULL record is a tombstone.

| Outcome | TTL | Why |
| --- | ---: | --- |
| ipapi.is answered | `GEO_CACHE_TTL`, 30 days | Answers are stable for weeks, each miss spends quota, and ipapi.is caps caching at 30 days |
| Upstream failed | not cached | So the next request retries instead of serving a hole |
| Upstream has no record for the address | 24 h | A tombstone; without it every intranet navigation spends a request |

Expired rows, and the oldest rows past `GEO_CACHE_MAX`, are pruned hourly. To
drop everything, stop the service, delete the database file and start again.

## Quota and failure handling

ipapi.is returns no rate-limit headers, so the budget is counted locally.
`IPAPI_IS_DAILY_LIMIT` requests per UTC day are allowed; past that lookups fail
until midnight. Usage is logged every 500 calls.

- Concurrent lookups of the same IP collapse into one upstream call.
- Private, loopback, link-local and CGNAT addresses never reach ipapi.is: they
  are in no geo database, and sending them would disclose internal addressing.
- At most `IPAPI_IS_MAX_INFLIGHT` requests run at once. ipapi.is rate-limits
  bursts per source IP and everything here leaves from one address: 39 requests
  in one second earned 42 HTTP 429s on 2026-08-04.
- After five consecutive failures the upstream is skipped for a minute.
- Redirects are refused: Go copies the request URL into `Referer` when it
  follows one. The key travels in the POST body, never in the query string.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4320` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `RATE_LIMIT` | `120` | Requests per minute per client |
| `IPAPI_IS_KEY` | *(required)* | ipapi.is API key. The service will not start without it |
| `IPAPI_IS_URL` | `https://api.ipapi.is` | Upstream base URL |
| `IPAPI_IS_TIMEOUT` | `4s` | Upstream request timeout |
| `IPAPI_IS_MAX_INFLIGHT` | `12` | Concurrent upstream requests |
| `IPAPI_IS_DAILY_LIMIT` | `20000` | Upstream requests per UTC day; `0` disables the budget |
| `GEO_CACHE_TTL` | `720h` (30 days) | How long successful upstream lookups are cached |
| `GEO_CACHE_PATH` | `/var/lib/ipflag-api/geo-cache.db` | SQLite cache file |
| `GEO_CACHE_MAX` | `500000` | Maximum cached IPs before eviction |

## Credentials

The ipapi.is key is read from `/etc/ipflag-api/ipapi.env`, referenced by
`EnvironmentFile=-` in `deploy/ipflag-api.service`. Copy
`deploy/ipapi.env.example` there and fill it in:

```sh
install -d -m 0750 -o root -g www-data /etc/ipflag-api
install -m 0640 -o root -g www-data deploy/ipapi.env.example /etc/ipflag-api/ipapi.env
```

The key must never be committed and must never reach the browser extension:
the extension talks to this API, and this API talks to ipapi.is.

## Local development

```sh
go build -o ipflag-api .
```

```sh
IPAPI_IS_KEY=... GEO_CACHE_PATH=./geo-cache.db ./ipflag-api
```
