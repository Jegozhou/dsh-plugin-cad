/**
 * Build both halves of the dsh-plugin-cad bundle.
 *
 *  - Host half: one ESM file bundled from `src/host/index.ts`; no runtime
 *    dependencies beyond Node built-ins, because it is installed into the
 *    harness profile's node_modules.
 *  - Browser half: one factory-registration file in the exact format the
 *    harness `@deepseek-ai/dsh-client-modules` loader consumes
 *    (`window.__ModuleLoader__.load({id, factory})`). React (and the other
 *    shell-seeded modules) resolve from the page's shared module table and are
 *    never bundled.
 *
 * Run from the package root: `node build.mjs`. Idempotent; safe to re-run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lib = join(root, 'lib')
const esbuild = join(root, 'node_modules', '.bin', 'esbuild')

if (!existsSync(esbuild)) {
  console.error('build: esbuild is missing — run `pnpm install` in the package root first')
  process.exit(1)
}

rmSync(lib, { recursive: true, force: true })
mkdirSync(lib, { recursive: true })

/** esbuild argv shared by both halves. */
function run(args) {
  execFileSync(esbuild, args, { stdio: 'inherit', cwd: root })
}

// 1. Host half — ESM, bundled, Node built-ins only.
const hostEntry = join(root, 'src', 'host', 'index.ts')
if (existsSync(hostEntry)) {
  run([
    hostEntry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    '--outfile=' + join(lib, 'index.js'),
    '--minify=false',
    '--sourcemap',
    '--legal-comments=eof',
    '--log-level=warning',
  ])
  console.log('host half  : lib/index.js        ' + size(join(lib, 'index.js')))
} else {
  console.log('host half  : skipped (src/host/index.ts missing)')
}

// 2. Browser half — IIFE factory registration.
const clientEntry = join(root, 'src', 'client', 'index.tsx')
if (existsSync(clientEntry)) {
  const globalName = '__dsh' + manifest.name
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')
  const raw = join(lib, 'client.raw.js')
  run([
    clientEntry,
    '--bundle',
    '--format=iife',
    '--global-name=' + globalName,
    '--platform=browser',
    '--target=es2022',
    '--jsx=automatic',
    '--loader:.css=text',
    '--minify',
    '--legal-comments=none',
    '--log-level=warning',
    '--outfile=' + raw,
    '--external:react',
    '--external:react/jsx-runtime',
    '--external:react-dom',
    '--external:react-dom/client',
    '--define:process.env.NODE_ENV="production"',
  ])
  const bundle = readFileSync(raw, 'utf8')
  rmSync(raw, { force: true })
  writeFileSync(join(lib, 'client.js'), `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(manifest.name)},\n  factory(require) {\n${bundle}\n    return ${globalName};\n  },\n});\n`)
  console.log('browser half: lib/client.js      ' + size(join(lib, 'client.js')) + '  (global ' + globalName + ')')
} else {
  console.log('browser half: skipped (src/client/index.tsx missing)')
}

// 3. Resources that must exist for a valid bundle.
const required = ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'lib/index.js']
const missing = required.filter(file => !existsSync(join(root, file)))
if (missing.length > 0) {
  console.error('build: missing required resources: ' + missing.join(', '))
  process.exit(1)
}
console.log('resources  : ok')

/** Human-readable byte size. */
function size(file) {
  const bytes = statSync(file).size
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`
}
