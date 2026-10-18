import { defineConfig } from 'vitest/config';

// Some test files build a few hundred bottles before they start; give setup room to finish.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } });
