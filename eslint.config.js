const js = require("@eslint/js");
const prettierConfig = require("eslint-config-prettier");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        Promise: "readonly",
        describe: "readonly",
        it: "readonly",
        before: "readonly",
        after: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  // More lenient rules for test files
  {
    files: ["test/**/*.js"],
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: ".*",
          varsIgnorePattern: "^_|^promise|^stream",
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      ".nyc_output/**",
      "dist/**",
      "*.min.js",
    ],
  },
  // Prettier integration - must be last to override formatting rules
  prettierConfig,
];
