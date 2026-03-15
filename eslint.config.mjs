import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: [
      "umd.js",
      "node_modules/",
      "dist/",
      "build/",
      "pdfspliter/**/vendor/**",
      "pdfspliter/**/api/**",
      "pdfspliter/**/*.min.js",
      "vetoriza/target/",
      "vetoriza/pkg/"
    ]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.browser }
  },
  {
    files: ["pdfspliter/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        pdfjsLib: "readonly",
        PDFLib: "readonly",
        proj4: "readonly",
        shp: "readonly",
        PizZip: "readonly",
        saveAs: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "off",
      "no-useless-escape": "off",
      "no-empty": "off"
    }
  },
  {
    files: ["api/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-redeclare": "off"
    }
  }
]);