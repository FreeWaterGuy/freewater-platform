// ESLint: only rules that catch real bugs or security holes, no style rules. `npm run lint` runs it; CI runs it on
// every change together with Semgrep (.semgrep/rules.yml). A finding that is a false positive is suppressed on its
// line with a one-line reason (`// eslint-disable-next-line <rule> -- why`), never by turning the rule off.
import globals from 'globals';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import nounsanitized from 'eslint-plugin-no-unsanitized';

// Correctness rules that hold for both the TypeScript and the browser scripts.
const bugRules = {
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-fallthrough': 'error',
  'no-unreachable': 'error',
  'no-self-compare': 'error',
  'no-unsafe-finally': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-compare-neg-zero': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-sparse-arrays': 'error',
  'no-async-promise-executor': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
};

// eslint-plugin-security: the rules that point at real holes. detect-object-injection is left off: it flags every
// obj[key] (thousands of hits, almost all safe) and would drown the real findings.
const securityRules = {
  'security/detect-eval-with-expression': 'error',
  'security/detect-child-process': 'error',
  'security/detect-non-literal-require': 'error',
  'security/detect-non-literal-regexp': 'error',
  'security/detect-unsafe-regex': 'error',
  'security/detect-pseudoRandomBytes': 'error',
  'security/detect-buffer-noassert': 'error',
  'security/detect-new-buffer': 'error',
  'security/detect-disable-mustache-escape': 'error',
  'security/detect-no-csrf-before-method-override': 'error',
  'security/detect-bidi-characters': 'error',
  'security/detect-possible-timing-attacks': 'error',
  'security/detect-non-literal-fs-filename': 'error',
  'security/detect-object-injection': 'off',
};

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'src/web/vendor/**', '**/*.min.js'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [tseslint.configs.base],
    plugins: { security },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...bugRules,
      ...securityRules,
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      // Type-aware: a promise nobody waits for loses its error and its ordering (money code especially).
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': 'error', // includes async callbacks where nothing waits (timers, forEach, createServer)
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
    },
  },
  {
    // Tests build paths, spawn helpers, load optional tools and run published snippets on purpose; their inputs are ours.
    files: ['test/**/*.ts'],
    rules: {
      'security/detect-non-literal-require': 'off',
      'security/detect-unsafe-regex': 'off',
      'no-new-func': 'off',
      '@typescript-eslint/no-implied-eval': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-child-process': 'off',
      'security/detect-non-literal-regexp': 'off',
      'security/detect-possible-timing-attacks': 'off',
    },
  },
  {
    // The browser pages: plain scripts, no build step. Nothing from the server may reach the page as HTML.
    files: ['src/web/**/*.js'],
    plugins: { security, 'no-unsanitized': nounsanitized },
    languageOptions: { sourceType: 'script', ecmaVersion: 2022, globals: { ...globals.browser } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...bugRules,
      ...securityRules,
      'security/detect-non-literal-fs-filename': 'off', // no fs in a browser
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },
);
