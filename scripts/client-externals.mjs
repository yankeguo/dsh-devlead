/**
 * Browser platform-singleton modules shared by the DSH web shell through the
 * frozen module table.
 *
 * This list must stay identical, in order, to `PLATFORM_MODULES` in
 * `packages/client/web/src/platform.ts` of DeepSeek Harness (and to the keys of
 * `getStaticModules()` in `packages/client/web/src/seed.ts`). It was verified
 * word for word against DSH 0.2.2-rc.1. A drift makes the client-module loader
 * throw "require(...) missed the module table" at runtime: the build externalizes
 * exactly this set for browser bundles (`scripts/build.mjs`), and the package
 * checker rejects browser imports outside it (`scripts/check-packages.mjs`).
 */
export const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]
