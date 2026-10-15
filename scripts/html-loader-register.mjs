/**
 * Registers `scripts/html-loader.mjs` as a Node module loader hook.
 *
 * Used via `--import ./scripts/html-loader-register.mjs` for `npm run dev` and
 * `npm test`; the production bundle does not need it, because esbuild inlines the page
 * with `--loader:.html=text`.
 */

import { register } from "node:module";

register("./html-loader.mjs", import.meta.url);
