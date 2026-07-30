import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://ipflag.io",
      lastModified: new Date("2026-07-31"),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: "https://ipflag.io/privacy",
      lastModified: new Date("2026-07-31"),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
