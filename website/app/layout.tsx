import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const SITE_URL = "https://ipflag.io";
const CHROME_STORE_URL = "https://chromewebstore.google.com/detail/ipgeo-flag/aaclbfgifnkbhkokgajglhgphjjjcoaa";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(SITE_URL),
    title: "IP Flag — Website IP & Server Location",
    description:
      "See where every website is hosted, with its country, IP, network and server location.",
    keywords: [
      "website IP lookup",
      "server location",
      "IP geolocation",
      "Chrome extension",
      "country flag",
      "ASN lookup",
      "website hosting location",
    ],
    authors: [{ name: "IP Flag", url: SITE_URL }],
    creator: "IP Flag",
    publisher: "IP Flag",
    category: "technology",
    alternates: {
      canonical: SITE_URL,
      languages: {
        en: `${SITE_URL}/?lang=en`,
        "zh-CN": `${SITE_URL}/?lang=zh-CN`,
        "zh-TW": `${SITE_URL}/?lang=zh-TW`,
        ja: `${SITE_URL}/?lang=ja`,
        de: `${SITE_URL}/?lang=de`,
        ru: `${SITE_URL}/?lang=ru`,
        fr: `${SITE_URL}/?lang=fr`,
        es: `${SITE_URL}/?lang=es`,
        "x-default": SITE_URL,
      },
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    icons: {
      icon: "/favicon-v2.svg",
      shortcut: "/favicon-v2.svg",
      apple: "/favicon-v2.svg",
    },
    openGraph: {
      title: "IP Flag — See where every website is hosted",
      description:
        "A lightweight Chrome extension for instant website server location and network details.",
      url: SITE_URL,
      siteName: "IP Flag",
      images: [{ url: `${SITE_URL}/og.png`, width: 1200, height: 630, alt: "IP Flag website server location preview" }],
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: "IP Flag — See where every website is hosted",
      description:
        "Country flag, IP, ASN, ISP and server map in one click.",
      images: [`${SITE_URL}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script defer src="https://tongji.giantaccel.com/script.js" data-website-id="64b816fc-65a3-4560-ae7b-d9a6101064ae" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "WebSite",
                  "@id": `${SITE_URL}/#website`,
                  url: SITE_URL,
                  name: "IP Flag",
                  description: "See where every website is hosted, with its country, IP, network and server location.",
                  inLanguage: ["en", "zh-CN", "zh-TW", "ja", "de", "ru", "fr", "es"],
                },
                {
                  "@type": "SoftwareApplication",
                  "@id": `${SITE_URL}/#application`,
                  name: "IP Flag",
                  applicationCategory: "BrowserApplication",
                  operatingSystem: "Chrome",
                  url: SITE_URL,
                  downloadUrl: CHROME_STORE_URL,
                  description: "A Chrome extension that shows the country, IP, ASN and server location behind any website.",
                  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
                },
              ],
            }),
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
