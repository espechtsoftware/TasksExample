/**
 * Bundles the MCP App view into a single self-contained HTML file.
 *
 * MCP Apps HTML is rendered by hosts inside a sandboxed iframe with a strict
 * CSP, so the view cannot load external scripts — everything (including the
 * ext-apps App runtime) must be inlined. esbuild bundles src/ui/dashboard.ts
 * and we splice the result into the template's APP_SCRIPT placeholder.
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const bundle = await build({
  entryPoints: [path.join(root, 'src/ui/dashboard.ts')],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  target: 'es2022'
});

const js = bundle.outputFiles[0].text;
// Guard against `</script>` sequences inside the bundled JS breaking the inline tag.
const safeJs = js.replaceAll('</script>', '<\\/script>');

const template = await readFile(path.join(root, 'src/ui/dashboard.html'), 'utf8');
const html = template.replace('/*APP_SCRIPT*/', () => safeJs);

await mkdir(path.join(root, 'dist/ui'), { recursive: true });
await writeFile(path.join(root, 'dist/ui/dashboard.html'), html);
console.log(`Built dist/ui/dashboard.html (${(html.length / 1024).toFixed(1)} KiB)`);
