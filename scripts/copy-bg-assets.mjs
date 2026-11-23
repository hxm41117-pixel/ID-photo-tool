import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const srcDir = path.join(projectRoot, 'node_modules', '@imgly', 'background-removal-data', 'dist');
const destDir = path.join(projectRoot, 'public', 'imgly-assets');

// Keep ONLY the `small` quantized portrait model (isnet_quint8, ~42MB) + WASM runtimes
// so all devices (SIMD/Non-SIMD, Threaded/Single) load 100% from local static assets.
const INCLUDED_KEYS = new Set([
  '/onnxruntime-web/ort-wasm.wasm',
  '/onnxruntime-web/ort-wasm-threaded.wasm',
  '/onnxruntime-web/ort-wasm-simd.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
  '/models/small',
]);

function main() {
  const resourcesPath = path.join(srcDir, 'resources.json');
  if (!fs.existsSync(resourcesPath)) {
    console.error(
      '[copy-bg-assets] Missing @imgly/background-removal-data. Please run npm install first.'
    );
    process.exit(1);
  }

  fs.mkdirSync(destDir, { recursive: true });

  const allResources = JSON.parse(fs.readFileSync(resourcesPath, 'utf-8'));
  const filteredResources = {};
  const hashesToKeep = new Set();

  for (const [key, entry] of Object.entries(allResources)) {
    if (!INCLUDED_KEYS.has(key)) continue;
    filteredResources[key] = entry;
    for (const chunk of entry.chunks) {
      hashesToKeep.add(chunk.hash);
    }
  }

  // Delete any unused files/chunks from public/imgly-assets/
  let removed = 0;
  for (const existing of fs.readdirSync(destDir)) {
    if (existing !== 'resources.json' && !hashesToKeep.has(existing)) {
      fs.rmSync(path.join(destDir, existing), { recursive: true, force: true });
      removed++;
    }
  }

  // Write filtered resources.json to public/imgly-assets/
  fs.writeFileSync(
    path.join(destDir, 'resources.json'),
    JSON.stringify(filteredResources, null, 2),
    'utf-8'
  );

  let copied = 0;
  let totalBytes = 0;
  for (const hash of hashesToKeep) {
    const srcFile = path.join(srcDir, hash);
    const destFile = path.join(destDir, hash);
    if (!fs.existsSync(srcFile)) {
      console.warn(`[copy-bg-assets] Warning: chunk ${hash} not found`);
      continue;
    }
    const stat = fs.statSync(srcFile);
    totalBytes += stat.size;
    if (!fs.existsSync(destFile) || fs.statSync(destFile).size !== stat.size) {
      fs.copyFileSync(srcFile, destFile);
      copied++;
    }
  }

  console.log(
    `[copy-bg-assets] Ready in public/imgly-assets/ (${hashesToKeep.size} chunks, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total, ${copied} copied, ${removed} unused removed).`
  );
}

main();
