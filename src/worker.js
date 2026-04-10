/**
 * Slopinator Web Worker
 * Runs the WASM LogEngine off the main thread.
 * Handles file indexing, line fetching, and searching.
 */

import init, { LogEngine } from './wasm-pkg/slopinator_wasm.js';

/** @type {LogEngine|null} */
let engine = null;
/** @type {File|null} */
let file = null;

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB for indexing/line fetching
const SEARCH_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB for search (fewer round-trips)
const INDEX_CHUNK_SIZE = 4 * 1024 * 1024;

// ===== Search Result Cache =====
const SEARCH_CACHE_MAX = 16;
/** @type {Map<string, {totalResults: number, results: any}>} */
const searchCache = new Map();

function searchCacheKey(query, caseSensitive) {
    return `${caseSensitive ? '1' : '0'}:${query}`;
}

function searchCacheGet(query, caseSensitive) {
    return searchCache.get(searchCacheKey(query, caseSensitive)) || null;
}

function searchCachePut(query, caseSensitive, data) {
    const key = searchCacheKey(query, caseSensitive);
    // Evict oldest if full
    if (searchCache.size >= SEARCH_CACHE_MAX && !searchCache.has(key)) {
        const firstKey = searchCache.keys().next().value;
        searchCache.delete(firstKey);
    }
    searchCache.set(key, data);
}

function searchCacheClear() {
    searchCache.clear();
}

/**
 * Initialize the WASM module.
 */
async function initWasm() {
    await init();
    postMessage({ type: 'wasm-ready' });
}

/**
 * Handle messages from the main thread.
 */
self.onmessage = async (e) => {
    const { type, id } = e.data;

    try {
        switch (type) {
            case 'open':
                await handleOpen(e.data, id);
                break;
            case 'getLines':
                await handleGetLines(e.data, id);
                break;
            case 'search':
                await handleSearch(e.data, id);
                break;
            case 'getSearchResults':
                handleGetSearchResults(e.data, id);
                break;
            case 'clearSearch':
                if (engine) engine.clear_search();
                respond(id, { ok: true });
                break;
            case 'getStats':
                handleGetStats(id);
                break;
            default:
                respond(id, { error: `Unknown message type: ${type}` });
        }
    } catch (err) {
        respond(id, { error: err.message || String(err) });
    }
};

/**
 * Open a file and build the line index.
 */
async function handleOpen(data, id) {
    file = data.file;
    const sparseFactor = data.sparseFactor || 1;
    const cacheChunks = data.cacheChunks || 8;

    // Clear search cache on new file
    searchCacheClear();

    // Create new engine
    engine = new LogEngine(sparseFactor, cacheChunks, CHUNK_SIZE);

    const totalSize = file.size;
    let offset = 0;

    // Progress reporting
    const reportInterval = Math.max(1, Math.floor(totalSize / INDEX_CHUNK_SIZE / 20));
    let chunkCount = 0;

    while (offset < totalSize) {
        const end = Math.min(offset + INDEX_CHUNK_SIZE, totalSize);
        const slice = file.slice(offset, end);
        const buffer = await slice.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        engine.index_chunk(bytes, offset);

        offset = end;
        chunkCount++;

        // Report progress periodically
        if (chunkCount % reportInterval === 0 || offset >= totalSize) {
            postMessage({
                type: 'index-progress',
                bytesIndexed: offset,
                totalSize,
                totalLines: engine.total_lines(),
            });
        }
    }

    engine.finalize_index(totalSize);

    const stats = engine.get_stats();
    respond(id, {
        ok: true,
        totalLines: engine.total_lines(),
        fileSize: totalSize,
        stats,
    });

    postMessage({ type: 'index-complete', totalLines: engine.total_lines(), stats });
}

/**
 * Get line content for display.
 */
async function handleGetLines(data, id) {
    if (!engine || !file) {
        respond(id, { error: 'No file loaded' });
        return;
    }

    const { startLine, count } = data;

    // Get byte range from the engine
    const range = engine.get_byte_range_for_lines(startLine, count);
    if (!range) {
        respond(id, { lines: [] });
        return;
    }

    const [startByte, endByte] = range;

    // Read from file
    const slice = file.slice(startByte, endByte);
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Parse lines via WASM
    const lines = engine.parse_lines(bytes, startLine, startByte);

    respond(id, { lines: lines || [] });
}

/**
 * Perform a full-file search.
 * Uses 16MB chunks and WASM-side newline counting for maximum speed.
 * Results are cached by query + caseSensitivity.
 */
async function handleSearch(data, id) {
    if (!engine || !file) {
        respond(id, { error: 'No file loaded' });
        return;
    }

    const { query, caseSensitive, maxResults } = data;

    // Check cache first — instant return for repeated queries
    const cached = searchCacheGet(query, caseSensitive);
    if (cached) {
        respond(id, {
            ok: true,
            totalResults: cached.totalResults,
            results: cached.results,
            fromCache: true,
        });
        postMessage({ type: 'search-complete', totalResults: cached.totalResults });
        return;
    }

    engine.start_search(query, caseSensitive ?? true, maxResults ?? 100000);

    const totalSize = file.size;
    let offset = 0;
    let lineBase = 0;

    // Use large chunks to minimize File.slice() + arrayBuffer() overhead
    const chunkSize = SEARCH_CHUNK_SIZE;

    // Report progress every ~5% to reduce postMessage overhead
    const progressStep = Math.max(chunkSize, Math.floor(totalSize / 20));
    let nextProgressAt = progressStep;

    while (offset < totalSize) {
        const end = Math.min(offset + chunkSize, totalSize);
        const slice = file.slice(offset, end);
        const buffer = await slice.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // WASM does search + newline counting in one pass — no JS byte loop needed
        const newlineCount = engine.search_chunk_counted(bytes, offset, lineBase);
        lineBase += newlineCount;

        offset = end;

        // Report search progress (throttled)
        if (offset >= nextProgressAt || offset >= totalSize) {
            nextProgressAt = offset + progressStep;
            postMessage({
                type: 'search-progress',
                bytesSearched: offset,
                totalSize,
                resultCount: engine.search_result_count(),
            });
        }
    }

    const results = engine.get_search_results(0, 100);
    const totalResults = engine.search_result_count();

    // Cache the results
    searchCachePut(query, caseSensitive, { totalResults, results });

    respond(id, {
        ok: true,
        totalResults,
        results,
    });

    postMessage({ type: 'search-complete', totalResults });
}

/**
 * Get a page of search results.
 */
function handleGetSearchResults(data, id) {
    if (!engine) {
        respond(id, { results: null });
        return;
    }
    const { start, count } = data;
    const results = engine.get_search_results(start, count);
    respond(id, { results });
}

/**
 * Get stats.
 */
function handleGetStats(id) {
    if (!engine) {
        respond(id, { stats: null });
        return;
    }
    respond(id, { stats: engine.get_stats() });
}

/**
 * Send a response back to the main thread with the request id.
 */
function respond(id, data) {
    postMessage({ type: 'response', id, ...data });
}

// Boot WASM
initWasm().catch((err) => {
    postMessage({ type: 'error', error: `WASM init failed: ${err.message}` });
});
