import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "ipflag.io";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "IP Flag — Website IP & Server Location",
    description:
      "See where every website is hosted, with its country, IP, network and server location.",
    icons: {
      icon: "/ipflag-icon.png",
      shortcut: "/ipflag-icon.png",
      apple: "/ipflag-icon.png",
    },
    openGraph: {
      title: "IP Flag — See where every website is hosted",
      description:
        "A lightweight Chrome extension for instant website server location and network details.",
      url: origin,
      siteName: "IP Flag",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630 }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "IP Flag — See where every website is hosted",
      description:
        "Country flag, IP, ASN, ISP and server map in one click.",
      images: [`${origin}/og.png`],
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
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
