import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Marked } from 'marked';

const root = resolve(import.meta.dirname, '../..');
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
const pages = readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => ({ source: `docs/${name}`, slug: name === 'index.md' ? 'overview' : name.slice(0,-3) }));
pages.push({ source: 'formats/SCI.md', slug: 'sci' }, { source: 'CONTRIBUTING.md', slug: 'contributing' }, { source: 'website/ASSETS.md', slug: 'media' });
const order = ['introduction','encoding','integration','architecture','sci','research','benchmarking','website','contributing','media','overview'];
for (const page of pages) {
  if (!/^[a-z0-9-]+$/.test(page.slug)) throw new Error(`Unsupported documentation filename: ${page.source}`);
  const tokens = new Marked().lexer(readFileSync(join(root, page.source), 'utf8'));
  const title = tokens.find(token => token.type === 'heading' && token.depth === 1);
  if (!title) throw new Error(`Documentation needs a title: ${page.source}`);
  page.title = title.text;
  page.url = page.slug === 'introduction' ? '/docs/' : `/docs/${page.slug}/`;
}
pages.sort((a,b) => (order.includes(a.slug) ? order.indexOf(a.slug) : order.length) - (order.includes(b.slug) ? order.indexOf(b.slug) : order.length) || a.title.localeCompare(b.title));
const urls = new Map(pages.map(page => [resolve(root,page.source),page.url]));

function docLink(href, source) {
  if (/^(https?:|mailto:)/i.test(href) || href.startsWith('#')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) throw new Error(`Unsupported documentation link: ${href}`);
  const target = new URL(href, `https://repo.invalid/${source}`);
  const path = resolve(root, '.' + decodeURIComponent(target.pathname));
  if (!path.startsWith(root + sep) || !existsSync(path)) throw new Error(`Broken documentation link in ${source}: ${href}`);
  return (urls.get(path) ?? `https://github.com/ecnivslabs/weft/blob/master/${relative(root,path).split(sep).map(encodeURIComponent).join('/')}`) + target.search + target.hash;
}

export function buildDocs(destination, assets) {
  const nav = current => pages.map(page => `<a href="${page.url}"${current.slug === page.slug ? ' aria-current="page"' : ''}>${escape(page.title)}</a>`).join('\n');
  for (const page of pages) {
    const headings = [], counts = new Map();
    const renderer = new Marked({
      gfm: true,
      walkTokens(token) { if (token.type === 'link' || token.type === 'image') token.href = docLink(token.href,page.source); },
      renderer: {
        html({ text }) { return escape(text); },
        heading({ tokens, depth, text }) {
          const base = text.toLowerCase().replace(/[`*_]/g,'').replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'') || 'section';
          const count = counts.get(base) ?? 0; counts.set(base,count+1);
          const id = count ? `${base}-${count}` : base;
          if (depth === 2) headings.push({ id, text });
          return `<h${depth} id="${escape(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
        },
      },
    });
    const content = renderer.parse(readFileSync(join(root,page.source),'utf8'));
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)} | Weft documentation</title>
<meta name="description" content="Weft documentation: ${escape(page.title)}.">
<meta name="theme-color" content="#0f0d0e"><link rel="canonical" href="https://weft.ecnivs.com${page.url}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets['base.css']}"><link rel="stylesheet" href="${assets['site.css']}"><link rel="stylesheet" href="${assets['docs.css']}">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header page-width"><a class="wordmark" href="/" aria-label="Weft home"><span class="brand-pixels" aria-hidden="true"></span>Weft</a><nav aria-label="Main navigation"><a href="/docs/" aria-current="page">Docs</a><a class="badge" href="https://github.com/ecnivslabs/weft">GitHub ↗</a></nav></header>
<div class="docs-layout page-width">
<aside class="docs-sidebar"><nav aria-label="Documentation">${nav(page)}</nav></aside>
<main id="main" class="doc-content">
<details class="docs-menu"><summary>Documentation menu</summary><nav aria-label="Documentation">${nav(page)}</nav></details>
<p class="doc-location"><a href="/docs/">Documentation</a> / ${escape(page.title)}</p>
<article>${content}</article>
<div class="doc-source"><a href="https://github.com/ecnivslabs/weft/blob/master/${page.source}">View source on GitHub</a><a href="/">Back to Weft</a></div>
</main>
<aside class="docs-outline"><nav aria-label="On this page"><p>On this page</p>${headings.map(heading => `<a href="#${escape(heading.id)}">${escape(heading.text)}</a>`).join('\n')}</nav></aside>
</div>
<footer class="site-footer page-width"><div class="footer-top"><p>A product of <a href="https://ecnivs.com">ecnivs</a>.</p><nav aria-label="Footer navigation"><a href="/docs/media/">Asset notices</a><a href="https://github.com/ecnivslabs/weft/blob/master/LICENSE">Software license</a></nav></div></footer>
</body>
</html>`;
    const file = join(destination,page.url,'index.html');
    mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,html);
    if (page.slug === 'introduction') { mkdirSync(join(destination,'docs/introduction'),{recursive:true}); writeFileSync(join(destination,'docs/introduction/index.html'),html); }
  }
  return pages.length;
}
