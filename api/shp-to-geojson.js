import shp from 'shpjs';
import { Buffer } from 'node:buffer';

function buildCorsHeaders(req) {
  const env = (globalThis.process && globalThis.process.env)
    ? globalThis.process.env
    : {};

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

export default async function handler(req, res) {
  const corsHeaders = buildCorsHeaders(req);
  res.setHeader('Access-Control-Allow-Origin', corsHeaders['Access-Control-Allow-Origin']);
  res.setHeader('Access-Control-Allow-Methods', corsHeaders['Access-Control-Allow-Methods']);
  res.setHeader('Access-Control-Allow-Headers', corsHeaders['Access-Control-Allow-Headers']);
  res.setHeader('Access-Control-Max-Age', corsHeaders['Access-Control-Max-Age']);
  res.setHeader('Vary', corsHeaders.Vary);

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido.' });
  }

  try {
    const zipBase64 = req?.body?.zipBase64;
    const fileName = req?.body?.fileName || 'arquivo.zip';

    if (!zipBase64 || typeof zipBase64 !== 'string') {
      return res.status(400).json({ success: false, error: 'Campo zipBase64 é obrigatório e deve ser string.' });
    }

    const zipArrayBuffer = toArrayBufferFromBase64(zipBase64);
    const geoRaw = await shp(zipArrayBuffer);
    const geojson = normalizeShpResult(geoRaw);

    if (!Array.isArray(geojson.features) || geojson.features.length === 0) {
      return res.status(422).json({ success: false, error: 'Shapefile ZIP não contém features válidas.' });
    }

    return res.status(200).json({
      success: true,
      fileName,
      totalFeatures: geojson.features.length,
      geojson
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: `Falha ao converter shapefile ZIP: ${error?.message || 'erro desconhecido'}`
    });
  }
}
