import { defineConfig } from 'vitest/config';

if (!process.env.FIRESTORE_EMULATOR_HOST?.startsWith('127.0.0.1:')) {
  throw new Error(
    'Firestore tests require a loopback emulator; production is never a test target.',
  );
}
export default defineConfig({
  test: {
    include: ['tests/firestore/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
