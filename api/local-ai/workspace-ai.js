/* global process, require, module */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveDefaultLlamaBin() {
  const cwd = process.cwd();
  // Prefer llama-completion.exe (non-interactive batch mode — works without TTY)
  const completionBin = path.join(cwd, 'pdfspliter', 'PDFtoArcgis', 'llama-cli', 'llama-completion.exe');
  if (fs.existsSync(completionBin)) return completionBin;
  const cliBin = path.join(cwd, 'pdfspliter', 'PDFtoArcgis', 'llama-cli', 'llama-cli.exe');
  if (fs.existsSync(cliBin)) return cliBin;
  return 'llama-completion';
}

function resolveDefaultModelPath() {
  const cwd = process.cwd();
  const envPath = String(process.env.PDFTOARCGIS_LOCAL_AI_MODEL_PATH || '').trim();
  if (envPath) return envPath;

  const modelsDir = path.join(cwd, 'pdfspliter', 'PDFtoArcgis', 'models');
  if (!fs.existsSync(modelsDir)) return '';

  const files = fs.readdirSync(modelsDir)
    .filter((name) => /\.gguf$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) return '';
  return path.join(modelsDir, files[0]);
}

function extractJsonFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function buildPrompt({ ocrText, fileName, expectedVertices = 0, pagesAnalyzed = 0 }) {
  // llama-completion works in raw completion mode, so the prompt must be written
  // as a full text the model will continue. We end the prompt right before the JSON
  // opens so the --json-schema grammar forces the model to emit valid JSON.
  const compactText = String(ocrText || '').slice(0, 60000);
  const lines = [
    'Task: Extract geospatial data from the Brazilian land-registry document below.',
    'Output ONLY a single JSON object with these keys:',
    '  matricula (string) — property registration number if present, else empty string.',
    '  projectionKey (string) — e.g. "SIRGAS2000 / UTM zone 22S", "WGS84", or empty.',
    '  geometryMode (string) — "absolute" when explicit coordinates exist, "local_relative" for bearing+distance only.',
    '  sourcePattern (string) — one of utm, latlong, rumo_distancia, azimute_distancia, misto, desconhecido.',
    '  geojson (object) — GeoJSON FeatureCollection with one Polygon feature. Closed ring (first point = last point).',
    'Rules: preserve vertex order from document; close the ring; no text outside JSON.',
    `File: ${fileName || 'documento.pdf'} |Pages: ${pagesAnalyzed || 0}${expectedVertices > 0 ? ` | Expected vertices: ~${expectedVertices}` : ''}`,
    '--- BEGIN OCR TEXT ---',
    compactText,
    '--- END OCR TEXT ---',
    'JSON:'
  ];
  return lines.join('\n');
}

function runCommand(command, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        LLAMA_LOG_VERBOSITY: '0'
      }
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error(`Timeout executando ${command}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}

async function runWithLlamaCli(prompt, config) {
  const bin = String(config.llamaBin || process.env.PDFTOARCGIS_LOCAL_AI_LLAMA_BIN || resolveDefaultLlamaBin()).trim();
  const modelPath = String(config.modelPath || resolveDefaultModelPath()).trim();
  if (!modelPath) {
    throw new Error('Modelo GGUF não encontrado. Defina PDFTOARCGIS_LOCAL_AI_MODEL_PATH ou coloque um .gguf em pdfspliter/PDFtoArcgis/models.');
  }

  const jsonSchema = JSON.stringify({
    type: 'object',
    required: ['geojson'],
    properties: {
      matricula: { type: 'string' },
      projectionKey: { type: 'string' },
      geometryMode: { type: 'string' },
      sourcePattern: { type: 'string' },
      geojson: {
        type: 'object',
        required: ['type', 'features'],
        properties: {
          type: { const: 'FeatureCollection' },
          features: { type: 'array', minItems: 1 }
        }
      }
    }
  });

  // Write schema and prompt to temp files so llama-completion can read them
  // without any shell-escaping issues (especially important on Windows).
  const tmpDir = os.tmpdir();
  const schemaFile = path.join(tmpDir, `llama_schema_${Date.now()}.json`);
  const promptFile = path.join(tmpDir, `llama_prompt_${Date.now()}.txt`);
  fs.writeFileSync(schemaFile, jsonSchema, 'utf8');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const args = [
    '-m', modelPath,
    '-f', promptFile,
    '--no-display-prompt',
    '--json-schema-file', schemaFile,
    '--temp', '0',
    '--ctx-size', String(config.ctxSize || process.env.PDFTOARCGIS_LOCAL_AI_CTX_SIZE || 8192),
    '--n-predict', String(config.nPredict || process.env.PDFTOARCGIS_LOCAL_AI_N_PREDICT || 4096)
  ];

  let result;
  try {
    result = await runCommand(bin, args, Number(process.env.PDFTOARCGIS_LOCAL_AI_TIMEOUT_MS || 240000));
  } finally {
    try { fs.unlinkSync(schemaFile); } catch { /* noop */ }
    try { fs.unlinkSync(promptFile); } catch { /* noop */ }
  }

  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(`llama-completion falhou (${result.code}): ${result.stderr.slice(0, 400) || 'sem saida'}`);
  }

  const parsed = extractJsonFromText(result.stdout);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('IA local (llama-completion) não retornou JSON válido.');
  }

  return parsed;
}

async function runLocalWorkspaceAI({ ocrText, fileName = '', expectedVertices = 0, pagesAnalyzed = 0 } = {}) {
  const provider = String(process.env.PDFTOARCGIS_LOCAL_AI_PROVIDER || 'llama_cli').toLowerCase();
  const prompt = buildPrompt({ ocrText, fileName, expectedVertices, pagesAnalyzed });

  if (provider === 'llama_cli') {
    return runWithLlamaCli(prompt, {});
  }

  throw new Error(`Provider local não suportado: ${provider}`);
}

module.exports = {
  runLocalWorkspaceAI
};
