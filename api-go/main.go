package main

import (
	"bytes"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

const (
	defaultPort      = "4320"
	sslCacheTTL      = 5 * time.Minute
	requestWindow    = time.Minute
	defaultRateLimit = 120
	sslLookupTimeout = 5 * time.Second

	// ipapi.is answers are stable for weeks and every miss spends a request
	// from a metered daily quota. Its terms also cap caching at 30 days.
	defaultGeoCacheTTL = 30 * 24 * time.Hour
	// Addresses the upstream has no record for, and addresses we never ask it
	// about. A day stops an intranet browsing session from spending the quota.
	noDataCacheTTL = 24 * time.Hour

	defaultUpstreamURL     = "https://api.ipapi.is"
	defaultUpstreamTimeout = 4 * time.Second
	defaultDailyLimit      = 20000
	// ipapi.is rate-limits per source IP at their edge, and every lookup here
	// leaves from one server. 39 requests in a single second earned 42 HTTP
	// 429s on 2026-08-04; with no local fallback those are missing flags.
	defaultMaxInflight = 12
	defaultCacheMax    = 500000
	defaultCachePath   = "/var/lib/ipflag-api/geo-cache.db"

	breakerTrip     = 5
	breakerCooldown = time.Minute
)

// Cache-Control values. max-age governs the browser, s-maxage the CDN. The
// extension's fetches set no cache option, so these headers really do reach the
// browser's own HTTP cache.
const (
	cacheIP       = "public, max-age=3600, s-maxage=86400, stale-if-error=604800"
	cacheDomain   = "public, max-age=300, s-maxage=300"
	cacheNotFound = "public, max-age=60"
	cacheNone     = "no-store"
)

var (
	domainPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	// RFC 6598. net.IP has no helper for it and some ISPs hand it to customers.
	cgnatRange = netip.MustParsePrefix("100.64.0.0/10")

	errNoGeoData      = errors.New("no geolocation data for this IP")
	errUpstreamNoData = errors.New("ipapi.is has no record for this IP")
	errUpstreamQuota  = errors.New("ipapi.is daily quota reached")
)

// ------------------------------------------------------------- geo records

// riskFlags accompanies every answer, since ipapi.is is the only source.
type riskFlags struct {
	IsDatacenter bool   `json:"d"`
	IsVPN        bool   `json:"v"`
	IsProxy      bool   `json:"p"`
	IsTor        bool   `json:"t"`
	IsAbuser     bool   `json:"a"`
	Datacenter   string `json:"dc,omitempty"`
	AbuserScore  string `json:"as,omitempty"`
}

type geoRecord struct {
	IP          string     `json:"ip"`
	Continent   string     `json:"co,omitempty"`
	CountryCode string     `json:"cc"`
	Country     string     `json:"cn,omitempty"`
	Region      string     `json:"rg,omitempty"`
	City        string     `json:"ct,omitempty"`
	Latitude    float64    `json:"la"`
	Longitude   float64    `json:"lo"`
	Timezone    string     `json:"tz,omitempty"`
	PostalCode  string     `json:"pc,omitempty"`
	Accuracy    string     `json:"ac,omitempty"`
	ASN         string     `json:"as,omitempty"`
	ISP         string     `json:"is,omitempty"`
	Risk        *riskFlags `json:"rk,omitempty"`
}

// flat renders the public response shape.
func (record *geoRecord) flat() map[string]any {
	value := map[string]any{
		"ip":           record.IP,
		"continent":    record.Continent,
		"country_code": record.CountryCode,
		"country":      record.Country,
		"latitude":     record.Latitude,
		"longitude":    record.Longitude,
	}
	for key, text := range map[string]string{
		"region": record.Region, "city": record.City, "timezone": record.Timezone,
		"postal_code": record.PostalCode, "accuracy": record.Accuracy,
		"asn": record.ASN, "isp": record.ISP,
	} {
		if text != "" {
			value[key] = text
		}
	}
	if risk := record.Risk; risk != nil {
		value["is_datacenter"] = risk.IsDatacenter
		value["is_vpn"] = risk.IsVPN
		value["is_proxy"] = risk.IsProxy
		value["is_tor"] = risk.IsTor
		value["is_abuser"] = risk.IsAbuser
		if risk.Datacenter != "" {
			value["datacenter"] = risk.Datacenter
		}
		if risk.AbuserScore != "" {
			value["abuser_score"] = risk.AbuserScore
		}
	}
	return value
}

// upstreamRecord mirrors the subset of the ipapi.is response the API exposes.
type upstreamRecord struct {
	IsBogon      bool `json:"is_bogon"`
	IsDatacenter bool `json:"is_datacenter"`
	IsTor        bool `json:"is_tor"`
	IsProxy      bool `json:"is_proxy"`
	IsVPN        bool `json:"is_vpn"`
	IsAbuser     bool `json:"is_abuser"`
	Datacenter   struct {
		Datacenter string `json:"datacenter"`
	} `json:"datacenter"`
	Company struct {
		Name        string `json:"name"`
		AbuserScore string `json:"abuser_score"`
	} `json:"company"`
	ASN struct {
		Number      uint32 `json:"asn"`
		Org         string `json:"org"`
		Descr       string `json:"descr"`
		AbuserScore string `json:"abuser_score"`
	} `json:"asn"`
	Location struct {
		Continent   string  `json:"continent"`
		Country     string  `json:"country"`
		CountryCode string  `json:"country_code"`
		State       string  `json:"state"`
		City        string  `json:"city"`
		Latitude    float64 `json:"latitude"`
		Longitude   float64 `json:"longitude"`
		Zip         string  `json:"zip"`
		Timezone    string  `json:"timezone"`
		Accuracy    string  `json:"accuracy"`
	} `json:"location"`
	Error string `json:"error"`
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		log.Printf("ignoring invalid %s=%q, using %s", name, raw, fallback)
		return fallback
	}
	return value
}

func envInt(name string, fallback, minimum int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum {
		log.Printf("ignoring invalid %s=%q, using %d", name, raw, fallback)
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// ---------------------------------------------------------------- geo cache

// geoCache is a SQLite table. Durability, crash safety, expiry and eviction are
// the database's problem rather than hand-rolled here; a NULL record is a
// tombstone for an address neither source can place.
type geoCache struct {
	db  *sql.DB
	max int
}

func openCache(path string, max int) (*geoCache, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS geo (
			ip      TEXT PRIMARY KEY,
			record  BLOB,
			expires INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS geo_expires ON geo(expires);`); err != nil {
		db.Close()
		return nil, err
	}
	return &geoCache{db: db, max: max}, nil
}

// get returns (record, true) on a hit, (nil, true) for a tombstone, and
// (nil, false) on a miss. Database errors are reported as a miss so a broken
// cache degrades into extra upstream calls rather than failed requests.
func (cache *geoCache) get(ip string) (*geoRecord, bool) {
	var blob []byte
	err := cache.db.QueryRow(
		`SELECT record FROM geo WHERE ip = ? AND expires > ?`, ip, time.Now().Unix(),
	).Scan(&blob)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("geo cache read failed for %s: %v", ip, err)
		}
		return nil, false
	}
	if blob == nil {
		return nil, true
	}
	record := &geoRecord{}
	if err := json.Unmarshal(blob, record); err != nil {
		return nil, false
	}
	return record, true
}

func (cache *geoCache) put(ip string, record *geoRecord, ttl time.Duration) {
	var blob []byte
	if record != nil {
		encoded, err := json.Marshal(record)
		if err != nil {
			return
		}
		blob = encoded
	}
	if _, err := cache.db.Exec(
		`INSERT INTO geo (ip, record, expires) VALUES (?, ?, ?)
		 ON CONFLICT(ip) DO UPDATE SET record = excluded.record, expires = excluded.expires`,
		ip, blob, time.Now().Add(ttl).Unix(),
	); err != nil {
		log.Printf("geo cache write failed for %s: %v", ip, err)
	}
}

// prune drops expired rows, then the oldest rows if the table outgrew its cap.
func (cache *geoCache) prune() {
	if _, err := cache.db.Exec(`DELETE FROM geo WHERE expires <= ?`, time.Now().Unix()); err != nil {
		log.Printf("geo cache prune failed: %v", err)
		return
	}
	if _, err := cache.db.Exec(
		`DELETE FROM geo WHERE ip IN (
			SELECT ip FROM geo ORDER BY expires
			LIMIT max(0, (SELECT COUNT(*) FROM geo) - ?))`, cache.max,
	); err != nil {
		log.Printf("geo cache eviction failed: %v", err)
	}
}

// ------------------------------------------------------------ single flight

// singleFlight collapses concurrent lookups of the same IP into one upstream
// call. Without it a burst of tabs opening the same site would each spend a
// request from the daily quota.
type singleFlight struct {
	mu    sync.Mutex
	calls map[string]*flightCall
}

type flightCall struct {
	wait   sync.WaitGroup
	record *geoRecord
	err    error
}

func newSingleFlight() *singleFlight {
	return &singleFlight{calls: make(map[string]*flightCall)}
}

func (flight *singleFlight) do(key string, fn func() (*geoRecord, error)) (*geoRecord, error) {
	flight.mu.Lock()
	if call, ok := flight.calls[key]; ok {
		flight.mu.Unlock()
		call.wait.Wait()
		return call.record, call.err
	}
	call := &flightCall{}
	call.wait.Add(1)
	flight.calls[key] = call
	flight.mu.Unlock()

	defer func() {
		// A panicking leader must not hand waiters a nil record with a nil
		// error, which the handler would serve as an empty HTTP 200.
		if recovered := recover(); recovered != nil {
			call.record, call.err = nil, fmt.Errorf("lookup panicked: %v", recovered)
		}
		flight.mu.Lock()
		delete(flight.calls, key)
		flight.mu.Unlock()
		call.wait.Done()
	}()

	call.record, call.err = fn()
	return call.record, call.err
}

// -------------------------------------------------------------- ipapi.is

// upstreamClient talks to ipapi.is. It counts the daily budget locally because
// the API publishes no quota headers at all, and stops calling for a minute
// after repeated failures.
type upstreamClient struct {
	endpoint string
	key      string
	client   *http.Client
	inflight chan struct{}

	mu        sync.Mutex
	failures  int
	openUntil time.Time
	day       string
	used      int
	limit     int
}

func newUpstreamClient(endpoint, key string, timeout time.Duration, dailyLimit, maxInflight int) *upstreamClient {
	return &upstreamClient{
		endpoint: strings.TrimRight(endpoint, "/"),
		key:      key,
		limit:    dailyLimit,
		inflight: make(chan struct{}, maxInflight),
		client: &http.Client{
			Timeout: timeout,
			// Go copies the request URL into Referer when it follows a
			// redirect, and never strips the query string. Refusing redirects
			// keeps the credentials from reaching a third party.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// admit reports whether this lookup may call ipapi.is, counting it against the
// daily budget when it may.
func (upstream *upstreamClient) admit() error {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	if time.Now().Before(upstream.openUntil) {
		return errors.New("ipapi.is is in cooldown")
	}
	if upstream.limit > 0 {
		today := time.Now().UTC().Format(time.DateOnly)
		if upstream.day != today {
			upstream.day, upstream.used = today, 0
		}
		if upstream.used >= upstream.limit {
			return errUpstreamQuota
		}
		upstream.used++
		if upstream.used%500 == 0 || upstream.used == upstream.limit {
			log.Printf("ipapi.is usage today: %d/%d", upstream.used, upstream.limit)
		}
	}
	return nil
}

func (upstream *upstreamClient) succeeded() {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	upstream.failures = 0
}

func (upstream *upstreamClient) failed() {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	upstream.failures++
	if upstream.failures >= breakerTrip {
		upstream.openUntil = time.Now().Add(breakerCooldown)
		upstream.failures = 0
		log.Printf("ipapi.is disabled for %s after repeated failures", breakerCooldown)
	}
}

// redact keeps the API key out of the logs. Defence in depth: the key travels
// in the request body, but an endpoint override could still put it somewhere
// Go copies into an error.
func (upstream *upstreamClient) redact(err error) error {
	if err == nil || upstream.key == "" {
		return err
	}
	message := err.Error()
	redacted := strings.ReplaceAll(message, upstream.key, "REDACTED")
	if redacted == message {
		// Nothing to hide — return the original so sentinels such as
		// errUpstreamNoData still match through errors.Is.
		return err
	}
	return errors.New(redacted)
}

func (upstream *upstreamClient) lookup(ip net.IP) (*upstreamRecord, error) {
	if err := upstream.admit(); err != nil {
		return nil, err
	}
	// Bounded concurrency: ipapi.is limits bursts per source IP, and everything
	// here leaves from one address.
	select {
	case upstream.inflight <- struct{}{}:
		defer func() { <-upstream.inflight }()
	case <-time.After(upstream.client.Timeout):
		return nil, errors.New("ipapi.is concurrency limit reached")
	}
	record, err := upstream.request(ip)
	return record, upstream.redact(err)
}

func (upstream *upstreamClient) request(ip net.IP) (*upstreamRecord, error) {
	// POST keeps the key out of the query string, so it never reaches the
	// upstream access log, a proxy, or a *url.Error. Header authentication is
	// silently ignored by ipapi.is — it would downgrade to the anonymous tier
	// without any error — so the body is the only safe alternative to the URL.
	payload, err := json.Marshal(map[string]string{"q": ip.String(), "key": upstream.key})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, upstream.endpoint+"/", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := upstream.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		// Keep the upstream's own wording; an invalid key says so.
		text := strings.TrimSpace(string(body))
		if len(text) > 200 {
			text = text[:200] + "…"
		}
		return nil, fmt.Errorf("ipapi.is returned HTTP %d: %s", response.StatusCode, text)
	}
	var record upstreamRecord
	if err := json.Unmarshal(body, &record); err != nil {
		return nil, err
	}
	if record.Error != "" {
		return nil, errors.New("ipapi.is: " + record.Error)
	}
	if record.IsBogon || record.Location.CountryCode == "" {
		return nil, errUpstreamNoData
	}
	return &record, nil
}

func upstreamGeoRecord(ip string, record *upstreamRecord) *geoRecord {
	location := record.Location
	asn := ""
	if record.ASN.Number != 0 {
		asn = "AS" + strconv.FormatUint(uint64(record.ASN.Number), 10)
	}
	return &geoRecord{
		IP:          ip,
		Continent:   location.Continent,
		CountryCode: strings.ToUpper(location.CountryCode),
		Country:     location.Country,
		Region:      location.State,
		City:        location.City,
		Latitude:    location.Latitude,
		Longitude:   location.Longitude,
		Timezone:    location.Timezone,
		PostalCode:  location.Zip,
		Accuracy:    location.Accuracy,
		ASN:         asn,
		ISP:         firstNonEmpty(record.ASN.Org, record.ASN.Descr, record.Company.Name),
		Risk: &riskFlags{
			IsDatacenter: record.IsDatacenter,
			IsVPN:        record.IsVPN,
			IsProxy:      record.IsProxy,
			IsTor:        record.IsTor,
			IsAbuser:     record.IsAbuser,
			Datacenter:   record.Datacenter.Datacenter,
			AbuserScore:  firstNonEmpty(record.Company.AbuserScore, record.ASN.AbuserScore),
		},
	}
}

// ---------------------------------------------------------------- service

type geoService struct {
	upstream *upstreamClient
	cache    *geoCache
	cacheTTL time.Duration
	group    *singleFlight
	sslMu    sync.Mutex
	sslCache map[string]sslCacheEntry
}

type sslCacheEntry struct {
	value   map[string]any
	expires time.Time
}

func openService() (*geoService, error) {
	key := os.Getenv("IPAPI_IS_KEY")
	if key == "" {
		return nil, errors.New("IPAPI_IS_KEY is required: ipapi.is is the only geolocation source")
	}
	cache, err := openCache(env("GEO_CACHE_PATH", defaultCachePath), envInt("GEO_CACHE_MAX", defaultCacheMax, 1))
	if err != nil {
		return nil, fmt.Errorf("open geo cache: %w", err)
	}
	limit := envInt("IPAPI_IS_DAILY_LIMIT", defaultDailyLimit, 0)
	inflight := envInt("IPAPI_IS_MAX_INFLIGHT", defaultMaxInflight, 1)
	log.Printf("ipapi.is is the only source, daily limit %d, at most %d concurrent requests", limit, inflight)
	return &geoService{
		upstream: newUpstreamClient(env("IPAPI_IS_URL", defaultUpstreamURL), key,
			envDuration("IPAPI_IS_TIMEOUT", defaultUpstreamTimeout), limit, inflight),
		cache:    cache,
		cacheTTL: envDuration("GEO_CACHE_TTL", defaultGeoCacheTTL),
		group:    newSingleFlight(),
		sslCache: make(map[string]sslCacheEntry),
	}, nil
}

// routable reports whether it is worth asking a geolocation service about an
// address. Private, loopback, link-local and CGNAT addresses are in no geo
// database, and sending them upstream would both waste quota and disclose the
// user's internal addressing to a third party.
func routable(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	address, ok := netip.AddrFromSlice(ip)
	return ok && !cgnatRange.Contains(address.Unmap())
}

// lookup resolves an IP through ipapi.is. There is no fallback: if the
// upstream cannot answer, neither can we.
func (service *geoService) lookup(ip net.IP) (*geoRecord, error) {
	key := ip.String()
	if record, hit := service.cache.get(key); hit {
		if record == nil {
			return nil, errNoGeoData
		}
		return record, nil
	}
	if !routable(ip) {
		// Private, loopback, link-local and CGNAT addresses are in no geo
		// database. Remember that so intranet browsing costs nothing.
		service.cache.put(key, nil, noDataCacheTTL)
		return nil, errNoGeoData
	}
	return service.group.do(key, func() (*geoRecord, error) {
		if record, hit := service.cache.get(key); hit {
			if record == nil {
				return nil, errNoGeoData
			}
			return record, nil
		}
		record, err := service.upstream.lookup(ip)
		switch {
		case err == nil:
			service.upstream.succeeded()
			resolved := upstreamGeoRecord(key, record)
			service.cache.put(key, resolved, service.cacheTTL)
			return resolved, nil
		case errors.Is(err, errUpstreamNoData):
			service.upstream.succeeded() // healthy, just no record for this address
			service.cache.put(key, nil, noDataCacheTTL)
			return nil, errNoGeoData
		case errors.Is(err, errUpstreamQuota):
			// Nothing to cache: the budget rolls over at UTC midnight.
			return nil, errNoGeoData
		default:
			service.upstream.failed()
			log.Printf("ipapi.is lookup for %s failed: %v", key, err)
			// Not cached either, so the next request retries once the breaker
			// closes rather than serving a hole for ten minutes.
			return nil, errNoGeoData
		}
	})
}

func cleanDomain(raw string) (string, error) {
	domain := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(raw), "."))
	if len(domain) > 253 || !domainPattern.MatchString(domain) {
		return "", errors.New("invalid domain")
	}
	return domain, nil
}

func resolveDomain(domain string) (net.IP, error) {
	addresses, err := net.LookupIP(domain)
	if err != nil {
		return nil, err
	}
	for _, address := range addresses {
		if ipv4 := address.To4(); ipv4 != nil {
			return ipv4, nil
		}
	}
	if len(addresses) > 0 {
		return addresses[0], nil
	}
	return nil, errors.New("domain did not resolve")
}

func (service *geoService) ssl(domain string) map[string]any {
	service.sslMu.Lock()
	if entry, ok := service.sslCache[domain]; ok && time.Now().Before(entry.expires) {
		value := entry.value
		service.sslMu.Unlock()
		return value
	}
	service.sslMu.Unlock()
	value := map[string]any{"checked_at": time.Now().UTC().Format(time.RFC3339)}
	dialer := &net.Dialer{Timeout: sslLookupTimeout}
	connection, err := tls.DialWithDialer(dialer, "tcp", net.JoinHostPort(domain, "443"), &tls.Config{ServerName: domain, MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}) // certificate inspection must also work for expired certificates
	if err != nil {
		value["error"] = err.Error()
	} else {
		defer connection.Close()
		certificates := connection.ConnectionState().PeerCertificates
		if len(certificates) > 0 {
			certificate := certificates[0]
			remaining := time.Until(certificate.NotAfter)
			value["valid_from"] = certificate.NotBefore.UTC().Format(time.RFC3339)
			value["expires_at"] = certificate.NotAfter.UTC().Format(time.RFC3339)
			value["days_remaining"] = int(remaining.Hours() / 24)
			value["valid"] = time.Now().After(certificate.NotBefore) && time.Now().Before(certificate.NotAfter)
			value["issuer"] = certificate.Issuer.String()
			value["subject"] = certificate.Subject.CommonName
		}
	}
	service.sslMu.Lock()
	service.sslCache[domain] = sslCacheEntry{value: value, expires: time.Now().Add(sslCacheTTL)}
	service.sslMu.Unlock()
	return value
}

func clientKey(request *http.Request) string {
	if value := request.Header.Get("CF-Connecting-IP"); value != "" {
		return value
	}
	if value := strings.Split(request.Header.Get("X-Forwarded-For"), ",")[0]; strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return request.RemoteAddr
}

type limiter struct {
	mu    sync.Mutex
	items map[string]rateEntry
	limit int
}

type rateEntry struct {
	started time.Time
	count   int
}

func (limiter *limiter) allow(key string) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := time.Now()
	entry := limiter.items[key]
	if entry.started.IsZero() || now.Sub(entry.started) >= requestWindow {
		if len(limiter.items) > 100000 {
			limiter.items = make(map[string]rateEntry)
		}
		limiter.items[key] = rateEntry{started: now, count: 1}
		return true
	}
	entry.count++
	limiter.items[key] = entry
	return entry.count <= limiter.limit
}

func jsonResponse(writer http.ResponseWriter, status int, cacheControl string, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Access-Control-Allow-Origin", "*")
	writer.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	writer.Header().Set("Cache-Control", cacheControl)
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func (service *geoService) handler(limiter *limiter) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		if request.Method != http.MethodGet {
			jsonResponse(writer, http.StatusMethodNotAllowed, cacheNone, map[string]string{"error": "method_not_allowed"})
			return
		}
		if !limiter.allow(clientKey(request)) {
			writer.Header().Set("Retry-After", "60")
			jsonResponse(writer, http.StatusTooManyRequests, cacheNone, map[string]string{"error": "rate_limited"})
			return
		}
		pathParts := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
		if request.URL.Path == "/" || request.URL.Path == "/health" {
			jsonResponse(writer, http.StatusOK, cacheNone, map[string]any{"ok": true, "service": "IP Flag Geo API"})
			return
		}
		endpoint := pathParts[0]
		value := ""
		if len(pathParts) > 1 {
			value = strings.Join(pathParts[1:], "/")
		} else {
			value = request.URL.Query().Get(endpoint)
		}
		if (endpoint != "ip" && endpoint != "domain") || value == "" || len(pathParts) > 2 {
			jsonResponse(writer, http.StatusNotFound, cacheNone, map[string]any{"error": "not_found", "endpoints": []string{"/ip/:ip", "/domain/:domain"}})
			return
		}
		var ip net.IP
		var query string
		var domain string
		var err error
		if endpoint == "ip" {
			ip = net.ParseIP(strings.Trim(value, "[]"))
			query = value
			if ip == nil {
				jsonResponse(writer, http.StatusBadRequest, cacheNone, map[string]string{"error": "invalid_ip"})
				return
			}
		} else {
			domain, err = cleanDomain(value)
			query = domain
			if err != nil {
				jsonResponse(writer, http.StatusBadRequest, cacheNone, map[string]string{"error": "invalid_domain"})
				return
			}
			ip, err = resolveDomain(domain)
			if err != nil {
				jsonResponse(writer, http.StatusNotFound, cacheNotFound, map[string]string{"error": "domain_not_resolved", "domain": domain})
				return
			}
		}
		record, err := service.lookup(ip)
		if err != nil || record == nil {
			jsonResponse(writer, http.StatusNotFound, cacheNotFound, map[string]string{"error": "ip_not_found", "ip": ip.String()})
			return
		}
		result := record.flat()
		result["query"] = query
		result["query_type"] = endpoint
		cacheControl := cacheIP
		if domain != "" {
			result["ssl"] = service.ssl(domain)
			cacheControl = cacheDomain
		}
		jsonResponse(writer, http.StatusOK, cacheControl, result)
	})
}

func main() {
	service, err := openService()
	if err != nil {
		log.Fatal(err)
	}
	defer service.cache.db.Close()

	go func() {
		service.cache.prune()
		for range time.Tick(time.Hour) {
			service.cache.prune()
		}
	}()

	server := &http.Server{
		Addr:              env("HOST", "127.0.0.1") + ":" + env("PORT", defaultPort),
		Handler:           service.handler(&limiter{items: make(map[string]rateEntry), limit: envInt("RATE_LIMIT", defaultRateLimit, 1)}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-shutdown
		// Every cached answer is already committed to SQLite, so there is
		// nothing to flush before exiting.
		_ = server.Close()
	}()

	log.Printf("listening on http://%s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
