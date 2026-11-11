#!/usr/bin/env node
// Turn the demo build (apps/web/dist-demo) into ONE shareable HTML file: CSS + JS inlined, the two
// sample clips embedded as base64. Output: demo/motion-studio-demo.html (a page fragment: title,
// style, root, scripts — the format an Artifact page expects; browsers open it fine as well).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/web/dist-demo');
const html = await fsp.readFile(path.join(dist, 'demo.html'), 'utf8');
const jsRel = /<script type="module" crossorigin src="\/([^"]+)"><\/script>/.exec(html)?.[1];
const cssRel = /<link rel="stylesheet" crossorigin href="\/([^"]+)">/.exec(html)?.[1];
if (!jsRel || !cssRel) throw new Error('Unexpected demo build output (script/style tag not found)');
const js = (await fsp.readFile(path.join(dist, jsRel), 'utf8')).replace(/<\/script/gi, '<\\/script');
const css = await fsp.readFile(path.join(dist, cssRel), 'utf8');
const b64 = async (f) => (await fsp.readFile(path.join(root, 'audit/T01/fixtures', f))).toString('base64');
const mediaJson = JSON.stringify({ hook: await b64('sample_8s_9x16.mp4'), broll: await b64('sample_3s_16x9.mp4') });

const page = `<title>Motion Studio Demo</title>
<style>
${css}
</style>
<div id="root"></div>
<script>window.__DEMO_MEDIA__ = ${mediaJson};</script>
<script type="module">
${js}
</script>
`;
await fsp.mkdir(path.join(root, 'demo'), { recursive: true });
const out = path.join(root, 'demo/motion-studio-demo.html');
await fsp.writeFile(out, page);
console.log(`demo: ${path.relative(root, out)} (${(page.length / 1024).toFixed(0)} KB)`);
