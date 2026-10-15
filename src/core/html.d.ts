/**
 * The heads-up page is a single `public/index.html` shared by all three targets and
 * inlined at build time (`--loader:.html=text` on the Node/Worker bundles). This
 * declaration lets TypeScript treat those imports as strings.
 */
declare module "*.html" {
  const content: string;
  export default content;
}
