const C = window.VMCore;

document.addEventListener('DOMContentLoaded', () => {
    const frequencySlider = document.getElementById('frequency-slider');
    const vieEngToggle = document.getElementById('vie-eng-toggle');
    const engEngToggle = document.getElementById('eng-eng-toggle');
    const extensionToggle = document.getElementById('extension-toggle');
    const datasetBtns = document.querySelectorAll('.dataset-btn');
    const modeSeg = document.getElementById('mode-seg');

    // ---- Load settings ----
    chrome.storage.sync.get(
        ['frequency', 'replacementMode', 'vieEngMode', 'engEngMode', 'extensionEnabled', 'datasetKey'],
        (raw) => {
            const s = C.withDefaults(raw);
            frequencySlider.value = s.frequency;
            vieEngToggle.checked = !!s.vieEngMode;
            engEngToggle.checked = !!s.engEngMode;
            setSegActive(modeSeg, s.replacementMode);
            document.querySelector(`.dataset-btn[data-key="${s.datasetKey}"]`)?.classList.add('active');
            updateExtensionToggleButton(s.extensionEnabled !== false);
            updateSliderLabels(s.frequency);
        }
    );

    // ---- Wire settings ----
    frequencySlider.addEventListener('input', (e) => {
        updateSliderLabels(e.target.value);
        chrome.storage.sync.set({ frequency: parseInt(e.target.value, 10) });
    });

    modeSeg.addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        setSegActive(modeSeg, btn.dataset.val);
        chrome.storage.sync.set({ replacementMode: btn.dataset.val });
    });

    datasetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            datasetBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            chrome.runtime.sendMessage({ action: 'setDataset', datasetKey: btn.dataset.key }, () => {
                void chrome.runtime.lastError;
            });
        });
    });

    vieEngToggle.addEventListener('change', (e) => {
        if (e.target.checked) engEngToggle.checked = false;
        chrome.storage.sync.set({ vieEngMode: e.target.checked, engEngMode: engEngToggle.checked });
    });

    engEngToggle.addEventListener('change', (e) => {
        if (e.target.checked) vieEngToggle.checked = false;
        chrome.storage.sync.set({ engEngMode: e.target.checked, vieEngMode: vieEngToggle.checked });
    });

    extensionToggle.addEventListener('click', () => {
        chrome.storage.sync.get('extensionEnabled', (result) => {
            const newState = result.extensionEnabled === false; // toggle
            chrome.storage.sync.set({ extensionEnabled: newState }, () => {
                updateExtensionToggleButton(newState);
            });
        });
    });

    document.getElementById('revert-btn').addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id != null) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'revertPage' }, () => void chrome.runtime.lastError);
            }
        });
    });

    document.getElementById('options-btn').addEventListener('click', () => {
        if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
        else window.open(chrome.runtime.getURL('options.html'));
    });

    // ---- helpers ----
    function setSegActive(seg, val) {
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === val));
    }

    function updateSliderLabels(value) {
        const labels = document.querySelectorAll('.slider-labels span');
        labels.forEach(span => span.classList.remove('active'));
        if (value < 33) labels[0].classList.add('active');
        else if (value < 66) labels[1].classList.add('active');
        else labels[2].classList.add('active');
    }

    function updateExtensionToggleButton(enabled) {
        extensionToggle.textContent = enabled ? 'Extension is ON' : 'Extension is OFF';
        extensionToggle.classList.toggle('active', enabled);
    }
});
