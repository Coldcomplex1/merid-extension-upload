// Options page controller. Uses window.VMCore for defaults/registry.
const C = window.VMCore;

const SYNC_KEYS = ['contextCheckMode', 'proxyUrl', 'frequency', 'replacementMode', 'vieEngMode', 'engEngMode', 'datasetKey'];
const LOCAL_KEYS = ['byokKey', 'aiProvider', 'aiModel'];

const els = {
    ctxMode: () => document.querySelectorAll('input[name="ctxMode"]'),
    proxyUrl: document.getElementById('proxyUrl'),
    testProxy: document.getElementById('testProxy'),
    proxyResult: document.getElementById('proxyResult'),
    aiProvider: document.getElementById('aiProvider'),
    byokKey: document.getElementById('byokKey'),
    aiModel: document.getElementById('aiModel'),
    byokPermHint: document.getElementById('byokPermHint'),
    modeSeg: document.getElementById('modeSeg'),
    intensitySeg: document.getElementById('intensitySeg'),
    directionSeg: document.getElementById('directionSeg'),
    datasetSeg: document.getElementById('datasetSeg'),
    datasetInfo: document.getElementById('datasetInfo'),
    clearAll: document.getElementById('clearAll'),
    savedTag: document.getElementById('savedTag')
};

const PROVIDER = {
    gemini: {
        origin: 'https://generativelanguage.googleapis.com/*',
        model: 'gemini-2.0-flash',
        hint: 'Saving a Gemini key will ask Chrome for permission to contact <code>generativelanguage.googleapis.com</code>. Use a standard AI Studio key (starts with <code>AIza…</code>).'
    },
    openai: {
        origin: 'https://api.openai.com/*',
        model: 'gpt-4o-mini',
        hint: 'Saving a key will ask Chrome for permission to contact <code>api.openai.com</code>.'
    }
};
function providerCfg() { return PROVIDER[els.aiProvider.value] || PROVIDER.gemini; }

function flashSaved() {
    els.savedTag.textContent = 'Saved ✓';
    els.savedTag.classList.add('flash');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => {
        els.savedTag.textContent = 'Settings save automatically';
        els.savedTag.classList.remove('flash');
    }, 1200);
}

function saveSync(obj) { chrome.storage.sync.set(obj, flashSaved); }
function saveLocal(obj) { chrome.storage.local.set(obj, flashSaved); }

function setActive(seg, val) {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === val));
}

function applyCtxModeClass(mode) {
    document.body.classList.toggle('ctx-proxy', mode === 'proxy');
    document.body.classList.toggle('ctx-byok', mode === 'byok');
}

function updateProviderHint() {
    els.byokPermHint.innerHTML = providerCfg().hint;
    els.aiModel.placeholder = providerCfg().model;
}

// ---- Load ----
function load() {
    chrome.storage.sync.get(SYNC_KEYS, sync => {
        chrome.storage.local.get(LOCAL_KEYS, local => {
            const s = C.withDefaults(sync);

            applyCtxModeClass(s.contextCheckMode);
            els.ctxMode().forEach(r => { r.checked = r.value === s.contextCheckMode; });
            els.proxyUrl.value = s.proxyUrl || '';
            els.aiProvider.value = local.aiProvider || 'gemini';
            els.byokKey.value = local.byokKey || '';
            els.aiModel.value = local.aiModel || '';
            updateProviderHint();

            setActive(els.modeSeg, s.replacementMode);
            setActive(els.intensitySeg, C.frequencyToIntensity(s.frequency));
            setActive(els.directionSeg, s.engEngMode ? 'engEng' : 'vieEng');
            setActive(els.datasetSeg, s.datasetKey);

            refreshDatasetInfo();
        });
    });
}

function refreshDatasetInfo() {
    chrome.runtime.sendMessage({ action: 'getStatus' }, res => {
        if (chrome.runtime.lastError || !res) { els.datasetInfo.textContent = ''; return; }
        els.datasetInfo.textContent = `Loaded: ${res.vocabCount} words (${(C.DATASET_REGISTRY[res.datasetKey] || {}).label || res.datasetKey}).`;
    });
}

async function requestProviderPermission() {
    try {
        return await chrome.permissions.request({ origins: [providerCfg().origin] });
    } catch (e) { return false; }
}

// ---- Wire up ----
function wire() {
    // Context mode radios
    els.ctxMode().forEach(radio => {
        radio.addEventListener('change', async () => {
            const mode = radio.value;
            if (mode === 'byok') {
                const granted = await requestProviderPermission();
                if (!granted) {
                    alert('Permission to contact the provider API is required for Bring-Your-Own-Key mode.');
                    document.querySelector('input[name="ctxMode"][value="off"]').checked = true;
                    applyCtxModeClass('off');
                    saveSync({ contextCheckMode: 'off' });
                    return;
                }
            }
            applyCtxModeClass(mode);
            saveSync({ contextCheckMode: mode });
        });
    });

    els.proxyUrl.addEventListener('change', () => saveSync({ proxyUrl: els.proxyUrl.value.trim() }));

    els.aiProvider.addEventListener('change', async () => {
        saveLocal({ aiProvider: els.aiProvider.value });
        updateProviderHint();
        // If already in BYOK mode, make sure we hold the new provider's permission.
        if (document.querySelector('input[name="ctxMode"]:checked')?.value === 'byok') {
            await requestProviderPermission();
        }
    });

    els.byokKey.addEventListener('change', () => saveLocal({ byokKey: els.byokKey.value.trim() }));
    els.aiModel.addEventListener('change', () => saveLocal({ aiModel: els.aiModel.value.trim() }));

    els.testProxy.addEventListener('click', testProxyConnection);

    els.modeSeg.addEventListener('click', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        setActive(els.modeSeg, btn.dataset.val);
        saveSync({ replacementMode: btn.dataset.val });
    });
    els.intensitySeg.addEventListener('click', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        setActive(els.intensitySeg, btn.dataset.val);
        saveSync({ frequency: C.intensityToFrequency(btn.dataset.val) });
    });
    els.directionSeg.addEventListener('click', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        setActive(els.directionSeg, btn.dataset.val);
        const engEng = btn.dataset.val === 'engEng';
        saveSync({ engEngMode: engEng, vieEngMode: !engEng });
    });
    els.datasetSeg.addEventListener('click', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        setActive(els.datasetSeg, btn.dataset.val);
        chrome.runtime.sendMessage({ action: 'setDataset', datasetKey: btn.dataset.val }, () => {
            void chrome.runtime.lastError;
            flashSaved();
            refreshDatasetInfo();
        });
    });

    els.clearAll.addEventListener('click', () => {
        if (!confirm('Delete ALL stored data (settings, cache)? This cannot be undone.')) return;
        chrome.storage.local.clear(() => chrome.storage.sync.clear(() => location.reload()));
    });
}

async function testProxyConnection() {
    const url = els.proxyUrl.value.trim();
    els.proxyResult.className = 'test-result';
    if (!url) { els.proxyResult.textContent = 'Enter a URL first.'; els.proxyResult.classList.add('err'); return; }
    els.proxyResult.textContent = 'Testing…';
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [{ hash: 'test', vietnamesePhrase: 'cân nhắc', candidateEnglish: 'consider', sentenceContext: 'Chúng tôi cần cân nhắc.', dataset: 'B2' }]
            })
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (Array.isArray(data.results)) {
            els.proxyResult.textContent = '✓ Connected';
            els.proxyResult.classList.add('ok');
        } else {
            throw new Error('Unexpected response shape');
        }
    } catch (e) {
        els.proxyResult.textContent = '✗ ' + e.message;
        els.proxyResult.classList.add('err');
    }
}

document.addEventListener('DOMContentLoaded', () => { load(); wire(); });
