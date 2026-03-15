// Pipeline PDFtoArcgis: texto bruto -> IA -> JSON estruturado -> validação/exportação.
// Garante que displayLogMessage esteja disponível quando o script roda isoladamente.
if (typeof displayLogMessage !== 'function' && window.displayLogMessage) {
  var displayLogMessage = window.displayLogMessage;
}

function getPdfToArcgisConfig() {
  const cfg = window.PDFTOARCGIS_CONFIG;
  return (cfg && typeof cfg === 'object') ? cfg : {};
}

const ENABLE_TOPOLOGY_VALIDATION = false;

function getAzurePdfToGeoJsonRoutes() {
  const cfg = getPdfToArcgisConfig();
  const configuredUrl = String(cfg.azurePdfToGeoJsonUrl || '').trim();
  const configuredUrls = Array.isArray(cfg.azurePdfToGeoJsonUrls)
    ? cfg.azurePdfToGeoJsonUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : [];

  const explicitRoutes = [
    ...configuredUrls,
    ...(configuredUrl ? [configuredUrl] : [])
  ];

  if (explicitRoutes.length > 0) {
    return [...new Set(explicitRoutes)];
  }

  const routes = [
    '/api/pdf-to-geojson'
  ];

  return [...new Set(routes)];
}

async function callAzurePdfToGeoJson(pdfBase64, fileName, totalPagesHint = 0, retryCount = 0, ocrText = '') {
  const cfg = getPdfToArcgisConfig();
  const MAX_RETRIES = Number.isFinite(Number(cfg.maxAzureRetries))
    ? Math.max(0, Number(cfg.maxAzureRetries))
    : 1;
  const INITIAL_DELAY_MS = 1200;

  const payload = JSON.stringify({
    pdfBase64,
    fileName,
    totalPagesHint: Number.isFinite(Number(totalPagesHint)) ? Number(totalPagesHint) : 0,
    ocrText: String(ocrText || '').slice(0, 80000)
  });
  const candidateRoutes = getAzurePdfToGeoJsonRoutes();
  let response = null;
  let lastError = null;

  for (const route of candidateRoutes) {
    try {
      const res = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });

      if (res.status === 404) {
        lastError = new Error(`Rota não encontrada: ${route}`);
        continue;
      }

      response = res;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!response) {
    const cfg = getPdfToArcgisConfig();
    const missingEndpointHint = !String(cfg.azurePdfToGeoJsonUrl || '').trim()
      ? ' Configure window.PDFTOARCGIS_CONFIG.azurePdfToGeoJsonUrl com a URL pública do backend Azure.'
      : '';
    throw new Error((lastError?.message || 'Não foi possível acessar a API de extração Azure.') + missingEndpointHint);
  }

  if (!response.ok) {
    const transientStatuses = new Set([429, 503, 504]);
    if (transientStatuses.has(response.status) && retryCount < MAX_RETRIES) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, retryCount);
      if (typeof displayLogMessage === 'function') {
        displayLogMessage(`[PDFtoArcgis][LogUI] Azure API indisponível (${response.status}). Nova tentativa em ${(delay / 1000).toFixed(1)}s...`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callAzurePdfToGeoJson(pdfBase64, fileName, totalPagesHint, retryCount + 1, ocrText);
    }

    const errText = await response.text().catch(() => '');
    let errPayload = {};
    if (errText) {
      try {
        errPayload = JSON.parse(errText);
      } catch {
        errPayload = { raw: errText };
      }
    }

    const message = errPayload?.error
      || (typeof errPayload?.message === 'string' ? errPayload.message : '')
      || (typeof errPayload?.raw === 'string' ? errPayload.raw.slice(0, 300) : '')
      || `Erro HTTP ${response.status} na API Azure`;
    const friendlyMessage = /backend call failure/i.test(message)
      ? 'Servico OCR da Azure indisponivel no momento. Tente novamente em alguns minutos.'
      : message;
    throw new Error(`API ${response.status}: ${friendlyMessage}`);
  }

  return response.json();
}

async function inferPdfPageCount(arrayBuffer) {
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;
    return Number.isFinite(pdfDoc?.numPages) ? pdfDoc.numPages : 0;
  } catch {
    return 0;
  }
}

async function extractPdfTextLocally(arrayBuffer, maxPages = 40) {
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;
    const totalPages = Math.min(pdfDoc.numPages || 0, maxPages);
    let fullText = '';

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      fullText += `\n\n--- PAGINA ${pageNum} ---\n`;
      fullText += buildPageTextWithLines(textContent);
    }

    return fullText.trim();
  } catch {
    return '';
  }
}

async function extractPdfTextViaTesseract(arrayBuffer, maxPages = 8) {
  try {
    if (!window.Tesseract || typeof window.Tesseract.recognize !== 'function') {
      return '';
    }

    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;
    const totalPages = Math.min(pdfDoc.numPages || 0, Math.max(1, maxPages));
    const chunks = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const result = await window.Tesseract.recognize(canvas, 'por+eng');
      const text = String(result?.data?.text || '').trim();
      if (text) {
        chunks.push(`--- PAGINA ${pageNum} ---\n${text}`);
      }
    }

    return chunks.join('\n\n').trim();
  } catch {
    return '';
  }
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// Navegação lateral e rolagem para resultados.
function openNav() {
  document.getElementById("mySidenav").style.width = "250px";
}
function closeNav() { document.getElementById("mySidenav").style.width = "0"; }


// Atualiza o painel de validação topológica.
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

  // Exibe painel.
  validationBox.style.display = "block";

  // Limpa listas.
  if (errorList) errorList.innerHTML = "";
  if (warningList) warningList.innerHTML = "";

  // Atualiza título.
  if (validationTitle) {
    if (topology.isValid) {
      validationTitle.innerHTML = '<i class="fas fa-check-circle" style="color:#28a745;"></i> Polígono Válido!';
    } else {
      validationTitle.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:#dc3545;"></i> Problemas Detectados';
    }
  }

  // Renderiza erros.
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

  // Renderiza avisos.
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

  // Renderiza resumo de sucesso.
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

  // Controla exibição das ações de correção.
  if (validationActions) {
    if (!topology.isValid && topology.errors.length > 0) {
      validationActions.style.display = "block";
    } else {
      validationActions.style.display = "none";
    }
  }
}

function hideValidationUI() {
  const validationBox = document.getElementById("validationBox");
  if (validationBox) validationBox.style.display = "none";
}

function scrollToResults() {
  const box = document.getElementById("resultBox");
  if (box && box.style.display !== "none") box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Configuração local do worker do PDF.js.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "vendor/pdf.worker.min.js";

// Referências de UI e estado.
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

// Resultados por matrícula no PDF unificado.
let documentsResults = [];
let activeDocIndex = -1;

// Projeções suportadas (WKT).
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
function isGeographicCoordinatePair(p) {
  return Number.isFinite(p?.east)
    && Number.isFinite(p?.north)
    && Math.abs(p.east) <= 180
    && Math.abs(p.north) <= 90;
}

function shouldUseGeodesicMath(p1, p2, projectionKey = null) {
  if (projectionKey === "WGS84") return true;
  return isGeographicCoordinatePair(p1) && isGeographicCoordinatePair(p2);
}

function calcularDistancia(p1, p2, options = {}) {
  const projectionKey = options?.projectionKey || null;

  if (shouldUseGeodesicMath(p1, p2, projectionKey)) {
    const R = 6371008.8;
    const lat1 = p1.north * (Math.PI / 180);
    const lat2 = p2.north * (Math.PI / 180);
    const dLat = (p2.north - p1.north) * (Math.PI / 180);
    const dLon = (p2.east - p1.east) * (Math.PI / 180);

    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  return Math.sqrt(Math.pow(p2.east - p1.east, 2) + Math.pow(p2.north - p1.north, 2));
}

function calcularAzimute(p1, p2, options = {}) {
  const projectionKey = options?.projectionKey || null;

  if (shouldUseGeodesicMath(p1, p2, projectionKey)) {
    const lat1 = p1.north * (Math.PI / 180);
    const lat2 = p2.north * (Math.PI / 180);
    const dLon = (p2.east - p1.east) * (Math.PI / 180);

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
      - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let az = Math.atan2(y, x) * (180 / Math.PI);
    return az < 0 ? az + 360 : az;
  }

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

// Detecção de CRS.
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

  // Calcula média das coordenadas extraídas.
  const avgE = vertices.reduce((sum, v) => sum + v.east, 0) / vertices.length;
  const avgN = vertices.reduce((sum, v) => sum + v.north, 0) / vertices.length;

  // Regras heurísticas para UTM no sul do Brasil.
  if (avgN > 7000000 && avgN < 8000000) {
    // Este entre 600k e 800k -> zona 22S.
    if (avgE > 600000 && avgE < 800000) {
      return { zone: 22, reason: "Inferido via coordenadas: Padrão compatível com UTM Zona 22S (Sul do Brasil)." };
    }
    // Este entre 300k e 600k -> zona 23S.
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

  // Fallback 1: inferência por estado/UF.
  if (!zone) {
    const inferred = inferZoneFromBrazilState(t);
    if (inferred) {
      zone = inferred;
      reasonParts.push(`Zona inferida como ${zone}S pela localidade.`);
      conf = "média";
    }
  }

  // Fallback 2: inferência por padrão numérico das coordenadas.
  if (!zone && vertices && vertices.length > 0) {
    const mathInference = inferCrsByCoordinates(vertices);
    if (mathInference) {
      zone = mathInference.zone;
      reasonParts.push(mathInference.reason);
      conf = "média";
    }
  }

  // Fallback 3: valor padrão.
  if (!zone) {
    zone = 22;
    reasonParts.push(`Zona não encontrada; fallback ${zone}S.`);
  }

  // Resolve datum/projeção final.
  if (hasWGS) return { key: "WGS84", confidence: "alta", reason: "Encontrado 'WGS 84'." };

  if (hasSAD) {
    let key = (zone === 23) ? "SAD69_23S" : "SAD69_22S";
    return { key, confidence: conf, reason: `Encontrado 'SAD-69'. ${reasonParts.join(" ")}` };
  }

  // Se não houver SAD/WGS explícito, assume SIRGAS 2000.
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
  const memorialMatches = Array.isArray(memorialInfo?.matches) ? memorialInfo.matches : [];

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
  if (memorialMatches.length > 0) {
    const coherentMatches = memorialMatches.filter(m => m?.coherent).length;
    csv += `# MEMORIAL_COHERENCE;${coherentMatches}/${memorialMatches.length}\n`;
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
    if (memorialMatches[i]) {
      const match = memorialMatches[i];
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

  const memorialMatches = Array.isArray(memorialInfo?.matches) ? memorialInfo.matches : [];
  const memorialIssues = Array.isArray(memorialInfo?.issues) ? memorialInfo.issues : [];
  const safeWarnings = Array.isArray(warnings) ? warnings : [];

  if (topologyInfo) {
    const intersections = Array.isArray(topologyInfo.intersectionPairs)
      ? topologyInfo.intersectionPairs
      : (Array.isArray(topologyInfo.intersections) ? topologyInfo.intersections : []);
    const topoErrors = Array.isArray(topologyInfo.errors) ? topologyInfo.errors : [];
    const topoWarnings = Array.isArray(topologyInfo.warnings) ? topologyInfo.warnings : [];
    const safeArea = Number.isFinite(topologyInfo.area) ? topologyInfo.area : 0;

    report += `VALIDAÇÃO TOPOLÓGICA:\n`;
    report += `  Polígono válido: ${topologyInfo.isValid ? "✓ SIM" : "✗ NÃO"}\n`;
    report += `  Área: ${safeArea.toFixed(2)} m²\n`;
    report += `  Fechado: ${topologyInfo.closed ? "✓ SIM" : "✗ NÃO"}\n`;
    report += `  Auto-intersecções: ${intersections.length > 0 ? `✗ ${intersections.length} encontradas` : "✓ Nenhuma"}\n`;
    report += `  Sentido: ${topologyInfo.isCCW ? "Anti-horário (CCW)" : "Horário (CW)"}\n\n`;

    if (topoErrors.length > 0) {
      report += `  ERROS DETECTADOS:\n`;
      topoErrors.forEach(e => report += `    • ${e}\n`);
      report += `\n`;
    }

    if (topoWarnings.length > 0) {
      report += `  AVISOS:\n`;
      topoWarnings.forEach(w => report += `    • ${w}\n`);
      report += `\n`;
    }
  }

  if (memorialMatches.length > 0) {
    report += `VALIDAÇÃO COM MEMORIAL (Azimutes/Distâncias):\n`;
    const coherent = memorialMatches.filter(m => m?.coherent).length;
    report += `  Correspondência: ${coherent}/${memorialMatches.length} edges coerentes\n`;
    report += `  Confiança: ${Math.round(coherent / memorialMatches.length * 100)}%\n\n`;

    if (memorialIssues.length > 0) {
      report += `  DISCREPÂNCIAS ENCONTRADAS:\n`;
      memorialIssues.forEach(issue => report += `    • ${issue}\n`);
      report += `\n`;
    }
  }

  if (safeWarnings.length > 0) {
    report += `AVISOS GERAIS:\n`;
    safeWarnings.forEach(w => report += `  • ${w}\n`);
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

function applyAzureGeoJsonResult(apiResult, sourceFileName) {
  const geojson = apiResult?.geojson;
  if (!geojson) {
    throw new Error('API Azure não retornou GeoJSON.');
  }

  const nameBase = (sourceFileName || 'coordenadas_extracao').replace(/\.[^/.]+$/, '');
  const projectionFromApi = String(apiResult?.projectionKey || '').trim();
  const projKey = projectionFromApi || getActiveProjectionKey() || 'SIRGAS2000_22S';

  let vertices = verticesFromGeoJSON(geojson, null);
  vertices = vertices
    .map((vertex, idx) => ({
      id: vertex.id || `V${String(idx + 1).padStart(3, '0')}`,
      east: Number(vertex.east),
      north: Number(vertex.north)
    }))
    .filter((vertex) => Number.isFinite(vertex.east) && Number.isFinite(vertex.north));

  if (vertices.length < 3) {
    throw new Error('GeoJSON retornado possui menos de 3 vértices válidos.');
  }

  vertices = prepararVerticesComMedidas(vertices, projKey);

  const topology = ENABLE_TOPOLOGY_VALIDATION
    ? validatePolygonTopology(vertices, projKey)
    : null;
  const warnings = Array.isArray(apiResult?.warnings) ? apiResult.warnings : [];
  const projectionInfo = {
    confidence: projectionFromApi ? 'alta' : 'baixa',
    reason: projectionFromApi
      ? 'CRS informado pela IA Azure no retorno do GeoJSON.'
      : 'CRS não informado pela IA; aplicado CRS ativo da interface.'
  };

  documentsResults = [{
    docId: apiResult?.matricula || nameBase.toUpperCase(),
    pages: apiResult?.pagesAnalyzed ? `1-${apiResult.pagesAnalyzed}` : '1',
    projectionKey: projKey,
    manualProjectionKey: null,
    projectionInfo,
    vertices,
    warnings,
    topology,
    memorialValidation: { matches: [], issues: [] },
    memorialData: { azimutes: [], distances: [] },
    relativeInfo: null,
    text: ''
  }];

  activeDocIndex = 0;
  window._arcgis_crs_key = projKey;
  extractedCoordinates = vertices;
  fileNameBase = apiResult?.matricula ? `MAT_${apiResult.matricula}` : nameBase;

  showDetectedCrsUI(projKey, projectionInfo);
  if (ENABLE_TOPOLOGY_VALIDATION && topology) {
    updateValidationUI(topology);
  } else {
    hideValidationUI();
  }
  displayResults();
  renderDocSelector();

  updateStatus(`✅ IA Azure concluiu: ${vertices.length} coordenadas processadas.`, 'success');
  progressContainer.style.display = 'none';

  if (typeof displayLogMessage === 'function') {
    displayLogMessage(`[PDFtoArcgis][LogUI] ✅ GeoJSON recebido da IA Azure (${vertices.length} vértices).`);
  }
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
  hideValidationUI();
  extractedCoordinates = [];
  previewTableBody.innerHTML = "";
  documentsResults = [];
  activeDocIndex = -1;

  try {
    updateStatus("📄 Enviando PDF para IA Azure...", "info");
    if (typeof displayLogMessage === 'function') {
      displayLogMessage(`[PDFtoArcgis][LogUI] ☁️ Fluxo único ativo: backend Azure (sem fallback local).`);
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdfBase64 = arrayBufferToBase64(arrayBuffer);
    const totalPagesHint = await inferPdfPageCount(arrayBuffer);

    progressBar.value = 35;
    document.getElementById("progressLabel").innerText = "Processando PDF na IA Azure...";

    let apiResult;
    try {
      apiResult = await callAzurePdfToGeoJson(pdfBase64, file.name, totalPagesHint);
    } catch (apiError) {
      const canFallbackLocalOcr = /API 500|OCR da Azure indisponivel|Backend call failure/i.test(String(apiError?.message || ''));
      if (!canFallbackLocalOcr) {
        throw apiError;
      }

      updateStatus("⚠️ OCR Azure indisponível. Tentando extração local de texto...", "info");
      const MIN_TEXT_LENGTH = 120;
      const localOcrText = await extractPdfTextLocally(arrayBuffer);

      if (typeof displayLogMessage === 'function') {
        displayLogMessage('[PDFtoArcgis][LogUI] ⚙️ Fallback local de OCR ativado (PDF.js) para manter o fluxo.');
      }

      let fallbackError = apiError;
      if (localOcrText && localOcrText.length >= MIN_TEXT_LENGTH) {
        try {
          apiResult = await callAzurePdfToGeoJson(pdfBase64, file.name, totalPagesHint, 0, localOcrText);
        } catch (errLocal) {
          fallbackError = errLocal;
        }
      }

      if (!apiResult) {
        updateStatus("⚠️ Tentando OCR avançado (Tesseract) para PDF digitalizado...", "info");
        const cfg = getPdfToArcgisConfig();
        const maxTesseractPages = Number.isFinite(Number(cfg.maxTesseractPages))
          ? Math.max(1, Number(cfg.maxTesseractPages))
          : 10;
        const tesseractText = await extractPdfTextViaTesseract(arrayBuffer, Math.min(totalPagesHint || maxTesseractPages, maxTesseractPages));
        if (!tesseractText || tesseractText.length < MIN_TEXT_LENGTH) {
          throw fallbackError;
        }

        if (typeof displayLogMessage === 'function') {
          displayLogMessage('[PDFtoArcgis][LogUI] 🔎 OCR avançado (Tesseract) aplicado; reenviando para API.');
        }
        apiResult = await callAzurePdfToGeoJson(pdfBase64, file.name, totalPagesHint, 0, tesseractText);
      }
    }

    progressBar.value = 100;

    if (!apiResult?.success) {
      throw new Error(apiResult?.error || 'Falha na extração via IA Azure.');
    }

    applyAzureGeoJsonResult(apiResult, file.name);
    return;

  } catch (e) {
    console.error("Erro no processamento:", e);
    updateStatus("Erro: " + e.message, "error");
  }
});


// Exporta CSV e relatório textual de validação.
downloadBtn.onclick = () => {
  if (!extractedCoordinates.length) return;
  try {
    const key = getActiveProjectionKey();
    const doc = getSelectedDoc();
    const epsg = PROJECTIONS[key]?.epsg || (doc?.relativeInfo?.relative ? "RELATIVO" : "");
    const crsName = doc?.relativeInfo?.relative ? "RELATIVO" : (key ? key.replace(/[^\w]/g, "_") : "CRS");

    // Gera CSV com diagnóstico topológico e de memorial.
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
    // Inclui origem do PDF e identificador da fonte no nome do arquivo.
    link.download = `${pdfOrigemNomeBase || fileNameBase}_${crsName}_Validado_${pdfOrigemSrc || "src"}.csv`;
    link.click();

    // Exporta relatório textual quando houver validação disponível.
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
      // Mantém padrão de nome com origem e identificador da fonte.
      linkRel.download = `${pdfOrigemNomeBase || fileNameBase}_${crsName}_Relatorio_${pdfOrigemSrc || "src"}.txt`;
      linkRel.click();
    }
  } catch (e) {
    // Ignora cancelamento explícito do usuário.
    if (e && e.name !== "AbortError") {
      updateStatus("Erro ao baixar arquivo: " + e.message, "error");
    }
  }
};

// Salva lote de arquivos (SHP + CSV) em diretório escolhido.
const toArrayBufferFS = (view, fileLabel = "arquivo") => {
  if (!view || typeof view.byteOffset !== "number" || typeof view.byteLength !== "number" || !view.buffer) {
    throw new Error(`Saída SHP inválida para ${fileLabel}.`);
  }
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
};

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

  return vertices;
}
function prepararVerticesComMedidas(vertices, projectionKey = null) {
  const out = [];
  for (let i = 0; i < vertices.length; i++) {
    const v = { ...vertices[i], ordem: i + 1 };
    if (i < vertices.length - 1) {
      v.distCalc = fmtMeters2(calcularDistancia(vertices[i], vertices[i + 1], { projectionKey }));
      v.azCalc = toDMS(calcularAzimute(vertices[i], vertices[i + 1], { projectionKey }));
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

      let geojson = null;
      let prjText = null;

      if (!isZip) {
        throw new Error("Formato não suportado. Para a ferramenta inversa, envie apenas .zip com o shapefile completo (.shp, .shx, .dbf, .prj).");
      }

      if (isZip) {
        // ZIP -> leitor tolerante
        const ab = await file.arrayBuffer();
        geojson = await readZipAsFeatureCollection(ab);
        // .prj do ZIP
        prjText = await extractPrjFromZip(file);
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
      shpVertices = prepararVerticesComMedidas(vertsUTM, shpCrsKey);

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
          vertsForDoc.map(v => ({ east: v.east, north: v.north, id: v.id })),
          shpCrsKey || getActiveProjectionKey() || "SIRGAS2000_22S"
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
        per += calcularDistancia(vertsForDoc[i], vertsForDoc[i + 1], { projectionKey: crsKey });
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

      function parsePtBrNumber(value) {
        if (typeof value === "number") return value;
        if (typeof value !== "string") return NaN;
        return Number(value.replace(/\./g, "").replace(",", "."));
      }

      // Incluir todos os segmentos
      const memorialRuns = [];
      for (let i = 0; i < vertsForDoc.length; i++) {
        const vAtual = vertsForDoc[i];
        const vProx = vertsForDoc[(i + 1) % vertsForDoc.length];
        let dist = parsePtBrNumber(vProx.distCalc);
        if (!Number.isFinite(dist)) {
          dist = calcularDistancia(vAtual, vProx, { projectionKey: crsKey });
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

