import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
    base: './',
    plugins: [
        wasm(),
        topLevelAwait(),
    ],
    build: {
        target: 'esnext',
        outDir: 'dist',
    },
    worker: {
        format: 'es',
        plugins: () => [
            wasm(),
            topLevelAwait(),
        ],
    },
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    optimizeDeps: {
        exclude: ['slopinator-wasm'],
    },
});
