/* global require, module, process, Buffer */

const DEFAULT_OPENAI_API_VERSION = '2024-10-21';
const DEFAULT_DOCINTEL_API_VERSION = '2024-11-30';
const MAX_DOCINTEL_POLLS = 60;
const POLL_INTERVAL_MS = 2000;
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

async function runDocumentIntelligence(pdfBase64, docIntelConfig) {
  const endpoint = sanitizeEndpoint(docIntelConfig.endpoint);
  const apiVersion = docIntelConfig.apiVersion || DEFAULT_DOCINTEL_API_VERSION;

  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${encodeURIComponent(apiVersion)}`;

  const analyzeResponse = await httpFetch(analyzeUrl, {
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
    '6) NÃO inferir, suavizar, reordenar, aproximar ou interpolar coordenadas; use apenas valores explícitos no texto OCR.',
    '7) Preserve a ordem dos vértices conforme o memorial/documento.',
    '8) Se o documento usar vírgula decimal, converta apenas para ponto decimal, sem alterar magnitude.',
    '9) Captura TOTAL: extraia todos os vértices encontrados (não resumir, não amostrar, não truncar lista).',
    '10) Se houver sequência de identificação de vértices (ex.: V001..V130, P1..Pn, M-01..M-xx), a quantidade de pontos no anel deve refletir toda a sequência útil encontrada no texto.',
    '11) Priorize linhas/tabulações que contenham pares numéricos de coordenadas (N/Y com E/X), mesmo quando existirem colunas extras (azimute, distância, confrontante, observações).',
    '12) Ignore repetições de cabeçalho/rodapé e repetições exatas da mesma linha OCR; mantenha apenas a sequência real dos vértices.',
    '13) Se houver múltiplos blocos de coordenadas, escolha o bloco principal do perímetro do imóvel com maior cardinalidade de vértices.',
    '14) Se não conseguir extrair com confiabilidade, retornar erro lógico no campo warnings e geometria mínima válida quando possível.'
  ].join('\n');

  const userPrompt = [
    `Arquivo: ${fileName || 'documento.pdf'}`,
    'Extraia matrícula (se existir), CRS provável e geometria do imóvel em GeoJSON.',
    'A geometria deve conter TODOS os vértices do perímetro principal presentes no documento, sem omissões.',
    'Não reduza para amostra; não retorne apenas 30-40 pontos se houver mais de 100 no texto.',
    'Texto OCR bruto abaixo:',
    ocrText
  ].join('\n\n');

  const responseFormat = { type: 'json_object' };

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

  if (!openAiConfig.endpoint || !openAiConfig.apiKey || (!usesDirectChatEndpoint && !openAiConfig.deployment)) {
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: {
        error: 'Configuração Azure OpenAI incompleta. Defina endpoint e api key; deployment é obrigatório quando o endpoint não for o chat/completions completo.'
      }
    };
    return;
  }

  if (!docIntelConfig.endpoint || !docIntelConfig.apiKey) {
    context.res = {
      status: 500,
      headers: corsHeaders,
      body: {
        error: 'Configuração Azure Document Intelligence incompleta. Defina endpoint e key.'
      }
    };
    return;
  }

  let parsedBody = req.body;
  if (typeof parsedBody === 'string') {
    try {
      parsedBody = JSON.parse(parsedBody);
    } catch {
      parsedBody = {};
    }
  }

  const { pdfBase64, fileName } = parsedBody || {};
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    context.res = {
      status: 400,
      headers: corsHeaders,
      body: {
        error: 'Campo pdfBase64 é obrigatório e deve ser string Base64 do PDF.'
      }
    };
    return;
  }

  try {
    const ocrResult = await runDocumentIntelligence(pdfBase64, docIntelConfig);
    const llmResult = await runAzureOpenAIExtraction(ocrResult.text, openAiConfig, fileName);
    const normalized = normalizeModelPayload(llmResult);
    const validated = validateGeoJsonPayload(normalized);

    context.res = {
      status: 200,
      headers: corsHeaders,
      body: {
        success: true,
        matricula: validated.matricula || '',
        projectionKey: validated.projectionKey || '',
        warnings: Array.isArray(validated.warnings) ? validated.warnings : [],
        geojson: validated.geojson,
        pagesAnalyzed: Array.isArray(ocrResult.pages) ? ocrResult.pages.length : 0
      }
    };
  } catch (error) {
    context.log.error('[pdf-to-geojson] erro:', error);
    const message = error?.message || 'Falha ao processar PDF com IA Azure.';
    const isNonTransient = /GeoJSON inválido|não retornou JSON válido|Payload da IA inválido/i.test(message);
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
