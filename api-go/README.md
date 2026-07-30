# IP Flag Go API

Go implementation of the IP Flag geolocation API. It serves `/domain/:domain`
and `/ip/:ip` (query parameters are also accepted), merges DB-IP Lite City and
ASN data, and adds an SSL certificate summary to domain lookups.

The service intentionally does not expose a provider/source field in its
public response. DB-IP Lite is still attributed on the product website as
required by its CC BY 4.0 license.
