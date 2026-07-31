# IP Flag Go API

Go implementation of the IP Flag geolocation API. It serves `/domain/:domain`
and `/ip/:ip` (query parameters are also accepted), reads DB-IP Lite as the
primary geolocation source, supplements missing timezone/coordinates from
MaxMind GeoLite2 City, and adds an SSL certificate summary to domain lookups.

The service intentionally does not expose a provider/source field in its
public response. DB-IP Lite and MaxMind GeoLite2 databases are downloaded by
separate protected timers. MaxMind credentials are read from
`/etc/ipflag-api/maxmind.env`; database files are never exposed to the browser
extension.

The MaxMind update timer requires an account ID and license key in that
root-owned file. Install both `ipflag-dbip-update.service`/
`ipflag-dbip-update.timer` and `ipflag-maxmind-update.service`/
`ipflag-maxmind-update.timer` alongside the API service.
