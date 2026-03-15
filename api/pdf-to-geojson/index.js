/* global require, module, process, Buffer */

const DEFAULT_OPENAI_API_VERSION = '2024-10-21';
const DEFAULT_DOCINTEL_API_VERSION = '2024-11-30';
const LEGACY_DOCINTEL_API_VERSION = '2023-07-31';
const MAX_DOCINTEL_POLLS = 60;
const POLL_INTERVAL_MS = 2000;
const DOCINTEL_FALLBACK_BATCH_SIZE = 2;
const MAX_DOCINTEL_ANALYZE_RETRIES = 2;
const DOCINTEL_RETRY_BASE_DELAY_MS = 900;
const MAX_OPENAI_RETRIES = 2;
const OPENAI_RETRY_BASE_DELAY_MS = 1000;
const USE_AZURE_AI = String(process.env.PDFTOARCGIS_USE_AZURE_AI || 'false').toLowerCase() === 'true';
const http = require('http');
const https = require('https');

module.exports = undefined;

function httpFetch(...args) {
  if (typeof fetch === 'function') {
    return fetch(...args);
  }

  const [url, options = {}] = args;
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.request(parsedUrl, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const textBody = buffer.toString('utf8');
        const headers = res.headers || {};

        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 0,
          headers: {
            get: (name) => {
              const value = headers[String(name || '').toLowerCase()];
              if (Array.isArray(value)) return value[0] || null;
              return value ?? null;
            }
          },
          text: async () => textBody,
          json: async () => {
            if (!textBody) return {};
            return JSON.parse(textBody);
          }
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function sanitizeEndpoint(endpoint) {
  return String(endpoint || '').trim().replace(/\/$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDocIntelAnalyzeCandidates(docIntelConfig, modelId, pagesRange = '') {
  const endpoint = sanitizeEndpoint(docIntelConfig.endpoint);
  const configuredApiVersion = String(docIntelConfig.apiVersion || DEFAULT_DOCINTEL_API_VERSION).trim() || DEFAULT_DOCINTEL_API_VERSION;
  const candidates = [
    {
      label: 'documentintelligence',
      apiVersion: configuredApiVersion,
      url: `${endpoint}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze?api-version=${encodeURIComponent(configuredApiVersion)}`
    }
  ];

  if (configuredApiVersion !== LEGACY_DOCINTEL_API_VERSION) {
    candidates.push({
      label: 'formrecognizer',
      apiVersion: LEGACY_DOCINTEL_API_VERSION,
      url: `${endpoint}/formrecognizer/documentModels/${encodeURIComponent(modelId)}:analyze?api-version=${encodeURIComponent(LEGACY_DOCINTEL_API_VERSION)}`
    });
  }

  return candidates.map((candidate) => ({
    ...candidate,
    url: pagesRange ? `${candidate.url}&pages=${encodeURIComponent(pagesRange)}` : candidate.url
  }));
}

function getErrorMessage(payload, fallback = 'Erro desconhecido') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (payload.error?.message) return payload.error.message;
  if (payload.error) return typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error);
  if (payload.message) return payload.message;
  return fallback;
}

function extractJsonFromModelContent(rawContent) {
  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    if (!trimmed) return '';

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return fencedMatch ? fencedMatch[1].trim() : trimmed;
  }

  if (Array.isArray(rawContent)) {
    const textParts = rawContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    return extractJsonFromModelContent(textParts);
  }

  return '';
}

function tryParseJsonText(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const objectSlice = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(objectSlice);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function buildCoordinateFocusedText(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return '';

  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const selected = [];
  const seen = new Set();

  const hasVertexToken = /\b(?:V(?:É|E)?RTICE|VERTICE|PONTO|PT|M\s*[-.]?\s*\d+|V\s*\d{1,4})\b/i;
  const hasUtmPair = /-?\d{5,7}[.,]\d+[^\d\n\r]{1,25}-?\d{5,7}[.,]\d+/;
  const hasLatLonPair = /-?\d{1,3}[.,]\d{4,}[^\d\n\r]{1,20}-?\d{1,3}[.,]\d{4,}/;
  const hasDmsPair = /\d{1,3}\s*[°º]\s*\d{1,2}\s*['’′]\s*\d{1,2}(?:[.,]\d+)?\s*(?:["”″]\s*)?[NSOLWE]/i;
  const hasAzDist = /\b(?:AZIMUTE|RUMO|DIST[ÂA]NCIA|DIST\.?|METROS?|M\b|BEARING|N\s*\d{1,2}.*E|S\s*\d{1,2}.*W)\b/i;

  for (const line of lines) {
    if (!hasVertexToken.test(line) && !hasUtmPair.test(line) && !hasLatLonPair.test(line) && !hasDmsPair.test(line) && !hasAzDist.test(line)) {
      continue;
    }

    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length < 8 || seen.has(compact)) continue;
    seen.add(compact);
    selected.push(compact);

    if (selected.length >= 5000) break;
  }

  return selected.join('\n');
}

function parseNumericValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    let normalized = value.trim().replace(/\s+/g, '');
    if (!normalized) return null;

    const hasComma = normalized.includes(',');
    const hasDot = normalized.includes('.');
    if (hasComma && hasDot) {
      if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
        normalized = normalized.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = normalized.replace(/,/g, '');
      }
    } else if (hasComma) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else if ((normalized.match(/\./g) || []).length > 1) {
      normalized = normalized.replace(/\./g, '');
    }

    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toArrayLike(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        return toArrayLike(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    const numericKeys = entries.every(([k]) => /^\d+$/.test(k));
    const ordered = numericKeys
      ? entries.sort((a, b) => Number(a[0]) - Number(b[0]))
      : entries;
    return ordered.map(([, v]) => v);
  }
  return null;
}

function collectPoints(value, collector, depth = 0) {
  if (depth > 5 || value == null) return;

  const arr = toArrayLike(value);
  if (arr) {
    if (arr.length >= 2) {
      const x = parseNumericValue(arr[0]);
      const y = parseNumericValue(arr[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        collector.push([x, y]);
        return;
      }
    }
    for (const item of arr) {
      collectPoints(item, collector, depth + 1);
    }
    return;
  }

  if (value && typeof value === 'object') {
    const x = parseNumericValue(value.east ?? value.x ?? value.lon ?? value.lng ?? value.longitude);
    const y = parseNumericValue(value.north ?? value.y ?? value.lat ?? value.latitude);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      collector.push([x, y]);
      return;
    }
    for (const nested of Object.values(value)) {
      collectPoints(nested, collector, depth + 1);
    }
    return;
  }

  if (typeof value === 'string') {
    const nums = value.match(/-?\d+(?:[.,]\d+)?/g);
    if (nums && nums.length >= 2) {
      const x = parseNumericValue(nums[0]);
      const y = parseNumericValue(nums[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        collector.push([x, y]);
      }
    }
  }
}

function normalizeRingFromAnyPoints(rawPoints) {
  const points = [];
  collectPoints(rawPoints, points, 0);

  if (points.length < 3) {
    const rawText = typeof rawPoints === 'string' ? rawPoints : JSON.stringify(rawPoints || '');
    const nums = String(rawText || '').match(/-?\d+(?:[.,]\d+)?/g) || [];
    if (nums.length >= 6) {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = parseNumericValue(nums[i]);
        const y = parseNumericValue(nums[i + 1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          points.push([x, y]);
        }
      }
    }
  }

  if (points.length < 3) return null;

  // Remove duplicatas consecutivas para evitar anel degenerado.
  const cleaned = [];
  for (const point of points) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1]) {
      cleaned.push(point);
    }
  }

  if (cleaned.length < 3) return null;

  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    cleaned.push([first[0], first[1]]);
  }

  return cleaned.length >= 4 ? cleaned : null;
}

function normalizeUtmPair(a, b) {
  const ax = parseNumericValue(a);
  const bx = parseNumericValue(b);
  if (!Number.isFinite(ax) || !Number.isFinite(bx)) return null;

  const absA = Math.abs(ax);
  const absB = Math.abs(bx);
  const isEasting = (v) => v >= 100000 && v <= 900000;
  const isNorthing = (v) => v >= 1000000 && v <= 10000000;

  if (isEasting(absA) && isNorthing(absB)) return [ax, bx];
  if (isNorthing(absA) && isEasting(absB)) return [bx, ax];
  return null;
}

function extractUtmRingFromText(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return null;

  const lines = text.split(/\r?\n/);
  const points = [];
  const hintRegex = /(coordenad|utm|sirgas|norte|leste|este|vertice|v\s*\d{1,4}|ponto|\bx\s*=|\by\s*=|\bn\s*=|\be\s*=)/i;

  for (const line of lines) {
    if (!hintRegex.test(line)) continue;
    const nums = line.match(/-?\d[\d.,]*/g) || [];
    for (let i = 0; i + 1 < nums.length; i++) {
      const pair = normalizeUtmPair(nums[i], nums[i + 1]);
      if (pair) {
        points.push(pair);
        break;
      }
    }
  }

  if (points.length < 3) {
    const nums = text.match(/-?\d[\d.,]*/g) || [];
    for (let i = 0; i + 1 < nums.length; i++) {
      const pair = normalizeUtmPair(nums[i], nums[i + 1]);
      if (pair) points.push(pair);
      if (points.length >= 120) break;
    }
  }

  if (points.length < 3) return null;

  const cleaned = [];
  for (const point of points) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1]) {
      cleaned.push(point);
    }
  }

  if (cleaned.length < 3) return null;
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    cleaned.push([first[0], first[1]]);
  }

  return cleaned.length >= 4 ? cleaned : null;
}

function coercePolygonGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;

  const ringCandidates = [
    geometry.coordinates,
    geometry?.coordinates?.coordinates,
    geometry?.coordinates?.rings,
    geometry?.coordinates?.paths,
    geometry?.coordinates?.points,
    geometry?.coordinates?.vertices,
    geometry.rings,
    geometry.paths,
    geometry.points,
    geometry.vertices
  ];

  for (const candidate of ringCandidates) {
    const ring = normalizeRingFromAnyPoints(candidate);
    if (ring) {
      return { type: 'Polygon', coordinates: [ring] };
    }
  }

  if (geometry.type === 'Polygon') {
    const coordsContainer = toArrayLike(geometry.coordinates) || geometry.coordinates;
    const firstRingCandidate = Array.isArray(coordsContainer)
      ? (toArrayLike(coordsContainer[0]) || coordsContainer[0])
      : coordsContainer;
    const ring = normalizeRingFromAnyPoints(firstRingCandidate || coordsContainer);
    if (ring) {
      return { type: 'Polygon', coordinates: [ring] };
    }
  }

  if (geometry.type === 'MultiPolygon') {
    const multi = toArrayLike(geometry.coordinates) || geometry.coordinates;
    const poly = Array.isArray(multi) ? (toArrayLike(multi[0]) || multi[0]) : multi;
    const firstRing = Array.isArray(poly) ? (toArrayLike(poly[0]) || poly[0]) : poly;
    const ring = normalizeRingFromAnyPoints(firstRing);
    if (ring) {
      return { type: 'Polygon', coordinates: [ring] };
    }
  }

  if (geometry.type === 'LineString') {
    const line = toArrayLike(geometry.coordinates) || geometry.coordinates;
    const ring = normalizeRingFromAnyPoints(line);
    if (ring) {
      return { type: 'Polygon', coordinates: [ring] };
    }
  }

  return null;
}

function tryCoercePayloadGeoJson(payload) {
  const geometryFromFeature = coercePolygonGeometry(payload?.geojson?.features?.[0]?.geometry);
  if (geometryFromFeature) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: geometryFromFeature, properties: payload?.geojson?.features?.[0]?.properties || {} }]
    };
  }

  const candidates = [
    payload?.geojson?.features?.[0]?.coordinates,
    payload?.geojson?.coordinates,
    payload?.coordinates,
    payload?.vertices
  ];

  for (const candidate of candidates) {
    const ring = normalizeRingFromAnyPoints(candidate);
    if (ring) {
      return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }]
      };
    }
  }

  return null;
}

function estimateExpectedVertexCount(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return 0;

  let maxVertexId = 0;
  const idRegexes = [
    /\b(?:V(?:É|E)?RTICE|VERTICE|PONTO|PT|M)\s*[-.:]?\s*0*(\d{1,4})\b/gi,
    /\bV\s*0*(\d{2,4})\b/gi
  ];

  for (const regex of idRegexes) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > maxVertexId) {
        maxVertexId = n;
      }
    }
  }

  const lineRegex = /(?:^|\n)\s*(?:V\s*\d{1,4}|V(?:É|E)?RTICE\s*\d{1,4}|PONTO\s*\d{1,4}|PT\s*\d{1,4}|M\s*[-.]?\s*\d{1,4})?[^\n]{0,140}?-?\d{5,7}[.,]\d+[^\n]{1,30}-?\d{5,7}[.,]\d+[^\n]*(?=\n|$)/gi;
  const lineHits = text.match(lineRegex) || [];

  return Math.max(maxVertexId, lineHits.length);
}

function getExtractedVertexCount(payload) {
  const ring = payload?.geojson?.features?.[0]?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return 0;

  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = Array.isArray(first)
    && Array.isArray(last)
    && first.length >= 2
    && last.length >= 2
    && first[0] === last[0]
    && first[1] === last[1];

  return closed ? Math.max(0, ring.length - 1) : ring.length;
}

function buildHeuristicGeojsonFromText(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return null;

  const lines = text.split(/\r?\n/);
  const points = [];
  const looksLikeCoordinateContext = /(coordenad|utm|sirgas|norte|sul|leste|oeste|este|north|east|x\s*=|y\s*=|\bn\s*=|\be\s*=|vertice|v[\s\-_.]*\d{1,4})/i.test(text);
  const classifyPair = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const absA = Math.abs(a);
    const absB = Math.abs(b);
    const isEasting = (v) => v >= 100000 && v <= 900000;
    const isNorthing = (v) => v >= 1000000 && v <= 10000000;

    if (isEasting(absA) && isNorthing(absB)) return [a, b];
    if (isNorthing(absA) && isEasting(absB)) return [b, a];
    return null;
  };
  const tryPushPoint = (a, b) => {
    const pair = classifyPair(a, b);
    if (!pair) return;
    points.push(pair);
  };

  for (const line of lines) {
    const matches = line.match(/-?\d+(?:[.,]\d+)?/g);
    if (!matches || matches.length < 2) continue;

    for (let i = 0; i + 1 < matches.length; i++) {
      const rawA = matches[i];
      const rawB = matches[i + 1];
      if (!/[.,]/.test(rawA) || !/[.,]/.test(rawB)) continue;

      const a = parseNumericValue(rawA);
      const b = parseNumericValue(rawB);
      tryPushPoint(a, b);
    }
  }

  if (points.length < 3 && looksLikeCoordinateContext) {
    const allNumbers = Array.from(text.matchAll(/-?\d+(?:[.,]\d+)?/g), (m) => m[0]);
    for (let i = 0; i + 1 < allNumbers.length; i++) {
      const a = parseNumericValue(allNumbers[i]);
      const b = parseNumericValue(allNumbers[i + 1]);
      tryPushPoint(a, b);
      if (points.length >= 80) break;
    }
  }

  if (points.length < 3) return null;

  const dedup = [];
  for (const p of points) {
    const prev = dedup[dedup.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) {
      dedup.push(p);
    }
  }

  if (dedup.length < 3) return null;
  const first = dedup[0];
  const last = dedup[dedup.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    dedup.push([first[0], first[1]]);
  }

  if (dedup.length < 4) return null;

  return {
    geojson: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [dedup] }, properties: {} }]
    },
    projectionKey: 'SIRGAS2000_22S',
    sourcePattern: 'utm',
    extractedVertices: dedup.length - 1
  };
}

function buildCorsHeaders(req) {
  const env = process.env || {};
  const configuredOrigins = String(env.PDF_TO_GEOJSON_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const requestOrigin = String(req?.headers?.origin || '').trim();
  const allowAnyOrigin = configuredOrigins.length === 0 || configuredOrigins.includes('*');
  const allowedOrigin = allowAnyOrigin
    ? '*'
    : (configuredOrigins.includes(requestOrigin) ? requestOrigin : configuredOrigins[0]);

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function normalizePdfBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const dataUrlMatch = raw.match(/^data:application\/pdf;base64,(.+)$/i);
  return (dataUrlMatch ? dataUrlMatch[1] : raw).replace(/\s+/g, '');
}

function looksLikePdfBase64(base64Value) {
  if (!base64Value || typeof base64Value !== 'string') return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(base64Value)) return false;

  try {
    const probe = Buffer.from(base64Value.slice(0, 64), 'base64').toString('latin1');
    return probe.includes('%PDF-');
  } catch {
    return false;
  }
}

function toBase64FromRawPdfBody(rawBody) {
  if (!rawBody) return '';

  if (Buffer.isBuffer(rawBody)) {
    return rawBody.toString('base64');
  }

  if (rawBody instanceof Uint8Array) {
    return Buffer.from(rawBody).toString('base64');
  }

  if (typeof rawBody === 'string') {
    const trimmed = rawBody.trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('%PDF-')) {
      return Buffer.from(trimmed, 'binary').toString('base64');
    }

    if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
      return trimmed.replace(/\s+/g, '');
    }

    return Buffer.from(rawBody, 'binary').toString('base64');
  }

  return '';
}

function extractTextFromAnalyzeResult(analyzeResult) {
  if (!analyzeResult || typeof analyzeResult !== 'object') return '';

  const direct = String(analyzeResult.content || '').trim();
  if (direct) return direct;

  const pages = Array.isArray(analyzeResult.pages) ? analyzeResult.pages : [];
  const pageTexts = pages.map((page) => {
    const lines = Array.isArray(page?.lines) ? page.lines : [];
    const lineText = lines
      .map((line) => String(line?.content || '').trim())
      .filter(Boolean)
      .join('\n');

    if (lineText) return lineText;

    const words = Array.isArray(page?.words) ? page.words : [];
    return words
      .map((word) => String(word?.content || '').trim())
      .filter(Boolean)
      .join(' ');
  }).filter(Boolean);

  return pageTexts.join('\n\n').trim();
}

async function runDocumentIntelligenceAnalyze(pdfBase64, docIntelConfig, pagesRange = '', modelId = 'prebuilt-read') {
  const analyzeCandidates = buildDocIntelAnalyzeCandidates(docIntelConfig, modelId, pagesRange);
  let analyzeResponse = null;
  let selectedCandidate = null;
  const failedCandidates = [];

  for (const candidate of analyzeCandidates) {
    for (let attempt = 0; attempt <= MAX_DOCINTEL_ANALYZE_RETRIES; attempt++) {
      const response = await httpFetch(candidate.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': docIntelConfig.apiKey
        },
        body: JSON.stringify({ base64Source: pdfBase64 })
      });

      if (response.ok) {
        analyzeResponse = response;
        selectedCandidate = candidate;
        break;
      }

      const errorPayload = await response.json().catch(() => ({}));
      const message = getErrorMessage(errorPayload);
      const transientStatus = response.status === 429 || response.status === 500 || response.status === 503 || response.status === 504;
      if (transientStatus && attempt < MAX_DOCINTEL_ANALYZE_RETRIES) {
        const waitMs = DOCINTEL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }

      failedCandidates.push({
        label: candidate.label,
        apiVersion: candidate.apiVersion,
        status: response.status,
        message
      });

      if (response.status !== 404) {
        throw new Error(`Document Intelligence (analyze) falhou [${candidate.label} ${candidate.apiVersion}]: ${response.status} - ${message}`);
      }

      break;
    }

    if (analyzeResponse) break;
  }

  if (!analyzeResponse) {
    const tried = failedCandidates
      .map((candidate) => `${candidate.label} ${candidate.apiVersion} => ${candidate.status} (${candidate.message})`)
      .join(' | ');
    throw new Error(`Document Intelligence (analyze) falhou: 404 - recurso/rota não encontrado. Verifique o endpoint do Azure AI Document Intelligence e a versão da API. Tentativas: ${tried}`);
  }

  const operationLocation = analyzeResponse.headers.get('operation-location');
  if (!operationLocation) {
    throw new Error(`Document Intelligence não retornou operation-location na rota ${selectedCandidate?.label || 'desconhecida'}.`);
  }

  for (let attempt = 0; attempt < MAX_DOCINTEL_POLLS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const pollResponse = await httpFetch(operationLocation, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': docIntelConfig.apiKey
      }
    });

    if (!pollResponse.ok) {
      const errorPayload = await pollResponse.json().catch(() => ({}));
      throw new Error(`Document Intelligence (poll) falhou: ${pollResponse.status} - ${getErrorMessage(errorPayload)}`);
    }

    const pollPayload = await pollResponse.json();
    const status = String(pollPayload.status || '').toLowerCase();

    if (status === 'succeeded') {
      const content = extractTextFromAnalyzeResult(pollPayload.analyzeResult);
      return {
        text: content,
        pages: pollPayload.analyzeResult?.pages || [],
        modelId
      };
    }

    if (status === 'failed' || status === 'canceled') {
      throw new Error(`Document Intelligence retornou status ${status}.`);
    }
  }

  throw new Error('Timeout ao aguardar processamento do Document Intelligence.');
}

async function runDocumentIntelligence(pdfBase64, docIntelConfig, options = {}) {
  const totalPagesHint = Number.isFinite(options.totalPagesHint) ? options.totalPagesHint : 0;
  let modelId = 'prebuilt-read';
  let firstPass = null;
  const modelCandidates = ['prebuilt-read', 'prebuilt-layout', 'prebuilt-document'];
  const firstPassErrors = [];

  for (const candidate of modelCandidates) {
    try {
      const pass = await runDocumentIntelligenceAnalyze(pdfBase64, docIntelConfig, '', candidate);
      if (String(pass?.text || '').trim()) {
        modelId = candidate;
        firstPass = pass;
        break;
      }
    } catch (error) {
      firstPassErrors.push(`${candidate}: ${error?.message || error}`);
    }
  }

  if (!firstPass) {
    if (totalPagesHint > 1) {
      const mergedPages = new Map();
      const mergedTexts = [];
      let fallbackModel = modelId;

      for (let start = 1; start <= totalPagesHint; start += DOCINTEL_FALLBACK_BATCH_SIZE) {
        const end = Math.min(totalPagesHint, start + DOCINTEL_FALLBACK_BATCH_SIZE - 1);
        const range = `${start}-${end}`;
        let rangePass = null;

        for (const candidate of modelCandidates) {
          try {
            const pass = await runDocumentIntelligenceAnalyze(pdfBase64, docIntelConfig, range, candidate);
            if (String(pass?.text || '').trim()) {
              rangePass = pass;
              fallbackModel = candidate;
              break;
            }
          } catch {
            // tenta próximo modelo e próximo range
          }
        }

        if (!rangePass) continue;
        if (rangePass.text) mergedTexts.push(rangePass.text);
        for (const p of (rangePass.pages || [])) {
          if (Number.isFinite(p?.pageNumber)) {
            mergedPages.set(p.pageNumber, p);
          }
        }
      }

      if (mergedTexts.length > 0) {
        return {
          text: mergedTexts.join('\n\n'),
          pages: [...mergedPages.values()].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0)),
          usedPagedFallback: true,
          modelId: fallbackModel
        };
      }
    }

    const detail = firstPassErrors.length > 0 ? ` Detalhes: ${firstPassErrors.join(' | ')}` : '';
    throw new Error(`Document Intelligence concluiu, mas sem conteúdo textual extraído.${detail}`);
  }

  const firstPages = Array.isArray(firstPass.pages) ? firstPass.pages : [];
  const firstCount = firstPages.length;

  if (!totalPagesHint || totalPagesHint <= firstCount) {
    return {
      ...firstPass,
      modelId
    };
  }

  const mergedPages = new Map();
  const mergedTexts = [];

  if (firstPass.text) mergedTexts.push(firstPass.text);
  for (const p of firstPages) {
    if (Number.isFinite(p?.pageNumber)) {
      mergedPages.set(p.pageNumber, p);
    }
  }

  let improved = false;
  for (let start = 1; start <= totalPagesHint; start += DOCINTEL_FALLBACK_BATCH_SIZE) {
    const end = Math.min(totalPagesHint, start + DOCINTEL_FALLBACK_BATCH_SIZE - 1);
    const range = `${start}-${end}`;

    try {
      const pass = await runDocumentIntelligenceAnalyze(pdfBase64, docIntelConfig, range, modelId);
      if (pass.text) {
        mergedTexts.push(pass.text);
      }

      for (const p of (pass.pages || [])) {
        if (Number.isFinite(p?.pageNumber)) {
          if (!mergedPages.has(p.pageNumber)) improved = true;
          mergedPages.set(p.pageNumber, p);
        }
      }
    } catch {
      // mantém o resultado inicial se algum range falhar
    }
  }

  const mergedPageList = [...mergedPages.values()].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
  if (improved && mergedPageList.length > firstCount) {
    return {
      text: mergedTexts.join('\n\n'),
      pages: mergedPageList,
      usedPagedFallback: true,
      modelId
    };
  }

  return {
    ...firstPass,
    modelId
  };
}

async function runAzureOpenAIExtraction(ocrText, openAiConfig, fileName = '', options = {}) {
  const endpoint = sanitizeEndpoint(openAiConfig.endpoint);
  const apiVersion = openAiConfig.apiVersion || DEFAULT_OPENAI_API_VERSION;

  const hasDirectChatPath = /\/openai\/deployments\/.+\/chat\/completions/i.test(endpoint);
  const chatUrl = hasDirectChatPath
    ? endpoint
    : `${endpoint}/openai/deployments/${encodeURIComponent(openAiConfig.deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const systemPrompt = [
    'Você é um extrator geoespacial para documentos fundiários/cartoriais brasileiros.',
    'Tarefa: converter texto OCR em um GeoJSON de polígono, pronto para GIS.',
    'Regras obrigatórias:',
    '1) Responder SOMENTE um JSON válido seguindo o schema fornecido.',
    '2) Não incluir markdown, comentários ou texto fora do JSON.',
    '3) GeoJSON deve ser FeatureCollection com 1 Feature Polygon.',
    '4) O anel do polígono deve estar fechado (primeiro ponto = último ponto).',
    '5) Coordenadas no padrão [x, y] => [este, norte] em metros quando CRS for UTM/SIRGAS/SAD.',
    '6) Se houver coordenadas explícitas (UTM, geográficas, DMS), NÃO inferir, suavizar, reordenar, aproximar ou interpolar; use apenas valores explícitos.',
    '7) Preserve a ordem dos vértices conforme o memorial/documento.',
    '8) Se o documento usar vírgula decimal, converta apenas para ponto decimal, sem alterar magnitude.',
    '9) Captura TOTAL: extraia todos os vértices encontrados (não resumir, não amostrar, não truncar lista).',
    '10) Se houver sequência de identificação de vértices (ex.: V001..V130, P1..Pn, M-01..M-xx), a quantidade de pontos no anel deve refletir toda a sequência útil encontrada no texto.',
    '11) Priorize linhas/tabulações que contenham pares numéricos de coordenadas (N/Y com E/X), mesmo quando existirem colunas extras (azimute, distância, confrontante, observações).',
    '12) Ignore repetições de cabeçalho/rodapé e repetições exatas da mesma linha OCR; mantenha apenas a sequência real dos vértices.',
    '13) Se houver múltiplos blocos de coordenadas, escolha o bloco principal do perímetro do imóvel com maior cardinalidade de vértices.',
    '14) Quando NÃO houver coordenadas absolutas e o documento trouxer apenas rumo/azimute + distância, construa polígono LOCAL RELATIVO: ponto inicial [0,0], acumule segmentos na ordem textual, feche o anel e use projectionKey="LOCAL_RELATIVE".',
    '15) Para azimute use convenção topográfica: 0° = Norte, crescimento horário.',
    '16) Para rumo quadrantal (ex.: N 35°20\' E), converta para direção cartesiana equivalente.',
    '17) Nesses casos locais relativos, informe geometryMode="local_relative" e inclua warning indicando necessidade de georreferenciamento manual posterior.',
    '18) Sempre retornar também sourcePattern em {"utm","latlong","rumo_distancia","azimute_distancia","misto","desconhecido"}.'
  ].join('\n');

  const focusedText = buildCoordinateFocusedText(ocrText);
  const compactOcrText = String(ocrText || '').slice(0, 80000);
  const compactFocusedText = String(focusedText || '').slice(0, 80000);
  const expectedVertices = Number.isFinite(options.expectedVertices) ? options.expectedVertices : 0;
  const minimumVertices = Number.isFinite(options.minimumVertices) ? options.minimumVertices : 0;
  const previousVertices = Number.isFinite(options.previousVertices) ? options.previousVertices : 0;

  const userPrompt = [
    `Arquivo: ${fileName || 'documento.pdf'}`,
    `Páginas OCR detectadas: ${options.pagesAnalyzed || 'desconhecido'}`,
    expectedVertices > 0 ? `Meta de cobertura: extrair aproximadamente ${expectedVertices} vértices (mínimo aceitável ${minimumVertices || expectedVertices}).` : 'Meta de cobertura: extrair todos os vértices disponíveis no documento.',
    previousVertices > 0 ? `Extração anterior parcial: ${previousVertices} vértices. É obrigatório melhorar a cobertura nesta tentativa.` : 'Primeira tentativa de extração.',
    'Extraia matrícula (se existir), CRS provável e geometria do imóvel em GeoJSON.',
    'A geometria deve conter TODOS os vértices do perímetro principal presentes no documento, sem omissões.',
    'Não reduza para amostra; não retorne apenas 30-40 pontos se houver mais de 100 no texto.',
    'Se o documento for apenas rumo/azimute+distância, retornar geometria local relativa fechada para georreferenciamento manual posterior.',
    'Use prioritariamente o trecho focado em coordenadas abaixo para montar o anel completo:',
    compactFocusedText || '(sem trecho focado disponível)',
    'Texto OCR bruto completo abaixo (contexto adicional):',
    compactOcrText
  ].join('\n\n');

  const responseFormat = { type: 'json_object' };

  let openAiPayload = {};
  for (let attempt = 0; attempt <= MAX_OPENAI_RETRIES; attempt++) {
    const openAiResponse = await httpFetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': openAiConfig.apiKey
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0,
        max_tokens: 8000,
        response_format: responseFormat
      })
    });

    openAiPayload = await openAiResponse.json().catch(() => ({}));
    if (openAiResponse.ok) {
      break;
    }

    const msg = getErrorMessage(openAiPayload);
    const transientStatus = openAiResponse.status === 429 || openAiResponse.status === 500 || openAiResponse.status === 503 || openAiResponse.status === 504;
    const backendFailure = /backend call failure/i.test(String(msg));
    if ((transientStatus || backendFailure) && attempt < MAX_OPENAI_RETRIES) {
      const waitMs = OPENAI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Azure OpenAI falhou: ${openAiResponse.status} - ${msg}`);
  }

  const message = openAiPayload.choices?.[0]?.message || {};

  if (message.parsed && typeof message.parsed === 'object') {
    return message.parsed;
  }

  const candidates = [
    message.content,
    message.text,
    openAiPayload.output_text,
    openAiPayload.response?.output_text
  ];

  for (const candidate of candidates) {
    const normalized = extractJsonFromModelContent(candidate);
    const parsed = tryParseJsonText(normalized);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  }

  throw new Error('Azure OpenAI não retornou JSON válido no formato esperado.');
}

function validateGeoJsonPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload da IA inválido.');
  }

  let geojson = payload.geojson;
  const repaired = tryCoercePayloadGeoJson(payload);
  if (repaired) {
    payload.geojson = repaired;
    geojson = repaired;
  }

  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    throw new Error('GeoJSON inválido: esperado FeatureCollection com features.');
  }

  let geometry = geojson.features[0]?.geometry;
  const coercedGeometry = coercePolygonGeometry(geometry);
  if (coercedGeometry) {
    geojson.features[0].geometry = coercedGeometry;
    geometry = coercedGeometry;
  }

  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || !Array.isArray(geometry.coordinates[0])) {
    const lastResortRing = normalizeRingFromAnyPoints(geometry?.coordinates ?? geometry);
    if (lastResortRing) {
      geojson.features[0].geometry = { type: 'Polygon', coordinates: [lastResortRing] };
      geometry = geojson.features[0].geometry;
    }
  }

  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || !Array.isArray(geometry.coordinates[0])) {
    const gType = String(geometry?.type || typeof geometry);
    const coordType = String(typeof geometry?.coordinates);
    throw new Error(`GeoJSON inválido: esperado Polygon com coordinates. Recebido geometry.type=${gType}, coordinatesType=${coordType}.`);
  }

  const ring = geometry.coordinates[0];
  if (ring.length < 4) {
    throw new Error('GeoJSON inválido: polígono com menos de 4 vértices no anel externo.');
  }

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!Array.isArray(first) || !Array.isArray(last) || first.length < 2 || last.length < 2) {
    throw new Error('GeoJSON inválido: vértices malformados.');
  }

  for (let i = 0; i < ring.length; i++) {
    const point = ring[i];
    if (!Array.isArray(point) || point.length < 2) {
      throw new Error('GeoJSON inválido: vértices malformados.');
    }

    const x = parseNumericValue(point[0]);
    const y = parseNumericValue(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('GeoJSON inválido: coordenadas não numéricas.');
    }

    ring[i] = [x, y];
  }

  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([ring[0][0], ring[0][1]]);
  }

  if (!payload.projectionKey) {
    const p = ring[0];
    if (Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) {
      payload.projectionKey = 'WGS84';
    }
  }

  if (String(payload.projectionKey || '').toUpperCase() === 'LOCAL_RELATIVE') {
    const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    warnings.push('Geometria local relativa (rumo/azimute + distância), requer georreferenciamento manual em GIS.');
    payload.warnings = [...new Set(warnings)];
    payload.geometryMode = 'local_relative';
  }

  return payload;
}

function normalizeModelPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (payload.geojson) {
    return payload;
  }

  const base = {
    matricula: String(payload.matricula || ''),
    projectionKey: String(payload.projectionKey || ''),
    geometryMode: String(payload.geometryMode || ''),
    sourcePattern: String(payload.sourcePattern || ''),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : []
  };

  if (payload.type === 'FeatureCollection' && Array.isArray(payload.features)) {
    return { ...base, geojson: payload };
  }

  if (payload.type === 'Feature' && payload.geometry) {
    return { ...base, geojson: { type: 'FeatureCollection', features: [payload] } };
  }

  if (payload.type === 'Polygon' && Array.isArray(payload.coordinates)) {
    return {
      ...base,
      geojson: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: payload, properties: {} }]
      }
    };
  }

  if (payload.geometry?.type === 'Polygon' && Array.isArray(payload.geometry.coordinates)) {
    return {
      ...base,
      geojson: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: payload.geometry, properties: payload.properties || {} }]
      }
    };
  }

  if (payload.result?.geojson) {
    return {
      ...base,
      geojson: payload.result.geojson,
      warnings: base.warnings.concat(Array.isArray(payload.result.warnings) ? payload.result.warnings : [])
    };
  }

  return payload;
}

module.exports = async function (context, req) {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    context.res = {
      status: 200,
      headers: corsHeaders,
      body: { ok: true }
    };
    return;
  }

  if (req.method !== 'POST') {
    context.res = {
      status: 405,
      headers: corsHeaders,
      body: { error: 'Método não permitido' }
    };
    return;
  }

  const env = process.env || {};

  const openAiConfig = {
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    apiKey: env.AZURE_OPENAI_API_KEY,
    deployment: env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: env.AZURE_OPENAI_API_VERSION || DEFAULT_OPENAI_API_VERSION
  };

  const usesDirectChatEndpoint = /\/openai\/deployments\/.+\/chat\/completions/i.test(String(openAiConfig.endpoint || ''));

  const docIntelConfig = {
    endpoint: env.AZURE_DOCUMENTINTELLIGENCE_ENDPOINT,
    apiKey: env.AZURE_DOCUMENTINTELLIGENCE_KEY,
    apiVersion: env.AZURE_DOCUMENTINTELLIGENCE_API_VERSION || DEFAULT_DOCINTEL_API_VERSION
  };

  if (USE_AZURE_AI && (!openAiConfig.endpoint || !openAiConfig.apiKey || (!usesDirectChatEndpoint && !openAiConfig.deployment))) {
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: {
        error: 'Configuração Azure OpenAI incompleta. Defina endpoint e api key; deployment é obrigatório quando o endpoint não for o chat/completions completo.'
      }
    };
    return;
  }

  const contentType = String(req?.headers?.['content-type'] || req?.headers?.['Content-Type'] || '').toLowerCase();
  let normalizedPdfBase64 = '';
  let localOcrText = '';
  let fileName = '';
  let totalPagesHint = 0;

  if (contentType.includes('application/pdf')) {
    fileName = String(req?.query?.fileName || req?.headers?.['x-file-name'] || 'documento.pdf');
    totalPagesHint = Number(req?.query?.totalPagesHint || req?.headers?.['x-total-pages-hint'] || 0);

    const rawPdfBody = req.rawBody ?? req.body;
    normalizedPdfBase64 = normalizePdfBase64(toBase64FromRawPdfBody(rawPdfBody));
  } else {
    let parsedBody = req.body;
    if (typeof parsedBody === 'string') {
      try {
        parsedBody = JSON.parse(parsedBody);
      } catch {
        parsedBody = {};
      }
    }

    const payloadPdfBase64 = parsedBody?.pdfBase64;
    localOcrText = String(parsedBody?.ocrText || '').trim();
    fileName = parsedBody?.fileName;
    totalPagesHint = Number(parsedBody?.totalPagesHint || 0);

    if ((!payloadPdfBase64 || typeof payloadPdfBase64 !== 'string') && !localOcrText) {
      context.res = {
        status: 400,
        headers: corsHeaders,
        body: {
          error: 'Envie pdfBase64 (PDF em Base64) ou ocrText (texto OCR já extraído).'
        }
      };
      return;
    }

    if (payloadPdfBase64 && typeof payloadPdfBase64 === 'string') {
      normalizedPdfBase64 = normalizePdfBase64(payloadPdfBase64);
    }
  }

  if (!USE_AZURE_AI && !localOcrText) {
    context.res = {
      status: 400,
      headers: corsHeaders,
      body: {
        error: 'Fluxo sem Azure ativo: envie ocrText no payload para extração.'
      }
    };
    return;
  }

  if (USE_AZURE_AI && !localOcrText && !looksLikePdfBase64(normalizedPdfBase64)) {
    context.res = {
      status: 400,
      headers: corsHeaders,
      body: {
        error: 'PDF inválido ou base64 malformado. Envie o arquivo PDF em Base64 válido.'
      }
    };
    return;
  }

  if (USE_AZURE_AI && !localOcrText && (!docIntelConfig.endpoint || !docIntelConfig.apiKey)) {
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: {
        error: 'Configuração Azure Document Intelligence incompleta. Defina endpoint e key.'
      }
    };
    return;
  }

  try {
    if (localOcrText) {
      const heuristic = buildHeuristicGeojsonFromText(localOcrText);
      if (heuristic) {
        context.res = {
          status: 200,
          headers: corsHeaders,
          body: {
            success: true,
            matricula: '',
            projectionKey: heuristic.projectionKey,
            geometryMode: 'absolute',
            sourcePattern: heuristic.sourcePattern,
            warnings: ['Geometria gerada por fallback heurístico a partir do OCR local.'],
            geojson: heuristic.geojson,
            pagesAnalyzed: 0,
            pageNumbers: [],
            pagesRequestedHint: Number.isFinite(Number(totalPagesHint)) ? Number(totalPagesHint) : 0,
            usedPagedFallback: false,
            textSourceUsed: 'client-ocr-heuristic',
            expectedVertices: heuristic.extractedVertices,
            extractedVertices: heuristic.extractedVertices
          }
        };
        return;
      }
    }

    if (!USE_AZURE_AI) {
      const ring = extractUtmRingFromText(localOcrText);
      if (!ring) {
        throw new Error('Não foi possível localizar coordenadas UTM válidas no OCR enviado.');
      }

      const extractedVertices = Math.max(0, ring.length - 1);
      context.res = {
        status: 200,
        headers: corsHeaders,
        body: {
          success: true,
          matricula: '',
          projectionKey: 'SIRGAS2000_22S',
          geometryMode: 'absolute',
          sourcePattern: 'ocr-text',
          warnings: ['Extração executada sem Azure (parser do workspace).'],
          geojson: {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }]
          },
          pagesAnalyzed: 0,
          pageNumbers: [],
          pagesRequestedHint: Number.isFinite(Number(totalPagesHint)) ? Number(totalPagesHint) : 0,
          usedPagedFallback: false,
          textSourceUsed: 'client-ocr-text',
          expectedVertices: estimateExpectedVertexCount(localOcrText),
          extractedVertices
        }
      };
      return;
    }

    const ocrResult = localOcrText
      ? {
        text: localOcrText,
        pages: [],
        usedPagedFallback: false,
        modelId: 'client-ocr-text'
      }
      : await runDocumentIntelligence(normalizedPdfBase64, docIntelConfig, {
        totalPagesHint: Number.isFinite(Number(totalPagesHint)) ? Number(totalPagesHint) : 0
      });
    const expectedVertices = estimateExpectedVertexCount(ocrResult.text);
    const minimumAcceptable = expectedVertices >= 20
      ? Math.floor(expectedVertices * 0.75)
      : 0;
    const pagesAnalyzed = Array.isArray(ocrResult.pages) ? ocrResult.pages.length : 0;
    const pageNumbers = Array.isArray(ocrResult.pages)
      ? ocrResult.pages.map((p) => p?.pageNumber).filter((n) => Number.isFinite(n))
      : [];

    let llmResult = await runAzureOpenAIExtraction(ocrResult.text, openAiConfig, fileName, {
      pagesAnalyzed,
      expectedVertices,
      minimumVertices: minimumAcceptable
    });
    let normalized = normalizeModelPayload(llmResult);
    let validated = validateGeoJsonPayload(normalized);
    let extractedVertices = getExtractedVertexCount(validated);
    const additionalWarnings = [];

    if (minimumAcceptable > 0 && extractedVertices < minimumAcceptable) {
      const focusedText = buildCoordinateFocusedText(ocrResult.text);

      if (focusedText && focusedText.length > 40) {
        try {
          const rescueResult = await runAzureOpenAIExtraction(
            focusedText,
            openAiConfig,
            `${fileName || 'documento.pdf'} [RESGATE]`,
            {
              pagesAnalyzed,
              expectedVertices,
              minimumVertices: minimumAcceptable,
              previousVertices: extractedVertices
            }
          );

          const rescueNormalized = normalizeModelPayload(rescueResult);
          const rescueValidated = validateGeoJsonPayload(rescueNormalized);
          const rescueExtractedVertices = getExtractedVertexCount(rescueValidated);

          if (rescueExtractedVertices > extractedVertices) {
            validated = rescueValidated;
            extractedVertices = rescueExtractedVertices;
            additionalWarnings.push(`Extração de resgate aplicada: ${extractedVertices}/${expectedVertices} vértices.`);
          } else {
            additionalWarnings.push(`Extração parcial mantida: ${extractedVertices}/${expectedVertices} vértices.`);
          }
        } catch (rescueError) {
          additionalWarnings.push(`Resgate não melhorou a extração: ${rescueError?.message || 'falha desconhecida'}.`);
        }
      } else {
        additionalWarnings.push(`Extração parcial: ${extractedVertices}/${expectedVertices} vértices (OCR focado insuficiente).`);
      }
    }

    if (minimumAcceptable > 0 && extractedVertices < minimumAcceptable) {
      try {
        const coverageRetry = await runAzureOpenAIExtraction(
          ocrResult.text,
          openAiConfig,
          `${fileName || 'documento.pdf'} [COBERTURA]`,
          {
            pagesAnalyzed,
            expectedVertices,
            minimumVertices: minimumAcceptable,
            previousVertices: extractedVertices
          }
        );

        const coverageNormalized = normalizeModelPayload(coverageRetry);
        const coverageValidated = validateGeoJsonPayload(coverageNormalized);
        const coverageExtracted = getExtractedVertexCount(coverageValidated);

        if (coverageExtracted > extractedVertices) {
          validated = coverageValidated;
          extractedVertices = coverageExtracted;
          additionalWarnings.push(`Reprocessamento de cobertura aplicado: ${extractedVertices}/${expectedVertices} vértices.`);
        }
      } catch (coverageError) {
        additionalWarnings.push(`Reprocessamento de cobertura falhou: ${coverageError?.message || 'falha desconhecida'}.`);
      }
    }

    const finalWarnings = [
      ...(Array.isArray(validated.warnings) ? validated.warnings : []),
      ...additionalWarnings
    ];

    context.res = {
      status: 200,
      headers: corsHeaders,
      body: {
        success: true,
        matricula: validated.matricula || '',
        projectionKey: validated.projectionKey || '',
        geometryMode: validated.geometryMode || '',
        sourcePattern: validated.sourcePattern || '',
        warnings: [...new Set(finalWarnings)],
        geojson: validated.geojson,
        pagesAnalyzed,
        pageNumbers,
        pagesRequestedHint: Number.isFinite(Number(totalPagesHint)) ? Number(totalPagesHint) : 0,
        usedPagedFallback: !!ocrResult.usedPagedFallback,
        textSourceUsed: localOcrText ? 'client-ocr-text' : 'document-intelligence',
        expectedVertices,
        extractedVertices
      }
    };
  } catch (error) {
    context.log.error('[pdf-to-geojson] erro:', error);
    const message = error?.message || 'Falha ao processar PDF com IA Azure.';
    const isNonTransient = /GeoJSON inválido|não retornou JSON válido|Payload da IA inválido|Extração incompleta|Document Intelligence \(analyze\) falhou: 400|Invalid request|não foi possível localizar coordenadas UTM válidas/i.test(message);
    context.res = {
      status: isNonTransient ? 422 : 502,
      headers: corsHeaders,
      body: {
        success: false,
        error: message
      }
    };
  }
};
