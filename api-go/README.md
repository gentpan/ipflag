# IP Flag Go API

Go implementation of the IP Flag geolocation API. It serves `/domain/:domain`
and `/ip/:ip` (query parameters are also accepted), resolves geolocation
through [ipapi.is](https://ipapi.is), and adds an SSL certificate summary to
domain lookups.

The service intentionally does not expose a provider/source field in its
public response.

## Data sources

`ipapi.is` is the primary source. The local DB-IP Lite databases (city and
ASN, supplemented by MaxMind GeoLite2 when present) remain installed and are
used as the fallback whenever ipapi.is is unset, unreachable, out of quota or
unable to answer. The DB-IP databases are still required at startup: the
service refuses to start without them, because they are what keeps it serving
during an upstream outage.

Fallback answers are cached for only 10 minutes, so ipapi.is is retried
shortly after it recovers instead of being shadowed for a month.

The risk fields below are only present when ipapi.is answered. Their absence
means "unknown", not "false" — the fallback databases cannot provide them.

| Field | Source |
| --- | --- |
| `country_code` `country` `continent` `region` `city` `latitude` `longitude` `timezone` `postal_code` `accuracy` | ipapi.is, fallback DB-IP Lite (`accuracy` fallback: absent) |
| `asn` `isp` | ipapi.is, fallback DB-IP ASN Lite |
| `is_datacenter` `datacenter` `is_vpn` `is_proxy` `is_tor` `is_abuser` `abuser_score` | ipapi.is only |
| `ssl` | live TLS handshake against the domain, no database involved |

## Caching

| Outcome | TTL | Why |
| --- | ---: | --- |
| ipapi.is answered | `GEO_CACHE_TTL`, 30 days | Answers are stable for weeks and each miss spends quota |
| Upstream failed, local databases answered | 10 min | Retry the upstream shortly after it recovers instead of shadowing it for a month |
| Upstream healthy but has no record, local databases answered | 24 h | Asking again changes nothing |
| Neither source can place the address | 24 h | A tombstone; without it every intranet navigation spends a request |

The cache lives in memory and is mirrored to an append-only log, so a 30 day
TTL survives restarts and deploys. Appending costs one line per new entry
rather than rewriting the whole file, which matters at a six-figure entry
count. A single goroutine owns every write; buffered lines are flushed and
`fsync`ed every `GEO_CACHE_FLUSH` and once more on `SIGTERM`, and the log is
compacted to the live entries once superseded lines dominate it. Disk errors
are never fatal — the cache degrades to memory-only.

Entries are stored as a compact struct rather than a rendered response map;
100,000 entries measure about 80 MB resident. Past `GEO_CACHE_MAX` the entries
closest to expiry are dropped, a tenth of the cap at a time.

The first line of the log records a schema number. Changing the shape of a
cached record means bumping `cacheSchema` in `main.go`, which makes every
stored entry expire on the next start — otherwise month-old entries would pin
the old behaviour. To drop the cache without a restart:

```sh
systemctl reload ipflag-api
```

## Quota and failure handling

ipapi.is returns no rate-limit headers of any kind, so the budget is counted
locally. `IPAPI_IS_DAILY_LIMIT` requests per UTC day are allowed; past that the
service serves from the local databases until midnight and logs the day's
usage. Usage is also logged every 500 calls.

- Concurrent lookups of the same IP collapse into one upstream call, so a burst
  of tabs opening the same site spends one request, not many.
- Private, loopback, link-local and CGNAT addresses never reach ipapi.is: they
  are in no geo database, and sending them would disclose internal addressing.
- At most `IPAPI_IS_MAX_INFLIGHT` upstream requests run at once.
- After five consecutive failures the breaker opens for a minute. When it
  expires exactly one request is let through as a probe; the rest keep using
  the local databases until that probe reports back.
- Reaching the daily budget and "no record for this IP" both leave the breaker
  closed — neither says anything about the upstream's health.
- Redirects are refused: Go copies the request URL into `Referer` when it
  follows one, so a redirect would hand the credentials to a third party. The
  key travels in the POST body, never in the query string.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4320` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `RATE_LIMIT` | `120` | Requests per minute per client |
| `IPAPI_IS_KEY` | *(unset)* | ipapi.is API key. **Unset disables the upstream entirely** and serves from the local databases only |
| `IPAPI_IS_URL` | `https://api.ipapi.is` | Upstream base URL |
| `IPAPI_IS_TIMEOUT` | `4s` | Upstream request timeout |
| `IPAPI_IS_DAILY_LIMIT` | `20000` | Upstream requests per UTC day; `0` disables the budget |
| `IPAPI_IS_MAX_INFLIGHT` | `12` | Concurrent upstream requests |
| `GEO_CACHE_TTL` | `720h` (30 days) | How long successful upstream lookups are cached |
| `GEO_CACHE_PATH` | `/var/lib/ipflag-api/geo-cache.jsonl` | Cache log location; empty disables persistence |
| `GEO_CACHE_MAX` | `200000` | Maximum cached IPs before eviction |
| `GEO_CACHE_FLUSH` | `2m` | How often buffered entries are flushed and synced |
| `DBIP_MMDB_PATH` | `/opt/ipflag-api/current/data/dbip-city-lite.mmdb` | Fallback city database (required) |
| `DBIP_ASN_MMDB_PATH` | `/opt/ipflag-api/current/data/dbip-asn-lite.mmdb` | Fallback ASN database (required) |
| `MAXMIND_CITY_MMDB_PATH` | `/opt/ipflag-api/current/data/GeoLite2-City.mmdb` | Optional supplement for the fallback path |

## Credentials

The ipapi.is key is read from `/etc/ipflag-api/ipapi.env`, referenced by
`EnvironmentFile=-` in `deploy/ipflag-api.service`. Copy
`deploy/ipapi.env.example` there and fill it in:

```sh
install -d -m 0750 -o root -g www-data /etc/ipflag-api
install -m 0640 -o root -g www-data deploy/ipapi.env.example /etc/ipflag-api/ipapi.env
```

The key must never be committed and must never reach the browser extension:
the extension talks to this API, and this API talks to ipapi.is. MaxMind
credentials live alongside it in `/etc/ipflag-api/maxmind.env` and are read
only by the update timer.

Install `ipflag-dbip-update.service`/`ipflag-dbip-update.timer` and
`ipflag-maxmind-update.service`/`ipflag-maxmind-update.timer` alongside the API
service to keep the fallback databases fresh.

## Local development

```sh
go build -o ipflag-api .
```

```sh
IPAPI_IS_KEY=... DBIP_MMDB_PATH=./data/dbip-city-lite.mmdb DBIP_ASN_MMDB_PATH=./data/dbip-asn-lite.mmdb GEO_CACHE_PATH=./geo-cache.json ./ipflag-api
```

DB-IP Lite is downloadable without an account:
`https://download.db-ip.com/free/dbip-city-lite-<YYYY-MM>.mmdb.gz`.
