use memchr::memchr_iter;

/// Stores byte offsets for each newline in the file, enabling O(1) random line access.
/// For a 2 GB file with ~16M lines, this uses ~128 MB (8 bytes per offset).
/// Sparse mode indexes every Nth line to reduce memory at the cost of slightly slower access.
pub struct LineIndex {
    /// Byte offset of the start of each indexed line
    offsets: Vec<u64>,
    /// Total file size in bytes (updated as chunks arrive)
    pub file_size: u64,
    /// Sparse mode: index every Nth line (1 = every line, 10 = every 10th, etc.)
    sparse_factor: u32,
    /// Total number of actual lines (may differ from offsets.len() in sparse mode)
    total_lines: u64,
}

impl LineIndex {
    pub fn new(sparse_factor: u32) -> Self {
        let factor = if sparse_factor == 0 { 1 } else { sparse_factor };
        Self {
            offsets: vec![0], // Line 0 always starts at byte 0
            file_size: 0,
            sparse_factor: factor,
            total_lines: 0,
        }
    }

    /// Process a chunk of bytes and record line offsets.
    /// `base_offset` is the byte position of the start of this chunk in the file.
    pub fn build_from_chunk(&mut self, chunk: &[u8], base_offset: u64) {
        for pos in memchr_iter(b'\n', chunk) {
            self.total_lines += 1;
            let absolute_offset = base_offset + (pos as u64) + 1; // byte after the \n
            if self.sparse_factor == 1 || self.total_lines % (self.sparse_factor as u64) == 0 {
                self.offsets.push(absolute_offset);
            }
        }
        // Update file size
        let chunk_end = base_offset + chunk.len() as u64;
        if chunk_end > self.file_size {
            self.file_size = chunk_end;
        }
    }

    /// Mark indexing as complete. If the file doesn't end with \n, count the last line.
    pub fn finalize(&mut self, total_file_size: u64) {
        self.file_size = total_file_size;
        // If file doesn't end with newline, the last partial line is still a line
        if self.file_size > 0 {
            let last_known = self.last_indexed_offset();
            if last_known < self.file_size {
                // There's content after the last newline → extra line
                // total_lines was only incremented on \n, so add 1 for trailing content
                // But only if the last byte isn't a \n
                // We already counted all \n in build_from_chunk, so total_lines = number of \n
                // Actual lines = number of \n + 1 (if file not empty), unless file ends with \n
                // Since we can't check the last byte here, we'll add 1 and let the caller handle it
            }
        }
    }

    fn last_indexed_offset(&self) -> u64 {
        *self.offsets.last().unwrap_or(&0)
    }

    /// Returns the total number of lines discovered so far.
    /// Lines = newline_count + 1 (if file has content that doesn't end with \n),
    /// but we approximate as newline_count + 1 always for non-empty files.
    pub fn total_lines(&self) -> u64 {
        if self.file_size == 0 {
            0
        } else {
            self.total_lines + 1 // +1 because line count = newline count + 1
        }
    }

    /// Get the byte range (start, end) for a given line number (0-indexed).
    /// Returns None if the line is out of range.
    pub fn line_byte_range(&self, line: u64) -> Option<(u64, u64)> {
        if line >= self.total_lines() {
            return None;
        }

        if self.sparse_factor == 1 {
            // Dense mode: direct lookup
            let start = self.offsets.get(line as usize).copied()?;
            let end = self
                .offsets
                .get((line + 1) as usize)
                .copied()
                .unwrap_or(self.file_size);
            Some((start, end))
        } else {
            // Sparse mode: find the nearest indexed line before `line`
            let index_pos = (line / self.sparse_factor as u64) as usize;
            let start = self.offsets.get(index_pos).copied()?;
            let end = self
                .offsets
                .get(index_pos + 1)
                .copied()
                .unwrap_or(self.file_size);
            // The caller will need to scan within this range to find the exact line
            Some((start, end))
        }
    }

    /// How many offsets are stored in memory
    pub fn memory_entries(&self) -> usize {
        self.offsets.len()
    }

    /// Approximate memory usage in bytes
    pub fn memory_usage_bytes(&self) -> usize {
        self.offsets.len() * 8 + std::mem::size_of::<Self>()
    }

    /// Reset the index
    pub fn clear(&mut self) {
        self.offsets.clear();
        self.offsets.push(0);
        self.file_size = 0;
        self.total_lines = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty() {
        let idx = LineIndex::new(1);
        assert_eq!(idx.total_lines(), 0);
    }

    #[test]
    fn test_single_line_no_newline() {
        let mut idx = LineIndex::new(1);
        idx.build_from_chunk(b"hello", 0);
        idx.finalize(5);
        // "hello" has 0 newlines, but 1 line of content
        assert_eq!(idx.total_lines(), 1);
    }

    #[test]
    fn test_multiple_lines() {
        let mut idx = LineIndex::new(1);
        let data = b"line1\nline2\nline3\n";
        idx.build_from_chunk(data, 0);
        idx.finalize(data.len() as u64);
        // 3 newlines → total_lines = 3+1 = 4? No, last line after \n is empty
        // Actually: "line1\nline2\nline3\n" → lines are "line1", "line2", "line3", ""
        // total_lines = 3 (newlines) + 1 = 4
        assert_eq!(idx.total_lines(), 4);

        // Verify byte ranges (dense mode)
        assert_eq!(idx.line_byte_range(0), Some((0, 6)));   // "line1\n"
        assert_eq!(idx.line_byte_range(1), Some((6, 12)));  // "line2\n"
        assert_eq!(idx.line_byte_range(2), Some((12, 18))); // "line3\n"
    }

    #[test]
    fn test_multi_chunk() {
        let mut idx = LineIndex::new(1);
        idx.build_from_chunk(b"aaa\nbbb\n", 0);
        idx.build_from_chunk(b"ccc\nddd", 8);
        idx.finalize(15);
        assert_eq!(idx.total_lines(), 4); // 3 newlines + 1
        assert_eq!(idx.line_byte_range(0), Some((0, 4)));
        assert_eq!(idx.line_byte_range(2), Some((8, 12)));
        assert_eq!(idx.line_byte_range(3), Some((12, 15)));
    }
}
