# IP Flag Go API

Go implementation of the IP Flag geolocation API. It serves `/domain/:domain`
and `/ip/:ip` (query parameters are also accepted), resolves geolocation
through a chain of providers, and adds an SSL certificate summary to domain
lookups.

The service intentionally does not expose a provider/source field in its
public response.

## Data sources

Three providers are tried in order; the first one that answers wins. A source
with no key configured is skipped, and `cnip.io` needs none.

| Order | Source | Budget | Notes |
| ---: | --- | --- | --- |
| 1 | ip2location.io | `IP2LOCATION_DAILY_LIMIT`, 1600/day | Free tier is a 50K monthly pool; the daily cap spreads it across the month. All-English output, but `time_zone` is a UTC offset rather than an IANA name |
| 2 | cnip.io | unlimited | Self-hosted, so no budget. Best accuracy in testing and returns IANA zone names, but `country`, `continent` and `isp` are Chinese even for non-Chinese addresses |
| 3 | ipapi.is | `IPAPI_IS_DAILY_LIMIT`, 20000/day | Adds `is_datacenter`/`is_vpn`/`is_tor`/`abuser_score`/`accuracy`, but 73% of its answers are self-reported `MEDIUM` accuracy and it tends to return an ASN's registered country rather than the routed location |

"No record for this address" ends the chain rather than falling through: every
provider draws on the same registry data, so asking the next one rarely helps
and would spend a request on every intranet address.

Because the sources differ, some response fields depend on which one answered:
`is_proxy` only from ip2location.io, the full risk set and `accuracy` only from
ipapi.is, and the timezone format varies. Absent keys mean unknown, not false.

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

No provider publishes rate-limit headers, so each budget is counted locally.
A source that reaches its daily limit is skipped until UTC midnight and the
next one in the chain answers instead. Usage is logged every 500 calls.

- Concurrent lookups of the same IP collapse into one upstream call.
- Private, loopback, link-local and CGNAT addresses reach no provider: they are
  in no geo database, and sending them would disclose internal addressing.
- At most `UPSTREAM_MAX_INFLIGHT` requests run at once per source. Providers
  rate-limit bursts per source IP and everything here leaves from one address:
  39 requests in one second earned ipapi.is 42 HTTP 429s on 2026-08-04.
- After five consecutive failures a source is skipped for a minute.
- Redirects are refused: Go copies the request URL into `Referer` when it
  follows one. The key travels in the POST body, never in the query string.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4320` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `RATE_LIMIT` | `120` | Requests per minute per client |
| `IP2LOCATION_KEY` | *(unset)* | ip2location.io key; the source is skipped without it |
| `IP2LOCATION_DAILY_LIMIT` | `1600` | Requests per UTC day; `0` disables the budget |
| `CNIP_URL` | `https://api.cnip.io` | Self-hosted source; empty disables it |
| `CNIP_DAILY_LIMIT` | `0` (unlimited) | Requests per UTC day |
| `IPAPI_IS_KEY` | *(unset)* | ipapi.is key; the source is skipped without it |
| `IPAPI_IS_DAILY_LIMIT` | `20000` | Requests per UTC day |
| `UPSTREAM_TIMEOUT` | `4s` | Per-request timeout |
| `UPSTREAM_MAX_INFLIGHT` | `12` | Concurrent upstream requests |
| `GEO_CACHE_TTL` | `720h` (30 days) | How long successful upstream lookups are cached |
| `GEO_CACHE_PATH` | `/var/lib/ipflag-api/geo-cache.db` | SQLite cache file |
| `GEO_CACHE_MAX` | `500000` | Maximum cached IPs before eviction |

## Credentials

Provider keys are read from `/etc/ipflag-api/ipapi.env`, referenced by
`EnvironmentFile=-` in `deploy/ipflag-api.service`. Copy
`deploy/ipapi.env.example` there and fill it in:

```sh
install -d -m 0750 -o root -g www-data /etc/ipflag-api
install -m 0640 -o root -g www-data deploy/ipapi.env.example /etc/ipflag-api/ipapi.env
```

Keys must never be committed and must never reach the browser extension:
the extension talks to this API, and this API talks to the providers.

## Local development

```sh
go build -o ipflag-api .
```

```sh
IP2LOCATION_KEY=... IPAPI_IS_KEY=... GEO_CACHE_PATH=./geo-cache.db ./ipflag-api
```
