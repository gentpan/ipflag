import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — IP Flag",
  description: "How IP Flag handles website hostnames and server location data.",
  alternates: { canonical: "https://ipflag.io/privacy" },
};

const sections = [
  {
    title: "What IP Flag does",
    body: "IP Flag is a browser extension that displays the country flag and network location of the server used by the website you are visiting.",
  },
  {
    title: "Data processed",
    body: "To provide this feature, IP Flag sends the current website hostname to https://api.ipflag.io. The response can include the resolved server IP, country, region, city, ASN, ISP, timezone and approximate coordinates. This describes the website server, not your physical location.",
  },
  {
    title: "Local caching",
    body: "Lookup results are cached in browser session storage to improve speed and reduce repeated requests. Session storage is cleared by the browser when the browsing session ends.",
  },
  {
    title: "What we do not collect",
    body: "IP Flag does not request your name, email address, passwords, payment information or page content. It does not sell user data or use lookup data for advertising profiles.",
  },
  {
    title: "Third-party services",
    body: "IP Flag uses its own geolocation API, backed primarily by local DB-IP Lite databases with MaxMind GeoLite2 as a supplemental source, and an optional map image service to display the approximate server location. DB-IP and MaxMind attribution are provided on this site. Opening optional external links is always initiated by the user.",
  },
  {
    title: "Changes",
    body: "This policy may be updated when the extension or its service providers change. The latest version will always be published on this page.",
  },
];

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <header className="legal-header shell">
        <Link className="brand" href="/" aria-label="Back to IP Flag home">
          <img className="flag-mark" src="/ipflag-icon.svg" alt="" aria-hidden="true" />
          <span>IP FLAG</span>
        </Link>
        <Link className="legal-back" href="/">← Back to home</Link>
      </header>
      <article className="legal-content shell">
        <div className="legal-title">
          <p className="eyebrow"><span /> Legal</p>
          <h1>Privacy policy</h1>
          <p>Effective July 31, 2026</p>
        </div>
        <div className="legal-sections">
          {sections.map((section, index) => (
            <section key={section.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{section.title}</h2>
                <p>{section.body}</p>
              </div>
            </section>
          ))}
        </div>
      </article>
      <footer className="legal-footer shell">
        <span>© 2026 IP Flag</span>
        <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP Lite</a>
        <a href="https://www.maxmind.com/en/geolite2" target="_blank" rel="noreferrer">IP Geolocation by MaxMind GeoLite2</a>
        <a href="https://ipflag.io">ipflag.io</a>
      </footer>
    </main>
  );
}
