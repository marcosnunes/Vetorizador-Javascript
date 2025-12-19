// Importação do WASM via window.vetoriza
let vetorizar_imagem;

/* global L, leafletImage, turf */

// --- CONFIGURAÇÃO INICIAL ---
const loader = document.getElementById('loader-overlay');
const loaderText = document.getElementById('loader-text');
let debugMaskLayer = null;
const geojsonFeatures = [];

// Inicializa o WASM (Vetorizador)
async function inicializarWasm() {
  try {
    await window.vetoriza();
    vetorizar_imagem = window.vetoriza.vetorizar_imagem;
    console.log("Módulo WASM carregado com sucesso.");
  } catch (e) {
    console.error("Falha ao carregar WASM:", e);
    alert("Erro crítico: O módulo de vetorização não carregou.");
  }
}

function testarObjetoGlobalWasm() {
  if (window.vetoriza) {
    console.log('vetoriza está disponível:', window.vetoriza);
    inicializarWasm();
  } else {
    console.error('Nenhum objeto global WASM encontrado (vetoriza). Verifique o build e a ordem dos scripts.');
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
    // 1. Aumenta contraste e brilho
    for (let i = 0; i < imgData.data.length; i += 4) {
      // Simples realce: multiplica RGB e soma offset
      imgData.data[i] = Math.min(255, imgData.data[i] * 1.2 + 20);     // R
      imgData.data[i + 1] = Math.min(255, imgData.data[i + 1] * 1.2 + 20); // G
      imgData.data[i + 2] = Math.min(255, imgData.data[i + 2] * 1.2 + 20); // B
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
        outData[outIdx] = outData[outIdx + 1] = outData[outIdx + 2] = mag > 100 ? 255 : 0;
        outData[outIdx + 3] = 255;
      }
    }
    for (let i = 0; i < outData.length; i++) {
      sobelData.data[i] = outData[i];
    }
    ctx.putImageData(sobelData, 0, 0);

    // 3. Binarização (garante que só pixels brancos fiquem)
    let binData = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < binData.data.length; i += 4) {
      const v = binData.data[i];
      if (v > 128) {
        binData.data[i] = binData.data[i + 1] = binData.data[i + 2] = 255;
        binData.data[i + 3] = 255;
      } else {
        binData.data[i] = binData.data[i + 1] = binData.data[i + 2] = 0;
        binData.data[i + 3] = 255;
      }
    }
    ctx.putImageData(binData, 0, 0);

    // Pega apenas os dados base64 (remove o prefixo data:image/png;base64,)
    const base64Full = mainCanvas.toDataURL('image/png').split(',')[1];

    loaderText.textContent = 'Analisando com IA (Aguarde)...';
    await yieldToMain();

    try {
      // 1. Chama a API Vercel (Serverless)
      const svgString = await chamarBackendGemini(base64Full, width, height);
      console.log("SVG recebido da IA.");

      console.log("Conteúdo do SVG (Debug):", svgString);

      // 2. Renderiza o SVG diretamente no canvas usando Canvg
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = width;
      maskCanvas.height = height;
      const maskCtx = maskCanvas.getContext('2d');

      try {
        // Verifica se canvg está disponível no escopo global
        if (typeof window.canvg === 'undefined') {
          throw new Error('Biblioteca Canvg não foi carregada. Verifique se umd.js está incluído no HTML.');
        }

        let canvgLib = window.canvg;

        // Tenta diferentes formas de acessar o Canvg
        let Canvg = canvgLib.Canvg || canvgLib;

        if (!Canvg || typeof Canvg.from !== 'function') {
          console.error('window.canvg:', window.canvg);
          throw new Error('Canvg.from não está disponível. Estrutura do objeto canvg: ' + JSON.stringify(Object.keys(canvgLib)));
        }

        // Usa o método correto do Canvg (versão 3.x usa .from())
        const canvgInstance = await Canvg.from(maskCtx, svgString);
        await canvgInstance.render();

      } catch (err) {
        console.error('Erro ao renderizar SVG com Canvg:', err);
        alert('Erro: Não foi possível renderizar o SVG com Canvg. Detalhes: ' + err.message);
        loader.style.display = 'none';
        drawnItems.removeLayer(selectionLayer);
        return;
      }

      // DEBUG: Mostra a máscara no mapa (opcional)
      if (debugMaskLayer) map.removeLayer(debugMaskLayer);
      debugMaskLayer = L.imageOverlay(maskCanvas.toDataURL(), bounds, { opacity: 0.7 });
      debugMaskLayer.addTo(map);

      // 4. Limpeza de ruído (Morfologia)
      applyMorphologicalClean(maskCtx, width, height);
      // Torna o fundo preto transparente na máscara binária
      const imgData2 = maskCtx.getImageData(0, 0, width, height);
      for (let i = 0; i < imgData2.data.length; i += 4) {
        // Se o pixel for preto (R=0,G=0,B=0), torna transparente
        if (imgData2.data[i] === 0 && imgData2.data[i + 1] === 0 && imgData2.data[i + 2] === 0) {
          imgData2.data[i + 3] = 0;
        } else {
          imgData2.data[i + 3] = 255;
        }
      }
      maskCtx.putImageData(imgData2, 0, 0);
      // DEBUG: Mostra a máscara binária após morfologia
      if (window.debugMorphLayer) map.removeLayer(window.debugMorphLayer);
      window.debugMorphLayer = L.imageOverlay(maskCanvas.toDataURL(), bounds, { opacity: 0.9 });
      window.debugMorphLayer.addTo(map);

      loaderText.textContent = 'Vetorizando polígonos...';
      await yieldToMain();

      // 5. Prepara para o WASM
      const base64Mask = maskCanvas.toDataURL('image/png').split(',')[1];

      try {
        // Chama o Rust/WASM para transformar pixels em GeoJSON
        const geojsonStr = vetorizar_imagem(base64Mask);
        const geojsonResult = JSON.parse(geojsonStr);

        // Converte coordenadas de pixel (0,0) para Lat/Lng reais
        const geojsonConvertido = converterPixelsParaLatLng(geojsonResult, maskCanvas, bounds);

        if (geojsonConvertido.features.length === 0) {
          alert("A IA não detectou construções nesta área.");
          drawnItems.removeLayer(selectionLayer); // Remove o polígono de seleção manual
        } else {
          const poligonosVetorizados = L.geoJSON(geojsonConvertido, {
            style: { color: '#00ffcc', weight: 2, fillOpacity: 0.3 }
          });
          // Remove o polígono de seleção manual
          drawnItems.removeLayer(selectionLayer);
          // Adiciona os vetores
          drawnItems.addLayer(poligonosVetorizados);
          // Guarda para exportação
          geojsonFeatures.push(...geojsonConvertido.features);
          alert(`Processamento concluído. ${geojsonConvertido.features.length} polígonos detectados e vetorizados.`);
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

  const MIN_AREA_METERS = 1.0; // Área mínima para considerar um edifício (reduzido para permitir mais polígonos)
  const TOLERANCIA_SIMPLIFICACAO = 0.000005;

  if (!geojson || !geojson.features) return turf.featureCollection([]);

  geojson.features.forEach(feature => {
    // Garante que é polígono
    if (!feature.geometry || feature.geometry.type !== 'Polygon') return;

    const coords = feature.geometry.coordinates[0];
    if (!coords || coords.length < 3) return;

    // Conversão Matemática: Pixel -> Lat/Lng
    const newCoords = coords.map(p => {
      // p[0] é X, p[1] é Y (de cima para baixo)
      const lng = mapBounds.getWest() + ((p[0] / imgWidth) * (mapBounds.getEast() - mapBounds.getWest()));
      const lat = mapBounds.getNorth() - ((p[1] / imgHeight) * (mapBounds.getNorth() - mapBounds.getSouth()));
      return [lng, lat];
    });

    // Fecha o anel se necessário
    if (newCoords[0][0] !== newCoords[newCoords.length - 1][0]) {
      newCoords.push([...newCoords[0]]);
    }

    try {
      const poly = turf.polygon([newCoords]);
      // Simplifica para ficar com cara de "Building Footprint" (menos vértices)
      const simplified = turf.simplify(poly, { tolerance: TOLERANCIA_SIMPLIFICACAO, highQuality: true });

      // AQUI é onde o filtro é aplicado.
      if (turf.area(simplified) > MIN_AREA_METERS) { // Agora verifica se é maior que 1.0 m²
        simplified.properties = {
          id: `imovel_${geojsonFeatures.length + featuresFinais.length + 1}`,
          area_m2: turf.area(simplified).toFixed(2)
        };
        featuresFinais.push(simplified);
      }
    } catch {
      // Ignora polígonos inválidos gerados pelo trace
    }
  });

  return turf.featureCollection(featuresFinais);
}


// --- EXPORTAÇÃO ---
async function exportarShapefile() {
  if (geojsonFeatures.length === 0) {
    alert("Não há polígonos para exportar. Desenhe uma área e aguarde o processamento.");
    return;
  }

  const geojson = { type: "FeatureCollection", features: geojsonFeatures };
  const options = { folder: 'mapeamento_ia', types: { polygon: 'edificacoes' } };

  loaderText.textContent = 'Gerando Shapefile...';
  loader.style.display = 'flex';

  try {
    // @ts-ignore (shpwrite é global)
    const zipData = await window.shpwrite.zip(geojson, options);
    const zipBlob = new Blob([zipData], { type: 'application/zip' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(zipBlob);
    link.download = 'mapeamento_edificacoes.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    alert(`Exportação concluída! Foram exportados ${geojsonFeatures.length} polígonos.`);
  } catch (e) {
    console.error("Erro ao exportar:", e);
    alert("Erro ao gerar arquivo ZIP.");
  } finally {
    loader.style.display = 'none';
  }
}

// Expõe para o botão do HTML
window.exportarShapefile = exportarShapefile;