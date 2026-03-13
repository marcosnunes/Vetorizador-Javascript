/* global module, process */

function buildCorsHeaders(req) {
  const configuredOrigins = String(process.env.ML_INFERENCE_ALLOWED_ORIGINS || '')
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function sanitizeEndpoint(endpoint) {
  return String(endpoint || '').trim().replace(/\/$/, '');
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseMaybeJson(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      try {
        return JSON.parse(parsed);
      } catch {
        return { raw: parsed };
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function ensureFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePrediction(prediction = {}) {
  const qualidadePredita = ensureFiniteNumber(prediction.qualidadePredita, 0.5);
  const edgeThresholdRecomendado = Math.round(ensureFiniteNumber(
    prediction.edgeThresholdRecomendado,
    prediction.edgeThresholdRecomendada
  ));
  const morphologySizeRecomendado = Math.max(1, Math.round(ensureFiniteNumber(
    prediction.morphologySizeRecomendado,
    prediction.morphologySizeRecomendada
  )));
  const contrastBoostRecomendado = Number(ensureFiniteNumber(
    prediction.contrastBoostRecomendado,
    prediction.contrastBoostRecomendada
  ).toFixed(3));
  const minAreaRecomendada = Number(ensureFiniteNumber(
    prediction.minAreaRecomendada,
    prediction.minAreaRecomendado
  ).toFixed(3));
  const simplificationRecomendada = Number(ensureFiniteNumber(
    prediction.simplificationRecomendada,
    prediction.simplificationRecomendado
  ).toFixed(6));

  return {
    provider: prediction.provider || 'azure-ml',
    modelVersion: prediction.modelVersion || 'unknown',
    qualidadePredita,
    edgeThresholdRecomendado,
    morphologySizeRecomendado,
    contrastBoostRecomendado,
    minAreaRecomendada,
    simplificationRecomendada,
    minAreaRecomendado: minAreaRecomendada,
    simplificationRecomendado: simplificationRecomendada,
    segmentMaskUrl: prediction.segmentMaskUrl || null,
    observacoes: Array.isArray(prediction.observacoes) ? prediction.observacoes : []
  };
}

module.exports = async function handler(context, req) {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: corsHeaders, body: '' };
    return;
  }

  const enabled = toBoolean(process.env.AZURE_AI_ENABLED, true);
  const endpoint = sanitizeEndpoint(process.env.AZURE_ML_ENDPOINT_URL);
  const key = String(process.env.AZURE_ML_ENDPOINT_KEY || '').trim();
  const deploymentName = String(process.env.AZURE_ML_DEPLOYMENT_NAME || '').trim();
  const hasConfig = Boolean(endpoint && key);

  if (req.method === 'GET') {
    context.res = {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: {
        ok: true,
        enabled,
        configured: hasConfig,
        available: enabled && hasConfig,
        provider: 'azure-ml-proxy'
      }
    };
    return;
  }

  if (req.method !== 'POST') {
    context.res = {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: { error: 'Method not allowed' }
    };
    return;
  }

  if (!enabled) {
    context.res = {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: { error: 'Azure AI disabled by configuration.' }
    };
    return;
  }

  if (!hasConfig) {
    context.res = {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: { error: 'Azure ML endpoint not configured.' }
    };
    return;
  }

  const payload = req?.body && typeof req.body === 'object' ? req.body : {};

  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    };
    if (deploymentName) {
      headers['azureml-model-deployment'] = deploymentName;
    }

    const azureResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const rawText = await azureResponse.text();
    const parsedBody = parseMaybeJson(rawText);

    if (!azureResponse.ok) {
      context.res = {
        status: azureResponse.status || 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: {
          error: 'Azure ML request failed.',
          status: azureResponse.status || 502,
          details: parsedBody || rawText || null
        }
      };
      return;
    }

    const normalized = normalizePrediction(parsedBody || {});

    context.res = {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: normalized
    };
  } catch (error) {
    context.res = {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: {
        error: 'Azure ML proxy execution failed.',
        details: String(error?.message || error || 'Unknown error')
      }
    };
  }
};
