import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://ipflag.io",
      lastModified: new Date("2026-07-30"),
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: "https://ipflag.io/privacy",
      lastModified: new Date("2026-07-30"),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
