import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  {
    // Build output and vendored files aren't lint targets.
    ignores: ["dist/**", "src/types/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.node },
  },
  {
    // typescript-eslint rules apply only to TS files. Applying them globally
    // would swap base no-unused-vars for the TS version even in browser .js
    // files, breaking existing suppression comments via the rule-name mismatch.
    files: ["**/*.{ts,mts,cts}"],
    extends: [tseslint.configs.recommended],
  },
  // Must stay last. Turns off formatting rules prettier owns, so the two
  // don't fight each other. This was a real conflict: eslint's
  // no-unexpected-multiline was flagging line breaks prettier inserted.
  prettier,
]);
