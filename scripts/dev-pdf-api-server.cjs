/* global Buffer, __dirname, process */

const http = require('http');
const fs = require('fs');
const path = require('path');

const handler = require('../api/pdf-to-geojson/index.js');

const PORT = Number(process.env.PDFTOARCGIS_DEV_API_PORT || 7072);
const LOCAL_SETTINGS_PATH = path.resolve(__dirname, '../api/local.settings.json');

function loadLocalSettings() {
  try {
    const raw = fs.readFileSync(LOCAL_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const values = parsed && typeof parsed === 'object' ? parsed.Values : null;
    if (!values || typeof values !== 'object') return;

    for (const [key, value] of Object.entries(values)) {
      if (typeof process.env[key] === 'undefined') {
        process.env[key] = String(value ?? '');
      }
    }
  } catch (error) {
    console.warn('[dev-pdf-api] Falha ao carregar local.settings.json:', error?.message || error);
  }
}

function applyDevOverrides() {
  const defaults = {
    PDFTOARCGIS_USE_AZURE_AI: 'false',
    PDFTOARCGIS_USE_WORKSPACE_LOCAL_AI: 'false',
    PDFTOARCGIS_WORKSPACE_LOCAL_AI_ONLY: 'false',
    PDFTOARCGIS_USE_LLM_EXTRACTION: 'false',
    PDFTOARCGIS_LLM_ONLY_MODE: 'false'
  };

  for (const [key, value] of Object.entries(defaults)) {
    const overrideKey = `PDFTOARCGIS_DEV_OVERRIDE_${key}`;
    if (typeof process.env[overrideKey] !== 'undefined') {
      process.env[key] = String(process.env[overrideKey]);
      continue;
    }

    process.env[key] = value;
  }
}

function createContext(res) {
  const logger = Object.assign(
    (...args) => console.log(...args),
    {
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args)
    }
  );

  return {
    log: logger,
    get res() {
      return this._res;
    },
    set res(value) {
      this._res = value;
      if (!value) return;

      const headers = value.headers || {};
      for (const [key, headerValue] of Object.entries(headers)) {
        if (typeof headerValue !== 'undefined') {
          res.setHeader(key, headerValue);
        }
      }

      const body = typeof value.body === 'string'
        ? value.body
        : JSON.stringify(value.body ?? {});

      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }

      res.statusCode = value.status || 200;
      res.end(body);
    }
  };
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

loadLocalSettings();
applyDevOverrides();

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith('/api/pdf-to-geojson')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, error: 'Rota não encontrada.' }));
    return;
  }

  try {
    const rawBody = await collectBody(req);
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    let body = {};

    if (contentType.includes('application/json')) {
      body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } else {
      body = rawBody;
    }

    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    const query = Object.fromEntries(url.searchParams.entries());
    const context = createContext(res);

    await handler(context, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      query,
      body,
      rawBody
    });

    if (!res.writableEnded && !context.res) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, error: 'Handler não retornou resposta.' }));
    }
  } catch (error) {
    console.error('[dev-pdf-api] erro:', error);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, error: error?.message || 'Erro interno no servidor local.' }));
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-pdf-api] ouvindo em http://127.0.0.1:${PORT}`);
});