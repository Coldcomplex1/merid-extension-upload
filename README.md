# Merid

A Chrome extension (Manifest V3) that helps **Vietnamese learners pick up English
vocabulary passively** while they browse Vietnamese websites. It detects selected
Vietnamese words/phrases from bundled SAT / CEFR datasets and swaps or annotates
them with the English equivalent, with an **optional AI context check** to make
sure the replacement fits the sentence.

> **Security note:** earlier versions shipped a hard‑coded OpenAI API key in
> `background.js`. That key has been **removed**. If you cloned an older commit,
> **revoke that key now** at <https://platform.openai.com/api-keys>. See
> [“Is the API key problem solved?”](#is-the-api-key-problem-solved).

---

## Features

- Detects Vietnamese vocabulary from bundled datasets (**SAT**, **CEFR C1**, **CEFR C2**, or **All**).
- Replaces / highlights / annotates matches with the English word.
- **Three display modes:** Replace directly · Highlight only (hover for meaning) · Show beside (`từ (word)`).
- **Adjustable intensity** (Light / Medium / Heavy) so you control how aggressive it is.
- **Optional AI context check** (Google **Gemini** by default; OpenAI also supported) via a backend
  proxy (recommended) or your own key (BYOK). When on, a word is **checked before it is highlighted**.
- Learning tooltip: definition, pronunciation (TTS), synonyms/antonyms, example, 👍/👎 context feedback.
- Works on dynamic / SPA pages (debounced `MutationObserver`), instant on/off, instant revert.
- Local‑first: your settings and cache stay on your device; nothing leaves it when the context check is off.

---

## Architecture

```
Chrome Extension (no secret in bundle)
 ├─ lib/vocab-core.js   Pure, DOM‑free logic (matching, normalization, CSV, request builder) — also unit‑tested
 ├─ content.js          Scans visible text, replaces matches, tooltip, revert; talks to the worker
 ├─ background.js       Loads datasets, batches + caches context checks, routes proxy/BYOK/off
 ├─ popup.*             Quick controls (dataset, intensity, mode, on/off, revert)
 └─ options.*           Full config: provider / backend URL / BYOK / mode / intensity / dataset / privacy
        │  sends only a single sentence per candidate — never whole pages
        ▼
 backend/ (Cloudflare Worker)  Holds the provider key server‑side, validates, rate‑limits, CORS,
        │                       returns { shouldReplace, confidence, reason, englishWord }
        ▼
 Gemini (default) / OpenAI API
```

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — minimal permissions, options page, CSP |
| `lib/vocab-core.js` | Shared pure functions (works in the content script **and** in Node tests) |
| `content.js` | DOM scanning, replacement, tooltip, live re‑processing, revert |
| `background.js` | Dataset loading, context‑check routing (proxy/BYOK/off), bounded cache |
| `popup.html/js/css` | Toolbar popup: dataset, intensity, mode, toggles, revert, settings link |
| `options.html/js/css` | Settings page: provider/backend/BYOK config, replacement options, data controls |
| `dataset-*.csv` | Bundled vocabulary (SAT / C1 / C2) |
| `fonts/` | Self‑hosted Outfit + Inter woff2 (no remote font requests) |
| `backend/` | Cloudflare Worker proxy (keeps the provider key server‑side) |
| `test/`, `scripts/` | Node test suite + zero‑dep lint/build scripts |

---

## Install (load unpacked)

1. `git clone` this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repo folder (or the `dist/` folder after `npm run build`).
4. Pin the extension and open a Vietnamese site (e.g. vnexpress.net, tuoitre.vn).

Out of the box the extension runs in **dataset‑only** mode (no network calls). The
AI context check is **off** until you configure it below.

---

## Set up the AI context check (recommended: backend proxy)

The context check uses **Google Gemini** by default (OpenAI is also supported) and,
when on, decides whether a word fits **before** it is highlighted. The backend proxy
keeps the provider key **out of the extension**. Full details in
[`backend/README.md`](backend/README.md).

```bash
cd backend
npm install
npx wrangler login
# Default provider is Gemini — use a standard AI Studio key (starts with AIza…):
npx wrangler secret put GEMINI_API_KEY     # paste your key — stored server‑side only
npx wrangler deploy                        # prints https://merid-context-proxy.<you>.workers.dev
```

Then in the extension **Settings** page:

1. **AI context check → Backend proxy (recommended)**.
2. Paste the Worker URL.
3. Click **Test connection** → expect `✓ Connected`.

### Alternative: Bring Your Own Key (BYOK)

For personal/dev use you can skip the backend and enter *your own* key in
**Settings → Bring your own key** (pick the provider, default Gemini). Notes:

- The key is stored only in `chrome.storage.local` **on your device** and is sent
  directly from your browser to the provider (your key, your billing).
- Use a standard **Gemini AI Studio key** (`AIza…`) — not a short‑lived ephemeral token.
- Chrome will ask for permission to contact the provider host
  (`generativelanguage.googleapis.com` or `api.openai.com`) — an *optional* host
  permission that the default install doesn’t request.
- **Not recommended for a shared/published install** — use the proxy for that.
- **Never ship someone else’s key.** This repo contains none.

---

## Privacy

Short version — full policy in [`PRIVACY.md`](PRIVACY.md):

- Page text is scanned **locally** in your browser to find vocabulary matches.
- With the context check **on**, only the **single sentence** around a matched word
  is sent to your backend/provider — **never full pages**.
- The backend Worker logs request **counts only**, never the sentence text.
- Your settings and context cache live on your device (`chrome.storage`).
- Turn the context check **Off** (the default) to send nothing off‑device.
- **Delete all stored data** any time from the Settings page.

---

## Permissions & why they’re needed

| Permission | Why |
|---|---|
| `storage` | Save settings and the context cache locally. |
| `activeTab` | Let the popup talk to the current tab (“revert this page”). |
| `host_permissions: <all_urls>` | The core feature is passive replacement **while you browse any Vietnamese site**, so the content script must run on the pages you visit. It only reads text to match vocabulary. |
| `optional_host_permissions: generativelanguage.googleapis.com / api.openai.com` | Requested **only if** you enable BYOK mode (for the provider you choose). Not requested otherwise. |

Removed vs. earlier versions: `scripting` and `tabs` (unused) and the broad
`externally_connectable` (dashboard auth) — see [`AUDIT.md`](AUDIT.md).

---

## Datasets

CSV files bundled with the extension. Columns: `word, type, [cefr], phon_br,
phon_n_am, definition, example, vietnamese, synonyms, antonyms`. Loading is lazy,
deduped by word, validated, and cached for fast service‑worker wake‑ups.

**Adding CEFR B2** (or any dataset): drop `dataset-B2.csv` (same columns) in the
repo, add a one‑line entry to `DATASET_REGISTRY` in `lib/vocab-core.js`, and add a
button in `popup.html` / `options.html`. No other code changes needed. B2 is not
included because we don’t ship fabricated vocabulary data.

---

## Development

No build step is required to run the extension unpacked. Tooling is zero‑dependency
(uses Node’s built‑ins):

```bash
npm test        # run the unit test suite (node --test) for lib/vocab-core.js
npm run lint    # syntax‑check every extension script (node --check)
npm run build   # copy shippable files to dist/ (+ dist.zip) and fail if a secret is present
```

The build **whitelists** only the files the extension needs — `backend/`, `test/`,
`scripts/`, docs, and `node_modules/` never ship.

---

## Publish checklist (Chrome Web Store)

1. **Revoke** any old/test API keys (the previously leaked one especially).
2. Deploy the backend proxy and configure it in Settings (or document BYOK).
3. `npm test && npm run lint && npm run build` → produces `dist.zip`.
4. Load `dist/` unpacked and test on real Vietnamese sites.
5. Confirm no key is in the bundle (the build fails if one is).
6. Review permissions and the justification above.
7. Prepare store assets: icon set (add 16/48/128 variants), 1280×800 screenshots, description.
8. Host `PRIVACY.md` at a public URL for the listing’s privacy field; fill the data‑use disclosures (reads website content; sends a single sentence to the proxy only when the context check is on).
9. Create a Chrome Web Store developer account ($5 one‑time), upload `dist.zip`.
10. Submit for review.

See [`AUDIT.md`](AUDIT.md) for current readiness status and remaining TODOs, and
[`ROADMAP.md`](ROADMAP.md) for product/technical suggestions beyond the MVP.

---

## Is the API key problem solved?

**What was unsafe before**
- A live OpenAI key (`sk-proj-…`) was hard‑coded in `background.js` and shipped in
  the extension bundle, and the extension called `api.openai.com` directly from the
  client. Anyone who installed the extension could extract and abuse the key.

**What changed**
- The key was removed from the codebase. Context checks now go through a
  **Cloudflare Worker** that holds the key in a server‑side secret, or — for
  personal use — through **BYOK** where the user supplies *their own* key stored
  locally. The default mode is **off** (no network calls at all).

- Context checks default to **Gemini** now (OpenAI still supported); the key handling
  is identical — server‑side secret in the Worker, or your own key locally via BYOK.

**Does any secret remain in the extension bundle?**
- **No.** The only key‑shaped strings anywhere are placeholders in
  `backend/.env.example` / `.dev.vars.example`. The production build (`npm run build`)
  actively **fails** if a key‑shaped string is found in the bundle.

**What you must configure before production**
1. **Revoke** the previously committed OpenAI key (only you can do this), and rotate any
   Gemini key you have shared in chat.
2. Create a **Gemini AI Studio key** (`AIza…`) and set it as the Worker secret
   (`wrangler secret put GEMINI_API_KEY`), or set it via BYOK in Settings.
3. Deploy the Worker and paste its URL into **Settings → Backend proxy**.
4. (Optional) set `ALLOWED_EXTENSION_IDS` to your published extension’s ID.
5. (Optional but recommended) scrub the old key from git history with
   `git filter-repo`/BFG — the key still exists in prior commits on the remote
   until then. Revoking it is the real fix; history scrubbing is cleanup.
