import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Unit tests cover the RN-free core of the adapter — the zod schemas, the
// validate/map pipeline (`decode.ts`), and the SSE parser. They deliberately do
// NOT import the React hooks, `http.ts`, or `streaming.ts`, which pull in
// Expo/React Native runtime modules that don't load under Node.
//
// Component tests under `components/` render through react-native-web (already
// a dependency — it's what the staging web export runs on), so `react-native`
// is aliased to it here; Expo-native modules (haptics, reanimated) are mocked
// per test file, as in `lib/auth/context.test.tsx`.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      'react-native': 'react-native-web',
    },
  },
  test: {
    // Default env is node; component tests opt into jsdom via a
    // `// @vitest-environment jsdom` header comment.
    environment: 'node',
    include: ['lib/**/*.test.{ts,tsx}', 'components/**/*.test.{ts,tsx}'],
  },
});
