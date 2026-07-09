# Privacy Policy — Merid

_Last updated: 2026-07-09_

Merid is a browser extension that helps Vietnamese speakers learn
English vocabulary while browsing. This policy explains exactly what the extension
does with data. We designed it to be **local‑first** and to send as little as
possible off your device.

## What the extension processes locally

- **Page text.** To find vocabulary matches, the extension reads the visible text
  of pages you visit and compares it against bundled word lists. This scanning
  happens **entirely in your browser**. Page text is not uploaded for scanning.
- **Your settings and cache.** Your preferences and the context‑check cache are
  stored on your device using `chrome.storage` (local and sync). If you enable Chrome
  Sync, your *settings* may sync across your own Chrome profiles via Google — the
  extension itself runs no account server.

## What may be sent off your device

The extension sends data off your device **only when you turn on the optional AI
context check**, and only then:

- **What is sent:** for a matched word, a small request containing the Vietnamese
  phrase, the candidate English word, and the **single sentence** in which the word
  appears (trimmed and length‑capped). Nothing else from the page is included.
- **What is NOT sent:** full page contents, page URLs, your browsing history,
  personal identifiers, cookies, or form/input contents.
- **Where it goes:** to the endpoint *you* configure — either your own backend
  proxy (recommended) or, in BYOK mode, directly to the AI provider (Google Gemini by
  default, or OpenAI) using *your* key.
- The bundled backend proxy logs request **counts only** and does **not** log the
  sentence text. If you use a third‑party provider (Google / OpenAI), their data‑use
  terms apply to the request.

When the context check is **Off** (the default), the extension makes **no network
requests** for its core functionality.

## API keys

- The extension contains **no API keys**.
- In backend‑proxy mode, the provider key lives only on your server.
- In BYOK mode, your key is stored only in `chrome.storage.local` on your device
  and is used solely to call the AI provider directly from your browser.

## Your controls

- **Disable data sharing:** set **AI context check → Off** in Settings. This is the
  default.
- **Turn the extension off** entirely with the popup toggle.
- **Delete everything:** Settings → **Delete all stored data** clears settings and
  the cache. Uninstalling the extension also removes local data.

## Data retention

All extension data is stored on your device until you clear it or uninstall.
Cached context decisions are capped and evicted automatically.

## Children’s privacy

The extension is a general‑purpose learning tool and does not knowingly collect
personal information from anyone, including children.

## Changes

Material changes to this policy will be reflected in this file and the extension’s
store listing.

## Contact

Questions about privacy can be directed to the extension’s support contact listed
on its Chrome Web Store page.
