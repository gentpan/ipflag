# IP Flag

IP Flag is a Chrome extension that shows where the website you are visiting is hosted.

> See where every website is hosted.

It adds the server country flag to the browser toolbar and reveals the resolved IP, ASN, ISP, city, timezone, coordinates and server location in one click.

## Links

- Website: <https://ipflag.io>
- Chrome Web Store: <https://chromewebstore.google.com/detail/ipgeo-flag/aaclbfgifnkbhkokgajglhgphjjjcoaa>
- Privacy policy: <https://ipflag.io/privacy>
- Public API health check: <https://api.ipflag.io/health>
- Source repository: <https://github.com/gentpan/ipflag>

## Features

- Server country flag in the Chrome toolbar
- Website hostname and resolved IP address
- ASN, ISP, city, region, timezone and coordinates
- Optional map preview in private builds with a runtime map token
- Session caching for faster repeated lookups
- Multilingual product website: English, Simplified Chinese, Traditional Chinese, Japanese, German, Russian, French and Spanish
- No account, sign-up, advertising profile or sale of user data

## Geolocation API

The extension uses the IP Flag API at `https://api.ipflag.io/` for all lookups.

```text
GET https://api.ipflag.io/domain/example.com
GET https://api.ipflag.io/ip/8.8.8.8
GET https://api.ipflag.io/domain?domain=example.com
GET https://api.ipflag.io/ip?ip=8.8.8.8
```

Example response:

```json
{
  "ip": "8.8.8.8",
  "country_code": "US",
  "country": "United States",
  "region": "California",
  "city": "Mountain View",
  "asn": "AS15169",
  "isp": "Google LLC",
  "latitude": 37.422,
  "longitude": -122.085
}
```

Domain responses also include an `ssl` object with the certificate check time, validity period, expiry time, remaining days and certificate subject/issuer. The production API is a statically compiled Go service in [`api-go/`](api-go/), with monthly DB-IP Lite City and ASN database updates managed by systemd. The older [`api/`](api/) directory is retained as a reference implementation.

## Load the extension locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository directory.

## Website development

The multilingual landing page lives in [`website/`](website/).

```bash
cd website
npm install
npm run dev
```

Validate a production build with:

```bash
npm run build
npm run lint
```

## Project structure

```text
background.js       Chrome service worker and toolbar flag updates
popup.html/js/css   Extension popup UI
flags/              Country flag assets
api-go/             Production Go geolocation API and deployment files
api/                Legacy/reference API implementation
website/            Multilingual product landing page
manifest.json       Chrome Extension Manifest V3
```

## Privacy

IP Flag sends the current website hostname to the geolocation service only to resolve the website server location. Lookup results are cached in browser session storage and are cleared when the session ends. The extension does not request your name, email, passwords, payment information or page content.

## License

No open-source license has been declared yet. All rights reserved by the project owner unless a license is added.
