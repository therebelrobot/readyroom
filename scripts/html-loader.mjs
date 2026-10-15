/**
 * Node module loader for `.html` imports, for the dev (`tsx watch`) and test runners.
 *
 * The production bundle inlines `public/index.html` at build time with esbuild's
 * `--loader:.html=text`, so the shipped artifact has no runtime file resolution. `tsx`
 * and the plain `node --test` runner do not know that loader mapping, so this hook
 * reproduces it for dev and tests: it reads the file and returns a module whose default
 * export is the file's text. Anything that is not `.html` is passed to the next loader
 * (tsx), so TypeScript handling is untouched.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".html")) {
    const text = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  }
  return nextLoad(url, context);
}
