# Context-check proxy (Cloudflare Worker)

This tiny Worker is what keeps the provider API key **out of the extension**. The
extension sends a small batch of `{ vietnamesePhrase, candidateEnglish,
sentenceContext }` items; the Worker asks the AI provider whether each replacement
fits the sentence and returns a structured decision. The key lives only in the
Worker's server-side environment.

The default provider is **Gemini** (`AI_PROVIDER=gemini`); set `AI_PROVIDER=openai`
to use OpenAI instead.

```
Extension  ──POST /{items}──▶  Worker (holds GEMINI_API_KEY)  ──▶  Gemini / OpenAI
                              ◀── {results:[{hash,shouldReplace,confidence,…}]}
```

## Request / response

**Request** `POST https://<your-worker>.workers.dev/`

```json
{
  "items": [
    { "hash": "h123", "vietnamesePhrase": "cân nhắc", "candidateEnglish": "consider",
      "sentenceContext": "Chúng tôi cần cân nhắc nhiều yếu tố.", "dataset": "B2" }
  ]
}
```

**Response**

```json
{
  "results": [
    { "hash": "h123", "shouldReplace": true, "confidence": 0.91,
      "reason": "Valid synonym in context.", "englishWord": "consider" }
  ]
}
```

Only a **single sentence** per item is ever received — never whole pages. The
Worker logs request *counts* only, never the context text.

## Deploy (≈5 minutes)

Prerequisites: Node.js 18+ and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd backend
npm install                       # installs wrangler locally

npx wrangler login                # opens a browser to authorize

# Store your Gemini key as an encrypted secret (NOT committed, NOT in the extension).
# Use a standard Google AI Studio key (starts with AIza…): https://aistudio.google.com/apikey
npx wrangler secret put GEMINI_API_KEY
# paste your key when prompted
# (Using OpenAI instead? set AI_PROVIDER="openai" in wrangler.toml and
#  `npx wrangler secret put OPENAI_API_KEY`.)

npx wrangler deploy               # prints your URL, e.g. https://merid-context-proxy.<you>.workers.dev
```

Then open the extension's **Settings** page, choose **Backend proxy** mode, paste
the Worker URL, and click **Test connection**.

### Optional hardening
- Set `ALLOWED_EXTENSION_IDS` in `wrangler.toml` to your published extension ID so
  only your extension can call the proxy.
- Tune `RATE_LIMIT_PER_MIN`.
- The built-in rate limiter is per-isolate (best-effort). For strict global limits,
  back it with a [KV namespace](https://developers.cloudflare.com/kv/) or a
  [Durable Object](https://developers.cloudflare.com/durable-objects/).

## Local development

```bash
cp .dev.vars.example .dev.vars    # put your key here (git-ignored)
npx wrangler dev                  # serves on http://localhost:8787
```

## Other platforms

The handler is a standard `fetch(request, env)` function. Porting to Vercel /
Netlify / an Express route is mostly wiring `env.GEMINI_API_KEY` (or
`env.OPENAI_API_KEY`) and the request body; keep the validation, CORS, and
rate-limit logic intact.
