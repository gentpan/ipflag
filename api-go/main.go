package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/maxminddb-golang"
)

const (
	defaultPort      = "4320"
	geoCacheTTL      = 10 * time.Minute
	sslCacheTTL      = 5 * time.Minute
	requestWindow    = time.Minute
	defaultRateLimit = 120
	sslLookupTimeout = 5 * time.Second
)

var domainPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

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
	Location     struct {
		Latitude  float64 `maxminddb:"latitude"`
		Longitude float64 `maxminddb:"longitude"`
	} `maxminddb:"location"`
}

type asnRecord struct {
	Number       uint32 `maxminddb:"autonomous_system_number"`
	Organization string `maxminddb:"autonomous_system_organization"`
}

type geoService struct {
	city     *maxminddb.Reader
	asn      *maxminddb.Reader
	geoMu    sync.Mutex
	geo      map[string]cacheEntry
	sslMu    sync.Mutex
	sslCache map[string]sslCacheEntry
}

type cacheEntry struct {
	value   map[string]any
	expires time.Time
}

type sslCacheEntry struct {
	value   map[string]any
	expires time.Time
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func openService() (*geoService, error) {
	cityPath := env("DBIP_MMDB_PATH", "/opt/ipflag-api/current/data/dbip-city-lite.mmdb")
	asnPath := env("DBIP_ASN_MMDB_PATH", "/opt/ipflag-api/current/data/dbip-asn-lite.mmdb")
	city, err := maxminddb.Open(cityPath)
	if err != nil {
		return nil, fmt.Errorf("open DB-IP city database: %w", err)
	}
	asn, err := maxminddb.Open(asnPath)
	if err != nil {
		city.Close()
		return nil, fmt.Errorf("open DB-IP ASN database: %w", err)
	}
	return &geoService{city: city, asn: asn, geo: make(map[string]cacheEntry), sslCache: make(map[string]sslCacheEntry)}, nil
}

func text(values map[string]string, key string) string {
	if values == nil {
		return ""
	}
	return values[key]
}

func (service *geoService) lookup(ip net.IP) (map[string]any, error) {
	key := ip.String()
	service.geoMu.Lock()
	if entry, ok := service.geo[key]; ok && time.Now().Before(entry.expires) {
		value := entry.value
		service.geoMu.Unlock()
		return value, nil
	}
	service.geoMu.Unlock()

	var city cityRecord
	if err := service.city.Lookup(ip, &city); err != nil {
		return nil, err
	}
	var asn asnRecord
	if err := service.asn.Lookup(ip, &asn); err != nil {
		return nil, err
	}
	code := strings.ToUpper(city.Country.ISOCode)
	if code == "" {
		return nil, errors.New("IP not found in DB-IP")
	}
	value := map[string]any{
		"ip":           key,
		"continent":    city.Continent.Code,
		"country_code": code,
		"country":      text(city.Country.Names, "en"),
		"latitude":     city.Location.Latitude,
		"longitude":    city.Location.Longitude,
	}
	if len(city.Subdivisions) > 0 {
		value["region"] = text(city.Subdivisions[0].Names, "en")
	}
	if cityName := text(city.City.Names, "en"); cityName != "" {
		value["city"] = cityName
	}
	if asn.Number != 0 {
		value["asn"] = "AS" + strconv.FormatUint(uint64(asn.Number), 10)
	}
	if asn.Organization != "" {
		value["isp"] = asn.Organization
	}
	service.geoMu.Lock()
	service.geo[key] = cacheEntry{value: value, expires: time.Now().Add(geoCacheTTL)}
	service.geoMu.Unlock()
	return value, nil
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
	if status == http.StatusOK {
		writer.Header().Set("Cache-Control", "public, max-age=300")
	} else {
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
		result, err := service.lookup(ip)
		if err != nil {
			jsonResponse(writer, http.StatusNotFound, map[string]string{"error": "ip_not_found", "ip": ip.String()})
			return
		}
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
	limit, _ := strconv.Atoi(env("RATE_LIMIT", strconv.Itoa(defaultRateLimit)))
	if limit < 1 {
		limit = defaultRateLimit
	}
	server := &http.Server{Addr: env("HOST", "127.0.0.1") + ":" + env("PORT", defaultPort), Handler: service.handler(&limiter{items: make(map[string]rateEntry), limit: limit}), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("listening on http://%s", server.Addr)
	log.Fatal(server.ListenAndServe())
}
