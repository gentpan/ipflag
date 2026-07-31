# IP Flag Go API

Go implementation of the IP Flag geolocation API. It serves `/domain/:domain`
and `/ip/:ip` (query parameters are also accepted), reads MaxMind GeoLite2 City
and ASN databases, and adds an SSL certificate summary to domain lookups.

The service intentionally does not expose a provider/source field in its
public response. The GeoLite2 databases are downloaded by the protected
`deploy/update-maxmind.sh` timer using `/etc/ipflag-api/maxmind.env`; the
database files are never exposed to the browser extension.

The update timer requires a MaxMind account ID and license key in that root-
owned file. Install `ipflag-maxmind-update.service` and
`ipflag-maxmind-update.timer` alongside the API service; the old DB-IP update
unit should remain disabled.
