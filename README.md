# IP Flag

IP Flag is a Chrome extension that shows where the website you are visiting is hosted.

**See where every website is hosted.**

It adds the server country flag to the browser toolbar and exposes the resolved IP, ASN, ISP, city, timezone and coordinates in one click. A map can be enabled in a private build with a provider token; public builds intentionally omit credentials.

## Product

- Website: <https://ipflag.io>
- Chrome Web Store: <https://chromewebstore.google.com/detail/ipgeo-flag/aaclbfgifnkbhkokgajglhgphjjjcoaa>
- Privacy policy: <https://ipflag.io/privacy>
- English store name: `IP Flag – Website IP & Server Location`
- 中文名称：`IP Flag - 网站服务器国旗与 IP 信息`
- 中文宣传语：`一眼查看网站服务器所在国家。`

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select this repository directory.

The extension uses the IP Flag API (`https://api.ipflag.io/domain/:domain`) for server geolocation and falls back to the legacy CNIP endpoint if the private API is temporarily unavailable. Direct IP lookups are available at `https://api.ipflag.io/ip/:ip`. Results are cached in session storage.

The API combines the local IP2Location database when configured and the monthly DB-IP Lite city database as a second source. DB-IP Lite is licensed under CC BY 4.0; the website includes the required attribution link.

## Website development

The landing page lives in [`website/`](website/). From that directory:

```bash
npm install
npm run dev
```

## License

No open-source license has been declared yet. All rights reserved by the project owner unless a license is added.
