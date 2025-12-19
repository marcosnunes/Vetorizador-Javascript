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
]);
