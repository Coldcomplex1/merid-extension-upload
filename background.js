// =============================================================
// Merid — background service worker
//
// Responsibilities:
//   - Load & cache the vocabulary datasets (CSV, bundled).
//   - Answer settings / vocabulary requests from the popup & content script.
//   - Run the OPTIONAL AI context check via a user-configured backend proxy
//     (recommended) or a Bring-Your-Own-Key call (dev fallback). Provider is
//     Gemini by default; OpenAI is also supported.
//   - Persist context-check feedback LOCALLY.
//
// SECURITY: This file contains NO API keys. The provider key (Gemini/OpenAI)
// lives only in the backend proxy's server-side environment (see /backend).
// BYOK keys, if used, are entered by the user and stored in chrome.storage.local
// on their machine — never in this bundle.
// =============================================================

importScripts('lib/vocab-core.js');
const C = self.VMCore;

// ---- Tunables ----
const DEFAULT_PROVIDER = 'gemini';           // 'gemini' | 'openai'
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const FASTPATH_THRESHOLD = 10;   // up-votes needed to bypass AI
const BLACKLIST_THRESHOLD = 5;   // down-votes needed to skip replacement
const BATCH_INTERVAL_MS = 800;   // ms between AI batch flushes (kept low so pending words reveal quickly)
const MAX_BATCH_SIZE = 30;       // max candidates per API call
const CONTEXT_CACHE_MAX = 5000;  // hard cap on cached context decisions
const REQUEST_TIMEOUT_MS = 15000;

// ---- In-memory state (rehydrated on SW wake) ----
let vocabulary = [];
let contextCache = {};

// =============================================================
// Config
// =============================================================
function getConfig() {
    return new Promise(resolve => {
        chrome.storage.sync.get(['contextCheckMode', 'proxyUrl'], sync => {
            chrome.storage.local.get(['byokKey', 'aiProvider', 'aiModel'], local => {
                const provider = local.aiProvider || DEFAULT_PROVIDER;
                const defaultModel = provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_GEMINI_MODEL;
                resolve({
                    mode: sync.contextCheckMode || 'off',      // 'off' | 'proxy' | 'byok'
                    proxyUrl: (sync.proxyUrl || '').trim(),
                    byokKey: (local.byokKey || '').trim(),
                    provider,                                   // 'gemini' | 'openai'
                    model: (local.aiModel || defaultModel).trim()
                });
            });
        });
    });
}

// =============================================================
// Context cache (LOCAL ONLY — no remote database)
// =============================================================
function loadContextCache() {
    return new Promise(resolve => {
        chrome.storage.local.get(['vm_context_cache'], result => {
            contextCache = result.vm_context_cache || {};
            resolve();
        });
    });
}

function saveContextCache() {
    return new Promise(resolve => {
        evictContextCacheIfNeeded();
        chrome.storage.local.set({ vm_context_cache: contextCache }, resolve);
    });
}

// Bounded cache: when over the cap, drop the least-recently-useful entries
// (never evict fast-path / blacklisted / user entries first).
function evictContextCacheIfNeeded() {
    const keys = Object.keys(contextCache);
    if (keys.length <= CONTEXT_CACHE_MAX) return;
    const scored = keys
        .filter(h => !contextCache[h].fastPath && !contextCache[h].blacklisted && contextCache[h].source !== 'user')
        .sort((a, b) => {
            const A = contextCache[a], B = contextCache[b];
            return (A.usageCount || 0) - (B.usageCount || 0) || (A.timestamp || 0) - (B.timestamp || 0);
        });
    const toRemove = keys.length - CONTEXT_CACHE_MAX;
    for (let i = 0; i < toRemove && i < scored.length; i++) delete contextCache[scored[i]];
}

// =============================================================
// AI context checking — routes to proxy or BYOK
// =============================================================
let batchQueue = [];
let batchTimer = null;

function enqueueCandidates(candidates, tabId) {
    const existing = new Set(batchQueue.map(c => c.hash));
    for (const c of candidates) {
        if (!existing.has(c.hash)) {
            batchQueue.push(Object.assign({}, c, { tabId }));
            existing.add(c.hash);
        }
    }
    if (!batchTimer) batchTimer = setTimeout(flushBatchQueue, BATCH_INTERVAL_MS);
}

async function flushBatchQueue() {
    batchTimer = null;
    if (batchQueue.length === 0) return;

    const batch = batchQueue.splice(0, MAX_BATCH_SIZE);
    if (batchQueue.length > 0) batchTimer = setTimeout(flushBatchQueue, BATCH_INTERVAL_MS);

    const cfg = await getConfig();
    let results = {}; // hash -> { approved, confidence, reason }
    try {
        results = await evaluateBatch(batch, cfg);
    } catch (err) {
        console.warn('[VM AI] Context check failed, failing OPEN (dataset-only):', err.message);
        // Fail-open: keep the dataset replacement visible rather than hiding words.
        batch.forEach(c => { results[c.hash] = { approved: true, confidence: 0, reason: 'checker-unavailable' }; });
    }

    for (const [hash, res] of Object.entries(results)) {
        const item = batch.find(b => b.hash === hash);
        if (!contextCache[hash]) {
            contextCache[hash] = {
                vietnamesePhrase: item?.vietnamesePhrase || '',
                candidateEnglish: item?.candidateEnglish || '',
                approved: !!res.approved,
                confidence: res.confidence || 0,
                reason: res.reason || '',
                source: 'ai',
                votes: { up: 0, down: 0 },
                fastPath: false,
                blacklisted: false,
                usageCount: 1,
                timestamp: Date.now()
            };
        } else {
            contextCache[hash].approved = !!res.approved;
            contextCache[hash].confidence = res.confidence || contextCache[hash].confidence || 0;
            contextCache[hash].usageCount = (contextCache[hash].usageCount || 0) + 1;
        }
    }
    await saveContextCache();

    // Notify each originating tab with a plain hash->boolean map.
    const byTab = {};
    for (const item of batch) {
        if (results[item.hash] === undefined) continue;
        (byTab[item.tabId] = byTab[item.tabId] || {})[item.hash] = !!results[item.hash].approved;
    }
    for (const [tabId, tabResults] of Object.entries(byTab)) {
        if (!Object.keys(tabResults).length) continue;
        chrome.tabs.sendMessage(parseInt(tabId), { action: 'contextCheckResult', results: tabResults }, () => {
            void chrome.runtime.lastError; // tab may have closed — ignore
        });
    }
}

async function evaluateBatch(batch, cfg) {
    if (cfg.mode === 'proxy') {
        if (!cfg.proxyUrl) throw new Error('Proxy URL not configured');
        return callProxy(batch, cfg.proxyUrl);
    }
    if (cfg.mode === 'byok') {
        if (!cfg.byokKey) throw new Error('BYOK key not configured');
        return cfg.provider === 'openai'
            ? callOpenAIDirect(batch, cfg.byokKey, cfg.model)
            : callGeminiDirect(batch, cfg.byokKey, cfg.model);
    }
    // mode 'off' — approve everything (dataset-only).
    const out = {};
    batch.forEach(c => { out[c.hash] = { approved: true, confidence: 0, reason: 'context-check-off' }; });
    return out;
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms))
    ]);
}

// ---- Backend proxy (recommended) ----
async function callProxy(batch, proxyUrl) {
    const items = batch.map(c => ({
        hash: c.hash,
        vietnamesePhrase: c.vietnamesePhrase,
        candidateEnglish: c.candidateEnglish,
        sentenceContext: c.sentenceContext,
        dataset: c.dataset
    }));
    const resp = await withTimeout(fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
    }), REQUEST_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`Proxy error ${resp.status}`);
    const data = await resp.json();
    const out = {};
    (data.results || []).forEach(r => {
        if (!r || !r.hash) return;
        out[r.hash] = { approved: r.shouldReplace !== false, confidence: r.confidence || 0, reason: r.reason || '' };
    });
    // Any item the proxy didn't answer -> fail-open.
    batch.forEach(c => { if (out[c.hash] === undefined) out[c.hash] = { approved: true, confidence: 0, reason: 'no-result' }; });
    return out;
}

// ---- BYOK: Gemini (default; user's own key, stored locally) ----
async function callGeminiDirect(batch, apiKey, model) {
    const prompt = buildEvaluationPrompt(batch);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || DEFAULT_GEMINI_MODEL}:generateContent`;
    const resp = await withTimeout(fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        })
    }), REQUEST_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`Gemini error ${resp.status}`);
    const data = await resp.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{"results":[]}';
    return C.parseModelResults(raw, batch);
}

// ---- BYOK: OpenAI (alternate; user's own key, stored locally) ----
async function callOpenAIDirect(batch, apiKey, model) {
    const prompt = buildEvaluationPrompt(batch);
    const resp = await withTimeout(fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model || DEFAULT_OPENAI_MODEL,
            messages: [
                { role: 'system', content: 'You are a fair linguistic evaluator. Respond ONLY with the requested JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 500,
            response_format: { type: 'json_object' }
        })
    }), REQUEST_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`OpenAI error ${resp.status}`);
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '{"results":[]}';
    return C.parseModelResults(raw, batch);
}

function buildEvaluationPrompt(batch) {
    const items = batch.map((c, i) =>
        `${i}: "${c.vietnamesePhrase}" -> "${c.candidateEnglish}" | Context: ${c.sentenceContext}`).join('\n');
    return `Decide, for each item, whether replacing the Vietnamese phrase with the English word fits the sentence for a language learner.
Be lenient: approve valid synonyms even if slightly formal/uncommon.
Reject ONLY if it introduces an offensive/inappropriate meaning, changes the sentence meaning entirely, or is clearly ungrammatical.

Items:
${items}

Respond with JSON: {"results":[{"i":0,"shouldReplace":true,"confidence":0.0-1.0,"reason":"short"}]}`;
}

// =============================================================
// Vocabulary loading (bundled CSV datasets)
// =============================================================
async function loadVocabulary(datasetKey) {
    const key = datasetKey || 'sat';
    const files = C.getDatasetFiles(key);
    const byWord = new Map(); // dedupe by normalized English word

    for (const file of files) {
        try {
            const resp = await fetch(chrome.runtime.getURL(file));
            const text = await resp.text();
            const rows = C.parseCSV(text);
            for (const row of rows) {
                if (!C.validateEntry(row)) continue;
                const entry = C.normalizeEntry(row, key);
                const wordKey = entry.word.toLowerCase();
                if (wordKey && !byWord.has(wordKey)) byWord.set(wordKey, entry);
            }
            console.log(`[VM] Loaded ${rows.length} rows from ${file}`);
        } catch (err) {
            console.error(`[VM] Failed to load ${file}:`, err.message);
        }
    }

    vocabulary = Array.from(byWord.values());
    // Persist so a SW restart can rehydrate without re-parsing on the hot path.
    chrome.storage.local.set({ vm_vocab_cache: { key, count: vocabulary.length, data: vocabulary } });
    console.log(`[VM] Total vocabulary (${key}):`, vocabulary.length);
    return vocabulary;
}

function initVocabulary() {
    return new Promise(resolve => {
        chrome.storage.sync.get(['datasetKey'], async result => {
            const key = result.datasetKey || 'sat';
            // Try the persisted cache first for a fast wake.
            chrome.storage.local.get(['vm_vocab_cache'], async cache => {
                const c = cache.vm_vocab_cache;
                if (c && c.key === key && Array.isArray(c.data) && c.data.length) {
                    vocabulary = c.data;
                    console.log(`[VM] Rehydrated ${vocabulary.length} words from cache (${key})`);
                    resolve(vocabulary);
                } else {
                    await loadVocabulary(key);
                    resolve(vocabulary);
                }
            });
        });
    });
}

// =============================================================
// Lifecycle
// =============================================================
chrome.runtime.onInstalled.addListener(() => { console.log('[VM] Installed/updated.'); initVocabulary(); loadContextCache(); });
chrome.runtime.onStartup.addListener(() => { console.log('[VM] Startup.'); initVocabulary(); loadContextCache(); });
initVocabulary();
loadContextCache();

// =============================================================
// Messaging (from popup / options / content script)
// =============================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'setDataset': {
            const key = request.datasetKey || 'sat';
            chrome.storage.sync.set({ datasetKey: key }, () => {
                loadVocabulary(key).then(() => sendResponse({ success: true, count: vocabulary.length }));
            });
            return true;
        }

        case 'getVocabulary': {
            if (vocabulary.length === 0) {
                initVocabulary().then(() => sendResponse({ vocabulary }));
                return true;
            }
            sendResponse({ vocabulary });
            return false;
        }

        case 'getSettings': {
            chrome.storage.sync.get(
                ['frequency', 'replacementMode', 'vieEngMode', 'engEngMode', 'extensionEnabled', 'datasetKey', 'contextCheckMode', 'proxyUrl'],
                settings => {
                    const finalSettings = C.withDefaults(settings);
                    // Content script never receives secrets/urls it doesn't need.
                    delete finalSettings.proxyUrl;
                    sendResponse(finalSettings);
                });
            return true;
        }

        case 'getStatus': {
            // Used by the options page (dataset info) and diagnostics.
            getConfig().then(cfg => {
                chrome.storage.sync.get(['extensionEnabled', 'datasetKey'], s => {
                    sendResponse({
                        enabled: s.extensionEnabled !== false,
                        datasetKey: s.datasetKey || 'sat',
                        vocabCount: vocabulary.length,
                        contextMode: cfg.mode,
                        backendConfigured: cfg.mode === 'off' || (cfg.mode === 'proxy' && !!cfg.proxyUrl) || (cfg.mode === 'byok' && !!cfg.byokKey)
                    });
                });
            });
            return true;
        }

        case 'checkContextBatch': {
            const items = request.items || [];
            const tabId = sender.tab?.id;
            if (!tabId || items.length === 0) { sendResponse({ hits: {}, queued: [] }); return false; }

            getConfig().then(cfg => {
                const hits = {};
                const toQueue = [];
                for (const c of items) {
                    if (cfg.mode === 'off') { hits[c.hash] = true; continue; } // dataset-only
                    const cached = contextCache[c.hash];
                    if (cached && cached.source) {
                        cached.usageCount = (cached.usageCount || 0) + 1;
                        hits[c.hash] = cached.blacklisted ? false : !!cached.approved;
                    } else {
                        toQueue.push(c);
                    }
                }
                if (Object.keys(hits).length) saveContextCache();
                if (toQueue.length) enqueueCandidates(toQueue, tabId);
                sendResponse({ hits, queued: toQueue.map(c => c.hash) });
            });
            return true;
        }

        case 'submitFeedback': {
            const { hash, vote, vietnamesePhrase, candidateEnglish } = request;
            if (!hash || !vote) { sendResponse({ success: false }); return false; }
            if (!contextCache[hash]) {
                contextCache[hash] = {
                    vietnamesePhrase: vietnamesePhrase || '', candidateEnglish: candidateEnglish || '',
                    approved: vote === 'up', confidence: 0, reason: 'user', source: 'user',
                    votes: { up: 0, down: 0 }, fastPath: false, blacklisted: false, usageCount: 1, timestamp: Date.now()
                };
            }
            const entry = contextCache[hash];
            entry.votes = entry.votes || { up: 0, down: 0 };
            if (vote === 'up') {
                entry.votes.up++; entry.approved = true;
                if (entry.votes.up >= FASTPATH_THRESHOLD) { entry.fastPath = true; entry.blacklisted = false; }
            } else if (vote === 'down') {
                entry.votes.down++;
                if (entry.votes.down >= BLACKLIST_THRESHOLD) { entry.blacklisted = true; entry.fastPath = false; entry.approved = false; }
            }
            saveContextCache().then(() => sendResponse({ success: true, entry }));
            return true;
        }

        default:
            return false;
    }
});
