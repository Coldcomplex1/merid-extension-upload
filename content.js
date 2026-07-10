// =============================================================
// Merid — content script (LOCAL-ONLY)
// Replaces Vietnamese vocabulary on the page with the English equivalent from
// the selected local dataset and shows a learning tooltip on hover.
//
// No network requests, no backend, no AI. Pure matching/normalization lives in
// lib/vocab-core.js (VMCore).
// =============================================================

const C = window.VMCore;

let settings = {};
let vocabulary = [];
let tooltipElement = null;
let currentObserver = null;
let replacedCount = 0;

const MAX_REPLACEMENTS_PER_PAGE = 800;   // safety cap to protect big pages
const MUTATION_DEBOUNCE_MS = 300;

// Text nodes we've already looked at (avoids MutationObserver reprocessing loops).
// Reset on every init() so a settings change re-evaluates the whole page.
let processedNodes = new WeakSet();

const FORBIDDEN_TAGS = new Set([
    'script', 'style', 'textarea', 'input', 'select', 'noscript', 'code', 'pre',
    'kbd', 'samp', 'var', 'option', 'button', 'svg', 'math', 'canvas', 'iframe',
    'audio', 'video'
]);
const SKIP_ANCESTOR_SELECTOR =
    'nav, [role="button"], [role="menu"], [role="menubar"], [role="tab"], ' +
    '[contenteditable=""], [contenteditable="true"], [aria-hidden="true"], ' +
    '.vocab-master-highlight, .vocab-master-tooltip';

console.log('[VM] Content script starting…');

// -------------------------------------------------------------
// Init / teardown
// -------------------------------------------------------------
function init() {
    if (currentObserver) { currentObserver.disconnect(); currentObserver = null; }
    processedNodes = new WeakSet();

    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
        if (chrome.runtime.lastError) { console.warn('[VM] getSettings failed:', chrome.runtime.lastError.message); return; }
        settings = C.withDefaults(response);

        if (settings.extensionEnabled === false) {
            console.log('[VM] Extension disabled — not processing.');
            return;
        }

        const start = () => {
            const mode = settings.engEngMode ? 'engEng' : 'vieEng';
            const vocabMap = C.buildVocabMap(vocabulary, mode);
            processPage(vocabMap);
            observeChanges(vocabMap);
        };

        if (vocabulary.length > 0) {
            start();
        } else {
            chrome.runtime.sendMessage({ action: 'getVocabulary' }, (resp) => {
                if (chrome.runtime.lastError) { console.warn('[VM] getVocabulary failed:', chrome.runtime.lastError.message); return; }
                vocabulary = (resp && resp.vocabulary) || [];
                if (vocabulary.length > 0) start();
            });
        }
    });
}

// -------------------------------------------------------------
// Node eligibility
// -------------------------------------------------------------
function shouldProcessNode(node) {
    if (processedNodes.has(node)) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    if (FORBIDDEN_TAGS.has(parent.tagName.toLowerCase())) return false;
    if (parent.isContentEditable) return false;
    if (parent.closest(SKIP_ANCESTOR_SELECTOR)) return false;
    return true;
}

// -------------------------------------------------------------
// Page processing (chunked to keep the main thread responsive)
// -------------------------------------------------------------
function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) if (shouldProcessNode(n)) nodes.push(n);
    return nodes;
}

function processPage(vocabMap) {
    const textNodes = collectTextNodes(document.body);
    let index = 0;
    const chunkSize = 50;

    function processChunk() {
        const end = Math.min(index + chunkSize, textNodes.length);
        for (; index < end; index++) processTextNode(textNodes[index], vocabMap);
        if (index < textNodes.length) {
            requestAnimationFrame(processChunk);
        } else {
            console.log('[VM] Page processing complete. Replaced:', replacedCount);
        }
    }
    processChunk();
}

function processTextNode(node, vocabMap) {
    const original = node.textContent;
    if (!original || !original.trim() || vocabMap.size === 0) { processedNodes.add(node); return; }
    if (replacedCount >= MAX_REPLACEMENTS_PER_PAGE) { processedNodes.add(node); return; }

    const tokens = C.tokenize(original);
    const out = [];
    let modified = false;

    for (let i = 0; i < tokens.length; i++) {
        const match = replacedCount < MAX_REPLACEMENTS_PER_PAGE
            ? C.findMatch(tokens, i, vocabMap, { allowSingleWord: true, minSingleWordLen: 2 })
            : null;

        if (!match) { out.push(makeTextNode(tokens[i])); continue; }

        const { size, matchedText, items } = match;
        const item = items[0]; // deterministic pick from the dataset
        const replaceWith = item.word;

        // Deterministic intensity gate — stable across re-renders (no Math.random).
        if (!C.gateByFrequency(matchedText.toLowerCase() + '|' + replaceWith.toLowerCase(), settings.frequency)) {
            out.push(makeTextNode(matchedText));
            i += size - 1;
            continue;
        }

        const span = document.createElement('span');
        span.className = 'vocab-master-highlight';
        span.dataset.word = item.word;
        span.dataset.original = matchedText;
        span.dataset.replacement = replaceWith;
        applyDisplayMode(span);

        out.push(span);
        i += size - 1;
        modified = true;
    }

    if (modified) {
        out.forEach(nd => { if (nd.nodeType === Node.TEXT_NODE) processedNodes.add(nd); });
        node.replaceWith(...out);
    } else {
        processedNodes.add(node);
    }
}

// Turn a span into its final displayed state per the current replacement mode.
function applyDisplayMode(span) {
    const matchedText = span.dataset.original || '';
    const replaceWith = span.dataset.replacement || matchedText;
    const isSameWord = matchedText.toLowerCase().trim() === replaceWith.toLowerCase().trim();
    const mode = settings.replacementMode || 'replace';

    span.classList.add('vocab-master-highlight', 'vocab-highlight');

    let didReplace = false;
    if (isSameWord || mode === 'highlight') {
        span.textContent = matchedText;                       // keep original, highlighted + tooltip
    } else if (mode === 'beside') {
        span.textContent = `${matchedText} (${replaceWith})`; // từ (word)
        didReplace = true;
    } else {
        span.textContent = replaceWith;                       // 'replace'
        didReplace = true;
    }

    if (didReplace && !span.classList.contains('vocab-replaced')) {
        span.classList.add('vocab-replaced');
        replacedCount++;
    }
    return didReplace;
}

function makeTextNode(text) {
    const t = document.createTextNode(text);
    processedNodes.add(t);
    return t;
}

// -------------------------------------------------------------
// Dynamic content — debounced MutationObserver
// -------------------------------------------------------------
function observeChanges(vocabMap) {
    let debounceTimer = null;
    let queuedRoots = [];

    currentObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            m.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE &&
                    (node.classList.contains('vocab-master-highlight') || node.classList.contains('vocab-master-tooltip'))) return;
                if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) queuedRoots.push(node);
            });
        }
        if (queuedRoots.length && !debounceTimer) {
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                const roots = queuedRoots;
                queuedRoots = [];
                const nodes = [];
                for (const r of roots) {
                    if (!r.isConnected) continue;
                    if (r.nodeType === Node.TEXT_NODE) { if (shouldProcessNode(r)) nodes.push(r); }
                    else nodes.push(...collectTextNodes(r));
                }
                processNodeBatch(nodes, vocabMap);
            }, MUTATION_DEBOUNCE_MS);
        }
    });

    currentObserver.observe(document.body, { childList: true, subtree: true });
}

function processNodeBatch(nodes, vocabMap) {
    let index = 0;
    const batchSize = 20;
    function run() {
        const end = Math.min(index + batchSize, nodes.length);
        for (; index < end; index++) processTextNode(nodes[index], vocabMap);
        if (index < nodes.length) requestAnimationFrame(run);
    }
    run();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'revertPage') {
        revertPage();
        sendResponse({ success: true });
    }
    return false;
});

// -------------------------------------------------------------
// Revert
// -------------------------------------------------------------
function revertPage() {
    const parents = new Set();
    document.querySelectorAll('.vocab-master-highlight').forEach(span => {
        const originalText = span.dataset.original || span.textContent;
        if (span.parentNode) parents.add(span.parentNode);
        span.replaceWith(document.createTextNode(originalText));
    });
    // Merge adjacent text nodes only where we actually changed things.
    parents.forEach(p => { try { p.normalize(); } catch (e) { /* detached */ } });
    replacedCount = 0;
}

// -------------------------------------------------------------
// Tooltip
// -------------------------------------------------------------
function createTooltip() {
    tooltipElement = document.createElement('div');
    tooltipElement.className = 'vocab-master-tooltip';
    tooltipElement.style.display = 'none';
    document.body.appendChild(tooltipElement);

    tooltipElement.addEventListener('click', onTooltipClick);
    document.addEventListener('mouseover', handleMouseOver);
}

function onTooltipClick(e) {
    if (e.target.closest('.vm-audio')) {
        const word = tooltipElement.querySelector('.vm-word')?.textContent || '';
        try {
            const u = new SpeechSynthesisUtterance(word);
            u.lang = 'en-US';
            window.speechSynthesis.speak(u);
        } catch (err) { /* speech not available */ }
    } else if (e.target.closest('.vm-close')) {
        hideTooltip();
    }
}

let hideTimeout = null;
function handleMouseOver(e) {
    const highlight = e.target.closest('.vocab-master-highlight');
    const tooltip = e.target.closest('.vocab-master-tooltip');
    if (highlight || tooltip) {
        if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
        if (highlight) {
            const item = vocabulary.find(v => v.word === highlight.dataset.word);
            if (item) showTooltip(highlight, item);
        }
    } else if (tooltipElement && tooltipElement.style.display !== 'none' && !hideTimeout) {
        hideTimeout = setTimeout(() => { hideTooltip(); hideTimeout = null; }, 120);
    }
}

function showTooltip(target, item) {
    const esc = C.escapeHtml;
    const rect = target.getBoundingClientRect();
    const originalText = target.dataset.original || '';

    tooltipElement.dataset.currentWord = item.word || '';

    const synonyms = (item.synonyms || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    const antonyms = (item.antonyms || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    const example = item.example
        ? esc(item.example).replace(new RegExp('(' + C.escapeRegExp(esc(item.word)) + ')', 'gi'), '<strong>$1</strong>')
        : 'No example available.';
    const titleFontSize = Math.max(16, 26 - Math.max(0, (item.word || '').length - 8) * 1.2);

    tooltipElement.innerHTML = `
        <div class="vm-card">
            <button class="vm-close" type="button" aria-label="Close tooltip">&times;</button>
            <div class="vm-header">
                <div class="vm-title vm-word" style="font-size:${titleFontSize.toFixed(1)}px">${esc((item.word || '').toUpperCase())}</div>
                <div class="vm-meta">
                    <span class="vm-type">(${esc(item.type || '')})</span>
                    <button class="vm-audio" type="button" aria-label="Play pronunciation">🔊</button>
                </div>
            </div>
            <div class="vm-definition">${esc(item.definition || 'No definition available.')}</div>
            ${synonyms.length ? `<div class="vm-chips vm-chips--synonyms">${synonyms.map(s => `<span class="vm-chip vm-yellow">${esc(s)}</span>`).join('')}</div>` : ''}
            ${antonyms.length ? `<div class="vm-chips vm-chips--antonyms">${antonyms.map(s => `<span class="vm-chip vm-dark">${esc(s)}</span>`).join('')}</div>` : ''}
            <div class="vm-example">${example}</div>
            <div class="vm-secondary">
                <div class="vm-details">
                    <div class="vm-detail-item"><strong>Vietnamese</strong><span>${esc(item.vietnamese || 'N/A')}</span></div>
                    ${(originalText && originalText.toLowerCase() !== (item.word || '').toLowerCase()) ? `<div class="vm-detail-item"><strong>Replaced</strong><span>${esc(originalText)}</span></div>` : ''}
                </div>
            </div>
        </div>`;

    tooltipElement.style.display = 'block';
    const tRect = tooltipElement.getBoundingClientRect();
    const buffer = 20;
    let top;
    if ((window.innerHeight - rect.bottom) < tRect.height + buffer && rect.top > tRect.height + buffer) {
        top = rect.top + window.scrollY - tRect.height - 10;
        tooltipElement.style.animation = 'vm-slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    } else {
        top = rect.bottom + window.scrollY + 10;
        tooltipElement.style.animation = 'vm-slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    }
    let left = rect.left + window.scrollX - (tRect.width / 2) + (rect.width / 2);
    if (left < 10) left = 10;
    if (left + tRect.width > window.innerWidth - 10) left = window.innerWidth - tRect.width - 10;
    tooltipElement.style.top = `${top}px`;
    tooltipElement.style.left = `${left}px`;
}

function hideTooltip() {
    if (tooltipElement) tooltipElement.style.display = 'none';
}

// -------------------------------------------------------------
// React to setting / dataset changes live (no reload)
// -------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const key in changes) settings[key] = changes[key].newValue;

    revertPage();

    if (settings.extensionEnabled === false) {
        if (currentObserver) { currentObserver.disconnect(); currentObserver = null; }
        return;
    }
    // Dataset change requires fresh vocab from the background.
    if (changes.datasetKey) {
        chrome.runtime.sendMessage({ action: 'getVocabulary' }, (resp) => {
            if (chrome.runtime.lastError) return;
            vocabulary = (resp && resp.vocabulary) || vocabulary;
            init();
        });
    } else {
        init();
    }
});

// -------------------------------------------------------------
// Boot
// -------------------------------------------------------------
init();
createTooltip();
