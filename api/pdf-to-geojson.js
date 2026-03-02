const DEFAULT_OPENAI_API_VERSION = '2024-10-21';
const DEFAULT_DOCINTEL_API_VERSION = '2024-11-30';
const MAX_DOCINTEL_POLLS = 60;
const POLL_INTERVAL_MS = 2000;

function sanitizeEndpoint(endpoint) {
  return String(endpoint || '').trim().replace(/\/$/, '');
}

function buildCorsHeaders(req) {
  const env = (globalThis.process && globalThis.process.env)
    ? globalThis.process.env
    : {};

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runDocumentIntelligence(pdfBase64, docIntelConfig) {
  const endpoint = sanitizeEndpoint(docIntelConfig.endpoint);
  const apiVersion = docIntelConfig.apiVersion || DEFAULT_DOCINTEL_API_VERSION;

  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${encodeURIComponent(apiVersion)}`;

  const analyzeResponse = await fetch(analyzeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': docIntelConfig.apiKey
    },
    body: JSON.stringify({ base64Source: pdfBase64 })
  });

  if (!analyzeResponse.ok) {
    const errorPayload = await analyzeResponse.json().catch(() => ({}));
    throw new Error(`Document Intelligence (analyze) falhou: ${analyzeResponse.status} - ${getErrorMessage(errorPayload)}`);
  }

  const operationLocation = analyzeResponse.headers.get('operation-location');
  if (!operationLocation) {
    throw new Error('Document Intelligence não retornou operation-location.');
  }

  for (let attempt = 0; attempt < MAX_DOCINTEL_POLLS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const pollResponse = await fetch(operationLocation, {
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
      const content = pollPayload.analyzeResult?.content || '';
      if (!content.trim()) {
        throw new Error('Document Intelligence concluiu, mas sem conteúdo textual extraído.');
      }
      return {
        text: content,
        pages: pollPayload.analyzeResult?.pages || []
      };
    }

    if (status === 'failed' || status === 'canceled') {
      throw new Error(`Document Intelligence retornou status ${status}.`);
    }
  }

  throw new Error('Timeout ao aguardar processamento do Document Intelligence.');
}

async function runAzureOpenAIExtraction(ocrText, openAiConfig, fileName = '') {
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
    '6) Se não conseguir extrair com confiabilidade, retornar erro lógico no campo warnings e geometria mínima válida quando possível.'
  ].join('\n');

  const userPrompt = [
    `Arquivo: ${fileName || 'documento.pdf'}`,
    'Extraia matrícula (se existir), CRS provável e geometria do imóvel em GeoJSON.',
    'Texto OCR bruto abaixo:',
    ocrText
  ].join('\n\n');

  const responseFormat = { type: 'json_object' };

  const openAiResponse = await fetch(chatUrl, {
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
      max_tokens: 4000,
      response_format: responseFormat
    })
  });

  const openAiPayload = await openAiResponse.json().catch(() => ({}));

  if (!openAiResponse.ok) {
    throw new Error(`Azure OpenAI falhou: ${openAiResponse.status} - ${getErrorMessage(openAiPayload)}`);
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

  const geojson = payload.geojson;
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    throw new Error('GeoJSON inválido: esperado FeatureCollection com features.');
  }

  const geometry = geojson.features[0]?.geometry;
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || !Array.isArray(geometry.coordinates[0])) {
    throw new Error('GeoJSON inválido: esperado Polygon com coordinates.');
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

  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
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
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const env = (globalThis.process && globalThis.process.env)
    ? globalThis.process.env
    : {};

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

  if (!openAiConfig.endpoint || !openAiConfig.apiKey || (!usesDirectChatEndpoint && !openAiConfig.deployment)) {
    return res.status(500).json({
      error: 'Configuração Azure OpenAI incompleta. Defina endpoint e api key; deployment é obrigatório quando o endpoint não for o chat/completions completo.'
    });
  }

  if (!docIntelConfig.endpoint || !docIntelConfig.apiKey) {
    return res.status(500).json({
      error: 'Configuração Azure Document Intelligence incompleta. Defina endpoint e key.'
    });
  }

  const { pdfBase64, fileName } = req.body || {};
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return res.status(400).json({
      error: 'Campo pdfBase64 é obrigatório e deve ser string Base64 do PDF.'
    });
  }

  try {
    const ocrResult = await runDocumentIntelligence(pdfBase64, docIntelConfig);
    const llmResult = await runAzureOpenAIExtraction(ocrResult.text, openAiConfig, fileName);
    const normalized = normalizeModelPayload(llmResult);
    const validated = validateGeoJsonPayload(normalized);

    return res.status(200).json({
      success: true,
      matricula: validated.matricula || '',
      projectionKey: validated.projectionKey || '',
      warnings: Array.isArray(validated.warnings) ? validated.warnings : [],
      geojson: validated.geojson,
      pagesAnalyzed: Array.isArray(ocrResult.pages) ? ocrResult.pages.length : 0
    });
  } catch (error) {
    console.error('[pdf-to-geojson] erro:', error);
    const message = error?.message || 'Falha ao processar PDF com IA Azure.';
    const isNonTransient = /GeoJSON inválido|não retornou JSON válido|Payload da IA inválido/i.test(message);
    return res.status(isNonTransient ? 422 : 502).json({
      success: false,
      error: message
    });
  }
}
