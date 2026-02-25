// PDFtoArcgis - fluxo IA direto (texto bruto -> JSON -> validacao)
//
// Garante que displayLogMessage está disponível (importa do global se necessário)
if (typeof displayLogMessage !== 'function' && window.displayLogMessage) {
  var displayLogMessage = window.displayLogMessage;
}

async function callOpenAIGPT4Turbo(prompt, retryCount = 0) {
  const MAX_RETRIES = 5;
  const INITIAL_DELAY_MS = 1000;
  
  const response = await fetch('/pdfspliter/api/llama-3.1-8b-instant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });
  
  if (!response.ok) {
    // Retry 429 com backoff exponencial
    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, retryCount);
      console.warn(`[PDFtoArcgis] 429 Too Many Requests. Retry ${retryCount + 1}/${MAX_RETRIES} em ${delay}ms...`);
      if (typeof displayLogMessage === 'function') {
        displayLogMessage(`[PDFtoArcgis][LogUI] Limite de taxa. Aguardando ${(delay/1000).toFixed(1)}s...`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      return callOpenAIGPT4Turbo(prompt, retryCount + 1);
    }
    
    if (typeof displayLogMessage === 'function') {
      displayLogMessage('[PDFtoArcgis] Erro na API IA: ' + response.status);
    } else {
      console.error('[PDFtoArcgis] Erro na API IA: ' + response.status);
    }
    return null;
  }
  const data = await response.json();
  return data;
}

// Texto bruto segue direto para a IA.


function repairJsonCoordinates(jsonStr) {
  if (!jsonStr) return jsonStr;
  jsonStr = String(jsonStr).trim();
  // Remover truncamento (JSON cortado)
  if (jsonStr.endsWith(',')) jsonStr = jsonStr.slice(0, -1);
  if (!jsonStr.endsWith(']') && !jsonStr.endsWith('}')) {
    if (jsonStr.includes('"vertices"')) jsonStr += ']}';
  }
  
  // === LÓGICA: Normalizar números brasileiros CORRETAMENTE ===
  // Padrão: 7.186.708,425 (com ponto de milhar + vírgula decimal)
  // Precisamos detectar:
  // 1. Se temos uma sequência tipo XXX.XXX.XXX,XXX (3 dígitos . 3 dígitos . 3 dígitos , decimais)
  // 2. Isso é número brasileiro: remover . e trocar , por .
  
  // Padrão: números com MÚLTIPLOS pontos (ponto de milhar) e vírgula final (decimal)
  // Exemplo: "7.186.708,425" ou "693.736,178"
  jsonStr = jsonStr.replace(/(\d{1,3})\.(\d{3})\.(\d{3}),(\d+)/g, (match, g1, g2, g3, g4) => {
    // XXX.XXX.XXX,DDD → XXXXXXXXX.DDD (5-10 dígitos inteiros)
    return g1 + g2 + g3 + '.' + g4;
  });
  
  // Padrão: 2 ou mais dígitos com ponto separando, terminando em vírgula
  // Exemplo: "693.736,178" → "693736.178"
  jsonStr = jsonStr.replace(/(\d{3})\.(\d{3}),(\d+)/g, '$1$2.$3');
  
  // Padrão: qualquer número com vírgula decimal dentro de JSON
  // Se for contexto de número (entre : e ,/}), converter vírgula por ponto
  jsonStr = jsonStr.replace(/("(?:norte|norte|este|east|north|azimute|distancia|lat|lon|latitude|longitude)"\s*:\s*)(-?\d+),(\d+)/g, '$1$2.$3');

  // Corrigir aspas duplas extras em azimute_dms (ex: 133°15'52"")
  jsonStr = jsonStr.replace(/("azimute_dms"\s*:\s*"[^"]*)""/g, '$1\\"');

  // Corrigir respostas com "vertices" repetido ("vertices":[...],"vertices":[...])
  jsonStr = jsonStr.replace(/\],\s*"vertices"\s*:\s*\[/g, ',');
  
  return jsonStr;
}

function mergeVerticesFromChunks(chunksResults) {
  const merged = [];
  const seen = new Set();
  for (const obj of chunksResults) {
    const verts = Array.isArray(obj?.vertices) ? obj.vertices : [];
    for (const v of verts) {
      const id = String(v.id || "").trim();
      let east = v.este ?? v.east;
      let north = v.norte ?? v.north;
      
      // Normalizar números brasileiros CORRETAMENTE:
      // Padrão: 7.186.708,425 → 7186708.425
      // Ou: 693.736,178 → 693736.178
      if (typeof east === 'string') {
        // Remover todos os pontos, depois trocar vírgula por ponto
        east = east.replace(/\./g, '').replace(/,/g, '.');
      }
      if (typeof north === 'string') {
        north = north.replace(/\./g, '').replace(/,/g, '.');
      }
      
      east = Number(east);
      north = Number(north);
      
      const key = `${id}|${east}|${north}`;
      if (!Number.isFinite(east) || !Number.isFinite(north)) continue;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ id: v.id || id, este: east, norte: north });
      }
    }
  }
  return merged;
}

function mergeLatLonFromChunks(chunksResults) {
  const merged = [];
  const seen = new Set();
  for (const obj of chunksResults) {
    const verts = Array.isArray(obj?.vertices) ? obj.vertices : [];
    for (const v of verts) {
      let lat = v.lat ?? v.latitude;
      let lon = v.lon ?? v.longitude;
      if (typeof lat === 'string') lat = lat.replace(/,/g, '.');
      if (typeof lon === 'string') lon = lon.replace(/,/g, '.');
      lat = Number(lat);
      lon = Number(lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = `${lat}|${lon}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ id: v.id || '', lat, lon });
    }
  }
  return merged;
}

// Extrai JSON de respostas com markdown ou texto extra.
function extractJSONFromResponse(rawResponse) {
  if (!rawResponse) return null;

  const str = String(rawResponse).trim();

  const extractFirstJsonBlock = (text) => {
    const startIndex = text.search(/[\[{]/);
    if (startIndex === -1) return null;

    const stack = [];
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{' || ch === '[') {
        stack.push(ch);
        continue;
      }

      if (ch === '}' || ch === ']') {
        if (stack.length === 0) return null;
        stack.pop();
        if (stack.length === 0) {
          return text.slice(startIndex, i + 1).trim();
        }
      }
    }

    return null;
  };

  // Padrão 1: JSON direto (esperado)
  if (str.startsWith('{') || str.startsWith('[')) {
    const direct = extractFirstJsonBlock(str);
    return direct || str;
  }

  // Padrão 2: JSON dentro de markdown (```json ... ```)
  const mdMatch = str.match(/```json\s*([\s\S]*?)\s*```/);
  if (mdMatch && mdMatch[1]) {
    const mdBlock = extractFirstJsonBlock(mdMatch[1].trim());
    if (mdBlock) return mdBlock;
  }

  // Padrão 3: JSON após texto explicativo
  // Procura pelo primeiro bloco JSON para evitar respostas com multiplos JSONs
  const extracted = extractFirstJsonBlock(str);
  if (extracted) return extracted;

  console.warn('[PDFtoArcgis] ⚠️ Não conseguiu extrair JSON da resposta:', str.substring(0, 100));
  return null;
}

// Corrige typos comuns em angulos DMS.
function fixDMSTypos(vertex) {
  if (!vertex.azimute_dms) return vertex;
  
  let dms = String(vertex.azimute_dms);
  
  // Substituir letra B ou O por 0, I por 1, S por 5, etc.
  dms = dms.replace(/[BOl]/gi, (match) => {
    const map = { 'B': '8', 'O': '0', 'l': '1', 'S': '5', 'I': '1' };
    return map[match.toUpperCase()] || match;
  });
  
  // Verificar se o primeiro número é válido (0-359)
  const degreeMatch = dms.match(/^(\d+)/);
  if (degreeMatch) {
    const deg = parseInt(degreeMatch[1]);
    if (deg > 360) {
      // Truncar se > 360 (ex: "3605" → "5" ou "36505" → "5")
      const degStr = String(deg);
      const corrected = parseInt(degStr.substring(degStr.length - 2)); // Últimos 2 dígitos
      if (corrected <= 360) {
        dms = dms.replace(/^(\d+)/, corrected.toString());
      }
    }
  }
  
  vertex.azimute_dms = dms;
  return vertex;
}

function parseDmsToDegrees(dms) {
  if (!dms) return null;
  const parts = String(dms).match(/-?\d+(?:\.\d+)?/g);
  if (!parts || parts.length === 0) return null;
  const deg = Math.abs(parseFloat(parts[0])) || 0;
  const min = parts.length > 1 ? Math.abs(parseFloat(parts[1])) : 0;
  const sec = parts.length > 2 ? Math.abs(parseFloat(parts[2])) : 0;
  const value = deg + (min / 60) + (sec / 3600);
  return value;
}

function normalizeAzimuth(value, dms) {
  let az = value;
  if (typeof az === 'string') az = az.replace(/,/g, '.');
  az = Number(az);
  if (!Number.isFinite(az) && dms) az = parseDmsToDegrees(dms);
  if (!Number.isFinite(az)) return null;
  az = ((az % 360) + 360) % 360;
  return az;
}

function inferUtmZoneFromLon(lon) {
  if (!Number.isFinite(lon)) return null;
  const zone = Math.floor((lon + 180) / 6) + 1;
  if (zone < 1 || zone > 60) return null;
  return zone;
}

function latLonToUtm(lat, lon, zone) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const utmZone = zone || inferUtmZoneFromLon(lon);
  if (!utmZone) return null;
  const projStr = `+proj=utm +zone=${utmZone} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  try {
    const xy = proj4(proj4.WGS84, projStr, [lon, lat]);
    return { east: xy[0], north: xy[1], zone: utmZone };
  } catch (e) {
    return null;
  }
}

function buildRelativeVerticesFromMeasures(rawVertices, startE = 0, startN = 0) {
  const vertices = [];
  let currE = startE;
  let currN = startN;
  let idx = 0;

  for (const v of rawVertices) {
    const az = normalizeAzimuth(v.azimute, v.azimute_dms);
    let dist = v.distancia;
    if (typeof dist === 'string') dist = dist.replace(/\./g, '').replace(/,/g, '.');
    dist = Number(dist);
    if (!Number.isFinite(az) || !Number.isFinite(dist)) {
      continue;
    }
    const id = v.id || `V${String(idx + 1).padStart(3, '0')}`;
    vertices.push({ id, east: currE, north: currN, ordem: idx + 1 });
    const rad = (az * Math.PI) / 180;
    currE += dist * Math.sin(rad);
    currN += dist * Math.cos(rad);
    idx++;
  }

  if (vertices.length >= 1) {
    const id = `V${String(vertices.length + 1).padStart(3, '0')}`;
    vertices.push({ id, east: currE, north: currN, ordem: vertices.length + 1 });
  }

  return vertices;
}

// Função IA para processar página por página - v2.5 otimizado
async function deducePolygonVerticesPerPage(pagesText) {
  const smallPrompt = (text) => `You are a cadastral document parser for Brazilian real estate (SIRGAS2000/UTM).

TASK: Extract ALL vertices from the RAW text below (no cleanup applied). RETURN: ONLY valid JSON. No markdown. No text before/after.

JSON: {"vertices":[{"id":"V1","este":693736.178,"norte":7186708.425,"azimute_dms":"133°15'52\"","azimute":133.2644,"distancia":24.86}]}
JSON (lat/lon): {"crs":"WGS84","vertices":[{"id":"V1","lat":-24.075847,"lon":-50.725369}]}
JSON (relative): {"modo":"relativo","vertices":[{"id":"V1","azimute_dms":"133°15'52\"","distancia":24.86}]}

RULES:
1. Este: 150k-900k, Norte: 6.9M-10.1M (omit invalid)
2. Fix typos: "B5º" -> numeric only
3. Escape double quotes in azimute_dms as \\\" (JSON valid)
4. If coordinates are in lat/lon (DMS or decimal), output decimal lat/lon (no DMS)
5. If only azimuth/distances and no coordinates exist, set modo="relativo" and return vertices with azimute/distancia only
6. Max 3 decimals, return {"vertices":[]} if empty
7. Do not invent data

Raw text from PDF (full page):
${text}`;

  const results = [];
  const latLonResults = [];
  let relativeResult = null;
  const totalPages = pagesText.length;
  let baseDelay = 5000; // ⬆️ Aumentado de 3s → 5s para evitar 429 rate limit
  
  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] 📄 IA: ${totalPages} página(s) com texto bruto`);
  }
  
  for (let i = 0; i < totalPages; i++) {
    const pageText = pagesText[i];
    if (!pageText || pageText.trim().length < 10) {
      console.log(`[PDFtoArcgis] Página ${i + 1}: vazia, pulando`);
      continue;
    }
    
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] ⏳ Página ${i + 1}/${totalPages}: preparando envio`);
    }
    
    // Enviar texto bruto completo (sem limpeza) para IA
    const textToSend = pageText;
    
    if (textToSend.trim().length < 10) {
      console.log(`[PDFtoArcgis] Página ${i + 1}: sem conteúdo para processar`);
      continue;
    }
    
    const prompt = smallPrompt(textToSend);
    console.log(`[PDFtoArcgis][LOG IA][PROMPT][PAGE ${i + 1}/${totalPages}]`, prompt.substring(0, 200) + '...');
    
    // Aguardar antes de fazer requisição (exceto primeira página)
    if (i > 0) {
      console.log(`[PDFtoArcgis] ⏳ Aguardando ${baseDelay}ms antes da próxima requisição...`);
      if (typeof displayLogMessage === 'function') {
        displayLogMessage(`[PDFtoArcgis][LogUI] ⏳ Aguardando ${(baseDelay/1000).toFixed(1)}s antes da próxima página...`);
      }
      await new Promise(resolve => setTimeout(resolve, baseDelay));
    }
    
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] 🤖 Enviando texto bruto da página ${i + 1}/${totalPages}`);
    }
    
    const r = await callOpenAIGPT4Turbo(prompt);
    let content = r?.choices?.[0]?.message?.content || "";
    console.log(`[PDFtoArcgis][LOG IA][RAW][PAGE ${i + 1}/${totalPages}]`, content);
    
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] ⏳ Página ${i + 1}: lendo resposta da IA`);
    }
    
    if (!content) {
      console.warn(`[PDFtoArcgis] Página ${i + 1} sem resposta`);
      if (typeof displayLogMessage === 'function') {
        displayLogMessage(`[PDFtoArcgis][LogUI] ⚠️ Página ${i + 1}: IA não retornou dados`);
      }
      continue;
    }
    
    // ETL MELHORIA: Extrair JSON de dentro de markdown ou texto explicativo
    const jsonExtracted = extractJSONFromResponse(content);
    if (!jsonExtracted) {
      console.warn(`[PDFtoArcgis] Página ${i + 1}: Não conseguiu extrair JSON da resposta`);
      if (typeof displayLogMessage === 'function') {
        displayLogMessage(`[PDFtoArcgis][LogUI] ⏳ Página ${i + 1}: JSON não encontrado`);
      }
      continue;
    }
    
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] ⏳ Página ${i + 1}: validando JSON`);
    }
    
    content = repairJsonCoordinates(jsonExtracted);
    
    // 🔧 PRE-PARSE: Normalizando formato de coordenadas comuns antes de JSON.parse()
    // Padrão 1: Coordenadas com ponto como separador decimal (518.881221 → 518881.221)
    content = content.replace(/"este"\s*:\s*(\d+\.\d+),/g, (match, num) => {
      const val = parseFloat(num);
      // Se este é 519.xxx (formato de 5 dígitos com ponto), converter para 519xxx (remover ponto)
      if (val > 0 && val < 1000 && String(num).split('.')[0].length === 3) {
        // 519.29996 → remove o ponto → 51929996, mas precisa ser 519299.96
        // Na verdade, se foi extraído como 519.29996, significa que foi dividido por 1000
        // Precisa multiplicar por 1000: 519.29996 * 1000 = 519299.96
        const normalized = val * 1000;
        return `"este":${normalized},`;
      }
      return match;
    });
    
    // Padrão 2: Norte com dígitos concatenados (73313338236 → 7331333.8236)
    content = content.replace(/"norte"\s*:\s*(\d+),/g, (match, num) => {
      const val = parseInt(num);
      const nStr = String(val);
      
      // Se norte tem > 10 dígitos, é concatenado (ex: 73313338236 tem 11 dígitos)
      if (nStr.length > 10) {
        // Primeira abordagem: 7 dígitos + resto como decimal
        const prefix = nStr.substring(0, 7);
        const decimal = nStr.substring(7);
        return `"norte":${prefix}.${decimal},`;
      }
      
      // Se norte tem exatamente 10 dígitos, pode ser formato compactado
      if (nStr.length === 10) {
        // Verificar se começa com 73 e tem padrão de coordenada sem decimal
        if (nStr.startsWith('73')) {
          // 7331352001 → 7331352.001
          const prefix = nStr.substring(0, 7);
          const decimal = nStr.substring(7);
          return `"norte":${prefix}.${decimal},`;
        }
      }
      
      return match;
    });
    
    try {
      const parsed = JSON.parse(content);
      
      // Validar coordenadas UTM (evitar dados fake/teste)
      if (parsed?.vertices && Array.isArray(parsed.vertices)) {
        const validVertices = parsed.vertices.filter(v => {
          // 🔧 NORMALIZACAO: Detectar e corrigir formato de coordenadas malformadas
          let e = parseFloat(v.este || v.east || 0);
          let n = parseFloat(v.norte || v.north || 0);
          
          // Padrão 1: Coordenadas com período como separador decimal (518.881221 → 518881.221)
          // Detectar se é formato de milhares com ponto decimal errado
          if (e > 0 && e < 1000 && !isNaN(e)) {
            // Verificar se este valor é muito pequeno para UTM
            // Se temos este:518.xyz, converter para 518xxxxx (remover ponto, é milhar)
            const eStr = String(e);
            if (eStr.includes('.') && eStr.split('.')[0].length <= 3) {
              // Remover ponto: 519.29996 → 51929996 (é o número correto, sem divisão)
              e = parseFloat(eStr.replace('.', ''));
            }
          }
          
          // Padrão 2: Norte com dígitos concatenados (7331352001 → 7331352.001)
          // Detectar se norte tem mais de 10 dígitos (impossível em UTM)
          if (n > 9999999999) {
            const nStr = String(Math.floor(n));
            if (nStr.length > 10) {
              // Quebrar em 7 dígitos + resto (e.g., 7331352001 → 7331352 + 001)
              const prefix = nStr.substring(0, 7);
              const decimal = nStr.substring(7);
              n = parseFloat(prefix + '.' + decimal);
            }
          }
          
          // Padrão 3: Coordenadas com período como milhar (como em pt-BR)
          // Este:519.29996 (com vírgula) deveria ser 519029.96 ou 519299.6
          if (e > 100 && e < 1000 && e % 1 !== 0) {
            // Verificar se remove ponto fica razoável
            const eWithoutDot = parseFloat(String(e).replace('.', ''));
            if (eWithoutDot >= 150000 && eWithoutDot <= 900000) {
              e = eWithoutDot;
            }
          }
          
          // Padrão 4: Norte truncado por falta de dígito
          // Detectar se norte está no intervalo 730k-760k (típico de truncamento)
          // Solução: Inserir '7' no meio, não no início
          // Ex: 733036 → 7330036 (7 vai entre 73 e 3036)
          if (n > 730000 && n < 760000 && e >= 150000 && e <= 900000) {
            const nStr = String(Math.floor(n));
            // Padrão típico: 733036 tem 6 dígitos, precisa de 7 dígitos
            // Inserir '0' após primeiro dígito: 7|330036 ou inserir '7' após 73: 733|0036
            // Tentativa 1: 733036 → 7330036 (inserir um '0' no meio)
            let correctedN = parseFloat('7' + nStr.substring(1));
            
            // Validar se fica no intervalo esperado
            if (correctedN >= 6900000 && correctedN <= 10100000) {
              n = correctedN;
              console.log(`[PDFtoArcgis] 🔧 N truncado corrigido: ${nStr} → ${correctedN}`);
            }
          }
          
          // Atualizar valores no vertex
          v.este = e;
          v.norte = n;
          
          // 🔧 Corrigir typos em DMS angles
          if (v.azimute_dms) {
            v = fixDMSTypos(v);
          }
          
          // Coordenadas UTM válidas para Brasil (todas as zonas 19-25)
          // ZONA 19: 150k-300k (Espírito Santo, SP)
          // ZONA 23: 400k-600k (RJ, SP, PR)
          // ZONA 25: 700k-900k (SC, RS)
          const isValidE = e >= 150000 && e <= 900000;
          const isValidN = n >= 6900000 && n <= 10100000;
          
          if (!isValidE || !isValidN) {
            console.warn(`[PDFtoArcgis] ⚠️ Coordenada inválida (após normalização): ${v.id || '?'} E=${e} N=${n}`);
          }
          return isValidE && isValidN;
        });
        
        if (validVertices.length !== parsed.vertices.length) {
          console.log(`[PDFtoArcgis] 🔧 Filtrados ${parsed.vertices.length - validVertices.length} vértice(s) com coordenadas inválidas`);
          if (typeof displayLogMessage === 'function') {
            displayLogMessage(`[PDFtoArcgis][LogUI] 🔧 Página ${i + 1}: ${validVertices.length} válido(s) de ${parsed.vertices.length}`);
          }
        }
        
        parsed.vertices = validVertices;
      }
      
      if (parsed?.modo === "relativo" || parsed?.relative === true) {
        relativeResult = parsed;
        break;
      }

      const hasLatLon = Array.isArray(parsed?.vertices)
        && parsed.vertices.some(v => v.lat !== undefined || v.lon !== undefined || v.latitude !== undefined || v.longitude !== undefined)
        && !parsed.vertices.some(v => v.este !== undefined || v.east !== undefined || v.norte !== undefined || v.north !== undefined);

      if (hasLatLon) {
        latLonResults.push(parsed);
      } else if (parsed?.vertices?.length > 0) {
        results.push(parsed);
        const vcount = parsed.vertices.length;
        
        // Se houver azimutes/distâncias, logar para validação
        const withMeasures = parsed.vertices.filter(v => v.azimute !== undefined || v.distancia !== undefined);
        const measureInfo = withMeasures.length > 0 ? ` (${withMeasures.length} com medidas)` : "";
        
        console.log(`[PDFtoArcgis] Página ${i + 1}: ${vcount} vértices${measureInfo}`);
        if (typeof displayLogMessage === 'function') {
          displayLogMessage(`[PDFtoArcgis][LogUI] ✅ Página ${i + 1}: ${vcount} coordenada(s)${measureInfo}`);
        }
      } else {
        console.log(`[PDFtoArcgis] Página ${i + 1}: nenhum vértice válido após filtros`);
        if (typeof displayLogMessage === 'function') {
          displayLogMessage(`[PDFtoArcgis][LogUI] ℹ️ Página ${i + 1}: sem coordenadas válidas`);
        }
      }
    } catch (e) {
      console.error('[PDFtoArcgis][PARSE ERROR][PAGE]', e, content);
      
      // Tentar novamente com extração mais agressiva
      console.log(`[PDFtoArcgis] 🔄 Tentando recuperar JSON da página ${i + 1}...`);
      const retryJson = extractJSONFromResponse(content);
      if (retryJson) {
        try {
          let retryContent = repairJsonCoordinates(retryJson);
          
          // Aplicar novamente normalização PRE-PARSE
          retryContent = retryContent.replace(/"este"\s*:\s*(\d+\.\d+),/g, (match, num) => {
            const val = parseFloat(num);
            if (val > 0 && val < 1000) {
              const normalized = parseFloat(String(num).replace('.', '')) / 1000;
              return `"este":${normalized},`;
            }
            return match;
          });
          
          retryContent = retryContent.replace(/"norte"\s*:\s*(\d+),/g, (match, num) => {
            const val = parseInt(num);
            if (val > 9999999999) {
              const nStr = String(val);
              if (nStr.length > 10) {
                const prefix = nStr.substring(0, 7);
                const decimal = nStr.substring(7);
                return `"norte":${prefix}.${decimal},`;
              }
            }
            return match;
          });
          
          const retryParsed = JSON.parse(retryContent);
          if (retryParsed?.vertices?.length > 0) {
            results.push(retryParsed);
            console.log(`[PDFtoArcgis] ✅ Página ${i + 1}: JSON recuperado (retry)`);
            if (typeof displayLogMessage === 'function') {
              displayLogMessage(`[PDFtoArcgis][LogUI] 🔧 Página ${i + 1}: JSON recuperado`);
            }
          }
        } catch (e2) {
          console.error('[PDFtoArcgis][PARSE ERROR RETRY]', e2);
        }
      }
      
      // Detectar se é mensagem de "sem dados" da IA
      if (typeof content === 'string' && (content.includes('Não há') || content.includes('não há') || content.includes('no data') || content.includes('no coordinates'))) {
        console.log(`[PDFtoArcgis] Página ${i + 1}: sem vértices (IA confirmou)`);
        if (typeof displayLogMessage === 'function') {
          displayLogMessage(`[PDFtoArcgis][LogUI] ℹ️ Página ${i + 1}: sem coordenadas`);
        }
        baseDelay = Math.min(baseDelay + 500, 5000); // Aumentar delay progressivamente até 5s
      } else {
        // Sem fallback por regex: a IA deve extrair diretamente do texto puro
        if (typeof displayLogMessage === 'function') {
          displayLogMessage(`[PDFtoArcgis][LogUI] ❌ Página ${i + 1}: resposta da IA inválida`);
        }
        baseDelay = Math.min(baseDelay + 1000, 8000); // Aumentar delay agressivamente
      }
    }
  }
  
  if (relativeResult) return relativeResult;

  if (latLonResults.length > 0) {
    const mergedLatLon = mergeLatLonFromChunks(latLonResults);
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] 🎉 IA concluiu: ${mergedLatLon.length} coordenada(s) lat/lon`);
    }
    return {
      ...latLonResults[0],
      vertices: mergedLatLon
    };
  }

  const mergedVertices = mergeVerticesFromChunks(results);
  console.log(`[PDFtoArcgis] Total de vértices únicos: ${mergedVertices.length}`);
  
  // Ordenar vértices por proximidade (nearest neighbor) para formar polígono correto
  const orderedVertices = orderVerticesByProximity(mergedVertices);
  console.log(`[PDFtoArcgis] Vértices ordenados por proximidade`);
  
  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] 🎉 IA concluiu: ${orderedVertices.length} coordenada(s)`);
  }
  
  if (orderedVertices.length >= 3) {
    return {
      imovel: null,
      matricula: null,
      datum: null,
      vertices: orderedVertices
    };
  }
  
  return null;
}

// Função para ordenar vértices por proximidade (nearest neighbor algorithm)
function orderVerticesByProximity(vertices) {
  if (vertices.length < 3) return vertices;
  
  const ordered = [];
  const remaining = [...vertices];
  
  // Começar pelo primeiro vértice
  let current = remaining.shift();
  ordered.push(current);
  
  // Para cada vértice, encontrar o mais próximo
  while (remaining.length > 0) {
    let nearestIndex = 0;
    let minDistance = Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const dist = Math.sqrt(
        Math.pow(remaining[i].east - current.east, 2) +
        Math.pow(remaining[i].north - current.north, 2)
      );
      
      if (dist < minDistance) {
        minDistance = dist;
        nearestIndex = i;
      }
    }
    
    current = remaining.splice(nearestIndex, 1)[0];
    ordered.push(current);
  }
  
  // Reindexar ordem
  return ordered.map((v, idx) => ({
    ...v,
    ordem: idx + 1
  }));
}

function hasCoordinateSignal(text) {
  if (!text) return false;
  const t = String(text);

  // UTM markers or explicit labels
  if (/\b(utm|sirgas|sirg|sgrs)\b/i.test(t)) return true;
  if (/(\bE(?:ste)?\b|\bLeste\b|\bEast\b)\s*[:=]?\s*\d{5,7}[.,]?\d*/i.test(t)) return true;
  if (/(\bN(?:orte)?\b|\bNorth\b)\s*[:=]?\s*\d{6,8}[.,]?\d*/i.test(t)) return true;

  // Lat/Lon decimal with labels or hemisphere
  if (/(lat(?:itude)?|lon(?:gitude)?)[^\d-]*-?\d{1,2}[.,]\d{4,}/i.test(t)) return true;
  if (/(lat(?:itude)?|lon(?:gitude)?)[^\d-]*-?\d{1,3}[.,]\d{4,}/i.test(t)) return true;

  // Lat/Lon DMS
  if (/\d{1,3}\s*°\s*\d{1,2}\s*['’]\s*\d{1,2}\s*["”]\s*[NSEW]/i.test(t)) return true;

  // Azimuth/Distance narrative
  if (/(azimute|rumo|dist[aâ]ncia)\s*[:=]?\s*\d+/i.test(t)) return true;

  return false;
}

// Extração robusta de texto por página (sem OCR): garante leitura de todas as páginas
async function extractPageTextSafely(page, pageIndex) {
  const tryExtract = async (options) => {
    const textContent = await page.getTextContent(options);
    let text = buildPageTextWithLines(textContent);
    if (!text || text.trim().length < 5) {
      const raw = (textContent.items || []).map(it => it.str).filter(Boolean).join(" ");
      if (raw && raw.trim().length > (text || "").trim().length) text = raw;
    }
    return text || "";
  };

  let pageText = "";
  try {
    pageText = await tryExtract({ disableCombineTextItems: false });
  } catch (e) { }

  if (!pageText || pageText.trim().length < 5) {
    try {
      pageText = await tryExtract({ disableCombineTextItems: true });
    } catch (e) { }
  }

  if (!pageText || pageText.trim().length < 5) {
    try {
      pageText = await tryExtract({ normalizeWhitespace: true, disableCombineTextItems: true });
    } catch (e) { }
  }

  if (!pageText || pageText.trim().length < 5) {
    try {
      pageText = await tryExtract({
        normalizeWhitespace: true,
        disableCombineTextItems: true,
        includeMarkedContent: true
      });
    } catch (e) { }
  }

  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] Página ${pageIndex}: ${pageText ? pageText.trim().length : 0} caracteres extraídos.`);
  }

  return pageText || "";
}

// OCR por página (Android primeiro, fallback Tesseract.js)
async function performOcrOnPage(page, pageIndex) {
  if (window.Android && window.Android.performOCR) {
    try {
      const ocrText = await window.Android.performOCR(pageIndex);
      return (ocrText && ocrText.length > 10) ? ocrText : "";
    } catch (e) {
      return "";
    }
  }

  if (window.__tesseractReady && !window.Tesseract) {
    try {
      await Promise.race([
        window.__tesseractReady,
        new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), 8000))
      ]);
    } catch (e) {
      return "";
    }
  }

  if (window.Tesseract) {
    try {
      const ocrOptions = {
        lang: 'por',
        workerPath: 'vendor/tesseract/worker.min.js',
        corePath: 'vendor/tesseract/tesseract-core.wasm.js',
        langPath: 'vendor/tesseract/lang-data'
      };
      const canvas = document.createElement('canvas');
      const viewport = page.getViewport({ scale: 2.0 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const result = await window.Tesseract.recognize(canvas, 'por', ocrOptions);
      const text = result?.data?.text || "";
      return (text && text.length > 10) ? text : "";
    } catch (e) {
      return "";
    }
  }

  return "";
}

// UI: Navegação lateral e rolagem para resultados
function openNav() {
  document.getElementById("mySidenav").style.width = "250px";
  if (typeof isAppInstalled === 'function' && typeof hideInstallBtn === 'function') {
    if (isAppInstalled()) hideInstallBtn();
  }
}
function closeNav() { document.getElementById("mySidenav").style.width = "0"; }


// === UI: Atualizar painel de validação topológica ===
function updateValidationUI(topology, corrections = []) {
  const validationBox = document.getElementById("validationBox");
  const validationTitle = document.getElementById("validationTitle");
  const validationErrors = document.getElementById("validationErrors");
  const validationWarnings = document.getElementById("validationWarnings");
  const validationSuccess = document.getElementById("validationSuccess");
  const validationDetails = document.getElementById("validationDetails");
  const validationActions = document.getElementById("validationActions");
  const errorList = document.getElementById("errorList");
  const warningList = document.getElementById("warningList");

  if (!validationBox) return;

  // Mostrar painel
  validationBox.style.display = "block";

  // Limpar listas
  if (errorList) errorList.innerHTML = "";
  if (warningList) warningList.innerHTML = "";

  // Atualizar título
  if (validationTitle) {
    if (topology.isValid) {
      validationTitle.innerHTML = '<i class="fas fa-check-circle" style="color:#28a745;"></i> Polígono Válido!';
    } else {
      validationTitle.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:#dc3545;"></i> Problemas Detectados';
    }
  }

  // Mostrar erros
  if (topology.errors && topology.errors.length > 0 && validationErrors && errorList) {
    validationErrors.style.display = "block";
    topology.errors.forEach(err => {
      const li = document.createElement("li");
      li.textContent = err;
      errorList.appendChild(li);
    });
  } else if (validationErrors) {
    validationErrors.style.display = "none";
  }

  // Mostrar avisos
  if (topology.warnings && topology.warnings.length > 0 && validationWarnings && warningList) {
    validationWarnings.style.display = "block";
    topology.warnings.forEach(warn => {
      const li = document.createElement("li");
      li.textContent = warn;
      warningList.appendChild(li);
    });
  } else if (validationWarnings) {
    validationWarnings.style.display = "none";
  }

  // Mostrar sucesso
  if (topology.isValid && validationSuccess && validationDetails) {
    validationSuccess.style.display = "block";
    
    const areaHa = (topology.area / 10000).toFixed(4);
    const areaM2 = topology.area.toFixed(2);
    const closedText = topology.closed ? "✓ Fechado" : "⚠ Não fechado";
    
    validationDetails.innerHTML = `
      <strong>Área:</strong> ${areaHa} ha (${areaM2} m²)<br>
      <strong>Fechamento:</strong> ${closedText}<br>
      <strong>Orientação:</strong> Anti-horária (CCW) ✓<br>
      <strong>Auto-intersecções:</strong> ${topology.hasIntersections ? '❌ Sim' : '✓ Não'}
    `;
    
    if (corrections.length > 0) {
      validationDetails.innerHTML += `<br><br><strong>Correções aplicadas:</strong><br>`;
      corrections.forEach(corr => {
        validationDetails.innerHTML += `• ${corr}<br>`;
      });
    }
  } else if (validationSuccess) {
    validationSuccess.style.display = "none";
  }

  // Mostrar/ocultar botão de correção
  if (validationActions) {
    if (!topology.isValid && topology.errors.length > 0) {
      validationActions.style.display = "block";
    } else {
      validationActions.style.display = "none";
    }
  }
}

// --- PWA: Instalar App (com feedback visual) ---
let deferredPrompt = null;
let installBtn = null;

function hideInstallBtn() {
  if (installBtn) installBtn.style.display = 'none';
}

// Detecta se já está instalado (standalone ou appinstalled)
function isAppInstalled() {
  // Checa standalone (PWA instalado) e display-mode
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  if (window.navigator.standalone === true) return true;
  // Checa se já existe service worker controlando e não há prompt
  if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
  // iOS: verifica se está rodando como app
  if (window.navigator && window.navigator.standalone) return true;
  // Android Chrome: verifica se não há prompt e já está instalado
  if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  return false;
}

if (isAppInstalled()) {
  hideInstallBtn();
}

window.addEventListener('appinstalled', hideInstallBtn);

window.addEventListener('DOMContentLoaded', function () {
  installBtn = document.getElementById('installPwaBtn');
  if (isAppInstalled()) hideInstallBtn();
});

window.addEventListener('beforeinstallprompt', (e) => {
  if (isAppInstalled()) {
    hideInstallBtn();
    return;
  }
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) {
    installBtn.style.display = 'block';
    installBtn.classList.remove('success', 'error');
    installBtn.textContent = 'Instalar App';
  }
});
window.addEventListener('DOMContentLoaded', function () {
  installBtn = document.getElementById('installPwaBtn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        try {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          if (outcome === 'accepted') {
            installBtn.classList.add('success');
            installBtn.textContent = 'App instalado!';
            setTimeout(() => {
              installBtn.style.display = 'none';
              installBtn.classList.remove('success');
              installBtn.textContent = 'Instalar App';
            }, 2000);
          } else {
            installBtn.classList.add('error');
            installBtn.textContent = 'Instalação cancelada';
            setTimeout(() => {
              installBtn.classList.remove('error');
              installBtn.textContent = 'Instalar App';
            }, 2000);
          }
        } catch (err) {
          installBtn.classList.add('error');
          installBtn.textContent = 'Erro ao instalar';
          setTimeout(() => {
            installBtn.classList.remove('error');
            installBtn.textContent = 'Instalar App';
          }, 2000);
        }
        deferredPrompt = null;
      }
    });
  }
});
function scrollToResults() {
  const box = document.getElementById("resultBox");
  if (box && box.style.display !== "none") box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Configuração do PDF.js para uso local/Android
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "vendor/pdf.worker.min.js";

// UI e estado
const fileInput = document.getElementById("fileInput");
const statusDiv = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressContainer = document.getElementById("progressContainer");
const resultBox = document.getElementById("resultBox");
const countDisplay = document.getElementById("countDisplay");
const previewTableBody = document.querySelector("#previewTable tbody");
const downloadBtn = document.getElementById("downloadBtn");
const saveToFolderBtn = document.getElementById("saveToFolderBtn");

const crsDetectedBox = document.getElementById("crsDetectedBox");
const crsDetectedTitle = document.getElementById("crsDetectedTitle");
const crsDetectedReason = document.getElementById("crsDetectedReason");
const advancedCrs = document.getElementById("advancedCrs");
const projectionSelect = document.getElementById("projectionSelect");
const forceCrsBtn = document.getElementById("forceCrsBtn");

const docSelectorBox = document.getElementById("docSelectorBox");
const docSelect = document.getElementById("docSelect");
const docMeta = document.getElementById("docMeta");

let extractedCoordinates = [];
let fileNameBase = "coordenadas_extracao";
let pdfOrigemNomeBase = "";
let pdfOrigemSrc = "";

// Resultados por matrícula (PDF unificado): [{docId,pages,projectionKey,manualProjectionKey,projectionInfo,vertices,warnings}]
let documentsResults = [];
let activeDocIndex = -1;

// Projecoes suportadas (WKT)
const PROJECTIONS = {
  SIRGAS2000_25S: {
    name: "SIRGAS 2000 / UTM zone 25S",
    epsg: "EPSG:31985",
    wkt: 'PROJCS["SIRGAS 2000 / UTM zone 25S",GEOGCS["SIRGAS 2000",DATUM["Sistema de Referencia Geocentrico para las Americas 2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-33],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1]]'
  },
  SIRGAS2000_21S: {
    name: "SIRGAS 2000 / UTM zone 21S",
    epsg: "EPSG:31981",
    wkt: 'PROJCS["SIRGAS 2000 / UTM zone 21S",GEOGCS["SIRGAS 2000",DATUM["Sistema de Referencia Geocentrico para las Americas 2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-57],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1]]'
  },
  SIRGAS2000_22S: {
    name: "SIRGAS 2000 / UTM zone 22S",
    epsg: "EPSG:31982",
    wkt: 'PROJCS["SIRGAS 2000 / UTM zone 22S",GEOGCS["SIRGAS 2000",DATUM["Sistema de Referencia Geocentrico para las Americas 2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-51],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1]]'
  },
  SIRGAS2000_23S: {
    name: "SIRGAS 2000 / UTM zone 23S",
    epsg: "EPSG:31983",
    wkt: 'PROJCS["SIRGAS 2000 / UTM zone 23S",GEOGCS["SIRGAS 2000",DATUM["Sistema de Referencia Geocentrico para las Americas 2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-45],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1]]'
  },
  SIRGAS2000_24S: {
    name: "SIRGAS 2000 / UTM zone 24S",
    epsg: "EPSG:31984",
    wkt: 'PROJCS["SIRGAS 2000 / UTM zone 24S",GEOGCS["SIRGAS 2000",DATUM["Sistema de Referencia Geocentrico para las Americas 2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-39],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1]]'
  },
  SAD69_22S: {
    name: "SAD69 / UTM zone 22S",
    epsg: "EPSG:29192",
    wkt: 'PROJCS["SAD69 / UTM zone 22S",GEOGCS["SAD69",DATUM["South_American_Datum_1969",SPHEROID["GRS 1967 Modified",6378160,298.25]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-51],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1]]'
  },
  SAD69_23S: {
    name: "SAD69 / UTM zone 23S",
    epsg: "EPSG:29193",
    wkt: 'PROJCS["SAD69 / UTM zone 23S",GEOGCS["SAD69",DATUM["South_American_Datum_1969",SPHEROID["GRS 1967 Modified",6378160,298.25]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-45],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1]]'
  },
  WGS84: {
    name: "WGS 84",
    epsg: "EPSG:4326",
    wkt: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]'
  }
};

// Helpers de status e normalizacao
function updateStatus(msg, type) {
  statusDiv.style.display = "block";
  statusDiv.innerText = msg;
  statusDiv.className = "status-" + type;
}

function sanitizeFileName(name) {
  return (name || "")
    .replace(/\.[^/.]+$/, "")
    .replace(/[\\/:*?"<>\n\r]/g, "")
    .replace(/\s+/g, "_");
}



// Calculos para exibicao (distancia/azimute)
function calcularDistancia(p1, p2) {
  return Math.sqrt(Math.pow(p2.east - p1.east, 2) + Math.pow(p2.north - p1.north, 2));
}

function calcularAzimute(p1, p2) {
  const dE = p2.east - p1.east;
  const dN = p2.north - p1.north;
  let az = Math.atan2(dE, dN) * (180 / Math.PI);
  return az < 0 ? az + 360 : az;
}

// Geodesia e validacao topologica


// Reordena vertices em sequencia CCW usando centroide.
function orderVerticesCCW(vertices) {
  if (vertices.length < 3) return vertices;

  // Centroide
  let centerN = 0, centerE = 0;
  for (const v of vertices) {
    centerN += v.north;
    centerE += v.east;
  }
  centerN /= vertices.length;
  centerE /= vertices.length;

  console.log(`[PDFtoArcgis] Centroide N=${centerN.toFixed(2)} E=${centerE.toFixed(2)}`);

  // Ordenar por angulo polar (CCW a partir do eixo E)
  const ordered = vertices.map(v => {
    const angle = Math.atan2(v.north - centerN, v.east - centerE);
    return { ...v, angle };
  }).sort((a, b) => a.angle - b.angle);

  console.log(`[PDFtoArcgis] Vertices ordenados em CCW`);

  return ordered;
}

// Valida topologia do poligono (interseccao e orientacao).
function validatePolygonTopology(vertices, projectionKey) {
  if (vertices.length < 3) {
    return {
      isValid: false,
      errors: ["Menos de 3 vértices"],
      warnings: [],
      hasIntersections: false,
      corrected: vertices,
      isCCW: false
    };
  }

  const errors = [];
  const warnings = [];

  // Reordenar se detectar desordem
  let orderedVertices = vertices;
  let isDisordered = false;

  // Detectar saltos anormais
  const nValues = vertices.map(v => v.north);
  const eValues = vertices.map(v => v.east);
  const minN = Math.min(...nValues);
  const maxN = Math.max(...nValues);
  const minE = Math.min(...eValues);
  const maxE = Math.max(...eValues);
  const nRange = maxN - minN;
  const eRange = maxE - minE;

  // Saltos > 50% do range sugerem desordem
  const adaptiveNThreshold = Math.max(1000, nRange * 0.5); // Mínimo 1km, ou 50% do range
  const adaptiveEThreshold = Math.max(1000, eRange * 0.5);

  for (let i = 0; i < vertices.length - 1; i++) {
    const nDiff = Math.abs(vertices[i].north - vertices[i + 1].north);
    const eDiff = Math.abs(vertices[i].east - vertices[i + 1].east);

    // Se há salto muito grande (> 50% do range), é desordenado
    if (nDiff > adaptiveNThreshold || eDiff > adaptiveEThreshold) {
      isDisordered = true;
      console.log(`[PDFtoArcgis] Desordem detectada entre vertices ${i} e ${i + 1}`);
      break;
    }
  }

  if (isDisordered) {
    orderedVertices = orderVerticesCCW(vertices);
    warnings.push("Vertices reordenados em CCW");
  }

  // Duplicados
  const duplicates = [];
  for (let i = 0; i < orderedVertices.length; i++) {
    for (let j = i + 1; j < orderedVertices.length; j++) {
      const dist = Math.hypot(
        orderedVertices[i].north - orderedVertices[j].north,
        orderedVertices[i].east - orderedVertices[j].east
      );
      if (dist < 0.01) { // Tolerância: 1cm
        duplicates.push({ i, j, dist });
      }
    }
  }

  if (duplicates.length > 0) {
    errors.push(`❌ ${duplicates.length} vertice(s) duplicado(s)`);
    console.log(`[PDFtoArcgis] Duplicados:`, duplicates);
  }

  // Fechamento
  const first = orderedVertices[0];
  const last = orderedVertices[orderedVertices.length - 1];
  const closureDistance = Math.hypot(
    first.north - last.north,
    first.east - last.east
  );

  if (closureDistance > 5) {
    warnings.push(`⚠️ Poligono nao fechado: ${closureDistance.toFixed(1)}m`);
  }

  // Auto-interseccao
  let hasIntersections = false;
  const intersectionPairs = [];
  
  for (let i = 0; i < orderedVertices.length - 1; i++) {
    for (let j = i + 2; j < orderedVertices.length - 1; j++) {
      // Não verificar arestas adjacentes
      if (i === 0 && j === orderedVertices.length - 2) continue;

      const p1 = orderedVertices[i];
      const p2 = orderedVertices[i + 1];
      const p3 = orderedVertices[j];
      const p4 = orderedVertices[j + 1];

      // Cross product test (detecção de intersecção)
      const d1 = (p2.east - p1.east) * (p3.north - p1.north) - (p2.north - p1.north) * (p3.east - p1.east);
      const d2 = (p2.east - p1.east) * (p4.north - p1.north) - (p2.north - p1.north) * (p4.east - p1.east);
      const d3 = (p4.east - p3.east) * (p1.north - p3.north) - (p4.north - p3.north) * (p1.east - p3.east);
      const d4 = (p4.east - p3.east) * (p2.north - p3.north) - (p4.north - p3.north) * (p2.east - p3.east);

      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        hasIntersections = true;
        intersectionPairs.push({ edge1: i, edge2: j });
      }
    }
  }

  if (hasIntersections) {
    errors.push(`❌ Auto-intersecções detectadas em ${intersectionPairs.length} pares de arestas`);
    console.log(`[PDFtoArcgis] Intersecções:`, intersectionPairs);
  }

  // Orientacao CCW
  let signedArea = 0;
  for (let i = 0; i < orderedVertices.length; i++) {
    const curr = orderedVertices[i];
    const next = orderedVertices[(i + 1) % orderedVertices.length];
    signedArea += curr.east * next.north - next.east * curr.north;
  }

  const isCCW = signedArea > 0;
  const area = Math.abs(signedArea) / 2;

  if (!isCCW) {
    warnings.push("⚠️ Ordem CW; convertendo para CCW");
    orderedVertices = orderedVertices.reverse();
  }

  // Area fora do esperado
  if (area === 0) {
    errors.push(`❌ Area zero (0 m2)`);
  } else if (area < 1) {
    errors.push(`❌ Area muito pequena (${area.toFixed(2)} m2)`);
  } else if (area > 1e8) {
    errors.push(`❌ Area absurda: ${(area / 1e4).toFixed(1)} ha (${area.toExponential(2)} m2)`);
  } else if (area > 1e7) {
    warnings.push(`⚠️ Area muito grande: ${(area / 1e4).toFixed(1)} ha (${area.toExponential(2)} m2)`);
  }

  // Segmentos longos
  for (let i = 0; i < orderedVertices.length - 1; i++) {
    const v1 = orderedVertices[i];
    const v2 = orderedVertices[i + 1];
    const dist = Math.hypot(v2.north - v1.north, v2.east - v1.east);
    
    if (dist > 10000) { // Segmentos > 10km são suspeitos
      warnings.push(`⚠️ Segmento ${i}→${i + 1} muito longo: ${(dist / 1000).toFixed(2)}km`);
    }
  }

  return {
    isValid: errors.length === 0 && area > 1,
    errors,
    warnings,
    hasIntersections,
    corrected: orderedVertices,  // Retornar vértices reordenados e corrigidos
    isCCW: true, // Sempre CCW após correção
    area,
    closed: closureDistance < 5,
    duplicates: duplicates.length,
    intersectionPairs
  };
}




// Doc selecionado e CRS
function getSelectedDoc() {
  if (activeDocIndex >= 0 && activeDocIndex < documentsResults.length) return documentsResults[activeDocIndex];
  return null;
}

function getActiveProjectionKey() {
  const doc = getSelectedDoc();
  if (doc) return doc.manualProjectionKey || doc.projectionKey || (projectionSelect?.value) || "SAD69_22S";
  return (projectionSelect?.value) || "SAD69_22S";
}

function showDetectedCrsUI(key, info) {
  if (!crsDetectedBox) return;
  crsDetectedBox.style.display = "block";
  const conf = info?.confidence || "baixa";
  crsDetectedTitle.textContent = `${key || "(não detectado)"} — confiança ${conf}`;
  crsDetectedReason.textContent = info?.reason || "";
  if (projectionSelect && key) {
    const ok = Array.from(projectionSelect.options).some(o => o.value === key);
    if (ok) projectionSelect.value = key;
  }
}


// Reconstrucao de texto por linha
function buildPageTextWithLines(textContent) {
  const items = (textContent.items || [])
    .map(it => ({
      str: it.str || "",
      x: it.transform ? it.transform[4] : 0,
      y: it.transform ? it.transform[5] : 0
    }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  let out = "";
  let lastY = null;
  const lineThreshold = 2.0;

  for (const it of items) {
    if (!it.str) continue;
    if (lastY === null) lastY = it.y;
    if (Math.abs(it.y - lastY) > lineThreshold) {
      out += "\n";
      lastY = it.y;
    } else {
      out += " ";
    }
    out += it.str;
  }
  return out;
}

// Deteccao de CRS
function inferZoneFromBrazilState(textLower) {
  if (/\b\-pr\b|\bparan[aá]\b/.test(textLower)) return 22;
  if (/\b\-sc\b|\bsanta\s*catarina\b/.test(textLower)) return 22;
  if (/\b\-rs\b|\brio\s*grande\s*do\s*sul\b/.test(textLower)) return 22;
  if (/\b\-sp\b|\bs[aã]o\s*paulo\b/.test(textLower)) return 23;
  if (/\b\-rj\b|\brio\s*de\s*janeiro\b/.test(textLower)) return 23;
  if (/\b\-mg\b|\bminas\s*gerais\b/.test(textLower)) return 23;
  if (/\b\-es\b|\besp[ií]rito\s*santo\b/.test(textLower)) return 24;
  return null;
}

/**
 * Infere o CRS com base na magnitude numérica das coordenadas (Geofencing reverso)
 */
function inferCrsByCoordinates(vertices) {
  if (!vertices || vertices.length === 0) return null;

  // Calcula a média das coordenadas extraídas
  const avgE = vertices.reduce((sum, v) => sum + v.east, 0) / vertices.length;
  const avgN = vertices.reduce((sum, v) => sum + v.north, 0) / vertices.length;

  // Lógica para o Brasil (UTM Sul)
  // Norte ~7.1 milhões (Paraná/Santa Catarina/RS)
  if (avgN > 7000000 && avgN < 8000000) {
    // Este entre 600k e 800k -> Zona 22S
    if (avgE > 600000 && avgE < 800000) {
      return { zone: 22, reason: "Inferido via coordenadas: Padrão compatível com UTM Zona 22S (Sul do Brasil)." };
    }
    // Este entre 300k e 600k -> Zona 23S (SP/MG)
    if (avgE > 300000 && avgE < 600000) {
      return { zone: 23, reason: "Inferido via coordenadas: Padrão compatível com UTM Zona 23S." };
    }
  }
  return null;
}

function detectProjectionFromText(fullText, vertices = []) {
  const t = (fullText || "").toLowerCase();
  const hasSAD = /sad[\s\-]?69/.test(t);
  const hasSIRGAS = /sirgas\s*2000/.test(t);
  const hasWGS = /wgs\s*84/.test(t);

  const zoneMatch =
    t.match(/(?:fuso|zona|zone)\s*[:=]?\s*(\d{2})\s*([ns])?/i) ||
    t.match(/utm\s*[:=]?\s*(\d{2})\s*([ns])?/i);

  const mcMatch = t.match(/(?:mc|meridiano\s+central)\s*[:=]?\s*(\d{2})\s*°?\s*([wo])/i);

  let zone = null;
  const reasonParts = [];
  let conf = "baixa";

  if (zoneMatch && zoneMatch[1]) {
    zone = parseInt(zoneMatch[1], 10);
    reasonParts.push(`Encontrado fuso/zona ${zone} no memorial.`);
    conf = "alta";
  }

  if (!zone && mcMatch && mcMatch[1]) {
    const mc = parseInt(mcMatch[1], 10);
    const map = { 57: 21, 51: 22, 45: 23, 39: 24 };
    zone = map[mc] || null;
    if (zone) {
      reasonParts.push(`Encontrado MC ${mc}°W → zona ${zone}.`);
      conf = "alta";
    }
  }

  // Fallback 1: Por Estado/UF
  if (!zone) {
    const inferred = inferZoneFromBrazilState(t);
    if (inferred) {
      zone = inferred;
      reasonParts.push(`Zona inferida como ${zone}S pela localidade.`);
      conf = "média";
    }
  }

  // Fallback 2: Pela matemática das coordenadas (CRUCIAL PARA PIRAQUARA)
  if (!zone && vertices && vertices.length > 0) {
    const mathInference = inferCrsByCoordinates(vertices); // Verifique se esta função existe no seu script
    if (mathInference) {
      zone = mathInference.zone;
      reasonParts.push(mathInference.reason);
      conf = "média";
    }
  }

  // Fallback 3: Padrão final
  if (!zone) {
    zone = 22;
    reasonParts.push(`Zona não encontrada; fallback ${zone}S.`);
  }

  // Retorno (Lógica de Datums)
  if (hasWGS) return { key: "WGS84", confidence: "alta", reason: "Encontrado 'WGS 84'." };

  if (hasSAD) {
    let key = (zone === 23) ? "SAD69_23S" : "SAD69_22S";
    return { key, confidence: conf, reason: `Encontrado 'SAD-69'. ${reasonParts.join(" ")}` };
  }

  // Se não achou SAD nem WGS, assume SIRGAS 2000 (Padrão IBGE)
  return {
    key: `SIRGAS2000_${zone}S`,
    confidence: conf,
    reason: (hasSIRGAS ? "Encontrado 'SIRGAS 2000'. " : "Datum assumido SIRGAS 2000. ") + reasonParts.join(" ")
  };
}

function detectProjectionFromAI(iaObj, inferredByCoords = null, projInfo = null) {
  if (!iaObj || typeof iaObj !== "object") return null;

  const rawParts = [
    iaObj.datum,
    iaObj.crs,
    iaObj.epsg,
    iaObj.srid,
    iaObj.projecao,
    iaObj.projection,
    iaObj.sistema,
    iaObj.spatial_reference,
    iaObj.spatialReference,
    iaObj.utm_zone,
    iaObj.utmZone,
    iaObj.zone,
    iaObj.zona,
    iaObj.fuso,
    iaObj.fuso_utm
  ].filter(Boolean);

  const raw = rawParts.join(" ");
  const lower = String(raw || "").toLowerCase();

  let epsgCode = null;
  if (typeof iaObj.epsg === "number" || typeof iaObj.epsg === "string") {
    epsgCode = String(iaObj.epsg).match(/\d{4,6}/)?.[0] || null;
  }
  if (!epsgCode) {
    epsgCode = raw.match(/epsg\s*[:=]?\s*(\d{4,6})/i)?.[1] || null;
  }

  if (epsgCode) {
    const key = Object.keys(PROJECTIONS).find(k => {
      const epsg = PROJECTIONS[k]?.epsg || "";
      return epsg.includes(epsgCode);
    });
    if (key) {
      return { key, confidence: "alta", reason: `EPSG ${epsgCode} informado pela IA.` };
    }
  }

  if (/(wgs\s*84|wgs84|wgs)/i.test(lower)) {
    return { key: "WGS84", confidence: "média", reason: "IA informou WGS84." };
  }

  const hasSad = /sad[\s\-]?69/.test(lower);
  const hasSirgas = /sirgas/.test(lower);
  let base = null;
  if (hasSad) base = "SAD69";
  if (hasSirgas) base = "SIRGAS2000";
  if (!base) return null;

  let zone = null;
  const zoneFields = [iaObj.zone, iaObj.zona, iaObj.fuso, iaObj.utm_zone, iaObj.utmZone, iaObj.fuso_utm].filter(Boolean);
  if (zoneFields.length) {
    const z = parseInt(String(zoneFields[0]).match(/\d{1,2}/)?.[0], 10);
    if (!Number.isNaN(z)) zone = z;
  }
  if (!zone) {
    const rawZone = raw.match(/(?:zona|zone|fuso|utm)\s*[:=]?\s*(\d{1,2})/i);
    if (rawZone?.[1]) zone = parseInt(rawZone[1], 10);
  }
  if (!zone && projInfo?.key) {
    const match = projInfo.key.match(/_(\d{2})S/);
    if (match?.[1]) zone = parseInt(match[1], 10);
  }
  if (!zone && inferredByCoords?.zone) zone = inferredByCoords.zone;
  if (!zone) zone = 22;

  const key = base === "SAD69"
    ? (zone === 23 ? "SAD69_23S" : "SAD69_22S")
    : `SIRGAS2000_${zone}S`;

  return {
    key,
    confidence: zone ? "média" : "baixa",
    reason: `IA informou datum ${base}${zone ? " e zona " + zone : ""}.`
  };
}

function resolveProjectionKeyForOutput(iaObj, projInfo, inferredByCoords) {
  const reasons = [];
  let key = null;
  let confidence = "baixa";

  const aiDetected = detectProjectionFromAI(iaObj, inferredByCoords, projInfo);
  if (aiDetected?.key) {
    key = aiDetected.key;
    confidence = aiDetected.confidence || confidence;
    if (aiDetected.reason) reasons.push(aiDetected.reason);
  }

  if (projInfo?.key) {
    if (!key) {
      key = projInfo.key;
      confidence = projInfo.confidence || confidence;
      if (projInfo.reason) reasons.push(`Texto: ${projInfo.reason}`);
    } else if (projInfo.key !== key && projInfo.confidence === "alta") {
      reasons.push(`Conflito IA vs texto; prevaleceu o CRS do texto (${projInfo.key}).`);
      key = projInfo.key;
      confidence = "alta";
    } else if (projInfo.key === key && projInfo.reason) {
      reasons.push(`Texto confirmou CRS: ${projInfo.reason}`);
    }
  }

  if (!key && inferredByCoords?.zone) {
    key = `SIRGAS2000_${inferredByCoords.zone}S`;
    confidence = "média";
    reasons.push(inferredByCoords.reason);
  }

  if (!key) {
    key = getActiveProjectionKey() || "SIRGAS2000_22S";
    reasons.push("CRS não identificado; usando seleção atual/padrão.");
  }

  return { key, info: { confidence, reason: reasons.join(" ") } };
}



// CSV com metadados
function gerarCsvParaVertices(vertices, epsg, docId = null, topologyInfo = null, memorialInfo = null, relativeInfo = null) {
  let csv = "\ufeffsep=;\n";

  // Cabeçalho profissional com metadados
  csv += `# MATRÍCULA;${docId || "N/A"}\n`;
  csv += `# EPSG;${epsg}\n`;
  if (relativeInfo?.relative) {
    csv += `# CRS_RELATIVO;SIM\n`;
    if (relativeInfo.start) {
      csv += `# ORIGEM_RELATIVA;${relativeInfo.start.east},${relativeInfo.start.north}\n`;
    }
  }
  if (topologyInfo) {
    csv += `# TOPOLOGY_VALID;${topologyInfo.isValid ? "SIM" : "NÃO"}\n`;
    csv += `# AREA_M2;${topologyInfo.area.toFixed(2)}\n`;
    csv += `# POLYGON_CLOSED;${topologyInfo.closed ? "SIM" : "NÃO"}\n`;
  }
  if (memorialInfo && memorialInfo.matches.length > 0) {
    const coherentMatches = memorialInfo.matches.filter(m => m.coherent).length;
    csv += `# MEMORIAL_COHERENCE;${coherentMatches}/${memorialInfo.matches.length}\n`;
  }
  csv += `#\n`;

  // Cabeçalho da tabela
  csv += "Point_ID;Ordem;Norte_Y;Este_X;EPSG;Dist_M;Azimute_Deg;Qualidade;Notas\n";

  // Estratégia de fechamento: se não estiver fechado, adiciona o primeiro vértice ao final
  let verticesToExport = [...vertices];
  if (topologyInfo && topologyInfo.closed === false && vertices.length > 2) {
    const first = vertices[0];
    // Cria um novo vértice de fechamento (Point_ID e Ordem incrementados)
    const closingVertex = {
      ...first,
      id: (first.id || "F") + "_close", // Sufixo para evitar duplicata
      ordem: vertices.length + 1,
      distCalc: "---",
      azCalc: "---"
    };
    verticesToExport.push(closingVertex);
  }

  for (let i = 0; i < verticesToExport.length; i++) {
    const c = verticesToExport[i];
    // Determinação de qualidade baseada em validação
    let quality = "✓ OK";
    let notes = "";
    // Verificar coerência com memorial se disponível
    if (memorialInfo && memorialInfo.matches[i]) {
      const match = memorialInfo.matches[i];
      if (!match.coherent) {
        quality = "⚠ AVISO";
        notes = `Az ${match.azDiff.toFixed(1)}° diff`;
        if (match.distDiff !== null && match.distDiff > 2) {
          notes += `; Dist ${match.distDiff.toFixed(1)}m diff`;
        }
      }
    }
    // Verificar se há distância "---" (último vértice ou fechamento)
    if (c.distCalc === "---") {
      notes = "Fechamento";
    }
    // Verificar duplicatas ou problemas topológicos
    if (i > 0) {
      const prev = verticesToExport[i - 1];
      if (prev.east === c.east && prev.north === c.north) {
        quality = "❌ ERRO";
        notes = "Duplicado";
      }
    }
    csv += `${c.id};${c.ordem};${c.north};${c.east};${epsg};${c.distCalc || ""};${c.azCalc || ""};${quality};${notes}\n`;
  }

  return csv;
}

// Relatorio de validacao
function gerarRelatorioValidacao(docId, pages, topologyInfo, memorialInfo, warnings) {
  let report = `RELATÓRIO DE VALIDAÇÃO - Matrícula ${docId}\n`;
  report += `Data: ${new Date().toLocaleString("pt-BR")}\n`;
  let safePages = Array.isArray(pages) ? pages.join(", ") : (typeof pages === 'string' ? pages : "(desconhecido)");
  report += `Páginas: ${safePages}\n`;
  report += `${"=".repeat(60)}\n\n`;

  if (topologyInfo) {
    report += `VALIDAÇÃO TOPOLÓGICA:\n`;
    report += `  Polígono válido: ${topologyInfo.isValid ? "✓ SIM" : "✗ NÃO"}\n`;
    report += `  Área: ${topologyInfo.area.toFixed(2)} m²\n`;
    report += `  Fechado: ${topologyInfo.closed ? "✓ SIM" : "✗ NÃO"}\n`;
    report += `  Auto-intersecções: ${topologyInfo.intersections.length > 0 ? `✗ ${topologyInfo.intersections.length} encontradas` : "✓ Nenhuma"}\n`;
    report += `  Sentido: ${topologyInfo.isCCW ? "Anti-horário (CCW)" : "Horário (CW)"}\n\n`;

    if (topologyInfo.errors.length > 0) {
      report += `  ERROS DETECTADOS:\n`;
      topologyInfo.errors.forEach(e => report += `    • ${e}\n`);
      report += `\n`;
    }

    if (topologyInfo.warnings.length > 0) {
      report += `  AVISOS:\n`;
      topologyInfo.warnings.forEach(w => report += `    • ${w}\n`);
      report += `\n`;
    }
  }

  if (memorialInfo && memorialInfo.matches.length > 0) {
    report += `VALIDAÇÃO COM MEMORIAL (Azimutes/Distâncias):\n`;
    const coherent = memorialInfo.matches.filter(m => m.coherent).length;
    report += `  Correspondência: ${coherent}/${memorialInfo.matches.length} edges coerentes\n`;
    report += `  Confiança: ${Math.round(coherent / memorialInfo.matches.length * 100)}%\n\n`;

    if (memorialInfo.issues.length > 0) {
      report += `  DISCREPÂNCIAS ENCONTRADAS:\n`;
      memorialInfo.issues.forEach(issue => report += `    • ${issue}\n`);
      report += `\n`;
    }
  }

  if (warnings && warnings.length > 0) {
    report += `AVISOS GERAIS:\n`;
    warnings.forEach(w => report += `  • ${w}\n`);
  }

  return report;
}


// UI: seletor de documento
function renderDocSelector() {
  if (!docSelectorBox || !docSelect) return;

  if (!documentsResults.length) {
    docSelectorBox.style.display = "none";
    return;
  }

  docSelectorBox.style.display = "block";
  docSelect.innerHTML = "";

  documentsResults.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `MAT ${d.docId} — ${(d.vertices || []).length} vértices`;
    docSelect.appendChild(opt);
  });

  if (activeDocIndex < 0) activeDocIndex = 0;
  docSelect.value = String(activeDocIndex);
  updateActiveDocUI();
}

function updateActiveDocUI() {
  const doc = getSelectedDoc();
  if (!doc) return;

  const projKey = doc.manualProjectionKey || doc.projectionKey || "(não detectado)";
  const epsg = PROJECTIONS[projKey]?.epsg || "";
  // Suportar tanto array de páginas (v2.0) quanto string (v3.0)
  const pages = Array.isArray(doc.pages)
    ? doc.pages.join(", ")
    : (typeof doc.pages === 'string' ? doc.pages : "(desconhecido)");
  const warns = (doc.warnings || []).length;

  if (docMeta) docMeta.textContent = `Páginas: ${pages}\nCRS: ${projKey}${epsg ? " (" + epsg + ")" : ""}\nAlertas: ${warns}`;

  showDetectedCrsUI(doc.manualProjectionKey || doc.projectionKey || null, doc.projectionInfo);

  if (advancedCrs) advancedCrs.style.display = (doc.manualProjectionKey || doc.projectionKey) ? "none" : "block";

  extractedCoordinates = doc.vertices || [];
  fileNameBase = `MAT_${doc.docId}`;
  displayResults();
}

if (docSelect) {
  docSelect.addEventListener("change", () => {
    activeDocIndex = parseInt(docSelect.value, 10);
    updateActiveDocUI();
  });
}

// UI: tabela de vertices
function displayResults() {
  resultBox.style.display = "block";
  countDisplay.innerText = extractedCoordinates.length;
  previewTableBody.innerHTML = "";
  for (const c of extractedCoordinates) {
    previewTableBody.innerHTML += `
      <tr>
        <td>${c.ordem}</td>
        <td>${c.id}</td>
        <td>${c.north}</td>
        <td>${c.east}</td>
        <td>${c.distCalc}</td>
        <td>${c.azCalc}</td>
      </tr>`;
  }
  scrollToResults();
}

// Processamento do PDF
fileInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  // Reset de UI e estado
  fileNameBase = file.name.replace(/\.[^/.]+$/, "");
  pdfOrigemNomeBase = file.name.replace(/\.[^/.]+$/, "");
  pdfOrigemSrc = file.name;
  document.getElementById("fileNameDisplay").innerText = file.name;
  progressContainer.style.display = "block";
  resultBox.style.display = "none";
  statusDiv.style.display = "none";
  extractedCoordinates = [];
  previewTableBody.innerHTML = "";
  documentsResults = [];
  activeDocIndex = -1;

  const ocrAvailable = (window.Android && window.Android.performOCR) || window.Tesseract;
  if (!ocrAvailable) {
    const msg = "⚠️ OCR indisponivel: habilite Tesseract.js no navegador ou OCR do Android.";
    updateStatus(msg, "warning");
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] ${msg}`);
    }
  }

  try {
    updateStatus("📄 Carregando PDF...", "info");
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), ignoreEncryption: true }).promise;
    const pagesText = [];

    // Leitura de todas as paginas
    let emptyPages = 0;
    let ocrPages = 0;
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] 📖 Lendo ${pdf.numPages} página(s)`);
    }
    
    for (let i = 1; i <= pdf.numPages; i++) {
      progressBar.value = Math.round((i / pdf.numPages) * 100);
      document.getElementById("progressLabel").innerText = `Lendo página ${i}/${pdf.numPages}...`;

      try {
        const page = await pdf.getPage(i);
        const pageText = await extractPageTextSafely(page, i);

        // Se a página estiver vazia/escaneada, apenas mantém o texto vazio (não faz OCR)
        let safeText = pageText || "";
        const hasSignal = hasCoordinateSignal(safeText);
        if (!safeText.trim() || !hasSignal) {
          document.getElementById("progressLabel").innerText = `OCR da página ${i}/${pdf.numPages}...`;
          if (typeof displayLogMessage === 'function') {
            const reason = safeText.trim() ? 'sem padrao de coordenadas' : 'texto vazio';
            displayLogMessage(`[PDFtoArcgis][LogUI] 🔍 Página ${i}: OCR (${reason})`);
          }
          const ocrText = await performOcrOnPage(page, i);
          if (ocrText && ocrText.trim().length > 10 && hasCoordinateSignal(ocrText)) {
            safeText = ocrText;
            ocrPages++;
            if (typeof displayLogMessage === 'function') {
              displayLogMessage(`[PDFtoArcgis][LogUI] ✅ Página ${i}: OCR ok (${ocrText.length} chars)`);
            }
          } else if (!hasSignal) {
            safeText = "";
          }
        } else {
          if (typeof displayLogMessage === 'function') {
            displayLogMessage(`[PDFtoArcgis][LogUI] ✓ Página ${i}: texto ok (${safeText.length} chars)`);
          }
        }
        if (safeText && !hasCoordinateSignal(safeText)) {
          safeText = "";
          if (typeof displayLogMessage === 'function') {
            displayLogMessage(`[PDFtoArcgis][LogUI] ℹ️ Página ${i}: sem padrao de coordenadas`);
          }
        }
        if (!safeText.trim()) emptyPages++;
        pagesText.push(safeText);
      } catch (e) {
        const msg = `[PDFtoArcgis] Erro ao ler página ${i}: ${e?.message || e}`;
        if (typeof displayLogMessage === 'function') {
          displayLogMessage(msg);
        } else {
          console.error(msg);
        }
        emptyPages++;
        pagesText.push("");
        continue;
      }
    }

    if (ocrPages > 0) {
      const msg = `ℹ️ OCR em ${ocrPages} página(s).`;
      updateStatus(msg, "info");
      if (typeof displayLogMessage === 'function') {
        displayLogMessage(`[PDFtoArcgis][LogUI] ${msg}`);
      }
    }
    if (emptyPages > 0) {
      const msg = `⚠️ ${emptyPages} página(s) sem texto detectável. Reexporte com camada de texto.`;
      updateStatus(msg, "warning");
      if (typeof displayLogMessage === 'function') {
        displayLogMessage(`[PDFtoArcgis][LogUI] ${msg}`);
      }
    }

    // --- LÓGICA DE INFERÊNCIA REVERSA ---
    const fullText = pagesText.join("\n");

    // Detectar CRS apenas pelo texto (IA faz a extração de vertices)
    const projInfo = detectProjectionFromText(fullText, []);

    // Agora sim chama o processamento final
    processExtractUnified(pagesText, projInfo);

  } catch (e) {
    console.error("Erro no processamento:", e);
    updateStatus("Erro: " + e.message, "error");
  }
});



async function processExtractUnified(pagesText, projInfo = null) {
  // Estratégia única: Processar página por página
  let iaObj = null;
  
  console.log(`[PDFtoArcgis] Processando ${pagesText.length} página(s) individualmente...`);
  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] 🤖 IA: extraindo coordenadas (texto bruto)`);
  }
  iaObj = await deducePolygonVerticesPerPage(pagesText);
  
  if (!iaObj) {
    updateStatus('❌ Falha na extração por IA.', 'error');
    progressContainer.style.display = "none";
    return;
  }

  const rawVertices = Array.isArray(iaObj.vertices) ? iaObj.vertices : [];
  let relativeMode = iaObj?.modo === "relativo" || iaObj?.relative === true;
  const hasLatLon = rawVertices.some(v => v?.lat !== undefined || v?.lon !== undefined || v?.latitude !== undefined || v?.longitude !== undefined);

  let vertices = rawVertices.map((v, idx) => ({
    id: v.id || `V${String(idx + 1).padStart(3, '0')}`,
    north: typeof v.norte === 'number' ? v.norte : (typeof v.north === 'number' ? v.north : parseFloat((v.norte ?? v.north ?? "").toString().replace(/,/g, "."))),
    east: typeof v.este === 'number' ? v.este : (typeof v.east === 'number' ? v.east : parseFloat((v.este ?? v.east ?? "").toString().replace(/,/g, "."))),
    lat: typeof v.lat === 'number' ? v.lat : (typeof v.latitude === 'number' ? v.latitude : parseFloat((v.lat ?? v.latitude ?? "").toString().replace(/,/g, "."))),
    lon: typeof v.lon === 'number' ? v.lon : (typeof v.longitude === 'number' ? v.longitude : parseFloat((v.lon ?? v.longitude ?? "").toString().replace(/,/g, "."))),
    azimute: v.azimute,
    azimute_dms: v.azimute_dms,
    distancia: v.distancia,
    ordem: idx + 1
  }));

  let relativeInfo = null;
  const warnings = [];
  let forceProjectionKey = null;
  let projectionReason = null;

  const hasCoords = vertices.some(v => Number.isFinite(v.north) && Number.isFinite(v.east));
  const hasMeasures = rawVertices.some(v => v?.azimute !== undefined || v?.azimute_dms || v?.distancia !== undefined);
  if (!relativeMode && !hasCoords && hasMeasures) relativeMode = true;

  if (relativeMode) {
    const rebuilt = buildRelativeVerticesFromMeasures(rawVertices, 0, 0);
    vertices = rebuilt;
    relativeInfo = { relative: true, start: { east: 0, north: 0 } };
    forceProjectionKey = "RELATIVO";
    projectionReason = "Polígono relativo (sem coordenadas absolutas); origem (0,0).";
    warnings.push("Polígono relativo: sem georreferenciamento absoluto (origem 0,0).");
  } else if (hasLatLon) {
    const converted = [];
    let zone = null;
    for (const v of vertices) {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
      const conv = latLonToUtm(v.lat, v.lon, zone);
      if (!conv) continue;
      zone = conv.zone || zone;
      converted.push({
        id: v.id,
        north: conv.north,
        east: conv.east,
        ordem: converted.length + 1,
        azimute: v.azimute,
        azimute_dms: v.azimute_dms,
        distancia: v.distancia
      });
    }
    vertices = converted;
    if (zone) {
      forceProjectionKey = `SIRGAS2000_${String(zone).padStart(2, '0')}S`;
      projectionReason = "Lat/Lon convertidas para UTM (SIRGAS2000).";
    }
  }

  // Remover vértices inválidos
  vertices = vertices.filter(v => Number.isFinite(v.north) && Number.isFinite(v.east));

  if (vertices.length < 3) {
    updateStatus('❌ Menos de 3 vértices válidos extraídos.', 'error');
    progressContainer.style.display = "none";
    return;
  }

  // === RECALCULAR DISTÂNCIAS E AZIMUTES ===
  vertices = prepararVerticesComMedidas(vertices);

  // CRS: IA + texto + coordenadas
  const fullText = pagesText.join("\n");
  const inferredByCoords = forceProjectionKey === "RELATIVO" ? null : inferCrsByCoordinates(vertices);
  const resolvedProjection = resolveProjectionKeyForOutput(iaObj, projInfo, inferredByCoords);
  const projKey = forceProjectionKey || resolvedProjection.key || (getActiveProjectionKey() || "SIRGAS2000_22S");
  window._arcgis_crs_key = projKey;
  const topologyValidation = validatePolygonTopology(vertices, projKey);
  
  // IA fornece azimutes/distâncias (sem regex paralelo)
  const memorialData = { azimutes: [], distances: [] };
  const memorialValidation = { matches: [], issues: [] };

  // documentsResults para exportacao
  documentsResults = [{
    docId: iaObj.matricula || "SEM_ID",
    pages: "1-" + pagesText.length,
    projectionKey: projKey,
    manualProjectionKey: null,
    projectionInfo: forceProjectionKey
      ? { confidence: "baixa", reason: projectionReason || "CRS relativo" }
      : (resolvedProjection.info || (inferredByCoords
        ? { confidence: "média", reason: inferredByCoords.reason }
        : { confidence: "baixa", reason: "CRS não inferido pelas coordenadas; usando seleção atual/padrão" })),
    vertices: vertices,
    warnings: warnings,
    topology: topologyValidation,
    memorialValidation: memorialValidation,
    memorialData: memorialData,
    relativeInfo: relativeInfo,
    text: fullText
  }];

  activeDocIndex = 0;

  // UI CRS
  showDetectedCrsUI(projKey, documentsResults[0].projectionInfo);

  // UI resultados
  extractedCoordinates = vertices;
  fileNameBase = iaObj.matricula ? `MAT_${iaObj.matricula}` : "coordenadas_extracao";
  
  // Validacao topologica antes de exibir
  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] 🔍 Validando topologia do polígono...`);
  }
  
  const topology = validatePolygonTopology(vertices, projKey);
  documentsResults[0].topology = topology;
  
  // Log de validacao
  if (topology.isValid) {
    console.log(`[PDFtoArcgis] ✅ Polígono válido: área ${topology.area.toFixed(2)}m², fechado: ${topology.closed ? 'SIM' : 'NÃO'}`);
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] ✅ Polígono válido! Área: ${topology.area.toFixed(2)}m²`);
    }
  } else {
    console.warn(`[PDFtoArcgis] ⚠️ Polígono com problemas:`, topology.errors);
  }
  
  if (topology.warnings.length > 0) {
    console.warn(`[PDFtoArcgis] ⚠️ Avisos:`, topology.warnings);
  }
  
  // UI de validacao
  updateValidationUI(topology);
  
  // Remover duplicatas se houver erro
  if (!topology.isValid && topology.errors.length > 0) {
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] ⚠️ Problemas detectados: ${topology.errors.join(', ')}`);
    }
    
    // Remover vertices muito proximos
    const uniqueVertices = [];
    for (const v of vertices) {
      const isDuplicate = uniqueVertices.some(u => 
        Math.abs(u.este - v.este) < 0.5 && Math.abs(u.norte - v.norte) < 0.5
      );
      if (!isDuplicate) {
        uniqueVertices.push(v);
      }
    }
    
    if (uniqueVertices.length < vertices.length) {
      console.log(`[PDFtoArcgis] 🔧 Removidos ${vertices.length - uniqueVertices.length} vértice(s) duplicado(s)`);
      extractedCoordinates = uniqueVertices;
      vertices = uniqueVertices;
      documentsResults[0].vertices = uniqueVertices;
      
      // Revalidar
      const revalidated = validatePolygonTopology(uniqueVertices, projKey);
      documentsResults[0].topology = revalidated;
      updateValidationUI(revalidated);
      
      if (revalidated.isValid) {
        if (typeof displayLogMessage === 'function') {
          displayLogMessage(`[PDFtoArcgis][LogUI] ✅ Polígono corrigido com sucesso!`);
        }
        console.log(`[PDFtoArcgis] ✅ Correção bem-sucedida. Nova área: ${revalidated.area.toFixed(2)}m²`);
      } else {
        if (typeof displayLogMessage === 'function') {
          displayLogMessage(`[PDFtoArcgis][LogUI] ⚠️ Algumas correções automáticas não resolveram todos os problemas. Verifique o relatório.`);
        }
      }
    }
  }
  
  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] 📊 Preparando tabela de vértices para visualização...`);
  }
  
  resultBox.style.display = 'block';
  countDisplay.textContent = vertices.length;
  previewTableBody.innerHTML = '';
  
  for (const v of vertices) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${v.ordem}</td>
      <td>${v.id || ''}</td>
      <td>${(v.north || 0).toFixed(3)}</td>
      <td>${(v.east || 0).toFixed(3)}</td>
      <td>${v.distCalc || '---'}</td>
      <td>${v.azCalc || '---'}</td>
    `;
    previewTableBody.appendChild(row);
  }
  
  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] 🎯 Pronto para exportar arquivos`);
  }

  // Status final
  progressContainer.style.display = "none";
  updateStatus(`✅ IA concluiu: ${vertices.length} coordenadas processadas.`, 'success');
  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] ✨ Pronto! Você pode agora baixar ou salvar os resultados`);
  }
  
  // Reabilitar botoes
  if (downloadBtn) downloadBtn.disabled = false;
  if (saveToFolderBtn) saveToFolderBtn.disabled = false;

  // Seletor de documentos
  renderDocSelector();
  
  scrollToResults();
}

// Exportar CSV
downloadBtn.onclick = () => {
  if (!extractedCoordinates.length) return;
  try {
    const key = getActiveProjectionKey();
    const doc = getSelectedDoc();
    const epsg = PROJECTIONS[key]?.epsg || (doc?.relativeInfo?.relative ? "RELATIVO" : "");
    const crsName = doc?.relativeInfo?.relative ? "RELATIVO" : (key ? key.replace(/[^\w]/g, "_") : "CRS");

    // Gerar CSV com diagnóstico profissional
    const csv = gerarCsvParaVertices(
      extractedCoordinates,
      epsg,
      doc?.docId || "DESCONHECIDA",
      doc?.topology,
      doc?.memorialValidation,
      doc?.relativeInfo
    );

    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    // Novo: incluir nome do PDF de origem e src no nome do arquivo
    link.download = `${pdfOrigemNomeBase || fileNameBase}_${crsName}_Validado_${pdfOrigemSrc || "src"}.csv`;
    link.click();

    // Também exportar relatório se houver validação
    if (doc?.topology || doc?.memorialValidation) {
      const relatorio = gerarRelatorioValidacao(
        doc.docId,
        doc.pages,
        doc.topology,
        doc.memorialValidation,
        doc.warnings
      );
      const linkRel = document.createElement("a");
      linkRel.href = URL.createObjectURL(new Blob([relatorio], { type: "text/plain;charset=utf-8;" }));
      // Novo: incluir nome do PDF de origem e src no nome do arquivo
      linkRel.download = `${pdfOrigemNomeBase || fileNameBase}_${crsName}_Relatorio_${pdfOrigemSrc || "src"}.txt`;
      linkRel.click();
    }
  } catch (e) {
    // Se o usuário cancelar o download, não mostrar erro
    if (e && e.name !== "AbortError") {
      updateStatus("Erro ao baixar arquivo: " + e.message, "error");
    }
  }
};

// Salvar na pasta (SHP + CSV)
const toArrayBufferFS = (view) => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

saveToFolderBtn.onclick = async () => {
  const hasDocs = Array.isArray(documentsResults) && documentsResults.length > 0;
  if (!hasDocs && !extractedCoordinates.length) return alert("⚠️ Processe um arquivo primeiro.");

  if (!("showDirectoryPicker" in window)) {
    updateStatus("❌ Seu navegador não suporta showDirectoryPicker. Use Edge/Chrome em HTTPS.", "error");
    return;
  }

  try {
    let handle = await window.showDirectoryPicker({ mode: "readwrite" });

    // Helper local de logging (fallback se displayLogMessage não estiver disponível)
    const logWrite = (msg) => {
      if (typeof displayLogMessage === "function") {
        displayLogMessage(msg);
      } else {
        console.log(msg);
      }
    };

    const writeFile = async (name, data) => {
      try {
        logWrite(`[PDFtoArcgis] 📝 Gravando ${name}...`);
        
        // Usar keepExistingData: false para sobrescrever se o arquivo já existe
        const fh = await handle.getFileHandle(name, { create: true });
        const w = await fh.createWritable({ keepExistingData: false });
        await w.write(data);
        await w.close();
        logWrite(`[PDFtoArcgis] ✓ ${name} gravado`);
      } catch (err) {
        // Se o usuário cancelar, não mostrar erro
        if (err && err.name === "AbortError") return;
        
        // Se falhar por estado inválido, indicar problema
        if (err && (err.name === "InvalidStateError" || err.message.includes("state cached"))) {
          logWrite("[PDFtoArcgis] ⚠️ Diretório desincronizado. Re-selecionando...");
          // Tentar re-selecionar e fazer retry uma única vez
          try {
            handle = await window.showDirectoryPicker({ mode: "readwrite" });
            const fhRetry = await handle.getFileHandle(name, { create: true });
            const wRetry = await fhRetry.createWritable({ keepExistingData: false });
            await wRetry.write(data);
            await wRetry.close();
            logWrite(`[PDFtoArcgis] ✓ ${name} gravado (após re-sincronizar)`);
            return;
          } catch (retryErr) {
            logWrite(`[PDFtoArcgis] ❌ Falha após re-sincronizar: ${retryErr.message}`);
            throw new Error("Diretório permanentemente desincronizado. Selecione a pasta novamente.");
          }
        }
        
        logWrite(`[PDFtoArcgis] ❌ Erro ao salvar ${name}: ${err.message}`);
        throw err;
      }
    };

    // Caso PDF simples (sem split)
    if (!hasDocs) {
      const key = getActiveProjectionKey();
      const projection = PROJECTIONS[key];
      if (!projection) throw new Error("CRS não suportado.");

      const base = sanitizeFileName(fileNameBase);
      const ring = extractedCoordinates.map(c => [c.east, c.north]);
      ring.push([ring[0][0], ring[0][1]]);

      const pointGeoms = extractedCoordinates.map(c => [c.east, c.north]);
      const pointProps = extractedCoordinates.map(c => ({
        ID: String(c.id).slice(0, 20),
        ORDEM: c.ordem,
        NORTH: c.north,
        EAST: c.east,
        EPSG: projection.epsg
      }));

      updateStatus("🗂️ Gravando SHP + CSV na pasta...", "info");

      let crsName = projection && projection.epsg ? projection.epsg : "CRS";
      crsName = String(crsName).replace(/[^\w\d]/g, "_");

      await new Promise((resolve, reject) => {
        window.shpwrite.write(
          [{ NOME: base, VERTICES: extractedCoordinates.length, EPSG: projection.epsg, TIPO: "LIMITE" }],
          "POLYGON",
          [[[ring]]],
          async (err, files) => {
            if (err) return reject(err);
            try {
              // Apenas gravando a versão limpa
              await writeFile(`${base}_${crsName}_limite.shp`, toArrayBufferFS(files.shp));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_limite.shx`, toArrayBufferFS(files.shx));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_limite.dbf`, toArrayBufferFS(files.dbf));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_limite.prj`, projection.wkt);
              resolve();
            } catch (e) { reject(e); }
          }
        );
      });

      await new Promise((resolve, reject) => {
        window.shpwrite.write(
          pointProps,
          "POINT",
          pointGeoms,
          async (err, files) => {
            if (err) return reject(err);
            try {
              // Apenas gravando a versão limpa
              await writeFile(`${base}_${crsName}_vertices.shp`, toArrayBufferFS(files.shp));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_vertices.shx`, toArrayBufferFS(files.shx));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_vertices.dbf`, toArrayBufferFS(files.dbf));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_vertices.prj`, projection.wkt);
              resolve();
            } catch (e) { reject(e); }
          }
        );
      });

      const csv = gerarCsvParaVertices(extractedCoordinates, projection.epsg, fileNameBase);
      await writeFile(`${base}_${crsName}_Validado.csv`, csv);

      updateStatus("✅ Gravado: limite + vertices + CSV (com .prj)!", "success");
      return;
    }

    // Caso PDF unificado (todas as matrículas)
    updateStatus(`🗂️ Gravando ${documentsResults.length} matrículas (SHP + CSV)...`, "info");

    let saved = 0;
    const skipped = [];

    for (const doc of documentsResults) {
      const vertices = Array.isArray(doc.vertices) ? doc.vertices : [];
      const docId = doc.docId || "SEM_ID";

      if (vertices.length < 3) {
        skipped.push(`Arquivo ${pdfOrigemSrc || "src"}: vértices insuficientes (${vertices.length})`);
        continue;
      }

      const projKey = doc.manualProjectionKey || doc.projectionKey || getActiveProjectionKey();
      const projection = PROJECTIONS[projKey];
      const isRelative = doc.relativeInfo?.relative === true;
      if (!projection && !isRelative) {
        skipped.push(`Arquivo ${pdfOrigemSrc || "src"}: CRS não suportado (${projKey})`);
        continue;
      }

      const base = sanitizeFileName(pdfOrigemNomeBase || fileNameBase);
      const ring = vertices.map(c => [c.east, c.north]);

      let crsName = projection && projection.epsg ? projection.epsg : (isRelative ? "RELATIVO" : "CRS");
      crsName = String(crsName).replace(/[^\w\d]/g, "_");

      // Limite (POLYGON)
      await new Promise((resolve, reject) => {
        window.shpwrite.write(
          [{ NOME: base, VERTICES: vertices.length, EPSG: projection?.epsg || (isRelative ? "RELATIVO" : ""), TIPO: "LIMITE" }],
          "POLYGON",
          [[[ring]]],
          async (err, files) => {
            if (err) return reject(err);
            try {
              // Apenas gravando a versão limpa
              await writeFile(`${base}_${crsName}_limite.shp`, toArrayBufferFS(files.shp));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_limite.shx`, toArrayBufferFS(files.shx));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_limite.dbf`, toArrayBufferFS(files.dbf));
              await new Promise(r => setTimeout(r, 100));
              if (projection?.wkt) {
                await writeFile(`${base}_${crsName}_limite.prj`, projection.wkt);
              }
              resolve();
            } catch (e) { reject(e); }
          }
        );
      });

      // Vertices (POINT)
      const pointGeoms = vertices.map(c => [c.east, c.north]);
      const pointProps = vertices.map(c => ({
        ID: String(c.id).slice(0, 20),
        ORDEM: c.ordem,
        NORTH: c.north,
        EAST: c.east,
        EPSG: projection?.epsg || (isRelative ? "RELATIVO" : "")
      }));

      await new Promise((resolve, reject) => {
        window.shpwrite.write(
          pointProps,
          "POINT",
          pointGeoms,
          async (err, files) => {
            if (err) return reject(err);
            try {
              // Apenas gravando a versão limpa
              await writeFile(`${base}_${crsName}_vertices.shp`, toArrayBufferFS(files.shp));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_vertices.shx`, toArrayBufferFS(files.shx));
              await new Promise(r => setTimeout(r, 100));
              await writeFile(`${base}_${crsName}_vertices.dbf`, toArrayBufferFS(files.dbf));
              await new Promise(r => setTimeout(r, 100));
              if (projection?.wkt) {
                await writeFile(`${base}_${crsName}_vertices.prj`, projection.wkt);
              }
              resolve();
            } catch (e) { reject(e); }
          }
        );
      });

      // CSV
      const csv = gerarCsvParaVertices(vertices, projection?.epsg || (isRelative ? "RELATIVO" : ""), docId, doc.topology, doc.memorialValidation, doc.relativeInfo);
      await writeFile(`${base}_${crsName}_Validado.csv`, csv);

      // Relatório de validação
      if (doc.topology || doc.memorialValidation) {
        let safePages = Array.isArray(doc.pages) ? doc.pages : (typeof doc.pages === 'string' ? doc.pages : '(desconhecido)');
        const relatorio = gerarRelatorioValidacao(docId, safePages, doc.topology, doc.memorialValidation, doc.warnings);
        await writeFile(`${base}_${crsName}_Relatorio.txt`, relatorio);
      }

      saved++;
    }

    if (skipped.length) {
      updateStatus(`✅ Concluído. Matrículas salvas: ${saved}\n⚠️ Ignoradas: ${skipped.length}\n- ${skipped.join("\n- ")}`, "warning");
    } else {
      updateStatus(`✅ Concluído. Matrículas salvas: ${saved}`, "success");
    }

  } catch (e) {
    if (e && (e.name === "InvalidStateError" || e.message.includes("state cached"))) {
      updateStatus("❌ Erro ao salvar na pasta: Diretório foi modificado. Selecione a pasta novamente.", "error");
    } else if (e && e.name === "NotAllowedError") {
      updateStatus("❌ Erro: Permissão negada ao acessar a pasta. Verifique as permissões do navegador.", "error");
    } else {
      updateStatus("❌ Erro ao salvar na pasta: " + (e.message || String(e)), "error");
    }
  }
};

// Modo avancado: forcar CRS
if (forceCrsBtn) {
  forceCrsBtn.addEventListener("click", () => {
    if (!projectionSelect) return;
    const key = projectionSelect.value;
    const doc = getSelectedDoc();

    if (doc) {
      doc.manualProjectionKey = key;
      doc.projectionInfo = { confidence: "manual", reason: "CRS forçado manualmente para a matrícula selecionada." };
      updateStatus(`ℹ️ CRS aplicado manualmente (MAT ${doc.docId}): ${key}`, "info");
      updateActiveDocUI();
    } else {
      updateStatus(`ℹ️ CRS aplicado manualmente: ${key}`, "info");
      showDetectedCrsUI(key, { confidence: "manual", reason: "CRS forçado manualmente." });
    }
  });
}


// Elementos do memorial
const shpInput = document.getElementById("shpInput");
const memorialMetaBox = document.getElementById("memorialMetaBox");
const respTecnicoInput = document.getElementById("respTecnico");
const respCreaInput = document.getElementById("respCrea");
const cidadeDetectadaInput = document.getElementById("cidadeDetectada");
const generateDocxBtn = document.getElementById("generateDocxBtn");

// Estado
let shpVertices = [];
let shpCrsKey = null;
let shpCrsText = "";
let shpPoligonoNome = "";
let shpCityName = "";

// Formatadores (pt-BR)
const BRNumber2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtMeters2(v) { return BRNumber2.format(v); }
function toDMS(az) {
  az = ((az % 360) + 360) % 360;
  const d = Math.floor(az);
  const mFloat = (az - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d, 3)}°${pad(m)}'${pad(s)}"`;
}
function crsKeyToText(key) {
  if (!key) return "CRS não identificado";
  const p = PROJECTIONS[key];
  if (!p) return key;
  return `${p.name.replace('zone', 'Zona').replace('zone ', 'Zona ')} (${p.epsg})`;
}
function inferCityFromVertices(vertices, key) {
  if (!vertices || vertices.length === 0) return "";
  const avgE = vertices.reduce((s, v) => s + v.east, 0) / vertices.length;
  const avgN = vertices.reduce((s, v) => s + v.north, 0) / vertices.length;

  let lonlat = null, lat = null, lon = null;
  try {
    if (key && key.startsWith("SIRGAS2000_")) {
      const zone = parseInt(key.match(/_(\d{2})S$/)?.[1] || "22", 10);
      const projStr = `+proj=utm +zone=${zone} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
      lonlat = proj4(projStr, proj4.WGS84, [avgE, avgN]); // [lon, lat]
    }
  } catch (e) { }

  if (lonlat && Array.isArray(lonlat)) { lon = lonlat[0]; lat = lonlat[1]; }

  const isCuritiba = (lat && lon)
    ? (lat >= -25.60 && lat <= -25.25 && lon >= -49.45 && lon <= -49.10)
    : (avgN >= 7.170e6 && avgN <= 7.220e6 && avgE >= 660000 && avgE <= 710000);

  const isPiraquara = (lat && lon)
    ? (lat >= -25.60 && lat <= -25.35 && lon >= -49.25 && lon <= -48.95)
    : (avgN >= 7.180e6 && avgN <= 7.200e6 && avgE >= 680000 && avgE <= 705000);

  if (isPiraquara) return "Piraquara-PR";
  if (isCuritiba) return "Curitiba-PR";
  return "Município não identificado";
}
async function extractPrjFromZip(file) {
  try {
    const ab = await file.arrayBuffer();
    const zip = new PizZip(ab);
    const names = Object.keys(zip.files);
    const prjName = names.find(n => n.toLowerCase().endsWith(".prj"));
    if (!prjName) return null;
    return zip.files[prjName].asText();
  } catch (e) { return null; }
}
function resolveCrsKeyFromPrj(prjText) {
  if (!prjText) return null;
  const t = prjText.toUpperCase();
  if (t.includes("SIRGAS") && t.includes("UTM")) {
    if (t.includes("ZONE 21") || t.includes("ZONA 21")) return "SIRGAS2000_21S";
    if (t.includes("ZONE 22") || t.includes("ZONA 22")) return "SIRGAS2000_22S";
    if (t.includes("ZONE 23") || t.includes("ZONA 23")) return "SIRGAS2000_23S";
    if (t.includes("ZONE 24") || t.includes("ZONA 24")) return "SIRGAS2000_24S";
    if (t.includes("ZONE 25") || t.includes("ZONA 25")) return "SIRGAS2000_25S";
  }
  if (t.includes("SAD") && t.includes("UTM")) {
    if (t.includes("ZONE 22") || t.includes("ZONA 22")) return "SAD69_22S";
    if (t.includes("ZONE 23") || t.includes("ZONA 23")) return "SAD69_23S";
  }
  if (t.includes("WGS") && !t.includes("UTM")) return "WGS84";
  return null;
}
function inferCrsKeyByValues(vertices) {
  const hint = inferCrsByCoordinates(vertices);
  if (hint?.zone) return `SIRGAS2000_${hint.zone}S`;
  return null;
}
function verticesFromGeoJSON(geojson, keyGuess = null) {
  let vertices = [];
  if (!geojson) return vertices;

  let f = null;
  if (geojson.type === "FeatureCollection") f = geojson.features?.[0];
  else if (geojson.type === "Feature") f = geojson;
  else return vertices;

  if (!f || !f.geometry) return vertices;
  const g = f.geometry;

  if (g.type === "Polygon" && Array.isArray(g.coordinates) && g.coordinates.length > 0) {
    const ring = g.coordinates[0];
    vertices = ring.map((xy, i) => ({ id: `V${String(i + 1).padStart(3, '0')}`, east: xy[0], north: xy[1] }));
  }
  else if (g.type === "MultiPolygon" && g.coordinates.length > 0) {
    const ring = g.coordinates[0][0];
    vertices = ring.map((xy, i) => ({ id: `V${String(i + 1).padStart(3, '0')}`, east: xy[0], north: xy[1] }));
  }
  else if (g.type === "Point" && Array.isArray(g.coordinates)) {
    const xy = g.coordinates;
    vertices = [{ id: "V001", east: xy[0], north: xy[1] }];
  }

  if (keyGuess && (keyGuess.startsWith("SIRGAS2000_") || keyGuess.startsWith("SAD69_"))) {
    const zone = parseInt(keyGuess.match(/_(\d{2})S$/)?.[1] || "22", 10);
    const projStr = `+proj=utm +zone=${zone} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
    const inDegrees = vertices.some(v => Math.abs(v.east) <= 180 && Math.abs(v.north) <= 90);
    if (inDegrees) {
      vertices = vertices.map(v => {
        const xy = proj4(proj4.WGS84, projStr, [v.east, v.north]); // [E,N]
        return { ...v, east: xy[0], north: xy[1] };
      });
    }
  }

  const cleaned = [];
  for (const p of vertices) {
    const last = cleaned[cleaned.length - 1];
    if (!last || last.east !== p.east || last.north !== p.north) cleaned.push(p);
  }
  if (cleaned.length >= 3) {
    const first = cleaned[0], last = cleaned[cleaned.length - 1];
    const distClose = Math.hypot(last.east - first.east, last.north - first.north);
    if (distClose > 0.01) cleaned.push({ ...first, id: `V${String(cleaned.length + 1).padStart(3, '0')}` });
  }
  return cleaned;
}
function prepararVerticesComMedidas(vertices) {
  const out = [];
  for (let i = 0; i < vertices.length; i++) {
    const v = { ...vertices[i], ordem: i + 1 };
    if (i < vertices.length - 1) {
      v.distCalc = fmtMeters2(calcularDistancia(vertices[i], vertices[i + 1]));
      v.azCalc = toDMS(calcularAzimute(vertices[i], vertices[i + 1]));
    } else {
      v.distCalc = "---";
      v.azCalc = "---";
    }
    out.push(v);
  }
  return out;
}

// Evento: carregar SHP
if (shpInput) {
  shpInput.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;

    try {
      updateStatus("🔄 Lendo SHP...", "info");

      // Nome amigavel
      shpPoligonoNome = file.name
        .replace(/\.[^/.]+$/, "")
        .replace(/_/g, " ")
        .trim();

      // Extensao
      const isZip = file.name.toLowerCase().endsWith(".zip");
      const isShp = file.name.toLowerCase().endsWith(".shp");

      let geojson = null;
      let prjText = null;

      if (isZip) {
        // ZIP -> GeoJSON
        const ab = await file.arrayBuffer();
        const geo = await shp(ab); // retorna FeatureCollection/Feature/Geometry
        // Forcar Polygon
        geojson = buildFeatureCollectionFromAny(geo);
        // .prj do ZIP
        prjText = await extractPrjFromZip(file);
      }
      if (isZip) {
        // ZIP -> leitor tolerante
        const ab = await file.arrayBuffer();
        geojson = await readZipAsFeatureCollection(ab);
        // .prj do ZIP
        prjText = await extractPrjFromZip(file);
      }
      else if (isShp) {
        // .shp solto
        const shpBuf = await file.arrayBuffer();
        const geom = await shp.parseShp(shpBuf); // [[x,y], [x,y], ...] ou múltiplos
        const ring = Array.isArray(geom) ? geom : [];
        const geometry = { type: "Polygon", coordinates: [ring] };

        geojson = {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry }]
        };
        // Sem ZIP: CRS por inferencia
      }
      else {
        throw new Error("Formato não suportado. Use .zip (SHP+DBF+PRJ) ou .shp.");
      }

      // Diagnostico GeoJSON
      logGeojsonSummary(geojson);

      // CRS
      shpCrsKey = resolveCrsKeyFromPrj(prjText);
      // Vertices no CRS de entrada
      let vertsRaw = verticesFromGeoJSON(geojson, shpCrsKey);
      console.log("[SHP] vertsRaw:", Array.isArray(vertsRaw) ? vertsRaw.length : vertsRaw);

      if (!shpCrsKey) {
        // Se não veio do .prj, tenta inferir pelos próprios valores
        shpCrsKey = inferCrsKeyByValues(vertsRaw) || "SIRGAS2000_22S";
      }

      // Vertices no CRS alvo
      const vertsUTM = verticesFromGeoJSON(geojson, shpCrsKey);
      console.log("[SHP] vertsUTM:", Array.isArray(vertsUTM) ? vertsUTM.length : vertsUTM);

      if (!Array.isArray(vertsUTM) || vertsUTM.length < 3) {
        console.warn("[SHP] Menos de 3 vertices apos parse.");
        updateStatus("⚠️ O SHP foi lido, mas não há polígono com 3+ vértices. Verifique se o layer é POLYGON/MULTIPOLYGON (ou se a linha está realmente fechada).", "warning");
        return;
      }

      // Cidade aproximada
      shpCityName = inferCityFromVertices(vertsUTM, shpCrsKey);
      if (cidadeDetectadaInput) cidadeDetectadaInput.value = shpCityName;

      // Medidas para UI
      shpVertices = prepararVerticesComMedidas(vertsUTM);

      // UI (tabela)
      extractedCoordinates = shpVertices.slice();
      countDisplay.innerText = extractedCoordinates.length;
      previewTableBody.innerHTML = "";
      for (const c of extractedCoordinates) {
        previewTableBody.innerHTML += `
          <tr>
            <td>${c.ordem}</td>
            <td>${c.id}</td>
            <td>${c.north}</td>
            <td>${c.east}</td>
            <td>${c.distCalc}</td>
            <td>${c.azCalc}</td>
          </tr>`;
      }
      resultBox.style.display = "block";
      scrollToResults();

      // UI CRS
      shpCrsText = crsKeyToText(shpCrsKey);
      showDetectedCrsUI(shpCrsKey, { confidence: "alta", reason: "Detectado a partir do .prj e/ou coordenadas." });

      // UI memorial
      if (memorialMetaBox) memorialMetaBox.style.display = "block";

      updateStatus("✅ SHP carregado e processado. Pronto para gerar o DOCX.", "success");
    } catch (e) {
      console.error(e);
      updateStatus("Erro ao ler SHP: " + e.message, "error");
    }
  });
}


// Gerar DOCX

if (generateDocxBtn) {
  generateDocxBtn.addEventListener("click", async () => {
    try {
      // Verificar libs
      if (!window.docx || !window.docx.Document) {
        updateStatus("❌ Biblioteca DOCX não carregada. Verifique a tag do 'docx.umd.js'.", "error");
        return;
      }
      if (typeof window.saveAs !== "function") {
        updateStatus("❌ FileSaver não carregado. Inclua FileSaver.min.js antes do script.", "error");
        return;
      }

      // Preferir shpVertices; fallback extractedCoordinates
      let vertsBase =
        (Array.isArray(shpVertices) && shpVertices.length >= 3) ? shpVertices :
          (Array.isArray(extractedCoordinates) ? extractedCoordinates : []);

      console.log("[Memorial] shpVertices.len=", shpVertices?.length, "| extractedCoordinates.len=", extractedCoordinates?.length);

      if (!Array.isArray(vertsBase) || vertsBase.length < 3) {
        updateStatus("⚠️ Carregue um SHP válido (polígono com 3+ vértices) antes.", "warning");
        return;
      }

      // Normalizar tipos e IDs
      vertsBase = vertsBase
        .map((v, i) => ({
          id: v.id ?? `V${String(i + 1).padStart(3, "0")}`,
          east: typeof v.east === "string" ? parseFloat(v.east) : v.east,
          north: typeof v.north === "string" ? parseFloat(v.north) : v.north,
          ordem: v.ordem ?? (i + 1),
          distCalc: v.distCalc,
          azCalc: v.azCalc
        }))
        .filter(v => Number.isFinite(v.east) && Number.isFinite(v.north));

      if (vertsBase.length < 3) {
        updateStatus("⚠️ As coordenadas contêm valores inválidos (NaN).", "warning");
        return;
      }

      // Fechar anel se necessario
      const first = vertsBase[0];
      const last = vertsBase[vertsBase.length - 1];
      const closed = Math.hypot(last.east - first.east, last.north - first.north) <= 0.01;
      let vertsForDoc = closed ? vertsBase.slice()
        : [...vertsBase, { ...first, id: `V${String(vertsBase.length + 1).padStart(3, "0")}` }];

      // Gerar dist/az se faltar
      const precisaMedidas = (v) => v.distCalc === undefined || v.azCalc === undefined;
      if (vertsForDoc.some(precisaMedidas)) {
        vertsForDoc = prepararVerticesComMedidas(
          vertsForDoc.map(v => ({ east: v.east, north: v.north, id: v.id }))
        );
      }

      // Metadados UI
      const resp = (respTecnicoInput?.value ?? "").trim();
      const crea = (respCreaInput?.value ?? "").trim();
      let cidade = (cidadeDetectadaInput?.value ?? "").trim();

      // CRS textual
      const crsKey = shpCrsKey || getActiveProjectionKey() || "SIRGAS2000_22S";
      const crsText = (shpCrsText && shpCrsText.trim()) ? shpCrsText : crsKeyToText(crsKey);

      // Cidade (inferir se vazio)
      if (!cidade || cidade === "Município não identificado") {
        cidade = inferCityFromVertices(
          vertsForDoc.map(v => ({ east: v.east, north: v.north })),
          crsKey
        ) || "Curitiba-PR";
      }

      const nomeArea = shpPoligonoNome || "gleba";
      // Data por extenso
      function formatarDataPorExtenso(date) {
        const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
        const d = date.getDate();
        const m = meses[date.getMonth()];
        const y = date.getFullYear();
        return `${d} de ${m} de ${y}`;
      }
      const dataBR = formatarDataPorExtenso(new Date());

      // Area (ha) e perimetro (m)
      let signed = 0;
      for (let i = 0; i < vertsForDoc.length; i++) {
        const a = vertsForDoc[i], b = vertsForDoc[(i + 1) % vertsForDoc.length];
        signed += a.east * b.north - b.east * a.north;
      }
      const areaHa = Math.abs(signed) / 2 / 10000;

      let per = 0;
      for (let i = 0; i < vertsForDoc.length - 1; i++) {
        per += calcularDistancia(vertsForDoc[i], vertsForDoc[i + 1]);
      }

      const BRNumber2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const areaTxt = BRNumber2.format(areaHa);
      const perTxt = BRNumber2.format(per);

      // Geracao do DOCX
      const { Document, Packer, Paragraph, TextRun, AlignmentType, LineSpacingType } = window.docx;

      // Espacamento entre letras
      function espacarLetras(texto) {
        return texto.split("").join(" ");
      }

      // Garantir numero valido
      function safeNumber(val, casas = 2) {
        const n = Number(val);
        return Number.isFinite(n) ? n.toFixed(casas) : "0.00";
      }

      // Incluir todos os segmentos
      const memorialRuns = [];
      for (let i = 0; i < vertsForDoc.length; i++) {
        const vAtual = vertsForDoc[i];
        const vProx = vertsForDoc[(i + 1) % vertsForDoc.length];
        // Calcula distância e azimute se não existirem
        let dist = vProx.distCalc;
        if (!dist || isNaN(Number(dist))) {
          dist = calcularDistancia(vAtual, vProx);
        }
        let azimute = vProx.azCalc;
        if (!azimute) {
          azimute = "00°00'00\"";
        }
        // Coordenadas entre parênteses
        memorialRuns.push(
          new TextRun({
            text: ` Do vértice ${i + 1} segue até o vértice ${((i + 1) % vertsForDoc.length) + 1}, com coordenadas `,
            size: 24, font: "Arial"
          }),
          new TextRun({
            text: `U T M (E=${safeNumber(vProx.east, 3)} e N=${safeNumber(vProx.north, 3)})`,
            bold: true, size: 24, font: "Arial"
          }),
          new TextRun({
            text: `, no azimute de ${azimute}, na extensão de ${safeNumber(dist)} m;`,
            size: 24, font: "Arial"
          })
        );
      }

      const spacing15 = { line: 360, lineRule: (window.docx && window.docx.LineSpacingType && window.docx.LineSpacingType.AUTO) ? window.docx.LineSpacingType.AUTO : "AUTO" };
      const doc = new Document({
        sections: [{
          properties: { page: { margin: { top: 1417, right: 1134, bottom: 1134, left: 1134 } } },
          headers: {
            default: new window.docx.Header({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing: spacing15,
                  children: [
                    new TextRun({
                      text: espacarLetras("MEMORIAL DESCRITIVO"),
                      bold: true,
                      size: 28, // Times New Roman 14pt = 28 half-points
                      font: "Times New Roman",
                      allCaps: true
                    })
                  ]
                }),
                // Linha vazia abaixo do título no cabeçalho
                new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] })
              ]
            })
          },
          children: [
            // ITEM 1 - DESCRIÇÃO
            new Paragraph({
              alignment: AlignmentType.JUSTIFIED,
              spacing: spacing15,
              children: [
                new TextRun({ text: "1. Descrição da Área: ", bold: true, size: 24, font: "Arial" }),
                new TextRun({
                  text: `A referida gleba é delimitada por um polígono irregular cuja descrição se inicia no vértice 1, seguindo sentido horário com coordenadas planas no sistema U T M (E=${safeNumber(vertsForDoc[0].east, 3)} e N=${safeNumber(vertsForDoc[0].north, 3)}), como segue:`,
                  size: 24, font: "Arial"
                })
              ]
            }),

            // CRS
            new Paragraph({
              alignment: AlignmentType.JUSTIFIED,
              spacing: spacing15,
              children: [
                new TextRun({ text: "Sistema de Referência (CRS): ", bold: true, size: 24, font: "Arial" }),
                new TextRun({ text: ` ${crsText}`, size: 24, font: "Arial" })
              ]
            }),

            // LINHA VAZIA ANTES DO ITEM 2
            new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] }),

            // ITEM 2 - MEMORIAL (BLOCO ÚNICO)
            new Paragraph({
              alignment: AlignmentType.JUSTIFIED,
              spacing: spacing15,
              children: [
                new TextRun({ text: "2. Memorial da Área: ", bold: true, size: 24, font: "Arial" }),
                ...memorialRuns
              ]
            }),

            // FECHAMENTO
            new Paragraph({
              alignment: AlignmentType.JUSTIFIED,
              spacing: spacing15,
              children: [
                new TextRun({
                  text: `Finalmente, fechando o polígono acima descrito, abrangendo uma área de ${areaTxt} ha e um perímetro de ${perTxt} m.`,
                  size: 24, font: "Arial"
                })
              ]
            }),

            // 3 LINHAS VAZIAS ANTES DA CIDADE/DATA
            new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] }),
            new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] }),
            new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] }),

            // DATA E ASSINATURA
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: spacing15,
              children: [new TextRun({ text: `${cidade}, ${dataBR}`, size: 24, font: "Arial" })]
            }),

            // 3 LINHAS VAZIAS ANTES DA ASSINATURA
            new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] }),
            new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] }),
            new Paragraph({ spacing: spacing15, children: [new TextRun({ text: "", size: 24, font: "Arial" })] }),

            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: spacing15,
              children: [
                new TextRun({ text: "______________________________________________", size: 24, font: "Arial" }),
                new TextRun({ text: resp || "Responsável Técnico", break: 1, size: 24, font: "Arial" }),
                crea ? new TextRun({ text: crea, break: 1, size: 24, font: "Arial" }) : null
              ].filter(Boolean)
            })
          ]
        }]
      });

      const blob = await Packer.toBlob(doc);
      const outName = `${(shpPoligonoNome || "Memorial").replace(/\s+/g, "_")}_Memorial.docx`;
      saveAs(blob, outName);

      updateStatus("✅ DOCX gerado com sucesso.", "success");
    } catch (e) {
      console.error(e);
      updateStatus("Erro ao gerar DOCX: " + e.message, "error");
    }
  });
}

// Escolhe o melhor Polygon/MultiPolygon do FeatureCollection
function pickBestPolygonFeature(fc) {
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;

  const polys = fc.features.filter(f => {
    const t = f?.geometry?.type;
    return t === "Polygon" || t === "MultiPolygon";
  });

  if (polys.length === 0) return null;

  // Heurística simples: “mais complexo” (mais coords) primeiro
  polys.sort((a, b) => {
    const la = JSON.stringify(a.geometry.coordinates).length;
    const lb = JSON.stringify(b.geometry.coordinates).length;
    return lb - la; // desc
  });

  return polys[0];
}

// Promove LineString para Polygon quando ja estiver fechada
function lineToPolygonIfClosed(coords, tol = 0.5) {
  if (!Array.isArray(coords) || coords.length < 3) return null;

  const first = coords[0];
  const last = coords[coords.length - 1];
  if (!Array.isArray(first) || !Array.isArray(last)) return null;

  const d = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (d > tol) return null; // não está fechada (longe demais)

  const isPreciselyClosed = d <= Number.EPSILON;
  const ring = isPreciselyClosed ? coords.slice() : [...coords, [first[0], first[1]]];

  return { type: "Polygon", coordinates: [ring] };
}

// Forca geometry a virar Polygon quando possivel
function coerceGeometryToPolygon(geometry, tol = 0.5) {
  if (!geometry || !geometry.type) return null;

  const t = geometry.type;
  if (t === "Polygon") return geometry;

  if (t === "MultiPolygon") {
    if (Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0) {
      const firstPoly = geometry.coordinates[0];
      if (Array.isArray(firstPoly) && firstPoly.length > 0) {
        return { type: "Polygon", coordinates: firstPoly };
      }
    }
    return null;
  }

  if (t === "LineString") {
    return lineToPolygonIfClosed(geometry.coordinates, tol);
  }

  if (t === "MultiLineString") {
    const mls = geometry.coordinates;
    if (Array.isArray(mls)) {
      for (const line of mls) {
        const poly = lineToPolygonIfClosed(line, tol);
        if (poly) return poly;
      }
    }
    return null;
  }

  // Point/MultiPoint etc. não são promovíveis sem regras adicionais
  return null;
}

// Normaliza retorno do shp(...) em FeatureCollection com Polygon
function buildFeatureCollectionFromAny(geo, tol = 0.5) {
  // 1) FeatureCollection
  if (geo && geo.type === "FeatureCollection" && Array.isArray(geo.features)) {
    const best = pickBestPolygonFeature(geo);
    if (best) {
      return { type: "FeatureCollection", features: [best] };
    }
    // Se não há Polygon/MultiPolygon, tenta promover alguma geometry (ex.: LineString fechada)
    for (const f of geo.features) {
      const poly = coerceGeometryToPolygon(f?.geometry, tol);
      if (poly) {
        return {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: f.properties || {}, geometry: poly }]
        };
      }
    }
    // Não conseguiu -> retorna como veio (para depuração)
    return geo;
  }

  // 2) Feature isolado
  if (geo && geo.type === "Feature" && geo.geometry) {
    let geometry = geo.geometry;
    if (geometry.type !== "Polygon") {
      const coerced = coerceGeometryToPolygon(geometry, tol);
      if (coerced) geometry = coerced;
    }
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: geo.properties || {}, geometry }]
    };
  }

  // 3) Geometry bruto
  if (geo && geo.type && geo.coordinates) {
    let geometry = geo;
    if (geometry.type !== "Polygon") {
      const coerced = coerceGeometryToPolygon(geometry, tol);
      if (coerced) geometry = coerced;
    }
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry }]
    };
  }

  // 4) Forma inesperada → retorna FC vazio (evita quebra)
  return { type: "FeatureCollection", features: [] };
}

// Log de diagnostico do GeoJSON
function logGeojsonSummary(geojson) {
  try {
    if (!geojson) {
      console.warn("[SHP] GeoJSON vazio/indefinido.");
      return;
    }
    if (geojson.type === "FeatureCollection") {
      const n = Array.isArray(geojson.features) ? geojson.features.length : 0;
      const gt = n > 0 ? geojson.features[0]?.geometry?.type : "(nenhum)";
      console.log(`[SHP] FC com ${n} feature(s). Primeiro geometry: ${gt}`);
    } else if (geojson.type === "Feature") {
      console.log(`[SHP] Feature isolado. Geometry: ${geojson.geometry?.type || "(desconhecido)"}`);
    } else {
      console.log(`[SHP] Objeto geometry. Type: ${geojson.type || "(desconhecido)"}`);
    }
  } catch (e) {
    console.warn("[SHP] Falha ao sumarizar GeoJSON:", e);
  }
}

async function readZipAsFeatureCollection(ab, tol = 0.5) {
  // 1) Caminho "normal": shp(ab) já tenta montar uma FeatureCollection
  try {
    const geo1 = await shp(ab);
    if (geo1) {
      const fc1 = buildFeatureCollectionFromAny(geo1, tol);
      if (fc1 && Array.isArray(fc1.features) && fc1.features.length > 0) {
        console.log("[SHP] readZip: shp(ab) OK");
        return fc1;
      }
    }
  } catch (e) {
    console.warn("[SHP] readZip: shp(ab) falhou; tentando parseZip.", e);
  }

  // 2) Caminho "multi-camada": parseZip retorna FC ou um objeto de coleções
  try {
    const parsed = await shp.parseZip(ab);
    // (a) Se já for FeatureCollection
    if (parsed && parsed.type === "FeatureCollection" && Array.isArray(parsed.features)) {
      const fc2 = buildFeatureCollectionFromAny(parsed, tol);
      if (fc2 && fc2.features?.length) {
        console.log("[SHP] readZip: parseZip OK");
        return fc2;
      }
    }

    // (b) Se for objeto com múltiplas coleções/arrays por chave
    if (parsed && typeof parsed === "object" && !parsed.type) {
      // Agrega só Polygon/MultiPolygon (ou LineString fechada → Polygon)
      const features = [];
      const keys = Object.keys(parsed);
      for (const k of keys) {
        const val = parsed[k];
        if (!val) continue;

        // Caso 1: uma FeatureCollection
        if (val.type === "FeatureCollection" && Array.isArray(val.features)) {
          for (const f of val.features) {
            const poly = coerceGeometryToPolygon(f?.geometry, tol);
            if (poly) features.push({ type: "Feature", properties: f.properties || {}, geometry: poly });
          }
          continue;
        }

        // Caso 2: um array de Features/Geometries crus
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item?.type === "Feature") {
              const poly = coerceGeometryToPolygon(item.geometry, tol);
              if (poly) features.push({ type: "Feature", properties: item.properties || {}, geometry: poly });
            } else if (item?.type && item?.coordinates) {
              const poly = coerceGeometryToPolygon(item, tol);
              if (poly) features.push({ type: "Feature", properties: {}, geometry: poly });
            }
          }
          continue;
        }

        // Caso 3: geometry simples
        if (val?.type && val?.coordinates) {
          const poly = coerceGeometryToPolygon(val, tol);
          if (poly) features.push({ type: "Feature", properties: {}, geometry: poly });
        }
      }

      if (features.length > 0) {
        console.log(`[SHP] readZip: parseZip agregou ${features.length} feature(s)`);
        return { type: "FeatureCollection", features };
      }
    }
  } catch (e) {
    console.warn("[SHP] readZip: parseZip falhou", e);
  }

  // 3) Sem sucesso: devolve FC vazia para o caller tratar
  console.warn("[SHP] readZip: nenhuma feature no ZIP");
  return { type: "FeatureCollection", features: [] };
}

