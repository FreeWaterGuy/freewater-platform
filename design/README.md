# Design work

Everything made before the code, kept here so it lives with the platform.

- `blueprint/` — the blueprint, sitemap, wireframes and hi-fi mockups, one screen per file (`*.dc.html`), with the real label photos in `img/`. `Main.dc.html` is the start.
- `prototype/freewater-prototype.html` — the clickable prototype. Open it in any browser.
- `screens/` — pictures of the hi-fi screens: the app (`Hf*`), advertiser (`HfAd*`), ops console (`Ops*`), driver app (`Driver*`), open books (`Ledger*`), white label (`Wl*`) and developer portal (`Dev*`).
- `videos/` — the explainer videos: the vending machine (wide and vertical, with and without captions), route delivery, and FreeWater compared with traditional retail.
- `generators/` — the scripts that drew the screens and the prototype.

The working platform's own previews are made from the code: `npm run demo:scan-preview`, `npm run demo:app-preview`, `npm run demo:ads-preview`.
