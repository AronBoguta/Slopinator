/**
 * Slopinator — Main Application
 * Orchestrates the UI, Worker communication, and virtual scrolling.
 */
import { VirtualScroll } from './virtual-scroll.js';

// ===== Worker Setup =====
let worker = null;
let requestId = 0;
const pendingRequests = new Map();

function initWorker() {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
        console.error('[Worker Error]', err);
        setStatus('Worker error');
    };
}

function handleWorkerMessage(e) {
    const msg = e.data;

    if (msg.type === 'response' && msg.id != null) {
        const resolver = pendingRequests.get(msg.id);
        if (resolver) {
            pendingRequests.delete(msg.id);
            resolver(msg);
        }
        return;
    }

    switch (msg.type) {
        case 'wasm-ready':
            console.log('[Slopinator] WASM engine ready');
            break;
        case 'index-progress':
            onIndexProgress(msg);
            break;
        case 'index-complete':
            onIndexComplete(msg);
            break;
        case 'search-progress':
            onSearchProgress(msg);
            break;
        case 'search-complete':
            onSearchComplete(msg);
            break;
        case 'error':
            console.error('[Worker]', msg.error);
            break;
    }
}

function sendWorkerRequest(type, data = {}) {
    const id = ++requestId;
    return new Promise((resolve) => {
        pendingRequests.set(id, resolve);
        worker.postMessage({ type, id, ...data });
    });
}

// ===== DOM Elements =====
const $welcome = document.getElementById('welcome');
const $viewer = document.getElementById('viewer');
const $gutter = document.getElementById('gutter');
const $scrollContainer = document.getElementById('scroll-container');
const $lineContainer = document.getElementById('line-container');
const $scrollSpacer = document.getElementById('scroll-spacer');
const $dropZone = document.getElementById('drop-zone');
const $searchInput = document.getElementById('search-input');
const $searchInfo = document.getElementById('search-info');
const $btnCase = document.getElementById('btn-case');

// Status bar
const $statusFile = document.getElementById('status-file');
const $statusSize = document.getElementById('status-size');
const $statusLines = document.getElementById('status-lines');
const $statusCursor = document.getElementById('status-cursor');
const $statusMemory = document.getElementById('status-memory');
const $searchToast = document.getElementById('search-toast');
const $searchToastText = document.getElementById('search-toast-text');
const $indexProgress = document.getElementById('index-progress');
const $indexProgressBar = document.getElementById('index-progress-bar');
const $indexProgressText = document.getElementById('index-progress-text');

// Dialogs
const $gotoDialog = document.getElementById('goto-dialog');
const $gotoInput = document.getElementById('goto-input');

// Search panel
const $searchPanel = document.getElementById('search-panel');
const $searchPanelCount = document.getElementById('search-panel-count');
const $searchPanelList = document.getElementById('search-panel-list');
let allSearchResults = null; // Full results for the sidebar

// ===== State =====
let totalLines = 0;
let fileLoaded = false;
let caseSensitive = true;
let searchQuery = '';
let searchResults = null;
let currentMatchIndex = -1;
let searchTimeout = null;
let fetchGeneration = 0; // Incremented on every viewport change; stale responses are discarded

// ===== Virtual Scroll =====
let virtualScroll = null;

function initVirtualScroll() {
    virtualScroll = new VirtualScroll({
        scrollContainer: $scrollContainer,
        lineContainer: $lineContainer,
        spacer: $scrollSpacer,
        gutter: $gutter,
        lineHeight: 20,
        onViewportChange: onViewportChange,
    });
}

async function onViewportChange(startLine, count) {
    if (!fileLoaded) return;

    // Tag this request with a generation number so we can discard stale responses
    const gen = ++fetchGeneration;

    try {
        const resp = await sendWorkerRequest('getLines', { startLine, count });
        // If a newer scroll happened while we were waiting, discard this response
        if (gen !== fetchGeneration) return;

        if (resp.lines && resp.lines.length > 0) {
            virtualScroll.setLineData(resp.lines);
            const first = resp.lines[0].line_number;
            const last = resp.lines[resp.lines.length - 1].line_number;
            $statusCursor.textContent = `Ln ${first + 1}–${last + 1}`;
        }
    } catch (err) {
        console.error('Failed to fetch lines:', err);
    }
}

// ===== File Opening =====
async function openFile(file) {
    if (!worker) return;

    // Show viewer, hide welcome
    $welcome.classList.add('hidden');
    $viewer.classList.remove('hidden');

    // Update status
    $statusFile.textContent = file.name;
    $statusSize.textContent = formatBytes(file.size);

    // Show indexing progress
    $indexProgress.classList.remove('hidden');
    $indexProgressText.textContent = 'Indexing…';

    // Reset search
    clearSearch();

    // Send file to worker
    const sparseFactor = file.size > 500_000_000 ? 10 : 1; // Sparse for 500MB+
    const resp = await sendWorkerRequest('open', {
        file,
        sparseFactor,
        cacheChunks: 8,
    });

    if (resp.error) {
        console.error('Failed to open file:', resp.error);
        setStatus('Error: ' + resp.error);
        return;
    }

    totalLines = resp.totalLines;
    fileLoaded = true;

    // Set up virtual scroll
    virtualScroll.setTotalLines(totalLines);
    $statusLines.textContent = `${formatNumber(totalLines)} lines`;

    // Update stats
    updateMemoryStats();
}

function onIndexProgress(msg) {
    const pct = ((msg.bytesIndexed / msg.totalSize) * 100).toFixed(1);
    $indexProgressBar.style.setProperty('--progress', pct + '%');
    $indexProgressText.textContent = `Indexing… ${pct}% (${formatNumber(msg.totalLines)} lines)`;
}

function onIndexComplete(msg) {
    $indexProgress.classList.add('hidden');
    totalLines = msg.totalLines;
    $statusLines.textContent = `${formatNumber(totalLines)} lines`;
}

// ===== Search =====
function triggerSearch() {
    const query = $searchInput.value.trim();
    if (!query || !fileLoaded) {
        clearSearchUI();
        return;
    }

    searchQuery = query;

    // Debounce
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => performSearch(query), 250);
}

async function performSearch(query) {
    $searchInfo.textContent = 'Searching…';
    const searchStart = performance.now();

    const resp = await sendWorkerRequest('search', {
        query,
        caseSensitive,
        maxResults: 100000,
    });

    if (resp.error) {
        $searchInfo.textContent = 'Error';
        return;
    }

    searchResults = resp.results;
    currentMatchIndex = resp.totalResults > 0 ? 0 : -1;

    // Fetch ALL results for the sidebar panel and highlights
    const totalFound = resp.totalResults;
    if (totalFound > 0 && totalFound > (searchResults?.matches?.length || 0)) {
        const allResp = await sendWorkerRequest('getSearchResults', {
            start: 0,
            count: Math.min(totalFound, 100000),
        });
        if (allResp.results) {
            searchResults = allResp.results;
            allSearchResults = allResp.results;
        }
    } else {
        allSearchResults = searchResults;
    }

    const elapsed = performance.now() - searchStart;

    updateSearchInfo();
    applySearchHighlights();
    showSearchTiming(elapsed, totalFound);
    populateSearchPanel(query);

    // Jump to first match
    if (currentMatchIndex >= 0 && searchResults && searchResults.matches.length > 0) {
        goToMatch(0);
    }
}

function onSearchProgress(msg) {
    const pct = ((msg.bytesSearched / msg.totalSize) * 100).toFixed(0);
    $searchInfo.textContent = `Searching… ${pct}% (${formatNumber(msg.resultCount)} found)`;
}

function onSearchComplete(msg) {
    updateSearchInfo();
}

function updateSearchInfo() {
    if (!searchResults || searchResults.total === 0) {
        $searchInfo.textContent = searchQuery ? 'No results' : '';
        return;
    }
    const current = currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0;
    const total = searchResults.total;
    const capped = searchResults.capped ? '+' : '';
    $searchInfo.textContent = `${current}/${formatNumber(total)}${capped}`;
}

function applySearchHighlights() {
    if (!virtualScroll || !searchResults || !searchResults.matches) {
        virtualScroll?.clearHighlights();
        return;
    }

    const highlights = new Map();
    for (let i = 0; i < searchResults.matches.length; i++) {
        const m = searchResults.matches[i];
        if (!highlights.has(m.line)) {
            highlights.set(m.line, []);
        }
        highlights.get(m.line).push({
            col: m.col,
            length: m.length,
            isCurrent: i === currentMatchIndex,
        });
    }

    virtualScroll.setSearchHighlights(highlights);
}

async function goToMatch(index) {
    if (!searchResults || searchResults.total === 0) return;

    // If we need more results, fetch them
    if (index >= searchResults.matches.length) {
        const resp = await sendWorkerRequest('getSearchResults', {
            start: 0,
            count: Math.min(index + 100, searchResults.total),
        });
        if (resp.results) {
            searchResults = resp.results;
        }
    }

    if (index < 0 || index >= searchResults.matches.length) return;

    currentMatchIndex = index;
    const match = searchResults.matches[index];

    virtualScroll.setCurrentMatchLine(match.line);
    virtualScroll.scrollToLine(match.line - Math.floor(virtualScroll.visibleCount / 2));

    updateSearchInfo();
    applySearchHighlights();
    updateSearchPanelActiveItem(index);
}

function nextMatch() {
    if (!searchResults || searchResults.total === 0) return;
    const next = (currentMatchIndex + 1) % searchResults.total;
    goToMatch(next);
}

function prevMatch() {
    if (!searchResults || searchResults.total === 0) return;
    const prev = (currentMatchIndex - 1 + searchResults.total) % searchResults.total;
    goToMatch(prev);
}

function clearSearch() {
    searchQuery = '';
    searchResults = null;
    allSearchResults = null;
    currentMatchIndex = -1;
    $searchInput.value = '';
    clearSearchUI();
    hideSearchPanel();
    if (worker && fileLoaded) {
        sendWorkerRequest('clearSearch');
    }
}

function clearSearchUI() {
    $searchInfo.textContent = '';
    virtualScroll?.clearHighlights();
}

function toggleCaseSensitive() {
    caseSensitive = !caseSensitive;
    $btnCase.classList.toggle('active', caseSensitive);
    if (searchQuery) triggerSearch();
}

// ===== Go-to-Line =====
function showGotoDialog() {
    $gotoDialog.classList.remove('hidden');
    $gotoInput.value = '';
    $gotoInput.max = totalLines;
    $gotoInput.focus();
}

function hideGotoDialog() {
    $gotoDialog.classList.add('hidden');
}

function goToLine() {
    const line = parseInt($gotoInput.value, 10);
    if (!isNaN(line) && line >= 1 && line <= totalLines) {
        virtualScroll.scrollToLine(line - 1); // Convert to 0-indexed
    }
    hideGotoDialog();
}

// ===== Stats =====
async function updateMemoryStats() {
    if (!worker || !fileLoaded) return;
    const resp = await sendWorkerRequest('getStats');
    if (resp.stats) {
        $statusMemory.textContent = `Mem: ${formatBytes(resp.stats.index_memory_bytes + resp.stats.cache_memory_bytes)}`;
    }
}

// ===== Drag & Drop =====
function setupDragDrop() {
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        $dropZone.classList.remove('hidden');
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            $dropZone.classList.add('hidden');
        }
    });

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        $dropZone.classList.add('hidden');

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            openFile(files[0]);
        }
    });
}

// ===== File Picker =====
function openFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.log,.txt,.csv,.json,.xml,.out,.err,*';
    input.onchange = () => {
        if (input.files && input.files.length > 0) {
            openFile(input.files[0]);
        }
    };
    input.click();
}

// ===== Keyboard Shortcuts =====
function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Ctrl+O — Open
        if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
            e.preventDefault();
            openFilePicker();
        }

        // Ctrl+F — Focus search
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            $searchInput.focus();
            $searchInput.select();
        }

        // Ctrl+G — Go to line
        if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
            e.preventDefault();
            if (fileLoaded) showGotoDialog();
        }

        // Escape — close dialogs, clear search focus
        if (e.key === 'Escape') {
            if (!$gotoDialog.classList.contains('hidden')) {
                hideGotoDialog();
            } else if (document.activeElement === $searchInput) {
                $searchInput.blur();
            }
        }
    });
}

// ===== Event Binding =====
function bindEvents() {
    // Open buttons
    document.getElementById('btn-open').addEventListener('click', openFilePicker);
    document.getElementById('btn-open-welcome').addEventListener('click', openFilePicker);

    // Search
    $searchInput.addEventListener('input', triggerSearch);
    $searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                prevMatch();
            } else {
                nextMatch();
            }
        }
    });

    $btnCase.addEventListener('click', toggleCaseSensitive);
    document.getElementById('btn-prev-match').addEventListener('click', prevMatch);
    document.getElementById('btn-next-match').addEventListener('click', nextMatch);

    // Go-to-line
    document.getElementById('btn-goto').addEventListener('click', () => {
        if (fileLoaded) showGotoDialog();
    });
    document.getElementById('goto-cancel').addEventListener('click', hideGotoDialog);
    document.getElementById('goto-go').addEventListener('click', goToLine);
    $gotoInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            goToLine();
        }
        if (e.key === 'Escape') {
            hideGotoDialog();
        }
    });

    // Theme toggle
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);

    // Search panel close
    document.getElementById('search-panel-close').addEventListener('click', hideSearchPanel);
}

// ===== Search Results Panel =====
const PANEL_BATCH_SIZE = 500; // Render results in batches for performance
let panelRenderedCount = 0;

function populateSearchPanel(query) {
    if (!allSearchResults || !allSearchResults.matches || allSearchResults.matches.length === 0) {
        hideSearchPanel();
        return;
    }

    const matches = allSearchResults.matches;
    $searchPanelCount.textContent = `${formatNumber(matches.length)} results`;
    $searchPanelList.innerHTML = '';
    panelRenderedCount = 0;

    // Show panel
    $searchPanel.classList.remove('hidden');

    // Render first batch
    renderPanelBatch(query, matches);

    // Lazy-load more results on scroll
    $searchPanelList.onscroll = () => {
        if (panelRenderedCount < matches.length) {
            const { scrollTop, scrollHeight, clientHeight } = $searchPanelList;
            if (scrollTop + clientHeight >= scrollHeight - 100) {
                renderPanelBatch(query, matches);
            }
        }
    };

    // Highlight first result
    updateSearchPanelActiveItem(0);
}

function renderPanelBatch(query, matches) {
    const end = Math.min(panelRenderedCount + PANEL_BATCH_SIZE, matches.length);
    const frag = document.createDocumentFragment();
    const batchItems = [];

    for (let i = panelRenderedCount; i < end; i++) {
        const m = matches[i];
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.dataset.index = i;

        // Line number
        const lineEl = document.createElement('span');
        lineEl.className = 'search-result-line';
        lineEl.textContent = `L${m.line + 1}`;

        // Placeholder text — will be updated with real content
        const textEl = document.createElement('span');
        textEl.className = 'search-result-text';
        textEl.innerHTML = `<mark>${escapeHtml(query)}</mark>`;

        item.appendChild(lineEl);
        item.appendChild(textEl);

        // Click to navigate
        item.addEventListener('click', () => {
            const idx = parseInt(item.dataset.index, 10);
            goToMatch(idx);
            updateSearchPanelActiveItem(idx);
        });

        frag.appendChild(item);
        batchItems.push({ match: m, textEl });
    }

    $searchPanelList.appendChild(frag);
    panelRenderedCount = end;

    // Async: fetch line content and update items with real context
    fetchLineContextForBatch(batchItems, query);
}

async function fetchLineContextForBatch(batchItems, query) {
    if (batchItems.length === 0) return;

    // Group by consecutive line ranges to minimize worker calls
    const lineNums = [...new Set(batchItems.map(b => b.match.line))].sort((a, b) => a - b);
    const minLine = lineNums[0];
    const maxLine = lineNums[lineNums.length - 1];

    try {
        const resp = await sendWorkerRequest('getLines', {
            startLine: minLine,
            count: maxLine - minLine + 1,
        });

        if (resp.lines && resp.lines.length > 0) {
            // Build a map of line number -> content
            const lineMap = new Map();
            for (const l of resp.lines) {
                lineMap.set(l.line_number, l.content);
            }

            // Update each item with the real line content, highlighted
            for (const { match, textEl } of batchItems) {
                const content = lineMap.get(match.line);
                if (content) {
                    textEl.innerHTML = highlightContextText(content, match.col, match.length);
                }
            }
        }
    } catch (err) {
        // Silently fail — items keep their placeholder text
    }
}

function highlightContextText(lineContent, col, matchLen) {
    // Show a window of text around the match for context
    const contextRadius = 40;
    const start = Math.max(0, col - contextRadius);
    const end = Math.min(lineContent.length, col + matchLen + contextRadius);

    const prefix = start > 0 ? '\u2026' : '';
    const suffix = end < lineContent.length ? '\u2026' : '';

    const before = escapeHtml(lineContent.substring(start, col));
    const matchText = escapeHtml(lineContent.substring(col, col + matchLen));
    const after = escapeHtml(lineContent.substring(col + matchLen, end));

    return `${prefix}${before}<mark>${matchText}</mark>${after}${suffix}`;
}

function updateSearchPanelActiveItem(index) {
    // Remove old active
    const old = $searchPanelList.querySelector('.search-result-item.active');
    if (old) old.classList.remove('active');

    // Set new active
    const items = $searchPanelList.querySelectorAll('.search-result-item');
    for (const item of items) {
        if (parseInt(item.dataset.index, 10) === index) {
            item.classList.add('active');
            // Scroll into view if needed
            const listRect = $searchPanelList.getBoundingClientRect();
            const itemRect = item.getBoundingClientRect();
            if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
                item.scrollIntoView({ block: 'nearest' });
            }
            break;
        }
    }
}

function hideSearchPanel() {
    $searchPanel.classList.add('hidden');
    $searchPanelList.innerHTML = '';
    $searchPanelList.onscroll = null;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ===== Search Timing =====
let searchTimingTimer = null;

function showSearchTiming(elapsedMs, resultCount) {
    if (searchTimingTimer) clearTimeout(searchTimingTimer);

    const timeStr = elapsedMs < 1000
        ? `${Math.round(elapsedMs)}ms`
        : `${(elapsedMs / 1000).toFixed(2)}s`;

    $searchToastText.textContent = `⚡ Found ${formatNumber(resultCount)} in ${timeStr}`;
    $searchToast.classList.remove('hidden');
    // Force reflow then add visible class for animation
    void $searchToast.offsetWidth;
    $searchToast.classList.add('visible');

    searchTimingTimer = setTimeout(() => {
        $searchToast.classList.remove('visible');
        setTimeout(() => $searchToast.classList.add('hidden'), 400);
    }, 2000);
}

// ===== Utilities =====
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatNumber(n) {
    return n.toLocaleString();
}

function setStatus(text) {
    $statusFile.textContent = text;
}

// ===== Theme =====
function initTheme() {
    const saved = localStorage.getItem('slopinator-theme');
    const theme = saved || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('slopinator-theme', next);
}

// ===== Init =====
function init() {
    initTheme();
    initWorker();
    initVirtualScroll();
    setupDragDrop();
    setupKeyboard();
    bindEvents();

    // Set initial case button state
    $btnCase.classList.toggle('active', caseSensitive);

    console.log('[Slopinator] Ready');
}

init();
