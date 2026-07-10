// Options page controller. Uses window.VMCore for defaults/registry.
// Local-only: no API keys, no backend URL, no AI settings.
const C = window.VMCore;

const SYNC_KEYS = ['frequency', 'replacementMode', 'vieEngMode', 'engEngMode', 'datasetKey'];

const els = {
    modeSeg: document.getElementById('modeSeg'),
    intensitySeg: document.getElementById('intensitySeg'),
    directionCards: document.getElementById('directionCards'),
    datasetSeg: document.getElementById('datasetSeg'),
    datasetInfo: document.getElementById('datasetInfo'),
    savedList: document.getElementById('savedList'),
    savedCount: document.getElementById('savedCount'),
    knownList: document.getElementById('knownList'),
    knownCount: document.getElementById('knownCount'),
    resetKnown: document.getElementById('resetKnown'),
    clearAll: document.getElementById('clearAll'),
    savedTag: document.getElementById('savedTag')
};

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

function setActive(seg, val) {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === val));
}

function setCard(mode, on) {
    const card = els.directionCards.querySelector(`.mode-card[data-mode="${mode}"]`);
    if (!card) return;
    card.classList.toggle('active', !!on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function cardOn(mode) {
    return !!els.directionCards.querySelector(`.mode-card[data-mode="${mode}"]`)?.classList.contains('active');
}

// ---- Load ----
function load() {
    chrome.storage.sync.get(SYNC_KEYS, sync => {
        const s = C.withDefaults(sync);
        setActive(els.modeSeg, s.replacementMode);
        setActive(els.intensitySeg, C.frequencyToIntensity(s.frequency));
        setCard('vieEng', !!s.vieEngMode);
        setCard('engEng', !!s.engEngMode);
        setActive(els.datasetSeg, s.datasetKey);
        refreshDatasetInfo();
    });
    renderDeck();
}

function refreshDatasetInfo() {
    chrome.runtime.sendMessage({ action: 'getStatus' }, res => {
        if (chrome.runtime.lastError || !res) { els.datasetInfo.textContent = ''; return; }
        els.datasetInfo.textContent = `Loaded: ${res.vocabCount} words (${(C.DATASET_REGISTRY[res.datasetKey] || {}).label || res.datasetKey}).`;
    });
}

// ---- Deck (saved + known words, local only) ----
function renderDeck() {
    chrome.storage.local.get(['savedWords', 'knownWords'], (r) => {
        renderSaved(r.savedWords || []);
        renderKnown(r.knownWords || []);
    });
}

function renderSaved(list) {
    els.savedCount.textContent = String(list.length);
    els.savedList.innerHTML = '';
    if (!list.length) {
        els.savedList.innerHTML = '<li class="deck-empty">No saved words yet. Hover a highlighted word and click “Save to Deck”.</li>';
        return;
    }
    list.forEach((entry, i) => {
        const word = entry && entry.word ? entry.word : String(entry);
        const vn = entry && entry.vietnamese ? entry.vietnamese : '';
        const li = document.createElement('li');
        const left = document.createElement('span');
        left.innerHTML = `<strong>${escapeHtml(word)}</strong>${vn ? ` <span class="vn">${escapeHtml(vn)}</span>` : ''}`;
        const rm = document.createElement('button');
        rm.className = 'deck-remove';
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove');
        rm.textContent = '✕';
        rm.addEventListener('click', () => removeFrom('savedWords', i));
        li.appendChild(left);
        li.appendChild(rm);
        els.savedList.appendChild(li);
    });
}

function renderKnown(list) {
    els.knownCount.textContent = String(list.length);
    els.knownList.innerHTML = '';
    if (!list.length) {
        els.knownList.innerHTML = '<li class="deck-empty">No known words yet. Click “I know this” on a word to stop replacing it.</li>';
        return;
    }
    list.forEach((w, i) => {
        const li = document.createElement('li');
        const left = document.createElement('span');
        left.innerHTML = `<strong>${escapeHtml(String(w))}</strong>`;
        const rm = document.createElement('button');
        rm.className = 'deck-remove';
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove');
        rm.textContent = '✕';
        rm.addEventListener('click', () => removeFrom('knownWords', i));
        li.appendChild(left);
        li.appendChild(rm);
        els.knownList.appendChild(li);
    });
}

function removeFrom(key, index) {
    chrome.storage.local.get([key], (r) => {
        const list = r[key] || [];
        list.splice(index, 1);
        chrome.storage.local.set({ [key]: list }, renderDeck);
    });
}

function escapeHtml(s) { return C && C.escapeHtml ? C.escapeHtml(s) : String(s); }

// ---- Wire up ----
function wire() {
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
    els.directionCards.addEventListener('click', e => {
        const card = e.target.closest('.mode-card'); if (!card) return;
        setCard(card.dataset.mode, !card.classList.contains('active'));
        saveSync({ vieEngMode: cardOn('vieEng'), engEngMode: cardOn('engEng') });
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

    els.resetKnown.addEventListener('click', () => {
        if (!confirm('Reset the known-words list? Those words will be replaced again while you browse.')) return;
        chrome.storage.local.set({ knownWords: [] }, renderDeck);
    });

    els.clearAll.addEventListener('click', () => {
        if (!confirm('Delete ALL stored data (settings + your deck)? This cannot be undone.')) return;
        chrome.storage.local.clear(() => chrome.storage.sync.clear(() => location.reload()));
    });

    // Keep the deck view fresh if it changes from a page (Save to Deck / I know this).
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.savedWords || changes.knownWords)) renderDeck();
    });
}

document.addEventListener('DOMContentLoaded', () => { load(); wire(); });
