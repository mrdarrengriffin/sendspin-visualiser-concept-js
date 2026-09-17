// @ts-check
import { defineConfig } from 'astro/config';

// Deployed to GitHub Pages under a sub-path. Note that github.io enforces https://, so the player
// page there cannot open Music Assistant's ws:// endpoint (browsers block mixed content); the lab
// and the docs work anywhere. To connect, serve the build over plain http:// (see README).
const BASE = '/sendspin-visualiser-concept-js';

/** Rehype plugin: prefix BASE onto root-absolute hrefs in markdown so docs links survive the sub-path. */
function rehypeBaseLinks() {
  const visit = (node) => {
    if (node.type === 'element' && node.tagName === 'a') {
      const href = node.properties?.href;
      if (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')) node.properties.href = BASE + href;
    }
    for (const child of node.children ?? []) visit(child);
  };
  return (tree) => visit(tree);
}

export default defineConfig({
  site: 'https://mrdarrengriffin.github.io',
  base: BASE,
  output: 'static',
  trailingSlash: 'ignore',
  markdown: { rehypePlugins: [rehypeBaseLinks] },
});
