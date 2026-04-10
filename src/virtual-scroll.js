/**
 * VirtualScroll — renders only the visible lines for massive log files.
 * Uses a spacer div for native scrollbar and absolutely-positioned line elements.
 */
export class VirtualScroll {
    /**
     * @param {object} options
     * @param {HTMLElement} options.scrollContainer
     * @param {HTMLElement} options.lineContainer
     * @param {HTMLElement} options.spacer
     * @param {HTMLElement} options.gutter
     * @param {number} options.lineHeight
     * @param {function(number, number): void} options.onViewportChange - (startLine, visibleCount)
     */
    constructor(options) {
        this.scrollContainer = options.scrollContainer;
        this.lineContainer = options.lineContainer;
        this.spacer = options.spacer;
        this.gutter = options.gutter;
        this.lineHeight = options.lineHeight || 20;
        this.onViewportChange = options.onViewportChange;

        this.totalLines = 0;
        this.visibleCount = 0;
        this.startLine = 0;
        this.overscan = 10; // Extra lines above/below viewport

        /** @type {Map<number, HTMLElement>} */
        this.lineElements = new Map();
        /** @type {Map<number, HTMLElement>} */
        this.gutterElements = new Map();

        /** @type {Array<{line_number: number, content: string}>} */
        this.lineData = [];

        /** @type {Set<number>} line numbers that have search matches */
        this.matchLines = new Set();
        /** @type {number} current match line */
        this.currentMatchLine = -1;

        // Search highlights data: Map<lineNumber, Array<{col, length, isCurrent}>>
        this.searchHighlights = new Map();

        this._boundOnScroll = this._onScroll.bind(this);
        this.scrollContainer.addEventListener('scroll', this._boundOnScroll, { passive: true });

        this._resizeObserver = new ResizeObserver(() => this._recalculate());
        this._resizeObserver.observe(this.scrollContainer);

        this._rafId = null;
        this._dirty = false;
    }

    /**
     * Set the total number of lines (updates the spacer height).
     */
    setTotalLines(total) {
        this.totalLines = total;
        this.spacer.style.height = (total * this.lineHeight) + 'px';
        this._recalculate();
    }

    /**
     * Update line data received from the worker.
     */
    setLineData(lines) {
        this.lineData = lines;
        this._render();
    }

    /**
     * Scroll to a specific line number (0-indexed).
     */
    scrollToLine(line) {
        const clampedLine = Math.max(0, Math.min(line, this.totalLines - 1));
        this.scrollContainer.scrollTop = clampedLine * this.lineHeight;
    }

    /**
     * Set search match lines for visual highlighting.
     */
    setSearchHighlights(highlights) {
        this.searchHighlights = highlights;
        this._render();
    }

    /**
     * Set current match line.
     */
    setCurrentMatchLine(line) {
        this.currentMatchLine = line;
        this._render();
    }

    /**
     * Clear all highlights.
     */
    clearHighlights() {
        this.searchHighlights.clear();
        this.matchLines.clear();
        this.currentMatchLine = -1;
        this._render();
    }

    /**
     * Handle scroll events with rAF debouncing.
     */
    _onScroll() {
        if (!this._dirty) {
            this._dirty = true;
            this._rafId = requestAnimationFrame(() => {
                this._dirty = false;
                this._recalculate();
            });
        }
    }

    /**
     * Recalculate which lines are visible and notify the host.
     */
    _recalculate() {
        const scrollTop = this.scrollContainer.scrollTop;
        const viewportHeight = this.scrollContainer.clientHeight;
        this.visibleCount = Math.ceil(viewportHeight / this.lineHeight);

        const newStart = Math.max(0, Math.floor(scrollTop / this.lineHeight) - this.overscan);
        const totalNeeded = this.visibleCount + this.overscan * 2;

        // Check if current data covers the visible viewport
        const dataCoversViewport = this.lineData.length > 0 &&
            this.lineData[0].line_number <= newStart &&
            this.lineData[this.lineData.length - 1].line_number >= newStart + this.visibleCount - 1;

        // Fire if start changed OR data doesn't cover the viewport (stale after fast scroll)
        if (newStart !== this.startLine || !dataCoversViewport) {
            this.startLine = newStart;
            if (this.onViewportChange) {
                this.onViewportChange(this.startLine, totalNeeded);
            }
        }
    }

    /**
     * Render the visible lines.
     */
    _render() {
        // Clear old elements
        this.lineContainer.innerHTML = '';
        this.gutter.innerHTML = '';
        this.lineElements.clear();
        this.gutterElements.clear();

        const scrollTop = this.scrollContainer.scrollTop;

        for (const line of this.lineData) {
            const lineNum = line.line_number;
            const y = lineNum * this.lineHeight;

            // Create line element
            const el = document.createElement('div');
            el.className = 'log-line';
            el.style.top = y + 'px';

            // Check for search highlights on this line
            const highlights = this.searchHighlights.get(lineNum);
            if (highlights && highlights.length > 0) {
                el.classList.add('highlight');
                if (lineNum === this.currentMatchLine) {
                    el.classList.add('current-match');
                }
                el.innerHTML = this._highlightContent(line.content, highlights, lineNum === this.currentMatchLine);
            } else {
                el.textContent = line.content;
                this._applyLogLevelColor(el, line.content);
            }

            this.lineContainer.appendChild(el);
            this.lineElements.set(lineNum, el);

            // Create gutter element
            const gutterEl = document.createElement('div');
            gutterEl.className = 'gutter-line';
            gutterEl.style.top = y + 'px';
            gutterEl.textContent = (lineNum + 1).toString(); // 1-indexed display
            this.gutter.appendChild(gutterEl);
            this.gutterElements.set(lineNum, gutterEl);
        }

        // Position the line container
        this.lineContainer.style.top = '0px';
    }

    /**
     * Highlight search matches within a line's text content.
     */
    _highlightContent(text, highlights, isCurrent) {
        // Sort highlights by column
        const sorted = [...highlights].sort((a, b) => a.col - b.col);
        let result = '';
        let lastIdx = 0;

        for (const h of sorted) {
            const col = h.col;
            const len = h.length;
            if (col > lastIdx) {
                result += this._escapeHtml(text.substring(lastIdx, col));
            }
            const cls = isCurrent && h.isCurrent ? 'match-highlight current' : 'match-highlight';
            result += `<span class="${cls}">${this._escapeHtml(text.substring(col, col + len))}</span>`;
            lastIdx = col + len;
        }

        if (lastIdx < text.length) {
            result += this._escapeHtml(text.substring(lastIdx));
        }

        return result;
    }

    /**
     * Log level keyword patterns and their badge classes.
     * Matches common levels and popular abbreviations.
     * Order matters — first match wins.
     */
    static LOG_LEVEL_PATTERNS = [
        // Error / Fatal
        { regex: /\b(FATAL|fatal)\b/, badge: 'badge-fatal' },
        { regex: /\b(CRIT|crit|CRITICAL|critical)\b/, badge: 'badge-fatal' },
        { regex: /\b(ERROR|error|ERR|err)\b/, badge: 'badge-error' },
        // Warning
        { regex: /\b(WARNING|warning|WARN|warn|WRN|wrn)\b/, badge: 'badge-warn' },
        // Info
        { regex: /\b(INFO|info|INF|inf|NOTICE|notice)\b/, badge: 'badge-info' },
        // Debug
        { regex: /\b(DEBUG|debug|DBG|dbg)\b/, badge: 'badge-debug' },
        // Trace
        { regex: /\b(TRACE|trace|TRC|trc|VERBOSE|verbose|VRB|vrb)\b/, badge: 'badge-trace' },
    ];

    /**
     * Apply log-level coloring by wrapping the matched keyword in a colored badge span.
     * Only searches within the first 120 chars for performance.
     */
    _applyLogLevelColor(el, content) {
        const prefix = content.substring(0, 120);

        for (const { regex, badge } of VirtualScroll.LOG_LEVEL_PATTERNS) {
            const match = prefix.match(regex);
            if (match) {
                const idx = match.index;
                const keyword = match[1];
                const before = this._escapeHtml(content.substring(0, idx));
                const after = this._escapeHtml(content.substring(idx + keyword.length));
                const badgeHtml = `<span class="log-level-badge ${badge}">${this._escapeHtml(keyword)}</span>`;
                el.innerHTML = before + badgeHtml + after;
                return;
            }
        }

        // No match — plain text
        el.textContent = content;
    }

    _escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Get the currently visible line range.
     */
    getVisibleRange() {
        return { start: this.startLine, count: this.visibleCount + this.overscan * 2 };
    }

    /**
     * Cleanup.
     */
    destroy() {
        this.scrollContainer.removeEventListener('scroll', this._boundOnScroll);
        this._resizeObserver.disconnect();
        if (this._rafId) cancelAnimationFrame(this._rafId);
    }
}
