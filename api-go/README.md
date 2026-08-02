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

Lookups are cached in a SQLite table next to the service, so a 30 day TTL
survives restarts and deploys and the database handles durability, expiry and
eviction instead of hand-rolled file juggling. A NULL record is a tombstone.

| Outcome | TTL | Why |
| --- | ---: | --- |
| ipapi.is answered | `GEO_CACHE_TTL`, 30 days | Answers are stable for weeks, each miss spends quota, and ipapi.is caps caching at 30 days |
| Upstream failed or out of budget | 10 min | Retry the upstream shortly after it recovers |
| Upstream healthy but has no record | 24 h | Asking again changes nothing |
| Neither source can place the address | 24 h | A tombstone; without it every intranet navigation spends a request |

Expired rows, and the oldest rows past `GEO_CACHE_MAX`, are pruned hourly. To
drop everything, stop the service, delete the database file and start again.

## Quota and failure handling

ipapi.is returns no rate-limit headers, so the budget is counted locally.
`IPAPI_IS_DAILY_LIMIT` requests per UTC day are allowed; past that the service
serves from the local databases until midnight. Usage is logged every 500 calls.

- Concurrent lookups of the same IP collapse into one upstream call.
- Private, loopback, link-local and CGNAT addresses never reach ipapi.is: they
  are in no geo database, and sending them would disclose internal addressing.
- After five consecutive failures the upstream is skipped for a minute.
- Redirects are refused: Go copies the request URL into `Referer` when it
  follows one. The key travels in the POST body, never in the query string.

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
| `GEO_CACHE_TTL` | `720h` (30 days) | How long successful upstream lookups are cached |
| `GEO_CACHE_PATH` | `/var/lib/ipflag-api/geo-cache.db` | SQLite cache file |
| `GEO_CACHE_MAX` | `500000` | Maximum cached IPs before eviction |
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
IPAPI_IS_KEY=... DBIP_MMDB_PATH=./data/dbip-city-lite.mmdb DBIP_ASN_MMDB_PATH=./data/dbip-asn-lite.mmdb GEO_CACHE_PATH=./geo-cache.db ./ipflag-api
```

DB-IP Lite is downloadable without an account:
`https://download.db-ip.com/free/dbip-city-lite-<YYYY-MM>.mmdb.gz`.
