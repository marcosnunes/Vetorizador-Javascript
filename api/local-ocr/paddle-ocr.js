/* global require, process, Buffer */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    const out = [];
    const err = [];
    let finished = false;

    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 180000;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // noop
      }
      reject(new Error(`PaddleOCR local timeout após ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => err.push(Buffer.from(chunk)));

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}

async function runLocalPaddleOcr({ pdfBase64 = '', fileName = '', totalPagesHint = 0 }) {
  const pythonBin = String(process.env.PDFTOARCGIS_PADDLE_PYTHON_BIN || 'python').trim();
  const timeoutMs = Number.isFinite(Number(process.env.PDFTOARCGIS_PADDLE_TIMEOUT_MS))
    ? Number(process.env.PDFTOARCGIS_PADDLE_TIMEOUT_MS)
    : 180000;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftoarcgis-paddle-'));
  const inputPath = path.join(tempRoot, 'input.json');
  const outputPath = path.join(tempRoot, 'output.json');
  const scriptPath = path.join(__dirname, 'paddle_ocr_extract.py');

  try {
    fs.writeFileSync(inputPath, JSON.stringify({
      pdfBase64: String(pdfBase64 || ''),
      fileName: String(fileName || ''),
      totalPagesHint: Number.isFinite(Number(totalPagesHint)) ? Number(totalPagesHint) : 0
    }), 'utf8');

    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8'
    };

    const result = await runProcess(pythonBin, [scriptPath, '--input', inputPath, '--output', outputPath], {
      cwd: path.dirname(scriptPath),
      env,
      timeoutMs
    });

    if (result.code !== 0) {
      const stderrPreview = String(result.stderr || '').slice(0, 800);
      const stdoutPreview = String(result.stdout || '').slice(0, 800);
      throw new Error(`PaddleOCR local retornou código ${result.code}. stderr=${stderrPreview || '(vazio)'} stdout=${stdoutPreview || '(vazio)'}`);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('PaddleOCR local não gerou arquivo de saída.');
    }

    const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    if (!payload || payload.success !== true) {
      throw new Error(String(payload?.error || 'PaddleOCR local falhou sem mensagem.'));
    }

    return {
      text: String(payload.text || ''),
      pages: Array.isArray(payload.pages) ? payload.pages : [],
      engine: String(payload.engine || 'paddleocr-local')
    };
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // noop
    }
  }
}

module.exports = {
  runLocalPaddleOcr
};
