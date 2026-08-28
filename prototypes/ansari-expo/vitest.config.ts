import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Unit tests cover the RN-free core of the adapter — the zod schemas, the
// validate/map pipeline (`decode.ts`), and the SSE parser. They deliberately do
// NOT import the React hooks, `http.ts`, or `streaming.ts`, which pull in
// Expo/React Native runtime modules that don't load under Node.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    // Default env is node; component tests opt into jsdom via a
    // `// @vitest-environment jsdom` header comment.
    environment: 'node',
    include: ['lib/**/*.test.{ts,tsx}'],
  },
});
