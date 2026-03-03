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
    const normalized = value.trim().replace(/\s+/g, '').replace(',', '.');
    if (!normalized) return null;
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
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

async function runDocumentIntelligence(pdfBase64, docIntelConfig) {
  const endpoint = sanitizeEndpoint(docIntelConfig.endpoint);
  const apiVersion = docIntelConfig.apiVersion || DEFAULT_DOCINTEL_API_VERSION;

  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${encodeURIComponent(apiVersion)}`;

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
  const compactOcrText = String(ocrText || '').slice(0, 220000);
  const compactFocusedText = String(focusedText || '').slice(0, 220000);
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
    const expectedVertices = estimateExpectedVertexCount(ocrResult.text);
    const minimumAcceptable = expectedVertices >= 20
      ? Math.floor(expectedVertices * 0.75)
      : 0;
    const pagesAnalyzed = Array.isArray(ocrResult.pages) ? ocrResult.pages.length : 0;

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

    return res.status(200).json({
      success: true,
      matricula: validated.matricula || '',
      projectionKey: validated.projectionKey || '',
      geometryMode: validated.geometryMode || '',
      sourcePattern: validated.sourcePattern || '',
      warnings: [...new Set(finalWarnings)],
      geojson: validated.geojson,
      pagesAnalyzed,
      textSourceUsed: 'document-intelligence',
      expectedVertices,
      extractedVertices
    });
  } catch (error) {
    console.error('[pdf-to-geojson] erro:', error);
    const message = error?.message || 'Falha ao processar PDF com IA Azure.';
    const isNonTransient = /GeoJSON inválido|não retornou JSON válido|Payload da IA inválido|Extração incompleta/i.test(message);
    return res.status(isNonTransient ? 422 : 502).json({
      success: false,
      error: message
    });
  }
}
