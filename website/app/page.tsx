"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { getTranslation, languages, type Language } from "./translations";

const CHROME_STORE_URL = "https://chromewebstore.google.com/detail/ipgeo-flag/aaclbfgifnkbhkokgajglhgphjjjcoaa";

function FlagMark() {
  return <img className="flag-mark" src="/ipflag-icon.svg" alt="" aria-hidden="true" />;
}

function LanguageSwitcher({ language, onChange }: { language: Language; onChange: (value: Language) => void }) {
  return (
    <label className="language-switcher">
      <span className="language-globe" aria-hidden="true">◎</span>
      <span className="sr-only">Language</span>
      <select value={language} onChange={(event) => onChange(event.target.value as Language)} aria-label="Language">
        {languages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      </select>
    </label>
  );
}

export default function Home() {
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === "undefined") return "en";
    const queryLanguage = new URLSearchParams(window.location.search).get("lang") as Language | null;
    const savedLanguage = window.localStorage.getItem("ipflag-language") as Language | null;
    return (languages.some(([code]) => code === queryLanguage) && queryLanguage) || (languages.some(([code]) => code === savedLanguage) && savedLanguage) || "en";
  });
  const t = getTranslation(language);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t.title;
  }, [language, t.title]);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    window.localStorage.setItem("ipflag-language", next);
    const url = new URL(window.location.href);
    url.searchParams.set("lang", next);
    window.history.replaceState({}, "", url);
  };

  return (
    <main>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="IP Flag home"><FlagMark /><span>IP FLAG</span></a>
        <nav aria-label="Main navigation">
          <a href="#features">{t.navFeatures}</a>
          <a href="#how-it-works">{t.navHow}</a>
          <a href="#privacy">{t.navPrivacy}</a>
        </nav>
        <div className="header-tools">
          <LanguageSwitcher language={language} onChange={changeLanguage} />
          <a className="header-cta" href={CHROME_STORE_URL} target="_blank" rel="noreferrer">{t.getFlag} <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> {t.eyebrow}</p>
          <h1>{t.heroTitle}<span className="hero-accent">{t.heroAccent}</span></h1>
          <p className="hero-intro">{t.heroIntro}</p>
          <div className="hero-actions">
            <a className="primary-button" href={CHROME_STORE_URL} target="_blank" rel="noreferrer">{t.addChrome} <span aria-hidden="true">↗</span></a>
            <a className="text-link" href="#how-it-works">{t.seeHow} <span aria-hidden="true">↓</span></a>
          </div>
          <div className="hero-proof" aria-label="Product attributes">
            {t.proof.map((item, index) => <span key={item}><b>0{index + 1}</b> {item}</span>)}
          </div>
        </div>

        <div className="product-stage" aria-label="IP Flag extension preview">
          <div className="stage-orbit orbit-one" /><div className="stage-orbit orbit-two" />
          <div className="browser-card">
            <div className="browser-topbar">
              <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
              <div className="address-bar"><span className="lock">◆</span>example.com</div>
              <div className="toolbar-flag"><img src="/flag-us.svg" alt="United States flag" /></div><span className="menu-dots">•••</span>
            </div>
            <div className="browser-page"><span className="page-label">{t.currentWebsite}</span><div className="page-lines"><i /><i /><i /><i /></div><div className="server-path"><span className="server-node">{t.serverPathYou}</span><i /><span className="server-node highlighted">US</span></div></div>
          </div>
          <div className="extension-popover">
            <div className="popover-head"><img src="/flag-us.svg" alt="United States flag" /><div><strong>United States</strong><span>San Francisco, California</span></div><b>US</b></div>
            <div className="map-grid" aria-label="Map preview"><span className="map-pin"><i /></span><span className="map-caption">SAN FRANCISCO</span></div>
            <dl className="detail-list">{t.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </div>
          <div className="floating-flags" aria-hidden="true"><span><img src="/flag-de.svg" alt="" /></span><span><img src="/flag-jp.svg" alt="" /></span><span><img src="/flag-uz.svg" alt="" /></span></div>
        </div>
      </section>

      <section className="signal-strip" aria-label="IP Flag information fields"><div className="signal-track">{t.infoStrip.map((item) => <span key={item}>{item}<i /></span>)}</div></section>

      <section className="features shell" id="features">
        <div className="section-heading"><p className="eyebrow"><span /> {t.whatGet}</p><h2>{t.sectionTitle[0]}<br />{t.sectionTitle[1]}</h2><p>{t.sectionIntro}</p></div>
        <div className="feature-grid">{t.features.map((feature, index) => { const number = `0${index + 1}`; return <article className="feature-card" key={number}><div className="feature-meta"><span>{number}</span><b>{feature.label}</b></div><div className={`feature-visual visual-${number}`} aria-hidden="true">{number === "01" && <div className="mini-toolbar"><i /><i /><i /><img src="/flag-de.svg" alt="" /></div>}{number === "02" && <div className="network-lines"><span>IP</span><b>172.67.174.72</b><span>ASN</span><b>AS13335</b></div>}{number === "03" && <div className="mini-map"><span><i /></span></div>}</div><h3>{feature.title}</h3><p>{feature.copy}</p></article>; })}</div>
      </section>

      <section className="how-it-works" id="how-it-works"><div className="shell steps-layout"><div className="steps-intro"><p className="eyebrow light"><span /> {t.howEyebrow}</p><h2>{t.howTitle}</h2><p>{t.howIntro}</p></div><ol className="steps-list">{t.steps.map((step, index) => <li key={step.title}><span>0{index + 1}</span><div><h3>{step.title}</h3><p>{step.copy}</p></div></li>)}</ol></div></section>

      <section className="privacy shell" id="privacy"><div className="privacy-card"><div><p className="eyebrow"><span /> {t.privacyEyebrow}</p><h2>{t.privacyTitle[0]}<br />{t.privacyTitle[1]}</h2></div><div className="privacy-copy"><p>{t.privacyCopy}</p><ul>{t.privacyChecks.map((item) => <li key={item}><span>✓</span> {item}</li>)}</ul><a href="/privacy/">{t.readPrivacy} <span aria-hidden="true">→</span></a></div></div></section>

      <section className="final-cta" id="install"><div className="final-flags" aria-hidden="true"><img src="/flag-de.svg" alt="" /><img src="/flag-us.svg" alt="" /><img src="/flag-jp.svg" alt="" /><img src="/flag-cn.svg" alt="" /><img src="/flag-sg.svg" alt="" /><img src="/flag-hk.svg" alt="" /></div><div className="shell final-content"><p className="eyebrow light"><span /> {t.coming}</p><h2>{t.finalTitle}</h2><p>{t.finalCopy}</p><a className="store-button" href={CHROME_STORE_URL} target="_blank" rel="noreferrer" aria-label={t.comingSoon}><b className="chrome-dot" /><span><small>{t.comingSoon}</small>Chrome Web Store</span></a></div></section>

      <footer className="site-footer shell"><a className="brand" href="#top"><FlagMark /><span>IP FLAG</span></a><p>{t.footerCopy}</p><div><a href="/privacy/">{t.footerPrivacy}</a><a href="https://www.maxmind.com/en/geolite2" target="_blank" rel="noreferrer">{t.dbIpAttribution}</a><span>© 2026 IP Flag</span></div></footer>
    </main>
  );
}
