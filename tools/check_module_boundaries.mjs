import fs from 'node:fs';
import path from 'node:path';

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

function shouldSkipFile(relPath) {
  const p = toPosix(relPath);
  if (p.startsWith('doc/')) return true;
  if (p.startsWith('tests/')) return true;
  if (p.startsWith('node_modules/')) return true;
  if (p.startsWith('dist/')) return true;
  if (p.startsWith('local_tools/')) return true;
  return false;
}

function layerOf(relPath) {
  const p = toPosix(relPath);
  if (p.startsWith('app/')) return 'entry';
  if (p.startsWith('backend/')) return 'backend';
  if (p.startsWith('core/')) return 'base';
  if (p.startsWith('renderer/')) return 'renderer';
  if (p.startsWith('ui/')) return 'ui';
  if (p === 'worker/protocol.gen.mjs' || p === 'worker/dispatch.gen.mjs') return 'protocol';
  if (p.startsWith('worker/')) return 'worker';
  return null;
}

const ALLOWED_IMPORTS = {
  base: new Set(['base']),
  protocol: new Set(['protocol', 'base']),
  worker: new Set(['worker', 'protocol', 'base']),
  backend: new Set(['backend', 'protocol', 'base']),
  ui: new Set(['ui', 'base']),
  renderer: new Set(['renderer', 'base']),
  entry: new Set(['entry', 'backend', 'renderer', 'ui', 'worker', 'protocol', 'base']),
};

const STATIC_IMPORT_RE = /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walkRepo(dirAbs, out = []) {
  const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    const rel = toPosix(path.relative(process.cwd(), abs));
    if (entry.isDirectory()) {
      if (shouldSkipFile(rel)) continue;
      walkRepo(abs, out);
      continue;
    }
    out.push(rel);
  }
  return out;
}

function extractImportSpecifiers(source) {
  const specs = [];
  for (const re of [STATIC_IMPORT_RE, EXPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      specs.push(match[1]);
    }
  }
  return specs;
}

function resolveRelativeImport(fromRel, spec) {
  if (!spec.startsWith('.')) {
    return null;
  }
  const fromDir = path.dirname(fromRel);
  const joined = path.resolve(fromDir, spec);
  const ext = path.extname(joined);
  const candidates = ext
    ? [joined]
    : [`${joined}.mjs`, `${joined}.js`, `${joined}.ts`];
  for (const absPath of candidates) {
    if (fs.existsSync(absPath)) {
      return toPosix(path.relative(process.cwd(), absPath));
    }
  }
  return null;
}

const allFiles = walkRepo(process.cwd());
const codeFiles = allFiles.filter((relPath) => {
  if (!(relPath.endsWith('.mjs') || relPath.endsWith('.js') || relPath.endsWith('.ts'))) {
    return false;
  }
  if (shouldSkipFile(relPath)) {
    return false;
  }
  return !!layerOf(relPath);
});

const codeSet = new Set(codeFiles);
const violations = [];

for (const fromRel of codeFiles) {
  const fromLayer = layerOf(fromRel);
  const allow = ALLOWED_IMPORTS[fromLayer] || new Set();
  const source = fs.readFileSync(path.resolve(process.cwd(), fromRel), 'utf8');
  const imports = extractImportSpecifiers(source);
  for (const spec of imports) {
    const toRel = resolveRelativeImport(fromRel, spec);
    if (!toRel || !codeSet.has(toRel)) {
      continue;
    }
    const toLayer = layerOf(toRel);
    if (!allow.has(toLayer)) {
      violations.push({ fromRel, fromLayer, toRel, toLayer });
    }
  }
}

if (violations.length) {
  console.error(`[boundaries] Violations: ${violations.length}`);
  for (const violation of violations) {
    console.error(`- ${violation.fromRel} (${violation.fromLayer}) imports ${violation.toRel} (${violation.toLayer})`);
  }
  process.exit(1);
}

console.log(`[boundaries] OK (${codeFiles.length} files)`);
