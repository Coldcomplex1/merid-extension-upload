# Security & Architecture Audit — Merid

This document records the audit of the extension **as it was** and the changes
made in this pass. For product/technical suggestions beyond the MVP see
[`ROADMAP.md`](ROADMAP.md).

> **Round 2 update (post‑audit).** Follow‑up changes after the audit: the context
> checker now defaults to **Google Gemini** (OpenAI still supported) and runs
> **before** a word is highlighted (matches show as unstyled “pending” text until the
> AI approves; rejected ones stay as plain original text). Login/deck/mastery were
> **fully removed** to focus on context checking (so the deck viewer, mastery chart,
> Save‑to‑Deck / “I know this”, and the popup status line no longer exist). Popup +
> options now use **self‑hosted Outfit + Inter**. The product was renamed to **Merid**.
> The key‑handling security model (proxy/BYOK, no secret in bundle) is unchanged.

---

## 1. Original architecture (before)

Manifest V3 extension, vanilla JS, **no build system / package manager / tests**.

- **`background.js`** (service worker): held a **hard‑coded OpenAI key** and called
  `api.openai.com` directly in batches; kept a context cache both in
  `chrome.storage.local` **and** in a **public Firestore** accessed via
  unauthenticated REST; loaded CSV vocab; wrote the user’s deck / mastered words to
  Firestore; accepted `uid`/`projectId` from any `*.web.app` / `*.firebaseapp.com`
  page via `onMessageExternal`.
- **`content.js`**: `TreeWalker` text‑node replacement, `MutationObserver`, tooltip,
  revert; re‑initialization was **gated on login**; injected page‑derived text into
  the tooltip via `innerHTML`.
- **`popup.*`**: settings UI **blocked by a full‑cover login overlay** when logged
  out (contradicting the “works without login” intent).
- **Datasets**: `dataset-SAT/C1/C2.csv` (~995 / 1379 / 978 rows). **No B2** despite
  the product spec referencing it.
- **Permissions**: `storage, activeTab, scripting, tabs`, `host_permissions:<all_urls>`,
  broad `externally_connectable`, and CSVs exposed as `web_accessible_resources`.
- **Docs**: one‑line README, no privacy policy.

---

## 2. What currently works (kept)

- MV3 loads and runs; CSV vocabulary parses, dedupes, and matches.
- DOM replacement, hover tooltip (definition / synonyms / example / TTS), and revert.
- Chunked processing via `requestAnimationFrame`; `MutationObserver` for dynamic content.
- Settings persistence; batch + cache scaffolding for the context check.
- Feedback (👍/👎) with fast‑path / blacklist thresholds.

These behaviors were **preserved and refactored**, not rewritten.

---

## 3. What was broken (bugs found)

| # | Bug | Fix |
|---|---|---|
| B1 | Re‑init required `settings.isLoggedIn` → settings/dataset changes didn’t apply when logged out | Removed login gating; live re‑process on any relevant change |
| B2 | Single‑word Vietnamese was never replaced (`!phrase.includes(' ')` skip) | `findMatch` now allows single words (min‑length guard) |
| B3 | Same Vietnamese phrase → multiple English collided (Map last‑write‑wins) | `buildVocabMap` stores `Map<key, item[]>` |
| B4 | AI rejection never reverted the **current** page (only future loads) | `applyResults` reverts rejected spans live |
| B5 | Unbounded context cache (storage bloat) | Bounded to 5 000 entries with LRU‑style eviction |
| B6 | `frequency` re‑rolled with `Math.random()` per render → flicker/non‑determinism | `gateByFrequency` is deterministic per phrase+context |
| B7 | Service worker lost in‑memory vocab on restart; 1.5 s `setTimeout` hack | Vocab persisted to `storage.local`; fast rehydrate on wake |
| B8 | Page text injected into tooltip via `innerHTML` (DOM‑injection risk) | All interpolated values run through `escapeHtml` |
| B9 | Naive CSV split mishandled edge cases | Hardened `parseCSV` (quoted commas, BOM, CRLF, blank lines) + `validateEntry` |
| B10 | `MutationObserver` reprocessed our own inserted nodes | `processedNodes` WeakSet + debounce |

---

## 4. What was risky (security findings)

| # | Risk | Severity | Resolution |
|---|---|---|---|
| S1 | **Hard‑coded live OpenAI key** shipped in the bundle | **Critical** | Removed; moved to a backend proxy / BYOK. **User must revoke the old key.** |
| S2 | Extension called OpenAI directly from the client | High | Replaced with configurable proxy; BYOK gated behind an optional host permission |
| S3 | **Unauthenticated Firestore REST** (implies open DB rules) for cache + user deck | High | Remote Firebase layer **removed**; deck/mastery/cache are now local |
| S4 | `externally_connectable` trusted all `*.web.app` / `*.firebaseapp.com` origins to set `uid`/`projectId` | High | Removed entirely |
| S5 | Unused `scripting` permission; `tabs` permission not required | Medium | Both removed |
| S6 | Page‑derived text into `innerHTML` | Medium | Escaped (B8) |
| S7 | Remote Google Fonts on extension pages | Low | Removed; system font stack |
| S8 | `host_permissions:<all_urls>` | Low (justified) | Kept (core feature) + documented; CSVs no longer web‑exposed |

---

## 5. What blocked publishing (and status)

| Blocker | Status |
|---|---|
| Leaked secret (Google secret‑scan would reject) | ✅ Removed from code; build fails on any key. ⚠️ **You must revoke it** and optionally scrub git history |
| No privacy policy | ✅ `PRIVACY.md` added |
| One‑line README | ✅ Full README with setup + publish checklist |
| Remote fonts / remote DB posture | ✅ Removed |
| Over‑broad permissions & `externally_connectable` | ✅ Trimmed |
| Icon set (only one `icon.png` reused for all sizes) | ⚠️ Works, but add true 16/48/128 PNGs before submission |

---

## 6. Fix now vs. later

**Fixed now (this pass):** S1–S8, B1–B10, backend proxy, options page, popup status/
revert, privacy policy, docs, tests, lint/build tooling, permission cleanup.

**Recommended before submission (small):** add real 16/48/128 icons; deploy the
proxy and set `ALLOWED_EXTENSION_IDS`; capture store screenshots.

**Later (see ROADMAP):** account/sync backend to replace the removed Firebase;
B2 dataset; spaced‑repetition & gamification; TypeScript migration; KV/Durable‑Object
rate limiting.

---

## 7. Changes implemented

- **`lib/vocab-core.js`** (new): pure, tested matching/normalization/CSV/request
  logic shared by the content script and tests.
- **`background.js`**: removed key + all Firestore/dashboard code; added
  proxy/BYOK/off routing with structured JSON, timeouts, fail‑open fallback, bounded
  cache, local deck/mastery, `getStatus`.
- **`content.js`**: shared core, expanded skip set (nav/buttons/roles/contenteditable),
  single‑word + multi‑meaning matching, deterministic gate, live re‑init, revert‑on‑reject,
  escaped tooltip, debounced observer, per‑page cap.
- **`manifest.json`**: dropped `scripting`/`tabs` and `externally_connectable` and
  `web_accessible_resources`; added `optional_host_permissions` (BYOK), `options_page`,
  explicit CSP, `lib/vocab-core.js` as first content script.
- **`popup.*`**: removed login overlay + remote fonts; added status line, display‑mode
  selector, revert button, settings link.
- **`options.*`** (new): backend/BYOK config with connection test, replacement/intensity/
  direction/dataset controls, local deck viewer, delete‑all‑data, privacy summary.
- **`backend/`** (new): Cloudflare Worker proxy + `wrangler.toml`, `package.json`,
  `.env.example`, `.dev.vars.example`, `README.md`.
- **Tooling/docs** (new): root `package.json` (test/lint/build), `scripts/`,
  `test/vocab-core.test.js`, `.gitignore`, `README.md`, `PRIVACY.md`, this file, `ROADMAP.md`.

---

## 8. Verification performed

- `npm test` → **21/21 pass** (normalization, matching/boundaries, hashing/gate,
  CSV, context/request builder, settings, dataset registry).
- `npm run lint` → all scripts pass `node --check`.
- `npm run build` → produces `dist/` + `dist.zip`; **secret scan built into the build**.
- Worker unit‑tested with a mocked OpenAI (preflight, valid batch, method/size/empty/no‑key guards).
- **Live browser smoke test** (headless Chromium, unpacked extension): 28 Vietnamese
  phrases replaced with correct English (e.g. `thoái vị → abdicate`), `<nav>` links
  skipped (0), tooltip shown on hover, popup + options pages loaded with **zero errors**.
- Repo secret scan → no `sk-…` keys outside `.env.example` placeholders; no Firebase/
  onrender residue in extension code.

---

## 9. Chrome Web Store readiness

**Status: Almost ready.**

Blocking items are resolved in code; what remains is operational and cannot be done
from inside the repo:

1. **Revoke** the previously committed OpenAI key (only you can).
2. **Deploy** the backend proxy and paste its URL into Settings.
3. Add real **16/48/128 icons** and **screenshots**; write the store description.
4. Host `PRIVACY.md` publicly and fill the data‑use disclosures.
5. (Optional) scrub the old key from git history.

Do those and it is **ready to submit**.
