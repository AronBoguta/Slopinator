mod line_index;
mod search;
mod chunk_cache;

use wasm_bindgen::prelude::*;
use serde::Serialize;
use line_index::LineIndex;
use search::{Searcher, SearchConfig, SearchMatch};
use chunk_cache::ChunkCache;

/// The main log engine exposed to JavaScript via wasm-bindgen.
/// Holds the line index, search state, and chunk cache.
#[wasm_bindgen]
pub struct LogEngine {
    line_index: LineIndex,
    chunk_cache: ChunkCache,
    searcher: Option<Searcher>,
    file_size: u64,
    indexing_complete: bool,
    /// Bytes processed so far during indexing
    bytes_indexed: u64,
}

#[derive(Serialize)]
pub struct LineData {
    pub line_number: u64,
    pub content: String,
}

#[derive(Serialize)]
pub struct EngineStats {
    pub total_lines: u64,
    pub file_size: u64,
    pub index_memory_bytes: usize,
    pub cache_memory_bytes: usize,
    pub indexing_complete: bool,
    pub bytes_indexed: u64,
    pub search_result_count: usize,
    pub search_capped: bool,
}

#[derive(Serialize)]
pub struct SearchResultSlice {
    pub matches: Vec<SearchMatchJs>,
    pub total: usize,
    pub capped: bool,
}

#[derive(Serialize)]
pub struct SearchMatchJs {
    pub line: u64,
    pub col: u32,
    pub offset: u64,
    pub length: u32,
}

impl From<&SearchMatch> for SearchMatchJs {
    fn from(m: &SearchMatch) -> Self {
        Self {
            line: m.line,
            col: m.col,
            offset: m.offset,
            length: m.length,
        }
    }
}

#[wasm_bindgen]
impl LogEngine {
    /// Create a new LogEngine.
    /// `sparse_factor`: 1 for dense indexing (every line), >1 for sparse (every Nth line)
    /// `cache_chunks`: number of chunks to cache in memory
    /// `chunk_size`: chunk size in bytes (default: 4MB = 4194304)
    #[wasm_bindgen(constructor)]
    pub fn new(sparse_factor: u32, cache_chunks: usize, chunk_size: usize) -> Self {
        // Set up panic hook for better WASM error messages
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        Self {
            line_index: LineIndex::new(sparse_factor),
            chunk_cache: ChunkCache::new(cache_chunks, chunk_size),
            searcher: None,
            file_size: 0,
            indexing_complete: false,
            bytes_indexed: 0,
        }
    }

    /// Process a chunk of the file to build the line index.
    /// Called from JS as chunks are read from the File.
    /// `data`: the raw bytes of this chunk
    /// `offset`: the byte offset of this chunk in the file
    pub fn index_chunk(&mut self, data: &[u8], offset: f64) {
        let offset = offset as u64;
        self.line_index.build_from_chunk(data, offset);
        self.bytes_indexed = offset + data.len() as u64;
    }

    /// Mark indexing as complete with the total file size.
    pub fn finalize_index(&mut self, total_size: f64) {
        let total_size = total_size as u64;
        self.file_size = total_size;
        self.line_index.file_size = total_size;
        self.line_index.finalize(total_size);
        self.indexing_complete = true;
    }

    /// Get the total number of lines discovered so far.
    pub fn total_lines(&self) -> f64 {
        self.line_index.total_lines() as f64
    }

    /// Get the byte range needed to read a specific set of lines.
    /// Returns [start_byte, end_byte] as a JS value.
    /// Used by JS to know which File.slice() to request.
    pub fn get_byte_range_for_lines(&self, start_line: f64, count: f64) -> JsValue {
        let start_line = start_line as u64;
        let count = count as u64;

        let start_range = self.line_index.line_byte_range(start_line);
        let end_line = (start_line + count).min(self.line_index.total_lines().saturating_sub(1));
        let end_range = self.line_index.line_byte_range(end_line);

        match (start_range, end_range) {
            (Some((start, _)), Some((_, end))) => {
                let result = vec![start as f64, end as f64];
                serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
            }
            _ => JsValue::NULL,
        }
    }

    /// Parse lines from a chunk of raw data.
    /// Returns an array of {line_number, content} objects.
    /// `data`: the raw bytes
    /// `start_line`: the line number of the first line in this data
    /// `base_offset`: byte offset of this data in the file
    pub fn parse_lines(
        &mut self,
        data: &[u8],
        start_line: f64,
        _base_offset: f64,
    ) -> JsValue {
        let start_line = start_line as u64;

        // Cache this data
        let base = _base_offset as u64;
        self.chunk_cache.put(base, data.to_vec());

        let mut lines: Vec<LineData> = Vec::new();
        let mut current_line = start_line;
        let mut line_start = 0;

        for (i, &byte) in data.iter().enumerate() {
            if byte == b'\n' {
                let content = String::from_utf8_lossy(&data[line_start..i]).into_owned();
                lines.push(LineData {
                    line_number: current_line,
                    content,
                });
                current_line += 1;
                line_start = i + 1;
            }
        }

        // Handle last line (no trailing newline)
        if line_start < data.len() {
            let content = String::from_utf8_lossy(&data[line_start..]).into_owned();
            lines.push(LineData {
                line_number: current_line,
                content,
            });
        }

        serde_wasm_bindgen::to_value(&lines).unwrap_or(JsValue::NULL)
    }

    /// Start a new search. This clears any previous search results.
    pub fn start_search(&mut self, query: &str, case_sensitive: bool, max_results: f64) {
        let config = SearchConfig {
            case_sensitive,
            max_results: max_results as usize,
            regex: false,
        };
        self.searcher = Some(Searcher::new(query, config));
    }

    /// Search within a chunk of data AND count newlines in one pass.
    /// Returns the number of newlines in this chunk (so JS doesn't need to re-scan).
    /// `line_base`: the line number of the first line in this chunk
    pub fn search_chunk_counted(
        &mut self,
        data: &[u8],
        base_offset: f64,
        line_base: f64,
    ) -> f64 {
        let base_offset_u64 = base_offset as u64;
        let line_base_u64 = line_base as u64;

        // Count newlines and build line_starts in one pass (done in WASM, much faster than JS)
        let mut line_starts: Vec<usize> = Vec::with_capacity(data.len() / 60); // estimate ~60 chars/line
        line_starts.push(0);
        let mut newline_count: u64 = 0;
        for (i, &b) in data.iter().enumerate() {
            if b == b'\n' {
                newline_count += 1;
                if i + 1 < data.len() {
                    line_starts.push(i + 1);
                }
            }
        }

        if let Some(ref mut searcher) = self.searcher {
            searcher.search_chunk(
                data,
                base_offset_u64,
                line_base_u64,
                &line_starts,
            );
        }

        newline_count as f64
    }

    /// Get a page of search results.
    pub fn get_search_results(&self, start: f64, count: f64) -> JsValue {
        if let Some(ref searcher) = self.searcher {
            let matches = searcher
                .get_results(start as usize, count as usize)
                .iter()
                .map(SearchMatchJs::from)
                .collect::<Vec<_>>();
            let result = SearchResultSlice {
                matches,
                total: searcher.result_count(),
                capped: searcher.capped,
            };
            serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
        } else {
            JsValue::NULL
        }
    }

    /// Get the total search result count
    pub fn search_result_count(&self) -> f64 {
        self.searcher
            .as_ref()
            .map(|s| s.result_count() as f64)
            .unwrap_or(0.0)
    }

    /// Clear search results
    pub fn clear_search(&mut self) {
        self.searcher = None;
    }

    /// Get engine statistics as a JS object.
    pub fn get_stats(&self) -> JsValue {
        let stats = EngineStats {
            total_lines: self.line_index.total_lines(),
            file_size: self.file_size,
            index_memory_bytes: self.line_index.memory_usage_bytes(),
            cache_memory_bytes: self.chunk_cache.memory_usage_bytes(),
            indexing_complete: self.indexing_complete,
            bytes_indexed: self.bytes_indexed,
            search_result_count: self
                .searcher
                .as_ref()
                .map(|s| s.result_count())
                .unwrap_or(0),
            search_capped: self.searcher.as_ref().map(|s| s.capped).unwrap_or(false),
        };
        serde_wasm_bindgen::to_value(&stats).unwrap_or(JsValue::NULL)
    }

    /// Reset everything (for loading a new file)
    pub fn reset(&mut self) {
        self.line_index.clear();
        self.chunk_cache.clear();
        self.searcher = None;
        self.file_size = 0;
        self.indexing_complete = false;
        self.bytes_indexed = 0;
    }

    /// Get the configured chunk size
    pub fn chunk_size(&self) -> f64 {
        self.chunk_cache.chunk_size() as f64
    }
}
