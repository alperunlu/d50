/**
 * Deliberately plain ts-jest, NOT jest-expo.
 *
 * The modules that matter most for safety (allowlist, ELM327 framing, PID
 * decoders, CSV) are pure TypeScript with no React Native imports. Keeping the
 * test runner independent of the RN/Expo toolchain means these tests can never
 * be broken by a native-side upgrade — they must always be runnable.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
