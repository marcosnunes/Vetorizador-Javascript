/* global module, Buffer, process, require */

const shp = require('shpjs');

function buildCorsHeaders(req) {
  const env = process.env || {};
  const configuredOrigins = String(env.SHP_TO_GEOJSON_ALLOWED_ORIGINS || '')
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

function toArrayBufferFromBase64(base64Value) {
  const normalized = String(base64Value || '').trim().replace(/\s+/g, '');
  if (!normalized) {
    throw new Error('Campo zipBase64 é obrigatório.');
  }

  const buffer = Buffer.from(normalized, 'base64');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function normalizeShpResult(result) {
  if (!result) {
    throw new Error('Nenhum dado geográfico encontrado no shapefile ZIP.');
  }

  if (result.type === 'FeatureCollection' && Array.isArray(result.features)) {
    return result;
  }

  if (Array.isArray(result)) {
    const features = result.flatMap((entry) => {
      if (entry?.type === 'FeatureCollection' && Array.isArray(entry.features)) {
        return entry.features;
      }
      return [];
    });

    return {
      type: 'FeatureCollection',
      features
    };
  }

  throw new Error('Formato retornado do shapefile inválido.');
}

module.exports = async function handler(context, req) {
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
      body: { success: false, error: 'Método não permitido.' }
    };
    return;
  }

  try {
    const zipBase64 = req?.body?.zipBase64;
    const fileName = req?.body?.fileName || 'arquivo.zip';

    if (!zipBase64 || typeof zipBase64 !== 'string') {
      context.res = {
        status: 400,
        headers: corsHeaders,
        body: { success: false, error: 'Campo zipBase64 é obrigatório e deve ser string.' }
      };
      return;
    }

    const zipArrayBuffer = toArrayBufferFromBase64(zipBase64);
    const geoRaw = await shp(zipArrayBuffer);
    const geojson = normalizeShpResult(geoRaw);

    if (!Array.isArray(geojson.features) || geojson.features.length === 0) {
      context.res = {
        status: 422,
        headers: corsHeaders,
        body: { success: false, error: 'Shapefile ZIP não contém features válidas.' }
      };
      return;
    }

    context.res = {
      status: 200,
      headers: corsHeaders,
      body: {
        success: true,
        fileName,
        totalFeatures: geojson.features.length,
        geojson
      }
    };
  } catch (error) {
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: {
        success: false,
        error: `Falha ao converter shapefile ZIP: ${error?.message || 'erro desconhecido'}`
      }
    };
  }
};
