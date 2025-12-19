// Importação do WASM via wasm_bindgen (no-modules target)
let vetorizar_imagem;

/* global L, leafletImage, turf, wasm_bindgen */

// --- CONFIGURAÇÃO INICIAL ---
const loader = document.getElementById('loader-overlay');
const loaderText = document.getElementById('loader-text');
let debugMaskLayer = null;
const geojsonFeatures = [];

// --- PARÂMETROS AJUSTÁVEIS ---
let CONFIG = {
  edgeThreshold: 90,          // Threshold para Sobel edge detection
  morphologySize: 5,          // Tamanho do kernel morfológico
  minArea: 15.0,              // Área mínima em m² (edificação residencial mínima)
  simplification: 0.00001,    // Tolerância de simplificação
  contrastBoost: 1.3,         // Multiplicador de contraste
  minQualityScore: 35         // Score mínimo para aceitar polígono (0-100)
};

// Função para sincronizar slider e input numérico
function sincronizarControle(sliderId, inputId, configKey, formatter = (v) => v.toFixed(0)) {
  const slider = document.getElementById(sliderId);
  const input = document.getElementById(inputId);
  
  if (!slider || !input) return;
  
  slider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    CONFIG[configKey] = value;
    input.value = formatter(value);
  });
  
  input.addEventListener('input', (e) => {
    let value = parseFloat(e.target.value) || 0;
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    
    if (value < min) value = min;
    if (value > max) value = max;
    
    CONFIG[configKey] = value;
    slider.value = value;
  });
  
  input.addEventListener('blur', (e) => {
    input.value = formatter(CONFIG[configKey]);
  });
}

// Inicializa listeners dos controles
window.addEventListener('DOMContentLoaded', () => {
  sincronizarControle('edgeThreshold', 'edgeThresholdInput', 'edgeThreshold', v => v.toFixed(0));
  sincronizarControle('morphologySize', 'morphologySizeInput', 'morphologySize', v => v.toFixed(0));
  sincronizarControle('minArea', 'minAreaInput', 'minArea', v => v.toFixed(0));
  sincronizarControle('minQualityScore', 'minQualityScoreInput', 'minQualityScore', v => v.toFixed(0));
  sincronizarControle('simplification', 'simplificationInput', 'simplification', v => v.toFixed(6));
  sincronizarControle('contrastBoost', 'contrastBoostInput', 'contrastBoost', v => v.toFixed(1));
  
  // Ativa colorir por qualidade por padrão
  const colorByQuality = document.getElementById('colorByQuality');
  if (colorByQuality) {
    colorByQuality.checked = true;
  }
});

// Função para aplicar pré-configurações
function aplicarPreset(tipo) {
  let preset;
  
  switch(tipo) {
    case 'urbano':
      preset = {
        edgeThreshold: 85,
        morphologySize: 5,
        minArea: 15.0,
        simplification: 0.00001,
        contrastBoost: 1.4,
        minQualityScore: 40,
        nome: 'Área Urbana Densa'
      };
      break;
      
    case 'rural':
      preset = {
        edgeThreshold: 70,
        morphologySize: 7,
        minArea: 30.0,
        simplification: 0.00002,
        contrastBoost: 1.5,
        minQualityScore: 35,
        nome: 'Área Rural'
      };
      break;
      
    case 'industrial':
      preset = {
        edgeThreshold: 80,
        morphologySize: 5,
        minArea: 100.0,
        simplification: 0.00003,
        contrastBoost: 1.3,
        minQualityScore: 40,
        nome: 'Galpões Industriais'
      };
      break;
      
    default:
      return;
  }
  
  // Aplicar configurações
  CONFIG.edgeThreshold = preset.edgeThreshold;
  CONFIG.morphologySize = preset.morphologySize;
  CONFIG.minArea = preset.minArea;
  CONFIG.simplification = preset.simplification;
  CONFIG.contrastBoost = preset.contrastBoost;
  CONFIG.minQualityScore = preset.minQualityScore;
  
  // Atualizar controles UI (sliders e inputs)
  document.getElementById('edgeThreshold').value = preset.edgeThreshold;
  document.getElementById('edgeThresholdInput').value = preset.edgeThreshold;
  document.getElementById('morphologySize').value = preset.morphologySize;
  document.getElementById('morphologySizeInput').value = preset.morphologySize;
  document.getElementById('minArea').value = preset.minArea;
  document.getElementById('minAreaInput').value = preset.minArea.toFixed(0);
  document.getElementById('minQualityScore').value = preset.minQualityScore;
  document.getElementById('minQualityScoreInput').value = preset.minQualityScore;
  document.getElementById('simplification').value = preset.simplification;
  document.getElementById('simplificationInput').value = preset.simplification.toFixed(6);
  document.getElementById('contrastBoost').value = preset.contrastBoost;
  document.getElementById('contrastBoostInput').value = preset.contrastBoost.toFixed(1);
  
  alert(`✅ Preset "${preset.nome}" aplicado!\n\n🎯 Otimizado para este tipo de área.`);
}

// Função para resetar parâmetros
function resetarParametros() {
  CONFIG = {
    edgeThreshold: 90,
    morphologySize: 5,
    minArea: 15.0,
    simplification: 0.00001,
    contrastBoost: 1.3,
    minQualityScore: 35
  };
  
  // Atualizar controles UI (sliders e inputs)
  document.getElementById('edgeThreshold').value = 90;
  document.getElementById('edgeThresholdInput').value = 90;
  document.getElementById('morphologySize').value = 5;
  document.getElementById('morphologySizeInput').value = 5;
  document.getElementById('minArea').value = 15.0;
  document.getElementById('minAreaInput').value = 15;
  document.getElementById('minQualityScore').value = 35;
  document.getElementById('minQualityScoreInput').value = 35;
  document.getElementById('simplification').value = 0.00001;
  document.getElementById('simplificationInput').value = 0.00001;
  document.getElementById('contrastBoost').value = 1.3;
  document.getElementById('contrastBoostInput').value = 1.3;
  
  alert('Parâmetros restaurados aos valores padrão profissionais!');
}

// Função para limpar resultados
function limparResultados() {
  geojsonFeatures.length = 0;
  drawnItems.clearLayers();
  if (debugMaskLayer) {
    map.removeLayer(debugMaskLayer);
    debugMaskLayer = null;
  }
  if (window.debugMorphLayer) {
    map.removeLayer(window.debugMorphLayer);
    window.debugMorphLayer = null;
  }
  atualizarEstatisticas();
  alert('Resultados limpos!');
}

// Função para atualizar estatísticas
function atualizarEstatisticas() {
  const totalPolygons = geojsonFeatures.length;
  const totalArea = geojsonFeatures.reduce((sum, f) => sum + parseFloat(f.properties.area_m2 || 0), 0);
  const highQ = geojsonFeatures.filter(f => f.properties.quality === 'alta').length;
  const medQ = geojsonFeatures.filter(f => f.properties.quality === 'media').length;
  const lowQ = geojsonFeatures.filter(f => f.properties.quality === 'baixa').length;
  
  document.getElementById('totalPolygons').textContent = totalPolygons;
  document.getElementById('totalArea').textContent = totalArea.toFixed(2);
  document.getElementById('highQuality').textContent = highQ;
  document.getElementById('medQuality').textContent = medQ;
  document.getElementById('lowQuality').textContent = lowQ;
  document.getElementById('lastProcessTime').textContent = new Date().toLocaleTimeString('pt-BR');
}

// Obter estilo baseado na qualidade
function getStyleByQuality(feature) {
  const colorByQuality = document.getElementById('colorByQuality')?.checked;
  
  if (!colorByQuality) {
    return { color: '#00ffcc', weight: 2, fillOpacity: 0.3 };
  }
  
  const quality = feature.properties.quality;
  let color;
  
  switch(quality) {
    case 'alta':
      color = '#00ff00'; // Verde
      break;
    case 'media':
      color = '#ffff00'; // Amarelo
      break;
    case 'baixa':
      color = '#ff0000'; // Vermelho
      break;
    default:
      color = '#00ffcc'; // Ciano
  }
  
  return { color: color, weight: 2, fillOpacity: 0.4 };
}

// Atualizar visualização quando checkbox muda
function atualizarVisualizacao() {
  if (window.lastGeoJSONLayer) {
    // Remove camada antiga
    drawnItems.removeLayer(window.lastGeoJSONLayer);
    
    // Recria com novo estilo
    const geojson = { type: 'FeatureCollection', features: geojsonFeatures };
    window.lastGeoJSONLayer = L.geoJSON(geojson, {
      style: function(feature) {
        return getStyleByQuality(feature);
      },
      onEachFeature: function(feature, layer) {
        const props = feature.properties;
        layer.bindPopup(`
          <strong>ID:</strong> ${props.id}<br>
          <strong>Área:</strong> ${props.area_m2} m²<br>
          <strong>Score:</strong> ${props.confidence_score}/100<br>
          <strong>Qualidade:</strong> ${props.quality}<br>
          <strong>Compacidade:</strong> ${props.compactness}<br>
          <strong>Vértices:</strong> ${props.vertices}
        `);
      }
    });
    
    drawnItems.addLayer(window.lastGeoJSONLayer);
  }
}

// ========== ALGORITMOS AVANÇADOS ==========

// Threshold Adaptativo Otsu - encontra melhor threshold automaticamente
function calcularThresholdOtsu(imageData) {
  const histogram = new Array(256).fill(0);
  const total = imageData.data.length / 4;
  
  // Calcular histograma
  for (let i = 0; i < imageData.data.length; i += 4) {
    const gray = imageData.data[i]; // Usa canal vermelho (imagem já em grayscale)
    histogram[gray]++;
  }
  
  // Normalizar histograma
  const prob = histogram.map(count => count / total);
  
  // Algoritmo Otsu
  let maxVariance = 0;
  let threshold = 0;
  let sumTotal = 0;
  
  for (let i = 0; i < 256; i++) {
    sumTotal += i * prob[i];
  }
  
  let sumBackground = 0;
  let weightBackground = 0;
  
  for (let t = 0; t < 256; t++) {
    weightBackground += prob[t];
    const weightForeground = 1 - weightBackground;
    
    if (weightBackground === 0 || weightForeground === 0) continue;
    
    sumBackground += t * prob[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumTotal - sumBackground) / weightForeground;
    
    const variance = weightBackground * weightForeground * 
                    Math.pow(meanBackground - meanForeground, 2);
    
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  
  console.log(`Threshold Otsu calculado: ${threshold}`);
  return threshold;
}

// Calcular score de confiança do polígono
function calcularScoreConfianca(polygon) {
  try {
    const area = turf.area(polygon);
    const perimeter = turf.length(polygon, { units: 'meters' });
    
    // Compacidade (círculo perfeito = 1.0, linha = 0)
    const compactness = (4 * Math.PI * area) / Math.pow(perimeter, 2);
    
    // Pontos do polígono
    const coords = polygon.geometry.coordinates[0];
    const numVertices = coords.length - 1; // -1 porque último = primeiro
    
    // Score baseado em múltiplos fatores:
    let score = 0;
    
    // 1. Área razoável (edificações típicas: 20-500m²) - PESO MAIOR
    if (area >= 25 && area <= 400) {
      score += 35; // Aumentado de 30
    } else if (area >= 15 && area <= 800) {
      score += 20; // Aumentado de 15
    } else if (area >= 10) {
      score += 5; // Penalidade menor para áreas muito pequenas
    }
    
    // 2. Compacidade (edificações são geralmente compactas) - PESO MAIOR
    if (compactness > 0.65) {
      score += 35; // Aumentado de 30
    } else if (compactness > 0.5) {
      score += 20; // Aumentado de 15
    } else if (compactness > 0.3) {
      score += 5; // Penalidade para formas muito alongadas
    } else {
      score -= 10; // PENALIZA formas lineares (sombras, ruas)
    }
    
    // 3. Número de vértices (edificações têm 4-20 vértices tipicamente)
    if (numVertices >= 4 && numVertices <= 15) {
      score += 20;
    } else if (numVertices <= 25) {
      score += 10;
    } else if (numVertices > 40) {
      score -= 5; // Penaliza polígonos muito complexos (ruído)
    }
    
    // 4. Razão perímetro/área (edificações têm razão moderada)
    const perimeterAreaRatio = perimeter / Math.sqrt(area);
    if (perimeterAreaRatio >= 3.5 && perimeterAreaRatio <= 5.5) {
      score += 10;
    } else if (perimeterAreaRatio > 8) {
      score -= 10; // Penaliza formas muito irregulares
    }
    
    // Garante que score não seja negativo
    score = Math.max(0, Math.min(100, score));
    
    return {
      score: score,
      compactness: compactness.toFixed(3),
      vertices: numVertices
    };
  } catch (e) {
    return { score: 0, compactness: 0, vertices: 0 };
  }
}

// Limpar geometria: remover buracos internos e corrigir auto-interseções
function limparGeometria(polygon) {
  try {
    // Remove buracos internos (mantém apenas outer ring)
    if (polygon.geometry.coordinates.length > 1) {
      polygon.geometry.coordinates = [polygon.geometry.coordinates[0]];
    }
    
    // Tenta corrigir auto-interseções usando buffer(0)
    let clean = turf.buffer(polygon, 0);
    
    // Se buffer retornar MultiPolygon, pega o maior
    if (clean.geometry.type === 'MultiPolygon') {
      const polygons = clean.geometry.coordinates.map(coords => 
        turf.polygon(coords)
      );
      
      // Ordena por área e pega o maior
      polygons.sort((a, b) => turf.area(b) - turf.area(a));
      clean = polygons[0];
    }
    
    return clean;
  } catch (e) {
    console.warn('Erro ao limpar geometria:', e.message);
    return polygon;
  }
}

// Aplicar threshold adaptativo em substituição ao threshold fixo
function aplicarThresholdAdaptativo(imageData, width, height) {
  const threshold = calcularThresholdOtsu(imageData);
  
  for (let i = 0; i < imageData.data.length; i += 4) {
    const val = imageData.data[i];
    const newVal = val > threshold ? 255 : 0;
    imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = newVal;
    imageData.data[i + 3] = 255;
  }
  
  return threshold;
}

// Inicializa o WASM (Vetorizador)
async function inicializarWasm() {
  try {
    // Com --target no-modules, o namespace é wasm_bindgen
    await wasm_bindgen('vetoriza/pkg/vetoriza_bg.wasm');
    vetorizar_imagem = wasm_bindgen.vetorizar_imagem;
    console.log("Módulo WASM carregado com sucesso.");
    console.log("Função vetorizar_imagem:", vetorizar_imagem);
  } catch (e) {
    console.error("Falha ao carregar WASM:", e);
    alert("Erro crítico: O módulo de vetorização não carregou. Detalhes: " + e.message);
  }
}

function testarObjetoGlobalWasm() {
  if (typeof wasm_bindgen !== 'undefined') {
    console.log('wasm_bindgen está disponível:', wasm_bindgen);
    inicializarWasm();
  } else {
    console.error('Nenhum objeto global WASM encontrado (wasm_bindgen). Verifique o build e a ordem dos scripts.');
  }
}

window.addEventListener('DOMContentLoaded', testarObjetoGlobalWasm);

// --- MAPA ---
const MAP_CENTER = [-25.706923, -52.385530];
const map = L.map('map').setView(MAP_CENTER, 15);

const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri',
  maxZoom: 21,
  maxNativeZoom: 19,
  preferCanvas: true
});
satelliteMap.addTo(map);

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const drawControl = new L.Control.Draw({
  edit: { featureGroup: drawnItems },
  draw: {
    polygon: {
      shapeOptions: {
        color: '#007bff',
        fillOpacity: 0.1
      }
    },
    marker: false, polyline: false, circle: false, rectangle: false
  }
});
map.addControl(drawControl);

// --- EVENTOS DO MAPA ---
map.on(L.Draw.Event.CREATED, (e) => {
  if (e.layerType === 'polygon') {
    geojsonFeatures.length = 0; // Limpa features anteriores

    // Limpeza de debug anterior
    if (debugMaskLayer) {
      map.removeLayer(debugMaskLayer);
      debugMaskLayer = null;
    }

    const layer = e.layer;
    const bounds = layer.getBounds();
    // Apenas adicionamos o layer aqui. NÃO REMOVEMOS (layer.remove()) antes da captura!
    drawnItems.addLayer(layer);

    // Pequeno delay para garantir que a UI atualizou
    setTimeout(() => processarAreaDesenhada(bounds, layer), 500); // Passamos o layer para remoção posterior
  }
});

// --- FUNÇÃO DE COMUNICAÇÃO COM A API ---
async function chamarBackendGemini(base64Image, width, height) {
  // Busca a chave Gemini do backend
  let geminiKey = null;
  try {
    const keyRes = await fetch('/api/gemini-key');
    if (keyRes.ok) {
      const keyData = await keyRes.json();
      geminiKey = keyData.geminiKey;
    } else {
      throw new Error('Não foi possível obter a chave Gemini do backend.');
    }
  } catch (err) {
    console.error('Erro ao buscar chave Gemini:', err);
    throw err;
  }

  // URL relativa: funciona no localhost:3000 e no vercel.app
  const url = '/api/vetorizar';

  console.log("Enviando imagem para processamento no servidor...");

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gemini-Key': geminiKey },
      body: JSON.stringify({
        imageBase64: base64Image,
        width: width,
        height: height
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro do servidor (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data.svg) {
      throw new Error("O servidor não retornou um SVG válido.");
    }

    return data.svg;

  } catch (error) {
    console.error("Erro na comunicação com a API:", error);
    throw error;
  }
}

// --- LÓGICA PRINCIPAL ---
async function processarAreaDesenhada(bounds, selectionLayer) {
  loaderText.textContent = 'Capturando imagem da área...';
  loader.style.display = 'flex';

  // Usamos os bounds do polígono desenhado para a captura
  leafletImage(map, async (err, mainCanvas) => {
    if (err) {
      loader.style.display = 'none';
      drawnItems.removeLayer(selectionLayer); // Remove o polígono se a captura falhar
      alert("Erro ao capturar mapa: " + err.message);
      return;
    }

    const width = mainCanvas.width;
    const height = mainCanvas.height;

    // PRÉ-PROCESSAMENTO: aumenta contraste, aplica filtro de bordas e binariza
    const ctx = mainCanvas.getContext('2d');
    let imgData = ctx.getImageData(0, 0, width, height);
    // 1. Aumenta contraste e brilho (usa parâmetro CONFIG.contrastBoost)
    for (let i = 0; i < imgData.data.length; i += 4) {
      // Realce configurável: multiplica RGB e soma offset
      imgData.data[i] = Math.min(255, imgData.data[i] * CONFIG.contrastBoost + 20);     // R
      imgData.data[i + 1] = Math.min(255, imgData.data[i + 1] * CONFIG.contrastBoost + 20); // G
      imgData.data[i + 2] = Math.min(255, imgData.data[i + 2] * CONFIG.contrastBoost + 20); // B
    }
    ctx.putImageData(imgData, 0, 0);

    // 2. Filtro de bordas (Sobel simplificado)
    // (aplica apenas no canal vermelho para simplificação)
    let sobelData = ctx.getImageData(0, 0, width, height);
    let outData = new Uint8ClampedArray(sobelData.data.length);
    const kernelX = [
      -1, 0, 1,
      -2, 0, 2,
      -1, 0, 1
    ];
    const kernelY = [
      -1, -2, -1,
      0, 0, 0,
      1, 2, 1
    ];
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let gx = 0, gy = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const px = x + kx;
            const py = y + ky;
            const idx = (py * width + px) * 4;
            const val = imgData.data[idx]; // canal vermelho
            const kIdx = (ky + 1) * 3 + (kx + 1);
            gx += val * kernelX[kIdx];
            gy += val * kernelY[kIdx];
          }
        }
        const mag = Math.sqrt(gx * gx + gy * gy);
        const outIdx = (y * width + x) * 4;
        // Usa threshold configurável (CONFIG.edgeThreshold)
        outData[outIdx] = outData[outIdx + 1] = outData[outIdx + 2] = mag > CONFIG.edgeThreshold ? 255 : 0;
        outData[outIdx + 3] = 255;
      }
    }
    for (let i = 0; i < outData.length; i++) {
      sobelData.data[i] = outData[i];
    }
    ctx.putImageData(sobelData, 0, 0);

    // 3. Binarização com Threshold Adaptativo (Otsu)
    console.log('Aplicando threshold adaptativo (Otsu)...');
    let binData = ctx.getImageData(0, 0, width, height);
    const thresholdUsado = aplicarThresholdAdaptativo(binData, width, height);
    console.log(`Threshold adaptativo aplicado: ${thresholdUsado}`);
    ctx.putImageData(binData, 0, 0);

    loaderText.textContent = 'Aplicando detecção de contornos...';
    await yieldToMain();

    try {
      // ABORDAGEM CLÁSSICA: Pula o Gemini e usa processamento direto
      // A imagem já está binarizada (bordas detectadas)
      
      // Criar canvas para máscara final
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = width;
      maskCanvas.height = height;
      const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
      
      // Copia a imagem binarizada para o canvas de máscara
      maskCtx.drawImage(mainCanvas, 0, 0);
      
      console.log('Imagem com bordas detectadas copiada para máscara');
      
      // Verifica se a máscara tem pixels brancos
      let checkData = maskCtx.getImageData(0, 0, width, height);
      let whitePixels = 0;
      for (let i = 0; i < checkData.data.length; i += 4) {
        if (checkData.data[i] > 200) whitePixels++;
      }
      console.log(`Máscara com bordas: ${whitePixels} pixels brancos de ${width * height} total`);

      // DEBUG: Mostra a máscara de bordas no mapa
      if (debugMaskLayer) map.removeLayer(debugMaskLayer);
      debugMaskLayer = L.imageOverlay(maskCanvas.toDataURL(), bounds, { opacity: 0.7 });
      debugMaskLayer.addTo(map);

      // Limpeza de ruído (Morfologia) - Closing para preencher gaps
      console.log('Aplicando morphological closing...');
      loaderText.textContent = 'Preenchendo contornos...';
      await yieldToMain();
      
      // Dilate seguido de Erode (Closing) com tamanho de kernel configurável
      applyMorphologicalOperation(maskCtx, width, height, 'dilate', CONFIG.morphologySize);
      applyMorphologicalOperation(maskCtx, width, height, 'erode', CONFIG.morphologySize);
      
      // Inverter: bordas brancas -> preenchimento branco
      let imgData2 = maskCtx.getImageData(0, 0, width, height);
      
      // Flood fill das regiões fechadas (transformar bordas em áreas preenchidas)
      console.log('Aplicando flood fill para preencher áreas fechadas...');
      loaderText.textContent = 'Preenchendo áreas...';
      await yieldToMain();
      
      // Inverter cores: branco vira preto, preto vira branco
      // Depois o WASM vai encontrar as regiões brancas como polígonos
      for (let i = 0; i < imgData2.data.length; i += 4) {
        const val = imgData2.data[i];
        const newVal = 255 - val; // Inverte
        imgData2.data[i] = imgData2.data[i + 1] = imgData2.data[i + 2] = newVal;
        imgData2.data[i + 3] = 255;
      }
      maskCtx.putImageData(imgData2, 0, 0);
      
      // Verifica pixels após inversão
      checkData = maskCtx.getImageData(0, 0, width, height);
      whitePixels = 0;
      for (let i = 0; i < checkData.data.length; i += 4) {
        if (checkData.data[i] > 200) whitePixels++;
      }
      console.log(`Após inversão: ${whitePixels} pixels brancos`);
      
      // DEBUG: Mostra a máscara final
      if (window.debugMorphLayer) map.removeLayer(window.debugMorphLayer);
      window.debugMorphLayer = L.imageOverlay(maskCanvas.toDataURL(), bounds, { opacity: 0.9 });
      window.debugMorphLayer.addTo(map);

      loaderText.textContent = 'Vetorizando polígonos...';
      await yieldToMain();

      // Prepara para o WASM
      const base64Mask = maskCanvas.toDataURL('image/png').split(',')[1];
      console.log('Enviando para WASM vetorizar_imagem...');

      try {
        // Chama o Rust/WASM para transformar pixels em GeoJSON
        const geojsonStr = vetorizar_imagem(base64Mask);
        console.log('WASM retornou GeoJSON string');
        const geojsonResult = JSON.parse(geojsonStr);
        console.log('GeoJSON parseado:', geojsonResult);

        // Converte coordenadas de pixel (0,0) para Lat/Lng reais
        const geojsonConvertido = converterPixelsParaLatLng(geojsonResult, maskCanvas, bounds);
        console.log(`Conversão para LatLng: ${geojsonConvertido.features.length} features`);

        if (geojsonConvertido.features.length === 0) {
          console.warn('Nenhum polígono encontrado após vetorização WASM');
          alert("A IA não detectou construções nesta área. Verifique o console para detalhes.");
          drawnItems.removeLayer(selectionLayer); // Remove o polígono de seleção manual
        } else {
          const poligonosVetorizados = L.geoJSON(geojsonConvertido, {
            style: function(feature) {
              return getStyleByQuality(feature);
            },
            onEachFeature: function(feature, layer) {
              // Adiciona popup com informações
              const props = feature.properties;
              layer.bindPopup(`
                <strong>ID:</strong> ${props.id}<br>
                <strong>Área:</strong> ${props.area_m2} m²<br>
                <strong>Score:</strong> ${props.confidence_score}/100<br>
                <strong>Qualidade:</strong> ${props.quality}<br>
                <strong>Compacidade:</strong> ${props.compactness}<br>
                <strong>Vértices:</strong> ${props.vertices}
              `);
            }
          });
          // Remove o polígono de seleção manual
          drawnItems.removeLayer(selectionLayer);
          // Adiciona os vetores
          drawnItems.addLayer(poligonosVetorizados);
          // Guarda referência para atualização de visualização
          window.lastGeoJSONLayer = poligonosVetorizados;
          // Guarda para exportação
          geojsonFeatures.push(...geojsonConvertido.features);
          
          // Atualiza estatísticas na UI
          atualizarEstatisticas();
          
          const totalArea = geojsonConvertido.features.reduce((sum, f) => sum + parseFloat(f.properties.area_m2 || 0), 0);
          const highQ = geojsonConvertido.features.filter(f => f.properties.quality === 'alta').length;
          const medQ = geojsonConvertido.features.filter(f => f.properties.quality === 'media').length;
          const lowQ = geojsonConvertido.features.filter(f => f.properties.quality === 'baixa').length;
          
          alert(`✅ Processamento concluído!\n\n📊 ${geojsonConvertido.features.length} polígonos detectados\n📐 Área total: ${totalArea.toFixed(2)} m²\n\n🎯 Qualidade:\n  🟢 Alta: ${highQ}\n  🟡 Média: ${medQ}\n  🔴 Baixa: ${lowQ}`);
        }

      } catch (e) {
        console.error("Erro no processo de vetorização (WASM/Turf):", e);
        alert("Erro ao processar vetores. Verifique o console para detalhes.");
        drawnItems.removeLayer(selectionLayer);
      }

      loader.style.display = 'none';

    } catch (error) {
      console.error("Erro Fatal:", error);
      if (error.message && error.message.includes('O modelo não retornou um SVG limpo')) {
        alert("A IA não conseguiu identificar construções na área selecionada. Tente desenhar uma área diferente ou verifique se há edificações visíveis na imagem.");
      } else {
        alert("Erro: " + error.message);
      }
      loader.style.display = 'none';
      drawnItems.removeLayer(selectionLayer);
    }

  }, { scale: 1, tileLayer: satelliteMap, mapBounds: bounds });
}

// --- UTILITÁRIOS (Sem Alterações) ---

function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function applyMorphologicalOperation(ctx, width, height, operationType, kernelSize = 5) {
  if (kernelSize % 2 === 0) kernelSize += 1;
  const originalData = ctx.getImageData(0, 0, width, height);
  const processedData = new ImageData(width, height);
  const k_offset = Math.floor(kernelSize / 2);
  const isDilate = operationType === 'dilate';
  const comparison = isDilate ? (a, b) => a > b : (a, b) => a < b;
  const initialValue = isDilate ? 0 : 255;

  // Simples implementação de morfologia binária
  const data = originalData.data;
  const outData = processedData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestVal = initialValue;
      // Otimização: verificar apenas o canal vermelho já que é p&b
      for (let ky = -k_offset; ky <= k_offset; ky++) {
        for (let kx = -k_offset; kx <= k_offset; kx++) {
          const px = x + kx;
          const py = y + ky;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const idx = (py * width + px) * 4;
            if (comparison(data[idx], bestVal)) {
              bestVal = data[idx];
            }
          }
        }
      }
      const outIndex = (y * width + x) * 4;
      outData[outIndex] = bestVal;     // R
      outData[outIndex + 1] = bestVal; // G
      outData[outIndex + 2] = bestVal; // B
      outData[outIndex + 3] = 255;     // Alpha
    }
  }
  ctx.putImageData(processedData, 0, 0);
}

function applyMorphologicalClean(ctx, width, height) {
  // Ajuste fino para remover ruídos e fechar telhados
  applyMorphologicalOperation(ctx, width, height, 'dilate', 9); // Fecha buracos (kernel maior)
  applyMorphologicalOperation(ctx, width, height, 'erode', 9);  // Restaura borda (kernel maior)
}

function converterPixelsParaLatLng(geojson, canvas, mapBounds) {
  const imgWidth = canvas.width;
  const imgHeight = canvas.height;
  const featuresFinais = [];

  // Usa parâmetros configuráveis do painel de controle
  const MIN_AREA_METERS = CONFIG.minArea;
  const TOLERANCIA_SIMPLIFICACAO = CONFIG.simplification;

  console.log(`Convertendo pixels para LatLng: ${geojson.features.length} features recebidas do WASM`);
  console.log('Bounds do mapa:', {
    north: mapBounds.getNorth(),
    south: mapBounds.getSouth(),
    east: mapBounds.getEast(),
    west: mapBounds.getWest()
  });
  console.log('Dimensões canvas:', imgWidth, 'x', imgHeight);

  if (!geojson || !geojson.features) return turf.featureCollection([]);

  geojson.features.forEach((feature, idx) => {
    // Garante que é polígono
    if (!feature.geometry || feature.geometry.type !== 'Polygon') {
      console.log(`Feature ${idx}: não é polígono, tipo=${feature.geometry?.type}`);
      return;
    }

    const coords = feature.geometry.coordinates[0];
    if (!coords || coords.length < 3) {
      console.log(`Feature ${idx}: coordenadas inválidas, length=${coords?.length}`);
      return;
    }

    if (idx < 3) console.log(`Feature ${idx}: ${coords.length} pontos, primeiros 3:`, coords.slice(0, 3));

    // Conversão Matemática: Pixel -> Lat/Lng
    const newCoords = coords.map(p => {
      // p[0] é X, p[1] é Y (de cima para baixo)
      const lng = mapBounds.getWest() + ((p[0] / imgWidth) * (mapBounds.getEast() - mapBounds.getWest()));
      const lat = mapBounds.getNorth() - ((p[1] / imgHeight) * (mapBounds.getNorth() - mapBounds.getSouth()));
      return [lng, lat];
    });
    
    if (idx < 3) console.log(`Feature ${idx} convertida, primeiras 3 coords:`, newCoords.slice(0, 3));

    // Fecha o anel se necessário
    if (newCoords[0][0] !== newCoords[newCoords.length - 1][0]) {
      newCoords.push([...newCoords[0]]);
    }

    try {
      const poly = turf.polygon([newCoords]);
      if (idx < 3) console.log(`Feature ${idx}: polígono criado com turf`);
      
      // Simplifica para ficar com cara de "Building Footprint" (menos vértices)
      const simplified = turf.simplify(poly, { tolerance: TOLERANCIA_SIMPLIFICACAO, highQuality: true });
      if (idx < 3) console.log(`Feature ${idx}: polígono simplificado`);

      const area = turf.area(simplified);
      if (idx < 3) {
        console.log(`Feature ${idx}: área calculada = ${area.toFixed(6)}m² (original ${coords.length} pontos)`);
      }

      // AQUI é onde os filtros são aplicados.
      if (area >= MIN_AREA_METERS) {
        // Limpar geometria: remove buracos e corrige auto-interseções
        let cleaned = limparGeometria(simplified);
        
        // Calcular score de confiança
        const qualityScore = calcularScoreConfianca(cleaned);
        
        // Filtro de qualidade mínima (remove falsos positivos)
        if (qualityScore.score >= CONFIG.minQualityScore) {
          cleaned.properties = {
            id: `imovel_${geojsonFeatures.length + featuresFinais.length + 1}`,
            area_m2: area.toFixed(2),
            confidence_score: qualityScore.score,
            compactness: qualityScore.compactness,
            vertices: qualityScore.vertices,
            quality: qualityScore.score >= 70 ? 'alta' : qualityScore.score >= 40 ? 'media' : 'baixa'
          };
          
          featuresFinais.push(cleaned);
          if (idx < 3) {
            console.log(`Feature ${idx}: ✅ APROVADA! Área: ${area.toFixed(2)}m² | Score: ${qualityScore.score} | Qualidade: ${cleaned.properties.quality}`);
          }
        } else {
          if (idx < 3) {
            console.log(`Feature ${idx}: ⚠️ REJEITADA POR QUALIDADE - Score ${qualityScore.score} < ${CONFIG.minQualityScore}`);
          }
        }
      } else {
        if (idx < 3) console.log(`Feature ${idx}: ❌ REJEITADA POR ÁREA - ${area.toFixed(2)}m² < ${MIN_AREA_METERS.toFixed(1)}m²`);
      }
    } catch (err) {
      console.error(`Feature ${idx} ERRO:`, err.message, err);
      // Ignora polígonos inválidos gerados pelo trace
    }
  });

  console.log(`Total de features após filtro: ${featuresFinais.length}`);
  return turf.featureCollection(featuresFinais);
}


// --- EXPORTAÇÃO ---
async function exportarShapefile() {
  if (geojsonFeatures.length === 0) {
    alert("Não há polígonos para exportar. Desenhe uma área e aguarde o processamento.");
    return;
  }

  console.log(`Iniciando exportação de ${geojsonFeatures.length} features`);
  console.log('Primeira feature:', geojsonFeatures[0]);
  
  const geojson = { type: "FeatureCollection", features: geojsonFeatures };
  console.log('GeoJSON completo:', geojson);
  
  const options = { folder: 'mapeamento_ia', types: { polygon: 'edificacoes' } };

  loaderText.textContent = 'Gerando Shapefile...';
  loader.style.display = 'flex';

  try {
    console.log('Verificando shpwrite:', typeof window.shpwrite);
    
    if (!window.shpwrite) {
      throw new Error('Biblioteca shpwrite não carregada');
    }
    
    console.log('Chamando shpwrite.zip...');
    const zipData = await window.shpwrite.zip(geojson, options);
    
    console.log('ZIP gerado, tipo:', typeof zipData);
    console.log('ZIP tamanho:', zipData ? zipData.byteLength || zipData.length : 'undefined');
    
    if (!zipData) {
      throw new Error('shpwrite.zip retornou dados vazios');
    }
    
    // Verificar primeiros caracteres
    if (typeof zipData === 'string') {
      console.log('Primeiros 10 chars:', zipData.substring(0, 10));
      
      // Detectar se é Base64 (começa com "UEsDB" = "PK" em Base64)
      if (zipData.startsWith('UEsDB') || /^[A-Za-z0-9+/=]+$/.test(zipData.substring(0, 100))) {
        console.log('Detectado Base64! Decodificando...');
      }
    }
    
    // shpwrite retorna Base64, precisamos decodificar para binário
    let zipBuffer;
    if (typeof zipData === 'string') {
      // Decodificar Base64 para binário
      console.log('Decodificando Base64 para binário...');
      const binaryString = atob(zipData);
      console.log('Base64 decodificado, tamanho binário:', binaryString.length);
      
      // Converter string binária para Uint8Array
      const len = binaryString.length;
      zipBuffer = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        zipBuffer[i] = binaryString.charCodeAt(i);
      }
      console.log('Conversão concluída, bytes:', zipBuffer.byteLength);
      console.log('Primeiros 4 bytes:', [zipBuffer[0], zipBuffer[1], zipBuffer[2], zipBuffer[3]]);
      console.log('Esperado para ZIP: [80, 75, 3, 4] (PK header)');
    } else if (zipData instanceof ArrayBuffer) {
      zipBuffer = zipData;
    } else if (zipData.buffer instanceof ArrayBuffer) {
      zipBuffer = zipData.buffer;
    } else {
      zipBuffer = zipData;
    }
    
    console.log('Criando blob com tamanho:', zipBuffer.byteLength || zipBuffer.length);
    const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });
    console.log('Blob criado, tamanho:', zipBlob.size);
    
    const link = document.createElement('a');
    link.href = URL.createObjectURL(zipBlob);
    link.download = 'mapeamento_edificacoes.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log('Download iniciado com sucesso');
    alert(`Exportação concluída! Foram exportados ${geojsonFeatures.length} polígonos.`);
  } catch (e) {
    console.error("Erro ao exportar:", e);
    console.error("Stack trace:", e.stack);
    alert("Erro ao gerar arquivo ZIP: " + e.message);
  } finally {
    loader.style.display = 'none';
  }
}

// Expõe para o botão do HTML
window.exportarShapefile = exportarShapefile;