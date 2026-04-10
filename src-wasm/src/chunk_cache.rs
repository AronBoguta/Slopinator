/// LRU cache for recently-read file chunks.
/// Each chunk is a Vec<u8> with a known byte offset range.
pub struct ChunkCache {
    entries: Vec<CacheEntry>,
    max_entries: usize,
    chunk_size: usize,
    access_counter: u64,
}

struct CacheEntry {
    start_offset: u64,
    data: Vec<u8>,
    last_access: u64,
}

impl ChunkCache {
    pub fn new(max_entries: usize, chunk_size: usize) -> Self {
        Self {
            entries: Vec::with_capacity(max_entries),
            max_entries,
            chunk_size,
            access_counter: 0,
        }
    }

    /// Get the configured chunk size
    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    /// Try to find cached data covering the given byte range.
    /// Returns the data slice if fully cached, None otherwise.
    pub fn get(&mut self, start: u64, end: u64) -> Option<Vec<u8>> {
        self.access_counter += 1;
        let ac = self.access_counter;

        // Find entry that contains this range
        for entry in self.entries.iter_mut() {
            let entry_end = entry.start_offset + entry.data.len() as u64;
            if entry.start_offset <= start && entry_end >= end {
                entry.last_access = ac;
                let local_start = (start - entry.start_offset) as usize;
                let local_end = (end - entry.start_offset) as usize;
                return Some(entry.data[local_start..local_end].to_vec());
            }
        }
        None
    }

    /// Insert a chunk into the cache, evicting the least-recently-used if full.
    pub fn put(&mut self, start_offset: u64, data: Vec<u8>) {
        self.access_counter += 1;

        // Check if this offset is already cached (update in place)
        for entry in self.entries.iter_mut() {
            if entry.start_offset == start_offset {
                entry.data = data;
                entry.last_access = self.access_counter;
                return;
            }
        }

        // Evict LRU if full
        if self.entries.len() >= self.max_entries {
            let mut min_access = u64::MAX;
            let mut min_idx = 0;
            for (i, entry) in self.entries.iter().enumerate() {
                if entry.last_access < min_access {
                    min_access = entry.last_access;
                    min_idx = i;
                }
            }
            self.entries.remove(min_idx);
        }

        self.entries.push(CacheEntry {
            start_offset,
            data,
            last_access: self.access_counter,
        });
    }

    /// Clear the entire cache
    pub fn clear(&mut self) {
        self.entries.clear();
        self.access_counter = 0;
    }

    /// Current memory usage in bytes (approximate)
    pub fn memory_usage_bytes(&self) -> usize {
        self.entries.iter().map(|e| e.data.len()).sum::<usize>()
            + std::mem::size_of::<Self>()
    }

    /// Compute which chunk offset a given byte offset falls into
    pub fn chunk_offset_for(&self, byte_offset: u64) -> u64 {
        (byte_offset / self.chunk_size as u64) * self.chunk_size as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_put_and_get() {
        let mut cache = ChunkCache::new(4, 1024);
        cache.put(0, vec![1, 2, 3, 4, 5]);
        let result = cache.get(0, 5);
        assert_eq!(result, Some(vec![1, 2, 3, 4, 5]));
    }

    #[test]
    fn test_partial_get() {
        let mut cache = ChunkCache::new(4, 1024);
        cache.put(0, vec![10, 20, 30, 40, 50]);
        let result = cache.get(2, 4);
        assert_eq!(result, Some(vec![30, 40]));
    }

    #[test]
    fn test_lru_eviction() {
        let mut cache = ChunkCache::new(2, 1024);
        cache.put(0, vec![1]);
        cache.put(1024, vec![2]);
        // Access first entry to make it recently used
        let _ = cache.get(0, 1);
        // Insert third → should evict entry at 1024
        cache.put(2048, vec![3]);
        assert!(cache.get(1024, 1025).is_none());
        assert!(cache.get(0, 1).is_some());
        assert!(cache.get(2048, 2049).is_some());
    }
}
