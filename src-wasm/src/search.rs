use memchr::memmem;
use serde::Serialize;

/// A single search match with its location in the file.
#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    /// 0-indexed line number
    pub line: u64,
    /// 0-indexed column (byte offset within the line)
    pub col: u32,
    /// Absolute byte offset in the file
    pub offset: u64,
    /// Length of the match in bytes
    pub length: u32,
}

/// Configuration for a search operation.
#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub case_sensitive: bool,
    pub max_results: usize,
    pub regex: bool,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            case_sensitive: true,
            max_results: 100_000,
            regex: false,
        }
    }
}

/// Chunk-based text searcher. Accumulates results across multiple chunk calls.
pub struct Searcher {
    /// The search pattern (original, as-given)
    pattern: Vec<u8>,
    /// Lowercased pattern for case-insensitive search
    pattern_lower: Vec<u8>,
    pub config: SearchConfig,
    pub results: Vec<SearchMatch>,
    /// Whether we've hit the max results cap
    pub capped: bool,
}

impl Searcher {
    pub fn new(query: &str, config: SearchConfig) -> Self {
        let pattern = query.as_bytes().to_vec();
        let pattern_lower = if config.case_sensitive {
            pattern.clone()
        } else {
            query.to_lowercase().as_bytes().to_vec()
        };
        Self {
            pattern,
            pattern_lower,
            config,
            results: Vec::new(),
            capped: false,
        }
    }

    /// Search within a chunk of data.
    /// `base_offset` is the byte position of this chunk in the file.
    /// `line_base` is the line number at the start of this chunk.
    /// `line_offsets` are the byte offsets of newlines within this chunk (relative to chunk start).
    pub fn search_chunk(
        &mut self,
        chunk: &[u8],
        base_offset: u64,
        line_base: u64,
        line_starts: &[usize], // positions within chunk where each line starts
    ) {
        if self.capped || self.pattern.is_empty() {
            return;
        }

        let haystack: Vec<u8>;
        let search_data = if self.config.case_sensitive {
            chunk
        } else {
            // For case-insensitive, lowercase the chunk
            haystack = chunk
                .iter()
                .map(|&b| {
                    if b.is_ascii_uppercase() {
                        b + 32
                    } else {
                        b
                    }
                })
                .collect();
            &haystack
        };

        let needle = if self.config.case_sensitive {
            &self.pattern
        } else {
            &self.pattern_lower
        };

        let finder = memmem::Finder::new(needle);

        for pos in finder.find_iter(search_data) {
            if self.results.len() >= self.config.max_results {
                self.capped = true;
                return;
            }

            // Determine which line this match is on
            let (line_num, line_start_in_chunk) =
                Self::find_line(pos, line_starts, line_base);

            self.results.push(SearchMatch {
                line: line_num,
                col: (pos - line_start_in_chunk) as u32,
                offset: base_offset + pos as u64,
                length: needle.len() as u32,
            });
        }
    }

    /// Find which line a byte position belongs to using the line_starts array.
    fn find_line(pos: usize, line_starts: &[usize], line_base: u64) -> (u64, usize) {
        // Binary search for the largest line_start <= pos
        let idx = match line_starts.binary_search(&pos) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        };
        (line_base + idx as u64, line_starts[idx])
    }

    /// Total number of results found so far
    pub fn result_count(&self) -> usize {
        self.results.len()
    }

    /// Clear all results (for a new search)
    pub fn clear(&mut self) {
        self.results.clear();
        self.capped = false;
    }

    /// Get a slice of results for pagination
    pub fn get_results(&self, start: usize, count: usize) -> &[SearchMatch] {
        let end = (start + count).min(self.results.len());
        if start >= self.results.len() {
            return &[];
        }
        &self.results[start..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_search() {
        let mut searcher = Searcher::new("error", SearchConfig::default());
        let chunk = b"INFO starting up\nERROR something failed\nINFO ok\nERROR again\n";
        // Line starts at positions: 0, 17, 40, 48
        let line_starts = vec![0, 17, 40, 48];
        searcher.search_chunk(chunk, 0, 0, &line_starts);

        // Case-sensitive: "error" won't match "ERROR"
        assert_eq!(searcher.result_count(), 0);
    }

    #[test]
    fn test_case_insensitive_search() {
        let config = SearchConfig {
            case_sensitive: false,
            ..Default::default()
        };
        let mut searcher = Searcher::new("error", config);
        let chunk = b"INFO starting up\nERROR something failed\nINFO ok\nERROR again\n";
        let line_starts = vec![0, 17, 40, 48];
        searcher.search_chunk(chunk, 0, 0, &line_starts);

        assert_eq!(searcher.result_count(), 2);
        assert_eq!(searcher.results[0].line, 1);
        assert_eq!(searcher.results[0].col, 0);
        assert_eq!(searcher.results[1].line, 3);
    }

    #[test]
    fn test_max_results_cap() {
        let config = SearchConfig {
            case_sensitive: true,
            max_results: 2,
            regex: false,
        };
        let mut searcher = Searcher::new("a", config);
        let chunk = b"aaa\naaa\naaa\n";
        let line_starts = vec![0, 4, 8];
        searcher.search_chunk(chunk, 0, 0, &line_starts);

        assert_eq!(searcher.result_count(), 2);
        assert!(searcher.capped);
    }
}
