/**
 * Merid — context-check proxy (Cloudflare Worker).
 *
 * The extension POSTs a small batch of {vietnamesePhrase, candidateEnglish,
 * sentenceContext} items. This Worker asks OpenAI whether each replacement fits
 * the sentence and returns a structured decision. The OpenAI key lives ONLY in
 * this Worker's server-side environment (a Wrangler secret) — never in the
 * extension bundle.
 *
 * Config (see wrangler.toml / .dev.vars.example):
 *   OPENAI_API_KEY        (secret)   — required
 *   OPENAI_MODEL          (var)      — default "gpt-4o-mini"
 *   ALLOWED_EXTENSION_IDS (var)      — optional comma list of extension IDs to allow
 *   RATE_LIMIT_PER_MIN    (var)      — optional, default 60 requests/min/IP
 */

const MAX_ITEMS = 40;
const MAX_FIELD_LEN = 400;      // per string field
const MAX_BODY_BYTES = 20000;   // reject anything page-sized

// Best-effort in-memory limiter (per isolate). For production-grade limits use
// a KV namespace or Durable Object — see backend/README.md.
const rlStore = new Map();

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    // Rate limit
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const limit = parseInt(env.RATE_LIMIT_PER_MIN || '60', 10);
    if (rateLimited(ip, limit, 60000)) {
      return json({ error: 'Rate limit exceeded' }, 429, cors);
    }

    // Size guard
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: 'Payload too large' }, 413, cors);
    }

    let body;
    try { body = JSON.parse(raw); }
    catch { return json({ error: 'Invalid JSON' }, 400, cors); }

    const items = sanitizeItems(body && body.items);
    if (!items.length) {
      return json({ error: 'No valid items' }, 400, cors);
    }

    const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
    if (provider === 'openai' && !env.OPENAI_API_KEY) {
      return json({ error: 'Server not configured (missing OPENAI_API_KEY)' }, 500, cors);
    }
    if (provider !== 'openai' && !env.GEMINI_API_KEY) {
      return json({ error: 'Server not configured (missing GEMINI_API_KEY)' }, 500, cors);
    }

    // Log counts only — never the page context.
    console.log(`context-check: ${items.length} item(s) from ${ip}`);

    try {
      const results = await evaluate(items, env);
      return json({ results }, 200, cors);
    } catch (err) {
      console.error('evaluate failed:', err && err.message);
      return json({ error: 'Upstream error' }, 502, cors);
    }
  }
};

// ---------------------------------------------------------------------------
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).map(it => ({
    hash: str(it && it.hash).slice(0, 64),
    vietnamesePhrase: str(it && it.vietnamesePhrase).slice(0, MAX_FIELD_LEN),
    candidateEnglish: str(it && it.candidateEnglish).slice(0, MAX_FIELD_LEN),
    sentenceContext: str(it && it.sentenceContext).slice(0, MAX_FIELD_LEN),
    dataset: str(it && it.dataset).slice(0, 16)
  })).filter(it => it.hash && it.candidateEnglish && it.vietnamesePhrase);
}

function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

function rateLimited(ip, limit, windowMs) {
  const now = Date.now();
  const arr = (rlStore.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  rlStore.set(ip, arr);
  return arr.length > limit;
}

async function evaluate(items, env) {
  const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  const prompt = buildPrompt(items);
  const rawText = provider === 'openai'
    ? await callOpenAI(prompt, env)
    : await callGemini(prompt, env);
  return mapResults(items, rawText);
}

async function callGemini(prompt, env) {
  const model = env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    })
  });
  if (!resp.ok) throw new Error('Gemini ' + resp.status);
  const data = await resp.json();
  return (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '{"results":[]}';
}

async function callOpenAI(prompt, env) {
  const model = env.OPENAI_MODEL || 'gpt-4o-mini';
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a fair linguistic evaluator for a language-learning tool. Respond ONLY with the requested JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 600,
      response_format: { type: 'json_object' }
    })
  });
  if (!resp.ok) throw new Error('OpenAI ' + resp.status);
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{"results":[]}';
}

function mapResults(items, rawText) {
  let text = rawText || '';
  let parsed = { results: [] };
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    parsed = JSON.parse(text);
  } catch { /* fall through to fail-open below */ }

  const byIndex = {};
  (parsed.results || []).forEach(r => { if (r && typeof r.i === 'number') byIndex[r.i] = r; });

  // Map back to hashes; anything the model skipped fails OPEN (shouldReplace true).
  return items.map((item, i) => {
    const r = byIndex[i] || {};
    return {
      hash: item.hash,
      shouldReplace: r.shouldReplace !== false,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
      reason: str(r.reason).slice(0, 200),
      englishWord: item.candidateEnglish
    };
  });
}

function buildPrompt(items) {
  const list = items.map((c, i) =>
    `${i}: "${c.vietnamesePhrase}" -> "${c.candidateEnglish}" | Context: ${c.sentenceContext}`).join('\n');
  return `For each item, decide whether replacing the Vietnamese phrase with the English word fits the sentence for a language learner.
Be lenient: approve valid synonyms even if somewhat formal or uncommon.
Reject ONLY if the replacement introduces an offensive/inappropriate meaning, changes the sentence meaning entirely, or is clearly ungrammatical.

Items:
${list}

Respond with JSON exactly like: {"results":[{"i":0,"shouldReplace":true,"confidence":0.0,"reason":"short"}]}`;
}

// ---------------------------------------------------------------------------
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  const allowList = (env.ALLOWED_EXTENSION_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!origin) {
    headers['Access-Control-Allow-Origin'] = '*';       // curl / server-to-server
  } else if (origin.startsWith('chrome-extension://')) {
    const id = origin.replace('chrome-extension://', '');
    if (allowList.length === 0 || allowList.includes(id)) {
      headers['Access-Control-Allow-Origin'] = origin;  // allow this extension
    }
  }
  return headers;
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {})
  });
}
