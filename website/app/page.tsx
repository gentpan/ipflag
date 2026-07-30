/* eslint-disable @next/next/no-img-element */
const details = [
  ["IP address", "104.20.23.154"],
  ["Domain", "example.com"],
  ["ASN", "AS13335"],
  ["ISP", "Cloudflare"],
  ["Timezone", "America/Los_Angeles"],
  ["Coordinates", "37.7749, -122.4194"],
];

const features = [
  {
    number: "01",
    label: "Instant signal",
    title: "The flag is the answer.",
    copy: "See the server country without opening a panel. IP Flag keeps the signal right in your browser toolbar.",
  },
  {
    number: "02",
    label: "Network context",
    title: "Look past the domain.",
    copy: "Open the popup for the resolved IP, ASN, provider, city, timezone and coordinates behind the site.",
  },
  {
    number: "03",
    label: "Geographic view",
    title: "Put the server on a map.",
    copy: "Turn raw infrastructure data into a place you can understand at a glance, without leaving the page.",
  },
];

function FlagMark() {
  return (
    <span className="flag-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export default function Home() {
  return (
    <main>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="IP Flag home">
          <FlagMark />
          <span>IP FLAG</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <a className="header-cta" href="#install">
          Get IP Flag <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> Website server intelligence</p>
          <h1>
            See where every
            <span className="hero-accent"> website is hosted.</span>
          </h1>
          <p className="hero-intro">
            IP Flag adds a country flag to your browser toolbar and reveals the
            IP, network and location behind any website in one click.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#install">
              Add to Chrome <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href="#how-it-works">
              See how it works <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className="hero-proof" aria-label="Product attributes">
            <span><b>01</b> No account</span>
            <span><b>02</b> One-click details</span>
            <span><b>03</b> Built for Chrome</span>
          </div>
        </div>

        <div className="product-stage" aria-label="IP Flag extension preview">
          <div className="stage-orbit orbit-one" />
          <div className="stage-orbit orbit-two" />
          <div className="browser-card">
            <div className="browser-topbar">
              <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
              <div className="address-bar">
                <span className="lock">◆</span>
                example.com
              </div>
              <div className="toolbar-flag">
                <img src="/flag-us.svg" alt="United States flag" />
              </div>
              <span className="menu-dots">•••</span>
            </div>
            <div className="browser-page">
              <span className="page-label">CURRENT WEBSITE</span>
              <div className="page-lines"><i /><i /><i /><i /></div>
              <div className="server-path">
                <span className="server-node">YOU</span>
                <i />
                <span className="server-node highlighted">US</span>
              </div>
            </div>
          </div>

          <div className="extension-popover">
            <div className="popover-head">
              <img src="/flag-us.svg" alt="United States flag" />
              <div>
                <strong>United States</strong>
                <span>San Francisco, California</span>
              </div>
              <b>US</b>
            </div>
            <div className="map-grid" aria-label="Map preview">
              <span className="map-pin"><i /></span>
              <span className="map-caption">SAN FRANCISCO</span>
            </div>
            <dl className="detail-list">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="floating-flags" aria-hidden="true">
            <span><img src="/flag-de.svg" alt="" /></span>
            <span><img src="/flag-jp.svg" alt="" /></span>
            <span><img src="/flag-uz.svg" alt="" /></span>
          </div>
        </div>
      </section>

      <section className="signal-strip" aria-label="IP Flag information fields">
        <div className="signal-track">
          <span>COUNTRY FLAG</span><i />
          <span>IP ADDRESS</span><i />
          <span>ASN</span><i />
          <span>ISP</span><i />
          <span>CITY</span><i />
          <span>TIMEZONE</span><i />
          <span>SERVER MAP</span><i />
        </div>
      </section>

      <section className="features shell" id="features">
        <div className="section-heading">
          <p className="eyebrow"><span /> What you get</p>
          <h2>One small flag.<br />A clearer internet.</h2>
          <p>Understand the infrastructure behind a website without opening developer tools or another tab.</p>
        </div>
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.number}>
              <div className="feature-meta">
                <span>{feature.number}</span>
                <b>{feature.label}</b>
              </div>
              <div className={`feature-visual visual-${feature.number}`} aria-hidden="true">
                {feature.number === "01" && (
                  <div className="mini-toolbar"><i /><i /><i /><img src="/flag-de.svg" alt="" /></div>
                )}
                {feature.number === "02" && (
                  <div className="network-lines"><span>IP</span><b>172.67.174.72</b><span>ASN</span><b>AS13335</b></div>
                )}
                {feature.number === "03" && (
                  <div className="mini-map"><span><i /></span></div>
                )}
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="how-it-works" id="how-it-works">
        <div className="shell steps-layout">
          <div className="steps-intro">
            <p className="eyebrow light"><span /> How it works</p>
            <h2>From URL to location, automatically.</h2>
            <p>Browse normally. IP Flag handles the lookup and keeps the answer close.</p>
          </div>
          <ol className="steps-list">
            <li>
              <span>01</span>
              <div><h3>Open a website</h3><p>Visit any regular HTTP or HTTPS page in your browser.</p></div>
            </li>
            <li>
              <span>02</span>
              <div><h3>Spot the country</h3><p>The toolbar icon changes to the server country flag.</p></div>
            </li>
            <li>
              <span>03</span>
              <div><h3>Open the full picture</h3><p>Click once for the IP, network, city, timezone and map.</p></div>
            </li>
          </ol>
        </div>
      </section>

      <section className="privacy shell" id="privacy">
        <div className="privacy-card">
          <div>
            <p className="eyebrow"><span /> Privacy, plainly</p>
            <h2>Useful context.<br />Nothing extra.</h2>
          </div>
          <div className="privacy-copy">
            <p>
              IP Flag sends the current website hostname to its geolocation
              service only to resolve the server location. Results are cached
              in your browser session for speed and cleared when the session ends.
            </p>
            <ul>
              <li><span>✓</span> No account or sign-up</li>
              <li><span>✓</span> No ads or behavioral profiles</li>
              <li><span>✓</span> No selling of user data</li>
            </ul>
            <a href="/privacy/">Read the privacy policy <span aria-hidden="true">→</span></a>
          </div>
        </div>
      </section>

      <section className="final-cta" id="install">
        <div className="final-flags" aria-hidden="true">
          <img src="/flag-de.svg" alt="" />
          <img src="/flag-us.svg" alt="" />
          <img src="/flag-jp.svg" alt="" />
        </div>
        <div className="shell final-content">
          <p className="eyebrow light"><span /> Coming to Chrome</p>
          <h2>Know where the web takes you.</h2>
          <p>IP Flag is getting ready for the Chrome Web Store.</p>
          <span className="store-button" aria-label="Chrome Web Store release coming soon">
            <b className="chrome-dot" />
            <span><small>COMING SOON ON THE</small>Chrome Web Store</span>
          </span>
        </div>
      </section>

      <footer className="site-footer shell">
        <a className="brand" href="#top"><FlagMark /><span>IP FLAG</span></a>
          <p>See where every website is hosted.</p>
        <div>
          <a href="/privacy/">Privacy</a>
          <span>© 2026 IP Flag</span>
        </div>
      </footer>
    </main>
  );
}
