package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/oschwald/maxminddb-golang"
)

const (
	defaultPort      = "4320"
	sslCacheTTL      = 5 * time.Minute
	requestWindow    = time.Minute
	defaultRateLimit = 120
	sslLookupTimeout = 5 * time.Second

	// ipapi.is answers are stable for weeks and every miss costs a request from
	// a metered daily quota, so successful lookups are cached for a month.
	defaultGeoCacheTTL = 30 * 24 * time.Hour
	// Fallback answers come from the local databases while ipapi.is is
	// unreachable; they expire quickly so the upstream is retried soon after it
	// recovers instead of being shadowed for a month.
	fallbackCacheTTL = 10 * time.Minute
	// Tombstones for addresses neither source can place. A day is long enough
	// to stop an intranet browsing session from spending the quota on every
	// navigation, and short enough that a freshly allocated public range starts
	// resolving within a day of the upstream learning about it.
	notFoundCacheTTL = 24 * time.Hour

	defaultUpstreamURL     = "https://api.ipapi.is"
	defaultUpstreamTimeout = 4 * time.Second
	defaultMaxInflight     = 12
	defaultDailyLimit      = 20000
	defaultCacheMaxEntries = 200000
	defaultCachePath       = "/var/lib/ipflag-api/geo-cache.jsonl"
	defaultCacheFlush      = 2 * time.Minute

	upstreamBreakerTrip     = 5
	upstreamBreakerCooldown = time.Minute

	// Bumping this discards every stored entry on the next start. Raise it
	// whenever the shape of a cached record changes or an upstream mapping bug
	// is fixed, so month-old entries cannot pin the old behaviour.
	cacheSchema = 1
)

var (
	domainPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	// RFC 6598. net.IP has no helper for it and some ISPs hand it to customers.
	cgnatRange = netip.MustParsePrefix("100.64.0.0/10")

	errNoGeoData = errors.New("no geolocation data for this IP")
)

// ------------------------------------------------------------- geo records

// riskFlags is only populated when ipapi.is answered. A nil pointer means the
// signals are unknown, which is different from all-false.
type riskFlags struct {
	IsDatacenter bool   `json:"d"`
	IsVPN        bool   `json:"v"`
	IsProxy      bool   `json:"p"`
	IsTor        bool   `json:"t"`
	IsAbuser     bool   `json:"a"`
	Datacenter   string `json:"dc,omitempty"`
	AbuserScore  string `json:"as,omitempty"`
}

// geoRecord is the cached form of a lookup. It is a struct rather than a
// map[string]any because the cache holds hundreds of thousands of these: the
// map form measured around 3 KB per entry, the struct is an order of magnitude
// smaller. The public map is built per request in flat().
type geoRecord struct {
	IP          string  `json:"ip"`
	Continent   string  `json:"co,omitempty"`
	CountryCode string  `json:"cc"`
	Country     string  `json:"cn,omitempty"`
	Region      string  `json:"rg,omitempty"`
	City        string  `json:"ct,omitempty"`
	Latitude    float64 `json:"la"`
	Longitude   float64 `json:"lo"`
	Timezone    string  `json:"tz,omitempty"`
	PostalCode  string  `json:"pc,omitempty"`
	Accuracy    string  `json:"ac,omitempty"`
	ASN         string  `json:"as,omitempty"`
	ISP         string  `json:"is,omitempty"`

	Risk *riskFlags `json:"rk,omitempty"`
}

// flat renders the public response shape. Absent risk keys mean "unknown" —
// the fallback databases cannot provide them — so they are omitted entirely
// rather than defaulted to false.
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
		"region":      record.Region,
		"city":        record.City,
		"timezone":    record.Timezone,
		"postal_code": record.PostalCode,
		"accuracy":    record.Accuracy,
		"asn":         record.ASN,
		"isp":         record.ISP,
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

type names struct {
	Names map[string]string `maxminddb:"names"`
}

type cityRecord struct {
	Continent struct {
		Code string `maxminddb:"code"`
	} `maxminddb:"continent"`
	Country struct {
		ISOCode string            `maxminddb:"iso_code"`
		Names   map[string]string `maxminddb:"names"`
	} `maxminddb:"country"`
	Subdivisions []names `maxminddb:"subdivisions"`
	City         names   `maxminddb:"city"`
	Postal       struct {
		Code string `maxminddb:"code"`
	} `maxminddb:"postal"`
	Location struct {
		Latitude  float64 `maxminddb:"latitude"`
		Longitude float64 `maxminddb:"longitude"`
		TimeZone  string  `maxminddb:"time_zone"`
	} `maxminddb:"location"`
}

type asnRecord struct {
	Number       uint32 `maxminddb:"autonomous_system_number"`
	Organization string `maxminddb:"autonomous_system_organization"`
}

// upstreamRecord mirrors the subset of the ipapi.is response the API exposes.
type upstreamRecord struct {
	IP           string `json:"ip"`
	IsBogon      bool   `json:"is_bogon"`
	IsDatacenter bool   `json:"is_datacenter"`
	IsTor        bool   `json:"is_tor"`
	IsProxy      bool   `json:"is_proxy"`
	IsVPN        bool   `json:"is_vpn"`
	IsAbuser     bool   `json:"is_abuser"`
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

type cacheEntry struct {
	Key      string     `json:"k"`
	Record   *geoRecord `json:"r,omitempty"`
	NotFound bool       `json:"n,omitempty"`
	Expires  time.Time  `json:"e"`
}

type cacheHeader struct {
	Schema int `json:"schema"`
}

// geoCache keeps lookups in memory and mirrors them to an append-only log, so
// a 30 day TTL survives restarts and deployments. Appending costs one line per
// new entry instead of rewriting the whole snapshot, which matters at a
// six-figure entry count. Disk errors are never fatal: the cache degrades to
// memory-only rather than taking the service down.
type geoCache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	max     int

	path     string
	file     *os.File
	writer   *bufio.Writer
	appended int
	pending  bool
}

func newGeoCache(path string, max int) *geoCache {
	cache := &geoCache{entries: make(map[string]cacheEntry), max: max, path: path}
	if path == "" {
		return cache
	}
	stale := cache.load()
	if err := cache.open(stale); err != nil {
		log.Printf("geo cache persistence disabled: %v", err)
		cache.path = ""
	}
	return cache
}

// load replays the log. It reports whether the file should be rewritten, which
// happens when the schema changed or when expired and superseded lines make up
// most of the file.
func (cache *geoCache) load() bool {
	file, err := os.Open(cache.path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("geo cache not loaded from %s: %v", cache.path, err)
		}
		return true
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	if !scanner.Scan() {
		return true
	}
	var header cacheHeader
	if err := json.Unmarshal(scanner.Bytes(), &header); err != nil || header.Schema != cacheSchema {
		log.Printf("geo cache schema is %v, expected %d — starting empty", header.Schema, cacheSchema)
		return true
	}

	now := time.Now()
	lines := 0
	for scanner.Scan() {
		var entry cacheEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil || entry.Key == "" {
			continue // a torn final line after a crash, nothing more to do about it
		}
		lines++
		if now.Before(entry.Expires) {
			cache.entries[entry.Key] = entry
		} else {
			delete(cache.entries, entry.Key)
		}
	}
	if err := scanner.Err(); err != nil {
		log.Printf("geo cache truncated while reading %s: %v", cache.path, err)
	}
	log.Printf("geo cache loaded %d live entries from %d log lines", len(cache.entries), lines)
	return lines > 2*len(cache.entries)+1000
}

func (cache *geoCache) open(rewrite bool) error {
	if err := os.MkdirAll(filepath.Dir(cache.path), 0o750); err != nil {
		return err
	}
	if rewrite {
		return cache.compactLocked()
	}
	file, err := os.OpenFile(cache.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	cache.file, cache.writer = file, bufio.NewWriter(file)
	return nil
}

func (cache *geoCache) get(key string) (*geoRecord, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry, ok := cache.entries[key]
	if !ok || !time.Now().Before(entry.Expires) {
		return nil, false
	}
	return entry.Record, true
}

func (cache *geoCache) put(key string, record *geoRecord, ttl time.Duration) {
	entry := cacheEntry{Key: key, Record: record, NotFound: record == nil, Expires: time.Now().Add(ttl)}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.entries[key] = entry
	cache.appendLocked(entry)
	if len(cache.entries) > cache.max {
		cache.evictLocked()
	}
}

func (cache *geoCache) appendLocked(entry cacheEntry) {
	if cache.writer == nil {
		return
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	if _, err := cache.writer.Write(append(line, '\n')); err != nil {
		log.Printf("geo cache append failed, persistence disabled: %v", err)
		cache.closeLocked()
		return
	}
	cache.appended++
	cache.pending = true
}

// evictLocked drops the entries closest to expiry, a tenth of the cap at a
// time so eviction does not run on every insert once the cache is full.
func (cache *geoCache) evictLocked() {
	type aged struct {
		key     string
		expires time.Time
	}
	all := make([]aged, 0, len(cache.entries))
	for key, entry := range cache.entries {
		all = append(all, aged{key: key, expires: entry.Expires})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].expires.Before(all[j].expires) })
	drop := len(cache.entries) - cache.max + cache.max/10
	for i := 0; i < drop && i < len(all); i++ {
		delete(cache.entries, all[i].key)
	}
}

// flush persists buffered appends and compacts the log once it is mostly
// superseded lines. It is called from a single goroutine so writes never race.
func (cache *geoCache) flush() error {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.writer == nil || !cache.pending {
		return nil
	}
	if err := cache.writer.Flush(); err != nil {
		return fmt.Errorf("flush geo cache: %w", err)
	}
	// Rename guarantees an atomic directory entry, not durable contents; only
	// Sync makes a restart after power loss see these entries.
	if err := cache.file.Sync(); err != nil {
		return fmt.Errorf("sync geo cache: %w", err)
	}
	cache.pending = false
	if cache.appended > 2*len(cache.entries)+1000 {
		return cache.compactLocked()
	}
	return nil
}

// compactLocked rewrites the log with only the live entries, through a
// temporary file so a crash mid-write cannot destroy the existing one.
func (cache *geoCache) compactLocked() error {
	temporary, err := os.CreateTemp(filepath.Dir(cache.path), ".geo-cache-*")
	if err != nil {
		return fmt.Errorf("create geo cache: %w", err)
	}
	writer := bufio.NewWriter(temporary)
	failed := func(err error, stage string) error {
		temporary.Close()
		os.Remove(temporary.Name())
		return fmt.Errorf("%s geo cache: %w", stage, err)
	}
	header, _ := json.Marshal(cacheHeader{Schema: cacheSchema})
	if _, err := writer.Write(append(header, '\n')); err != nil {
		return failed(err, "write")
	}
	now := time.Now()
	live := 0
	for _, entry := range cache.entries {
		if !now.Before(entry.Expires) {
			continue
		}
		line, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		if _, err := writer.Write(append(line, '\n')); err != nil {
			return failed(err, "write")
		}
		live++
	}
	if err := writer.Flush(); err != nil {
		return failed(err, "flush")
	}
	if err := temporary.Sync(); err != nil {
		return failed(err, "sync")
	}
	if err := temporary.Close(); err != nil {
		os.Remove(temporary.Name())
		return fmt.Errorf("close geo cache: %w", err)
	}
	if err := os.Rename(temporary.Name(), cache.path); err != nil {
		os.Remove(temporary.Name())
		return fmt.Errorf("publish geo cache: %w", err)
	}

	cache.closeLocked()
	file, err := os.OpenFile(cache.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("reopen geo cache: %w", err)
	}
	cache.file, cache.writer = file, bufio.NewWriter(file)
	cache.appended, cache.pending = live, false
	return nil
}

func (cache *geoCache) closeLocked() {
	if cache.file != nil {
		cache.file.Close()
	}
	cache.file, cache.writer = nil, nil
}

// purge empties the cache and the log. Wired to SIGHUP so a bad batch of
// cached answers can be cleared with systemctl reload, without exposing an
// unauthenticated admin endpoint.
func (cache *geoCache) purge() error {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.entries = make(map[string]cacheEntry)
	if cache.path == "" {
		return nil
	}
	return cache.compactLocked()
}

func (cache *geoCache) size() int {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return len(cache.entries)
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

// ------------------------------------------------------------- daily quota

// dailyQuota is the only thing standing between a traffic spike and a blown
// ipapi.is bill: the API returns no quota headers at all, so usage has to be
// counted locally.
type dailyQuota struct {
	mu    sync.Mutex
	day   string
	used  int
	limit int
}

func (quota *dailyQuota) take() bool {
	if quota.limit <= 0 {
		return true
	}
	today := time.Now().UTC().Format(time.DateOnly)
	quota.mu.Lock()
	defer quota.mu.Unlock()
	if quota.day != today {
		if quota.day != "" {
			log.Printf("ipapi.is usage for %s: %d/%d", quota.day, quota.used, quota.limit)
		}
		quota.day, quota.used = today, 0
	}
	if quota.used >= quota.limit {
		return false
	}
	quota.used++
	if quota.used%500 == 0 || quota.used == quota.limit {
		log.Printf("ipapi.is usage today: %d/%d", quota.used, quota.limit)
	}
	return true
}

// -------------------------------------------------------------- ipapi.is

// errUpstreamNoData means ipapi.is answered correctly but has nothing for this
// IP — a private range, a bogon, an unallocated block. That is a property of
// the address, not an upstream problem, so it counts as a healthy response.
var errUpstreamNoData = errors.New("ipapi.is has no data for this IP")

// errUpstreamQuota means the daily budget is spent. Like errUpstreamNoData it
// says nothing about the upstream's health, so it must not trip the breaker —
// otherwise the breaker would spend the rest of the day probing once a minute.
var errUpstreamQuota = errors.New("ipapi.is daily quota reached")

type upstreamClient struct {
	endpoint string
	key      string
	client   *http.Client
	inflight chan struct{}
	quota    *dailyQuota

	mu        sync.Mutex
	failures  int
	openUntil time.Time
}

func newUpstreamClient(endpoint, key string, timeout time.Duration, maxInflight, dailyLimit int) *upstreamClient {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = maxInflight
	return &upstreamClient{
		endpoint: strings.TrimRight(endpoint, "/"),
		key:      key,
		client: &http.Client{
			Timeout:   timeout,
			Transport: transport,
			// Go copies the request URL into the Referer header when it follows
			// a redirect, and it never strips the query string. Following one
			// would hand the key to whatever host the redirect points at.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		inflight: make(chan struct{}, maxInflight),
		quota:    &dailyQuota{limit: dailyLimit},
	}
}

// allow admits a caller through the breaker. When the cooldown expires exactly
// one caller is let through as a probe; the rest keep using the local
// databases until that probe reports back.
func (upstream *upstreamClient) allow() bool {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	if upstream.openUntil.IsZero() {
		return true
	}
	if time.Now().Before(upstream.openUntil) {
		return false
	}
	// Hold the door for another cooldown so a failing probe does not release a
	// whole wave of requests behind it.
	upstream.openUntil = time.Now().Add(upstreamBreakerCooldown)
	return true
}

func (upstream *upstreamClient) recordSuccess() {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	upstream.failures = 0
	upstream.openUntil = time.Time{}
}

func (upstream *upstreamClient) recordFailure() {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	upstream.failures++
	if upstream.failures >= upstreamBreakerTrip {
		upstream.openUntil = time.Now().Add(upstreamBreakerCooldown)
		upstream.failures = 0
		log.Printf("ipapi.is disabled for %s after repeated failures", upstreamBreakerCooldown)
	}
}

// redact keeps the API key out of the logs. It is defence in depth: the key
// travels in the request body, not the URL, but an endpoint override could
// still put it somewhere Go copies into an error.
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
	// Checked before the breaker probe so an exhausted budget does not burn it.
	if !upstream.quota.take() {
		return nil, errUpstreamQuota
	}
	select {
	case upstream.inflight <- struct{}{}:
		defer func() { <-upstream.inflight }()
	default:
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
		return nil, fmt.Errorf("ipapi.is returned HTTP %d: %s", response.StatusCode, snippet(body))
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

// snippet keeps the upstream's own wording (an invalid key says so) without
// letting a large error page into the log.
func snippet(body []byte) string {
	text := strings.TrimSpace(string(body))
	if len(text) > 200 {
		text = text[:200] + "…"
	}
	return text
}

func upstreamGeoRecord(ip string, record *upstreamRecord) *geoRecord {
	location := record.Location
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
		ASN: func() string {
			if record.ASN.Number == 0 {
				return ""
			}
			return "AS" + strconv.FormatUint(uint64(record.ASN.Number), 10)
		}(),
		ISP: firstNonEmpty(record.ASN.Org, record.ASN.Descr, record.Company.Name),
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
	city        *maxminddb.Reader
	asn         *maxminddb.Reader
	maxmindCity *maxminddb.Reader
	upstream    *upstreamClient
	cache       *geoCache
	cacheTTL    time.Duration
	group       *singleFlight
	sslMu       sync.Mutex
	sslCache    map[string]sslCacheEntry
}

type sslCacheEntry struct {
	value   map[string]any
	expires time.Time
}

func openService() (*geoService, error) {
	dbipCityPath := env("DBIP_MMDB_PATH", "/opt/ipflag-api/current/data/dbip-city-lite.mmdb")
	dbipASNPath := env("DBIP_ASN_MMDB_PATH", "/opt/ipflag-api/current/data/dbip-asn-lite.mmdb")
	maxmindCityPath := env("MAXMIND_CITY_MMDB_PATH", "/opt/ipflag-api/current/data/GeoLite2-City.mmdb")
	dbipCity, err := maxminddb.Open(dbipCityPath)
	if err != nil {
		return nil, fmt.Errorf("open DB-IP City database: %w", err)
	}
	dbipASN, err := maxminddb.Open(dbipASNPath)
	if err != nil {
		dbipCity.Close()
		return nil, fmt.Errorf("open DB-IP ASN database: %w", err)
	}
	maxmindCity, err := maxminddb.Open(maxmindCityPath)
	if err != nil {
		log.Printf("MaxMind GeoLite2 supplement unavailable: %v", err)
		maxmindCity = nil
	}

	var upstream *upstreamClient
	if key := os.Getenv("IPAPI_IS_KEY"); key != "" {
		limit := envInt("IPAPI_IS_DAILY_LIMIT", defaultDailyLimit, 0)
		upstream = newUpstreamClient(
			env("IPAPI_IS_URL", defaultUpstreamURL),
			key,
			envDuration("IPAPI_IS_TIMEOUT", defaultUpstreamTimeout),
			envInt("IPAPI_IS_MAX_INFLIGHT", defaultMaxInflight, 1),
			limit,
		)
		log.Printf("ipapi.is is the primary source, daily limit %d, local databases used as fallback", limit)
	} else {
		log.Printf("IPAPI_IS_KEY is not set, serving from the local databases only")
	}

	return &geoService{
		city:        dbipCity,
		asn:         dbipASN,
		maxmindCity: maxmindCity,
		upstream:    upstream,
		cache:       newGeoCache(env("GEO_CACHE_PATH", defaultCachePath), envInt("GEO_CACHE_MAX", defaultCacheMaxEntries, 1)),
		cacheTTL:    envDuration("GEO_CACHE_TTL", defaultGeoCacheTTL),
		group:       newSingleFlight(),
		sslCache:    make(map[string]sslCacheEntry),
	}, nil
}

func text(values map[string]string, key string) string {
	if values == nil {
		return ""
	}
	return values[key]
}

// routable reports whether it is worth asking a geolocation service about an
// address. Private, loopback, link-local and CGNAT addresses are never in any
// geo database, and sending them upstream would both waste quota and disclose
// the user's internal addressing to a third party.
func routable(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	return !cgnatRange.Contains(address.Unmap())
}

// lookup resolves an IP through ipapi.is, falling back to the local databases
// when the upstream is unset, broken, out of quota or unable to answer.
func (service *geoService) lookup(ip net.IP) (*geoRecord, error) {
	key := ip.String()
	if record, ok := service.cache.get(key); ok {
		if record == nil {
			return nil, errNoGeoData
		}
		return record, nil
	}
	return service.group.do(key, func() (*geoRecord, error) {
		if record, ok := service.cache.get(key); ok {
			if record == nil {
				return nil, errNoGeoData
			}
			return record, nil
		}

		// A local answer normally expires quickly so the upstream is retried
		// soon after it recovers. When the upstream is healthy and simply has
		// no record for this address, or when the address is one we will never
		// ask about, that retry would be pure waste — keep it for a day.
		ttl := notFoundCacheTTL
		if service.upstream != nil && routable(ip) && service.upstream.allow() {
			record, err := service.upstream.lookup(ip)
			switch {
			case err == nil:
				service.upstream.recordSuccess()
				resolved := upstreamGeoRecord(key, record)
				service.cache.put(key, resolved, service.cacheTTL)
				return resolved, nil
			case errors.Is(err, errUpstreamNoData):
				// The upstream is healthy, this address simply is not in it.
				service.upstream.recordSuccess()
			case errors.Is(err, errUpstreamQuota):
				// Expected once a day at worst; dailyQuota already logged it.
				// Keep the short TTL so the upstream is asked again as soon as
				// the budget rolls over at UTC midnight.
				ttl = fallbackCacheTTL
			default:
				service.upstream.recordFailure()
				ttl = fallbackCacheTTL
				log.Printf("ipapi.is lookup for %s failed, falling back to local databases: %v", key, err)
			}
		}

		record, err := service.localLookup(ip)
		if err != nil {
			// Neither source can place this address. Remember that, or every
			// navigation to an intranet host spends another upstream request.
			service.cache.put(key, nil, notFoundCacheTTL)
			return nil, errNoGeoData
		}
		service.cache.put(key, record, ttl)
		return record, nil
	})
}

// localLookup is the original DB-IP primary / MaxMind supplement path. It is
// now the fallback, and keeps the behaviour it had before ipapi.is was
// introduced so a degraded service still answers as it always did.
func (service *geoService) localLookup(ip net.IP) (*geoRecord, error) {
	var city cityRecord
	if err := service.city.Lookup(ip, &city); err != nil {
		return nil, err
	}
	var supplement cityRecord
	if service.maxmindCity != nil {
		_ = service.maxmindCity.Lookup(ip, &supplement)
	}
	var asn asnRecord
	if err := service.asn.Lookup(ip, &asn); err != nil {
		return nil, err
	}
	code := strings.ToUpper(city.Country.ISOCode)
	if code == "" {
		city = supplement
		code = strings.ToUpper(city.Country.ISOCode)
	}
	if code == "" {
		return nil, errNoGeoData
	}
	record := &geoRecord{
		IP:          ip.String(),
		Continent:   city.Continent.Code,
		CountryCode: code,
		Country:     text(city.Country.Names, "en"),
		Latitude:    city.Location.Latitude,
		Longitude:   city.Location.Longitude,
		Timezone:    firstNonEmpty(city.Location.TimeZone, supplement.Location.TimeZone),
		PostalCode:  firstNonEmpty(city.Postal.Code, supplement.Postal.Code),
		City:        text(city.City.Names, "en"),
	}
	if city.Location.Latitude == 0 && city.Location.Longitude == 0 {
		record.Latitude = supplement.Location.Latitude
		record.Longitude = supplement.Location.Longitude
	}
	if len(city.Subdivisions) > 0 {
		record.Region = text(city.Subdivisions[0].Names, "en")
	}
	if asn.Number != 0 {
		record.ASN = "AS" + strconv.FormatUint(uint64(asn.Number), 10)
	}
	record.ISP = asn.Organization
	return record, nil
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

func jsonResponse(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Access-Control-Allow-Origin", "*")
	writer.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	switch {
	case status == http.StatusOK:
		writer.Header().Set("Cache-Control", "public, max-age=300")
	case status == http.StatusNotFound:
		// Let the edge absorb repeated misses for unroutable addresses.
		writer.Header().Set("Cache-Control", "public, max-age=60")
	default:
		writer.Header().Set("Cache-Control", "no-store")
	}
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
			jsonResponse(writer, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
			return
		}
		if !limiter.allow(clientKey(request)) {
			writer.Header().Set("Retry-After", "60")
			jsonResponse(writer, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"})
			return
		}
		pathParts := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
		if request.URL.Path == "/" || request.URL.Path == "/health" {
			jsonResponse(writer, http.StatusOK, map[string]any{"ok": true, "service": "IP Flag Geo API"})
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
			jsonResponse(writer, http.StatusNotFound, map[string]any{"error": "not_found", "endpoints": []string{"/ip/:ip", "/domain/:domain"}})
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
				jsonResponse(writer, http.StatusBadRequest, map[string]string{"error": "invalid_ip"})
				return
			}
		} else {
			domain, err = cleanDomain(value)
			query = domain
			if err != nil {
				jsonResponse(writer, http.StatusBadRequest, map[string]string{"error": "invalid_domain"})
				return
			}
			ip, err = resolveDomain(domain)
			if err != nil {
				jsonResponse(writer, http.StatusNotFound, map[string]string{"error": "domain_not_resolved", "domain": domain})
				return
			}
		}
		record, err := service.lookup(ip)
		if err != nil || record == nil {
			jsonResponse(writer, http.StatusNotFound, map[string]string{"error": "ip_not_found", "ip": ip.String()})
			return
		}
		// The cached record is shared between requests; flat() builds a fresh
		// map so the per-request fields cannot race with a concurrent handler.
		result := record.flat()
		result["query"] = query
		result["query_type"] = endpoint
		if domain != "" {
			result["ssl"] = service.ssl(domain)
		}
		jsonResponse(writer, http.StatusOK, result)
	})
}

func main() {
	service, err := openService()
	if err != nil {
		log.Fatal(err)
	}
	defer service.city.Close()
	defer service.asn.Close()
	if service.maxmindCity != nil {
		defer service.maxmindCity.Close()
	}

	// One goroutine owns every write to the cache log, so a periodic flush can
	// never race the shutdown flush or leave an orphaned temporary file.
	flushInterval := envDuration("GEO_CACHE_FLUSH", defaultCacheFlush)
	stopFlush := make(chan struct{})
	flushDone := make(chan struct{})
	reload := make(chan os.Signal, 1)
	signal.Notify(reload, syscall.SIGHUP)
	go func() {
		defer close(flushDone)
		ticker := time.NewTicker(flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := service.cache.flush(); err != nil {
					log.Printf("geo cache flush failed, will retry: %v", err)
				}
			case <-reload:
				if err := service.cache.purge(); err != nil {
					log.Printf("geo cache purge failed: %v", err)
				} else {
					log.Printf("geo cache purged on SIGHUP")
				}
			case <-stopFlush:
				if err := service.cache.flush(); err != nil {
					log.Printf("WARNING: geo cache NOT persisted on shutdown: %v", err)
				} else {
					log.Printf("geo cache saved with %d entries, shutting down", service.cache.size())
				}
				return
			}
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
		signal.Stop(shutdown)
		close(stopFlush)
		<-flushDone // the log is on disk before the process can exit
		_ = server.Close()
	}()

	log.Printf("listening on http://%s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-flushDone
}
