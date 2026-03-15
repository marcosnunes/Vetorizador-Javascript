import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLocalWorkspaceAI } = require('../api/local-ai/workspace-ai.js');

const root = process.cwd();
// Prefer llama-completion.exe (non-interactive /  non-TTY safe), fall back to llama-cli.exe
const defaultBin = (() => {
  const completion = path.join(root, 'pdfspliter', 'PDFtoArcgis', 'llama-cli', 'llama-completion.exe');
  if (fs.existsSync(completion)) return completion;
  return path.join(root, 'pdfspliter', 'PDFtoArcgis', 'llama-cli', 'llama-cli.exe');
})();
const bin = process.env.PDFTOARCGIS_LOCAL_AI_LLAMA_BIN || defaultBin;

const modelsDir = path.join(root, 'pdfspliter', 'PDFtoArcgis', 'models');
let modelPath = process.env.PDFTOARCGIS_LOCAL_AI_MODEL_PATH || '';
if (!modelPath && fs.existsSync(modelsDir)) {
  const candidate = fs.readdirSync(modelsDir).find((f) => /\.gguf$/i.test(f));
  if (candidate) modelPath = path.join(modelsDir, candidate);
}

console.log('[healthcheck-local-ai] BIN:', bin);
console.log('[healthcheck-local-ai] MODEL:', modelPath || '(nao encontrado)');

if (!fs.existsSync(bin)) {
  throw new Error('llama-cli nao encontrado no caminho configurado.');
}

const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) {
  throw new Error(`llama-cli --version falhou: ${version.stderr || version.stdout}`);
}
console.log('[healthcheck-local-ai] llama-cli OK');

if (!modelPath || !fs.existsSync(modelPath)) {
  throw new Error('Modelo GGUF nao encontrado. Coloque um .gguf em pdfspliter/PDFtoArcgis/models.');
}

process.env.PDFTOARCGIS_LOCAL_AI_MODEL_PATH = modelPath;
process.env.PDFTOARCGIS_LOCAL_AI_LLAMA_BIN = bin;

const sample = [
  'VERTICE V1 LAT: -23.456789 LON: -51.123456',
  'VERTICE V2 LAT: -23.456500 LON: -51.122800',
  'VERTICE V3 LAT: -23.455900 LON: -51.123100',
  'VERTICE V4 LAT: -23.456200 LON: -51.123900'
].join('\n');

const response = await runLocalWorkspaceAI({
  ocrText: sample,
  fileName: 'healthcheck.pdf',
  expectedVertices: 4,
  pagesAnalyzed: 1
});

if (!response || typeof response !== 'object') {
  throw new Error('Resposta invalida da IA local.');
}

console.log('[healthcheck-local-ai] JSON OK');
console.log('[healthcheck-local-ai] projectionKey:', response.projectionKey || '(vazio)');
console.log('[healthcheck-local-ai] sourcePattern:', response.sourcePattern || '(vazio)');
