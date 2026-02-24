// Importação do WASM via wasm_bindgen (no-modules target)
let vetorizar_imagem;

/* global L, leafletImage, turf, wasm_bindgen */

// ==================== IMPORTS DE FIREBASE/FIRESTORE ====================
import { inicializarFirebase, estaOnline, monitorarConexao } from './firebase-config.js';
import { 
  salvarRunFirestore, 
  salvarFeaturesFirestore, 
  salvarFeedbackFirestore,
  exportarDatasetCompleto 
} from './firestore-service.js';
import { 
  inicializarFilaOffline, 
  adicionarNaFila, 
  sincronizarFila,
  contarOperacoesPendentes 
} from './offline-queue.js';

// --- CONFIGURAÇÃO INICIAL ---
const loader = document.getElementById('loader-overlay');
const loaderText = document.getElementById('loader-text');
let debugMaskLayer = null;
const geojsonFeatures = [];
let activeRunId = null;
let activeRunStartedAt = null;

const LEARNING_DB_NAME = 'vetorizador_learning_db';
const LEARNING_DB_VERSION = 1;
let learningDbPromise = null;

// Variáveis de sincronização Firebase
let firebaseInicializado = false;
let modoOffline = false;

// --- PARÂMETROS AJUSTÁVEIS ---
let CONFIG = {
  edgeThreshold: 90,          // Threshold para Sobel edge detection
  morphologySize: 5,          // Tamanho do kernel morfológico
  minArea: 15.0,              // Área mínima em m² (edificação residencial mínima)
  simplification: 0.00001,    // Tolerância de simplificação
  contrastBoost: 1.3,         // Multiplicador de contraste
  minQualityScore: 35,        // Score mínimo para aceitar polígono (0-100)
  mergeDistance: 3,           // Distância em metros para mesclar polígonos próximos
  clusteringEnabled: true,    // Ativa DBSCAN para limpar ruído de borda
  clusterEps: 2.5,            // Raio (px) de vizinhança do DBSCAN
  clusterMinPts: 6,           // Mínimo de pontos vizinhos para core point
  minClusterSize: 40          // Mínimo de pixels por cluster aceito
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
  
  input.addEventListener('blur', () => {
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
  sincronizarControle('mergeDistance', 'mergeDistanceInput', 'mergeDistance', v => v.toFixed(1));
  sincronizarControle('clusterEps', 'clusterEpsInput', 'clusterEps', v => v.toFixed(1));
  sincronizarControle('clusterMinPts', 'clusterMinPtsInput', 'clusterMinPts', v => v.toFixed(0));
  sincronizarControle('minClusterSize', 'minClusterSizeInput', 'minClusterSize', v => v.toFixed(0));

  const clusteringEnabled = document.getElementById('clusteringEnabled');
  if (clusteringEnabled) {
    clusteringEnabled.checked = CONFIG.clusteringEnabled;
    clusteringEnabled.addEventListener('change', (e) => {
      CONFIG.clusteringEnabled = e.target.checked;
    });
  }
  
  // Ativa colorir por qualidade por padrão
  const colorByQuality = document.getElementById('colorByQuality');
  if (colorByQuality) {
    colorByQuality.checked = true;
    // Listener para atualizar visualização quando checkbox muda
    colorByQuality.addEventListener('change', atualizarVisualizacao);
  }

  // ==================== INICIALIZAÇÃO FIREBASE + FILA OFFLINE ====================
  inicializarSistemaAprendizado().catch((err) => {
    console.error('Falha na inicialização do sistema de aprendizado:', err);
  });
});

// ==================== FUNÇÃO UNIFICADA DE INICIALIZAÇÃO ====================
async function inicializarSistemaAprendizado() {
  console.log('🚀 Inicializando sistema de aprendizado...');
  
  // 1. Inicializar IndexedDB local (Phase 1 - sempre necessário)
  try {
    await inicializarBancoAprendizado();
    console.log('✅ Banco local de aprendizado inicializado');
  } catch (error) {
    console.error('❌ Erro ao inicializar banco local:', error);
  }

  // 2. Inicializar fila offline
  try {
    await inicializarFilaOffline();
    console.log('✅ Fila offline inicializada');
  } catch (error) {
    console.error('❌ Erro ao inicializar fila offline:', error);
  }

  // 3. Inicializar Firebase/Firestore (Phase 2)
  try {
    const { db, auth } = inicializarFirebase();
    if (db && auth) {
      firebaseInicializado = true;
      console.log('✅ Firebase/Firestore inicializado');
      
      // 4. Monitorar conexão e sincronizar quando online
      monitorarConexao(
        () => {
          modoOffline = false;
          sincronizarFilaPendente();
        },
        () => {
          modoOffline = true;
        }
      );

      // 5. Sincronizar fila pendente (se houver operações offline)
      await sincronizarFilaPendente();
    }
  } catch (error) {
    console.error('⚠️ Firebase não inicializado - rodando apenas com IndexedDB local:', error);
    firebaseInicializado = false;
  }

  atualizarIndicadorConexao();
}

// ==================== SINCRONIZAR FILA PENDENTE ====================
async function sincronizarFilaPendente() {
  if (!firebaseInicializado || !estaOnline()) {
    return;
  }

  const pendentes = await contarOperacoesPendentes();
  if (pendentes === 0) {
    return;
  }

  console.log(`🔄 Sincronizando ${pendentes} operações pendentes...`);
  
  try {
    const resultado = await sincronizarFila(async (operationType, payload) => {
      switch (operationType) {
        case 'run':
          await salvarRunFirestore(payload.runId, payload.dadosRun);
          break;
        case 'features':
          await salvarFeaturesFirestore(payload.runId, payload.features);
          break;
        case 'feedback':
          await salvarFeedbackFirestore(payload.runId, payload.featureId, payload.feedback);
          break;
        default:
          console.warn(`⚠️ Tipo de operação desconhecido: ${operationType}`);
      }
    });

    if (resultado.sucesso > 0) {
      mostrarNotificacao(`✅ ${resultado.sucesso} operações sincronizadas`, 'success');
    }
  } catch (error) {
    console.error('❌ Erro na sincronização da fila:', error);
  }
}

// ==================== ATUALIZAR INDICADOR DE CONEXÃO ====================
function atualizarIndicadorConexao() {
  const indicador = document.getElementById('connection-status');
  if (!indicador) return;

  if (!firebaseInicializado) {
    indicador.textContent = '💾 Modo Local';
    indicador.className = 'status-local';
  } else if (modoOffline || !estaOnline()) {
    indicador.textContent = '📵 Offline';
    indicador.className = 'status-offline';
  } else {
    indicador.textContent = '🌐 Online';
    indicador.className = 'status-online';
  }
}

// Função para aplicar pré-configurações
function aplicarPreset(tipo) {
  let preset;
  
  switch(tipo) {
    case 'urbano':
      preset = {
        edgeThreshold: 105,       // Mais seletivo para reduzir bordas espúrias urbanas
        morphologySize: 5,        // Preserva telhados sem unir objetos distintos
        minArea: 35.0,            // Remove pequenos artefatos em área densa
        simplification: 0.00002,  // Mantém melhor o footprint dos telhados
        contrastBoost: 1.4,       // Realce moderado para não estourar sombras
        minQualityScore: 60,      // Filtro mais rígido em qualidade
        clusteringEnabled: true,
        clusterEps: 2.2,
        clusterMinPts: 8,
        minClusterSize: 90,
        nome: 'Área Urbana (Precisão Alta)'
      };
      break;
      
    case 'rural':
      preset = {
        edgeThreshold: 65,        // Reduzido para capturar edificações em vegetação
        morphologySize: 9,        // Muito maior para fechar gaps grandes
        minArea: 40.0,            // Aumentado - edificações rurais são maiores
        simplification: 0.00004,  // Mais simplificação para reduzir vértices
        contrastBoost: 1.6,       // Alto contraste para separar de vegetação
        minQualityScore: 45,      // Filtro médio para área rural
        clusteringEnabled: true,
        clusterEps: 3.0,
        clusterMinPts: 5,
        minClusterSize: 35,
        nome: 'Área Rural (Profissional)'
      };
      break;
      
    case 'industrial':
      preset = {
        edgeThreshold: 70,
        morphologySize: 7,
        minArea: 150.0,           // Galpões são grandes
        simplification: 0.00005,  // Muita simplificação - formas retangulares
        contrastBoost: 1.4,
        minQualityScore: 50,
        clusteringEnabled: true,
        clusterEps: 2.0,
        clusterMinPts: 7,
        minClusterSize: 60,
        nome: 'Galpões Industriais (Profissional)'
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
  CONFIG.mergeDistance = 3; // Sempre ativa fusão nos presets
  CONFIG.clusteringEnabled = preset.clusteringEnabled;
  CONFIG.clusterEps = preset.clusterEps;
  CONFIG.clusterMinPts = preset.clusterMinPts;
  CONFIG.minClusterSize = preset.minClusterSize;
  
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
  document.getElementById('mergeDistance').value = 3;
  document.getElementById('mergeDistanceInput').value = '3.0';
  document.getElementById('clusteringEnabled').checked = preset.clusteringEnabled;
  document.getElementById('clusterEps').value = preset.clusterEps;
  document.getElementById('clusterEpsInput').value = preset.clusterEps.toFixed(1);
  document.getElementById('clusterMinPts').value = preset.clusterMinPts;
  document.getElementById('clusterMinPtsInput').value = preset.clusterMinPts;
  document.getElementById('minClusterSize').value = preset.minClusterSize;
  document.getElementById('minClusterSizeInput').value = preset.minClusterSize;
  
  alert(`✅ Preset "${preset.nome}" aplicado!\n\n🎯 Configurações profissionais ativadas:\n• Fusão automática de fragmentos\n• Filtros de qualidade otimizados\n• Geometrias simplificadas`);
}

// Função para resetar parâmetros
function resetarParametros() {
  CONFIG = {
    edgeThreshold: 90,
    morphologySize: 5,
    minArea: 15.0,
    simplification: 0.00001,
    contrastBoost: 1.3,
    minQualityScore: 35,
    mergeDistance: 3,
    clusteringEnabled: true,
    clusterEps: 2.5,
    clusterMinPts: 6,
    minClusterSize: 40
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
  document.getElementById('mergeDistance').value = 3;
  document.getElementById('mergeDistanceInput').value = '3.0';
  document.getElementById('clusteringEnabled').checked = true;
  document.getElementById('clusterEps').value = 2.5;
  document.getElementById('clusterEpsInput').value = '2.5';
  document.getElementById('clusterMinPts').value = 6;
  document.getElementById('clusterMinPtsInput').value = 6;
  document.getElementById('minClusterSize').value = 40;
  document.getElementById('minClusterSizeInput').value = 40;
  
  alert('✅ Parâmetros restaurados!\n\nTodos os valores foram redefinidos para os padrões recomendados.');
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
  alert('🗑️ Resultados limpos!\n\nTodos os polígonos foram removidos do mapa.');
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
        layer.bindPopup(criarPopupFeedback(feature));
      }
    });
    
    drawnItems.addLayer(window.lastGeoJSONLayer);
  }
}

function gerarRunId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `run_${Date.now()}_${random}`;
}

function obterTextoFeedback(status) {
  switch (status) {
    case 'aprovado':
      return '✅ Aprovado';
    case 'rejeitado':
      return '❌ Rejeitado';
    case 'editado':
      return '✏️ Editado';
    default:
      return '⏳ Pendente';
  }
}

function criarPopupFeedback(feature) {
  const props = feature.properties || {};
  const feedbackStatus = props.feedback_status || 'pendente';
  const feedbackReason = props.feedback_reason || '-';
  const featureId = props.id || '';

  return `
    <strong>ID:</strong> ${props.id}<br>
    <strong>Área:</strong> ${props.area_m2} m²<br>
    <strong>Score:</strong> ${props.confidence_score}/100<br>
    <strong>Qualidade:</strong> ${props.quality}<br>
    <strong>Compacidade:</strong> ${props.compactness}<br>
    <strong>Vértices:</strong> ${props.vertices}<br>
    <strong>Feedback:</strong> ${obterTextoFeedback(feedbackStatus)}<br>
    <strong>Motivo:</strong> ${feedbackReason}<br>
    <div style="margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap;">
      <button onclick="marcarFeedbackPoligono('${featureId}', 'aprovado')">✅ Aprovar</button>
      <button onclick="marcarFeedbackPoligono('${featureId}', 'rejeitado')">❌ Rejeitar</button>
      <button onclick="marcarFeedbackPoligono('${featureId}', 'editado')">✏️ Editado</button>
    </div>
  `;
}

function inicializarBancoAprendizado() {
  if (learningDbPromise) return learningDbPromise;

  learningDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LEARNING_DB_NAME, LEARNING_DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('runs')) {
        db.createObjectStore('runs', { keyPath: 'runId' });
      }

      if (!db.objectStoreNames.contains('feedback')) {
        const store = db.createObjectStore('feedback', { keyPath: 'feedbackId' });
        store.createIndex('runId', 'runId', { unique: false });
        store.createIndex('featureId', 'featureId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return learningDbPromise;
}

async function idbPut(storeName, value) {
  const db = await inicializarBancoAprendizado();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(storeName, key) {
  const db = await inicializarBancoAprendizado();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(storeName) {
  const db = await inicializarBancoAprendizado();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function salvarRunAprendizado(runPayload) {
  // Salva localmente no IndexedDB (sempre)
  await idbPut('runs', runPayload);

  // Tenta salvar no Firestore se online e inicializado
  if (firebaseInicializado && estaOnline()) {
    try {
      // Salva run
      await salvarRunFirestore(runPayload.runId, runPayload);
      
      // Salva features como subcoleção
      if (runPayload.features && runPayload.features.length > 0) {
        await salvarFeaturesFirestore(runPayload.runId, runPayload.features);
      }
      
      console.log(`✅ Run ${runPayload.runId.substring(0, 8)} salva no Firestore`);
    } catch (error) {
      console.error('❌ Erro ao salvar run no Firestore - adicionando à fila offline:', error);
      await adicionarNaFila('run', { runId: runPayload.runId, dadosRun: runPayload });
      if (runPayload.features && runPayload.features.length > 0) {
        await adicionarNaFila('features', { runId: runPayload.runId, features: runPayload.features });
      }
    }
  } else {
    // Adiciona à fila offline para sincronização posterior
    await adicionarNaFila('run', { runId: runPayload.runId, dadosRun: runPayload });
    if (runPayload.features && runPayload.features.length > 0) {
      await adicionarNaFila('features', { runId: runPayload.runId, features: runPayload.features });
    }
  }
}

async function salvarFeedbackAprendizado(feedbackPayload) {
  // Salva localmente no IndexedDB (sempre)
  await idbPut('feedback', feedbackPayload);

  // Tenta salvar no Firestore se online e inicializado
  if (firebaseInicializado && estaOnline()) {
    try {
      await salvarFeedbackFirestore(
        feedbackPayload.runId, 
        feedbackPayload.featureId, 
        {
          status: feedbackPayload.feedbackStatus,
          reason: feedbackPayload.feedbackReason,
          editedGeometry: feedbackPayload.editedGeometry,
          timestamp: feedbackPayload.timestamp
        }
      );
      console.log(`✅ Feedback ${feedbackPayload.feedbackId} salvo no Firestore`);
    } catch (error) {
      console.error('❌ Erro ao salvar feedback no Firestore - adicionando à fila offline:', error);
      await adicionarNaFila('feedback', {
        runId: feedbackPayload.runId,
        featureId: feedbackPayload.featureId,
        feedback: {
          status: feedbackPayload.feedbackStatus,
          reason: feedbackPayload.feedbackReason,
          editedGeometry: feedbackPayload.editedGeometry,
          timestamp: feedbackPayload.timestamp
        }
      });
    }
  } else {
    // Adiciona à fila offline para sincronização posterior
    await adicionarNaFila('feedback', {
      runId: feedbackPayload.runId,
      featureId: feedbackPayload.featureId,
      feedback: {
        status: feedbackPayload.feedbackStatus,
        reason: feedbackPayload.feedbackReason,
        editedGeometry: feedbackPayload.editedGeometry,
        timestamp: feedbackPayload.timestamp
      }
    });
  }
}

async function atualizarFeedbackNoRun(runId, featureId, feedbackStatus, feedbackReason) {
  if (!runId || !featureId) return;

  const run = await idbGet('runs', runId);
  if (!run || !Array.isArray(run.features)) return;

  const target = run.features.find((f) => f.featureId === featureId);
  if (!target) return;

  target.feedbackStatus = feedbackStatus;
  target.feedbackReason = feedbackReason || '';
  target.feedbackUpdatedAt = new Date().toISOString();

  await idbPut('runs', run);
}

async function marcarFeedbackPoligono(featureId, status) {
  const feature = geojsonFeatures.find((f) => f.properties?.id === featureId);
  if (!feature) {
    alert('⚠️ Polígono não encontrado para feedback.');
    return;
  }

  // Se for modo editado, ativar edição visual
  if (status === 'editado') {
    ativarEdicaoPoligono(featureId, feature);
    return;
  }

  let feedbackReason = '';
  if (status === 'rejeitado') {
    feedbackReason = prompt('Informe o motivo (ex.: sombra, rua, fragmentado, noise):', feature.properties.feedback_reason || '') || '';
  }

  feature.properties.feedback_status = status;
  feature.properties.feedback_reason = feedbackReason;
  feature.properties.feedback_updated_at = new Date().toISOString();

  const feedbackPayload = {
    feedbackId: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    runId: feature.properties.run_id || activeRunId || 'sem_run',
    featureId: featureId,
    label: status,
    reason: feedbackReason,
    createdAt: new Date().toISOString()
  };

  try {
    await salvarFeedbackAprendizado(feedbackPayload);
    await atualizarFeedbackNoRun(
      feedbackPayload.runId,
      featureId,
      status,
      feedbackReason
    );
    atualizarVisualizacao();
  } catch (err) {
    console.error('Erro ao salvar feedback no banco local:', err);
  }
}

// Nova função para ativar modo de edição visual
function ativarEdicaoPoligono(featureId, feature) {
  console.log('🔵 Iniciando edição do polígono:', featureId);
  
  // Fechar todos os popups para liberar a visão do mapa
  window.map.closePopup();
  
  // CRÍTICO: Remover layers de debug que bloqueiam a visualização
  if (debugMaskLayer) {
    window.map.removeLayer(debugMaskLayer);
    debugMaskLayer = null;
  }
  if (window.debugMorphLayer) {
    window.map.removeLayer(window.debugMorphLayer);
    window.debugMorphLayer = null;
  }
  
  // Procurar o layer correspondente no mapa pelo featureId
  let targetLayer = null;
  
  if (window.lastGeoJSONLayer) {
    window.lastGeoJSONLayer.eachLayer((layer, index) => {
      const layerFeatureId = layer.feature?.properties?.id;
      console.log(`  Layer ${index}: id=${layerFeatureId}, procurando=${featureId}`);
      
      if (layerFeatureId === featureId) {
        targetLayer = layer;
        console.log(`  ✅ Encontrado exato no índice ${index}`);
      }
    });
  }

  if (!targetLayer) {
    console.error('❌ Layer não encontrado para featureId:', featureId);
    alert('⚠️ Polígono não encontrado. Tente clicar diretamente no polígono no mapa.');
    return;
  }

  console.log('✅ Layer encontrado, iniciando edição');
  
  // Salvar geometria original antes de editar
  const geometriaOriginal = JSON.parse(JSON.stringify(feature.geometry));
  
  // Obter coordenadas do polígono
  const latlngs = targetLayer.getLatLngs();
  console.log(`  Coordenadas originais: ${latlngs.length} vértices`);
  
  // Remover layer do GeoJSON temporariamente
  window.lastGeoJSONLayer.removeLayer(targetLayer);
  
  // Criar polígono editável com estilo destacado
  const editablePolygon = L.polygon(latlngs, {
    color: '#FF6B00',
    weight: 4,
    fillOpacity: 0.2,
    fillColor: '#FF6B00',
    dashArray: '10, 5'
  }).addTo(window.map);
  
  // Customizar os marcadores de vértice ANTES de ativar edição
  const editHandler = editablePolygon.editing;
  
  // Habilitar edição usando Leaflet.Draw
  editHandler.enable();
  
  // Redimensionar marcadores de vértice após 100ms (dar tempo para renderizar)
  setTimeout(() => {
    const markers = editHandler._markers;
    if (markers) {
      markers.forEach(marker => {
        // Reduzir significativamente o tamanho do marcador
        const icon = marker.getIcon();
        if (icon) {
          marker.setIcon(L.divIcon({
            className: 'leaflet-div-icon-edit-small',
            html: '<div style="width: 10px; height: 10px; background: white; border: 2px solid #FF6B00; border-radius: 50%; cursor: move;"></div>',
            iconSize: [10, 10],
            iconAnchor: [5, 5]
          }));
        }
      });
    }
  }, 100);
  
  console.log('✅ Vértices habilitados para edição');

  // Criar painel de instruções temporário - COMPACTO E TRANSPARENTE
  const instrucoes = L.control({ position: 'bottomright' });
  instrucoes.onAdd = function() {
    const div = L.DomUtil.create('div', 'edit-instructions');
    div.style.background = 'rgba(0, 0, 0, 0.75)';
    div.style.padding = '12px';
    div.style.borderRadius = '6px';
    div.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
    div.style.maxWidth = '280px';
    div.style.zIndex = '10000'; // Aumentar z-index para garantir visibilidade
    div.style.color = 'white';
    div.style.backdropFilter = 'blur(4px)';
    div.innerHTML = `
      <strong style="color: #FFA500; font-size: 14px; display: block; margin-bottom: 8px;">✏️ Editando Polígono</strong>
      <p style="margin: 0 0 10px 0; font-size: 12px; line-height: 1.4; color: #E0E0E0;">
        • <strong>Arraste vértices</strong> brancos<br>
        • <strong>Clique linhas</strong> → novo ponto<br>
        • <strong>Zoom</strong> para precisão (até 23x)<br>
        • 🏆 <span style="color: #FFD700;">ML aprende!</span>
      </p>
      <button id="salvar-edicao" style="background: #28a745; color: white; border: none; padding: 10px 12px; border-radius: 4px; cursor: pointer; width: 100%; margin-bottom: 6px; font-weight: bold; font-size: 13px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
        ✅ Salvar Correção
      </button>
      <button id="cancelar-edicao" style="background: #dc3545; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; width: 100%; font-size: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
        ❌ Cancelar
      </button>
    `;
    
    // Prevenir propagação de eventos do mapa
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    
    return div;
  };
  instrucoes.addTo(window.map);

  // Handler para salvar edição
  setTimeout(() => {
    const btnSalvar = document.getElementById('salvar-edicao');
    const btnCancelar = document.getElementById('cancelar-edicao');
    
    if (btnSalvar) {
      btnSalvar.addEventListener('click', async () => {
        // Capturar geometria editada
        const geometriaEditada = editablePolygon.toGeoJSON().geometry;
        
        // Pedir motivo da edição
        const motivo = prompt(
          '📝 Informe o motivo da correção:\n\n' +
          'Exemplos:\n' +
          '• "borda imprecisa"\n' +
          '• "faltou canto sudeste"\n' +
          '• "sobrou parte da sombra"\n' +
          '• "forma irregular"',
          ''
        ) || 'correção manual';
        
        if (!motivo.trim()) {
          alert('⚠️ Por favor, informe um motivo para a correção.');
          return;
        }
        
        // Atualizar feature com geometrias original E editada
        feature.geometry = geometriaEditada;
        feature.properties.feedback_status = 'editado';
        feature.properties.feedback_reason = motivo;
        feature.properties.feedback_updated_at = new Date().toISOString();
        feature.properties.geometria_original = geometriaOriginal;  // GOLD para ML!
        
        // Salvar feedback com ambas geometrias
        const feedbackPayload = {
          feedbackId: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          runId: feature.properties.run_id || activeRunId || 'sem_run',
          featureId: featureId,
          label: 'editado',
          reason: motivo,
          geometriaOriginal: geometriaOriginal,
          geometriaCorrigida: geometriaEditada,
          createdAt: new Date().toISOString()
        };
        
        try {
          await salvarFeedbackAprendizado(feedbackPayload);
          await atualizarFeedbackNoRun(
            feedbackPayload.runId,
            featureId,
            'editado',
            motivo
          );
          
          // Remover polígono editável e instruções
          window.map.removeLayer(editablePolygon);
          instrucoes.remove();
          
          // Atualizar visualização com nova geometria
          atualizarVisualizacao();
          
          mostrarNotificacao('✅ Correção salva com sucesso! Dados valiosos para o ML 🏆', 'success');
          console.log('✏️ Edição salva:', {
            featureId,
            motivo,
            geometriaOriginal: geometriaOriginal.coordinates,
            geometriaCorrigida: geometriaEditada.coordinates
          });
        } catch (err) {
          console.error('Erro ao salvar correção:', err);
          alert('❌ Erro ao salvar correção: ' + err.message);
        }
      });
    }

    if (btnCancelar) {
      btnCancelar.addEventListener('click', () => {
        // Remover polígono editável e instruções
        window.map.removeLayer(editablePolygon);
        instrucoes.remove();
        
        // Restaurar visualização original
        atualizarVisualizacao();
      });
    }
  }, 100); // Pequeno delay para garantir que elementos foram adicionados ao DOM
}

async function exportarDatasetAprendizado() {
  try {
    let datasetCompleto;

    // Se Firebase está inicializado e online, exportar do Firestore
    if (firebaseInicializado && estaOnline()) {
      const escolha = confirm(
        '🌐 Firebase detectado!\n\n' +
        'Escolha a fonte de dados:\n' +
        'OK = Exportar do Firestore (todos os usuários)\n' +
        'Cancelar = Exportar apenas dados locais (IndexedDB)'
      );

      if (escolha) {
        loader.style.display = 'flex';
        loaderText.textContent = 'Exportando dataset do Firestore...';
        try {
          datasetCompleto = await exportarDatasetCompleto();
          loader.style.display = 'none';
          
          if (!datasetCompleto || !datasetCompleto.runs || datasetCompleto.runs.length === 0) {
            alert('⚠️ Nenhum dado encontrado no Firestore.');
            return;
          }

          const blob = new Blob([JSON.stringify(datasetCompleto, null, 2)], { type: 'application/json' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `dataset_firestore_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          
          mostrarNotificacao(`✅ Dataset exportado: ${datasetCompleto.runs.length} runs`, 'success');
          return;
        } catch (error) {
          loader.style.display = 'none';
          console.error('❌ Erro ao exportar do Firestore:', error);
          alert('❌ Erro ao exportar do Firestore. Exportando dados locais...');
          // Continua para exportação local
        }
      }
    }

    // Exportação local (IndexedDB)
    const runs = await idbGetAll('runs');
    const feedback = await idbGetAll('feedback');

    if (runs.length === 0 && feedback.length === 0) {
      alert('⚠️ Não há dados de aprendizado para exportar ainda.');
      return;
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'vetorizador-edificacoes',
      version: 'fase2-firestore-offline',
      source: 'indexeddb-local',
      runs,
      feedback
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `dataset_local_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    mostrarNotificacao(`✅ Dataset local exportado: ${runs.length} runs`, 'success');
  } catch (err) {
    console.error('Erro ao exportar dataset de aprendizado:', err);
    alert('❌ Erro ao exportar dataset de aprendizado.');
  }
}

// ==================== HELPER: NOTIFICAÇÕES ====================
function mostrarNotificacao(mensagem, tipo = 'info') {
  console.log(`[${tipo.toUpperCase()}] ${mensagem}`);
  // TODO: Adicionar toast notification no futuro
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
  } catch {
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
  } catch {
    console.warn('Erro ao limpar geometria');
    return polygon;
  }
}

// Mesclar polígonos próximos (mesma edificação fragmentada)
function mesclarPoligonosProximos(features, distanciaMetros = 2) {
  if (features.length === 0) return features;
  
  console.log(`🔗 Iniciando fusão de polígonos próximos (distância: ${distanciaMetros}m)...`);
  
  const merged = [];
  const processed = new Set();
  
  features.forEach((feature, i) => {
    if (processed.has(i)) return;
    
    // Lista de polígonos para mesclar com este
    const toMerge = [feature];
    processed.add(i);
    
    // Busca polígonos próximos
    features.forEach((otherFeature, j) => {
      if (i === j || processed.has(j)) return;
      
      try {
        // Calcula distância entre polígonos
        const distance = turf.distance(
          turf.centerOfMass(feature),
          turf.centerOfMass(otherFeature),
          { units: 'meters' }
        );
        
        // Se estão próximos, marca para fusão
        if (distance <= distanciaMetros) {
          toMerge.push(otherFeature);
          processed.add(j);
        }
      } catch {
        // Ignora erros de geometria inválida
      }
    });
    
    // Mescla os polígonos próximos
    if (toMerge.length === 1) {
      merged.push(feature);
    } else {
      try {
        // Aplica buffer pequeno para unir polígonos próximos
        const buffered = toMerge.map(f => turf.buffer(f, distanciaMetros / 1000, { units: 'kilometers' }));
        let union = buffered[0];
        
        for (let k = 1; k < buffered.length; k++) {
          try {
            union = turf.union(union, buffered[k]);
          } catch {
            console.warn('Erro ao unir polígonos');
          }
        }
        
        // Remove o buffer aplicado
        const debuffered = turf.buffer(union, -(distanciaMetros / 1000), { units: 'kilometers' });
        
        // Se gerou MultiPolygon, separa novamente
        if (debuffered.geometry.type === 'MultiPolygon') {
          debuffered.geometry.coordinates.forEach(coords => {
            const poly = turf.polygon(coords);
            if (turf.area(poly) >= CONFIG.minArea) {
              merged.push(poly);
            }
          });
        } else if (turf.area(debuffered) >= CONFIG.minArea) {
          merged.push(debuffered);
        }
      } catch {
        // Se falhar, mantém os polígonos originais
        toMerge.forEach(f => merged.push(f));
      }
    }
  });
  
  console.log(`✅ Fusão concluída: ${features.length} → ${merged.length} polígonos`);
  return merged;
}

// Aplicar threshold adaptativo em substituição ao threshold fixo
function aplicarThresholdAdaptativo(imageData) {
  const threshold = calcularThresholdOtsu(imageData);
  
  for (let i = 0; i < imageData.data.length; i += 4) {
    const val = imageData.data[i];
    const newVal = val > threshold ? 255 : 0;
    imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = newVal;
    imageData.data[i + 3] = 255;
  }
  
  return threshold;
}

function aplicarClusteringDBSCAN(imageData, width, height, options = {}) {
  const eps = Math.max(1, Number(options.eps) || 2.5);
  const minPts = Math.max(2, Number(options.minPts) || 6);
  const minClusterSize = Math.max(minPts, Number(options.minClusterSize) || 40);

  const data = imageData.data;
  const points = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx] > 200) {
        points.push({ x, y });
      }
    }
  }

  if (points.length === 0) {
    return {
      enabled: true,
      totalPoints: 0,
      keptPoints: 0,
      removedPoints: 0,
      clustersFound: 0,
      validClusters: 0,
      eps,
      minPts,
      minClusterSize
    };
  }

  const cellSize = eps;
  const radiusCells = Math.ceil(eps / cellSize);
  const eps2 = eps * eps;
  const grid = new Map();

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const gx = Math.floor(p.x / cellSize);
    const gy = Math.floor(p.y / cellSize);
    const key = `${gx},${gy}`;

    if (!grid.has(key)) {
      grid.set(key, []);
    }
    grid.get(key).push(i);
  }

  const labels = new Int32Array(points.length);
  labels.fill(-2); // -2: não visitado, -1: ruído, >=0: clusterId
  const clusterSizes = [];

  function regionQuery(index) {
    const p = points[index];
    const gx = Math.floor(p.x / cellSize);
    const gy = Math.floor(p.y / cellSize);
    const neighbors = [];

    for (let oy = -radiusCells; oy <= radiusCells; oy++) {
      for (let ox = -radiusCells; ox <= radiusCells; ox++) {
        const key = `${gx + ox},${gy + oy}`;
        const bucket = grid.get(key);
        if (!bucket) continue;

        for (let b = 0; b < bucket.length; b++) {
          const candidateIndex = bucket[b];
          const q = points[candidateIndex];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          if ((dx * dx + dy * dy) <= eps2) {
            neighbors.push(candidateIndex);
          }
        }
      }
    }

    return neighbors;
  }

  let clusterId = 0;
  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -2) continue;

    const neighbors = regionQuery(i);
    if (neighbors.length < minPts) {
      labels[i] = -1;
      continue;
    }

    labels[i] = clusterId;
    const queue = neighbors.slice();
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];

      if (labels[current] === -1) {
        labels[current] = clusterId;
      }

      if (labels[current] !== -2) {
        continue;
      }

      labels[current] = clusterId;
      const currentNeighbors = regionQuery(current);

      if (currentNeighbors.length >= minPts) {
        for (let n = 0; n < currentNeighbors.length; n++) {
          queue.push(currentNeighbors[n]);
        }
      }
    }

    clusterId++;
  }

  for (let i = 0; i < labels.length; i++) {
    if (labels[i] >= 0) {
      clusterSizes[labels[i]] = (clusterSizes[labels[i]] || 0) + 1;
    }
  }

  const validClusters = new Set();
  for (let id = 0; id < clusterSizes.length; id++) {
    if ((clusterSizes[id] || 0) >= minClusterSize) {
      validClusters.add(id);
    }
  }

  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }

  let keptPoints = 0;
  for (let i = 0; i < points.length; i++) {
    if (!validClusters.has(labels[i])) continue;
    const idx = (points[i].y * width + points[i].x) * 4;
    data[idx] = 255;
    data[idx + 1] = 255;
    data[idx + 2] = 255;
    keptPoints++;
  }

  return {
    enabled: true,
    totalPoints: points.length,
    keptPoints,
    removedPoints: points.length - keptPoints,
    clustersFound: clusterSizes.length,
    validClusters: validClusters.size,
    eps,
    minPts,
    minClusterSize
  };
}

function contarPixelsBrancos(imageData, threshold = 200) {
  let whitePixels = 0;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > threshold) whitePixels++;
  }
  return whitePixels;
}

function registrarRelatorioProcessamento(relatorio) {
  if (!relatorio) return;

  console.groupCollapsed('📊 Relatório de Processamento');
  console.log('ROI:', relatorio.roi);
  console.log('Parâmetros:', relatorio.parametros);
  if (relatorio.dbscan) {
    console.log('DBSCAN:', relatorio.dbscan);
  }
  console.table(relatorio.etapas);
  console.log('Resultado final:', relatorio.resultadoFinal);
  console.groupEnd();
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
    alert("❌ Erro crítico ao carregar o módulo de processamento\n\nO sistema de vetorização não pôde ser inicializado.\n\nDetalhes técnicos: " + e.message);
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
window.map = map; // Tornar acessível globalmente para edição de polígonos

// Mapa Google Satellite - cobertura confiável em altos zooms (não some)
const satelliteMap = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
  attribution: '&copy; Google Maps',
  maxZoom: 21,
  maxNativeZoom: 21,
  preferCanvas: true,
  crossOrigin: 'anonymous'
});
satelliteMap.addTo(map);

// CRÍTICO: Declarar drawnItems ANTES de usar nas customizações
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

// Customizar tamanho dos vértices de edição (Leaflet.Draw)
L.EditToolbar.Edit.include({
  options: {
    poly: {
      allowIntersection: false
    },
    featureGroup: drawnItems
  }
});

// Customizar tamanho dos marcadores de vértice
L.Edit.PolyVertexMarker.include({
  options: {
    touchRadius: 12,
    radius: 6
  }
});

// Tradução para português
L.drawLocal.draw.toolbar.buttons.polygon = 'Desenhar área';
L.drawLocal.draw.handlers.polygon.tooltip.start = 'Clique para começar a desenhar a área';
L.drawLocal.draw.handlers.polygon.tooltip.cont = 'Clique para continuar desenhando';
L.drawLocal.draw.handlers.polygon.tooltip.end = 'Clique no primeiro ponto para fechar';
L.drawLocal.draw.toolbar.actions.title = 'Cancelar desenho';
L.drawLocal.draw.toolbar.actions.text = 'Cancelar';
L.drawLocal.draw.toolbar.finish.title = 'Finalizar desenho';
L.drawLocal.draw.toolbar.finish.text = 'Concluir';
L.drawLocal.draw.toolbar.undo.title = 'Deletar último ponto';
L.drawLocal.draw.toolbar.undo.text = 'Desfazer';
L.drawLocal.edit.toolbar.actions.save.title = 'Salvar alterações';
L.drawLocal.edit.toolbar.actions.save.text = 'Salvar';
L.drawLocal.edit.toolbar.actions.cancel.title = 'Cancelar edição';
L.drawLocal.edit.toolbar.actions.cancel.text = 'Cancelar';
L.drawLocal.edit.toolbar.actions.clearAll.title = 'Limpar tudo';
L.drawLocal.edit.toolbar.actions.clearAll.text = 'Limpar';
L.drawLocal.edit.toolbar.buttons.edit = 'Editar camadas';
L.drawLocal.edit.toolbar.buttons.editDisabled = 'Sem camadas para editar';
L.drawLocal.edit.toolbar.buttons.remove = 'Deletar camadas';
L.drawLocal.edit.toolbar.buttons.removeDisabled = 'Sem camadas para deletar';

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

// --- LÓGICA PRINCIPAL ---
async function processarAreaDesenhada(bounds, selectionLayer) {
  loaderText.textContent = '📸 Capturando imagem da área selecionada...';
  loader.style.display = 'flex';
  activeRunId = gerarRunId();
  activeRunStartedAt = new Date().toISOString();

  // Usamos os bounds do polígono desenhado para a captura
  leafletImage(map, async (err, mainCanvas) => {
    if (err) {
      loader.style.display = 'none';
      drawnItems.removeLayer(selectionLayer); // Remove o polígono se a captura falhar
      alert("❌ Erro ao capturar imagem do mapa\n\n" + err.message);
      return;
    }

    // Recorta apenas a área selecionada para evitar distorção espacial
    const nwPoint = map.latLngToContainerPoint(bounds.getNorthWest());
    const sePoint = map.latLngToContainerPoint(bounds.getSouthEast());

    const cropX = Math.max(0, Math.floor(Math.min(nwPoint.x, sePoint.x)));
    const cropY = Math.max(0, Math.floor(Math.min(nwPoint.y, sePoint.y)));
    const cropW = Math.max(1, Math.min(mainCanvas.width - cropX, Math.ceil(Math.abs(sePoint.x - nwPoint.x))));
    const cropH = Math.max(1, Math.min(mainCanvas.height - cropY, Math.ceil(Math.abs(sePoint.y - nwPoint.y))));

    if (cropW < 10 || cropH < 10) {
      loader.style.display = 'none';
      drawnItems.removeLayer(selectionLayer);
      alert('⚠️ Área selecionada muito pequena para processamento.\n\nAmplie a seleção e tente novamente.');
      return;
    }

    const roiCanvas = document.createElement('canvas');
    roiCanvas.width = cropW;
    roiCanvas.height = cropH;
    const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });
    roiCtx.drawImage(mainCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    // Máscara da geometria desenhada (remove pixels fora do polígono de seleção)
    const maskPathCanvas = document.createElement('canvas');
    maskPathCanvas.width = cropW;
    maskPathCanvas.height = cropH;
    const maskPathCtx = maskPathCanvas.getContext('2d', { willReadFrequently: true });
    maskPathCtx.clearRect(0, 0, cropW, cropH);
    maskPathCtx.fillStyle = '#ffffff';
    maskPathCtx.beginPath();

    const latLngs = selectionLayer.getLatLngs();
    const ring = Array.isArray(latLngs[0]) ? latLngs[0] : latLngs;

    ring.forEach((latLng, idx) => {
      const p = map.latLngToContainerPoint(latLng);
      const x = p.x - cropX;
      const y = p.y - cropY;
      if (idx === 0) {
        maskPathCtx.moveTo(x, y);
      } else {
        maskPathCtx.lineTo(x, y);
      }
    });
    maskPathCtx.closePath();
    maskPathCtx.fill();

    const roiData = roiCtx.getImageData(0, 0, cropW, cropH);
    const polyMaskData = maskPathCtx.getImageData(0, 0, cropW, cropH);
    for (let i = 0; i < roiData.data.length; i += 4) {
      if (polyMaskData.data[i] < 10) {
        roiData.data[i] = 0;
        roiData.data[i + 1] = 0;
        roiData.data[i + 2] = 0;
      }
    }
    roiCtx.putImageData(roiData, 0, 0);

    const width = roiCanvas.width;
    const height = roiCanvas.height;
    const relatorio = {
      runId: activeRunId,
      roi: {
        width,
        height,
        areaPixels: width * height,
        cropX,
        cropY
      },
      parametros: {
        edgeThreshold: CONFIG.edgeThreshold,
        morphologySize: CONFIG.morphologySize,
        minArea: CONFIG.minArea,
        minQualityScore: CONFIG.minQualityScore,
        clusterEps: CONFIG.clusterEps,
        clusterMinPts: CONFIG.clusterMinPts,
        minClusterSize: CONFIG.minClusterSize,
        clusteringEnabled: CONFIG.clusteringEnabled
      },
      etapas: [],
      dbscan: null,
      resultadoFinal: null
    };

    // PRÉ-PROCESSAMENTO: aumenta contraste, aplica filtro de bordas e binariza
    const ctx = roiCtx;
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
    relatorio.etapas.push({
      etapa: 'Sobel',
      brancos: contarPixelsBrancos(sobelData)
    });
    ctx.putImageData(sobelData, 0, 0);

    // 3. Binarização com Threshold Adaptativo (Otsu)
    console.log('Aplicando threshold adaptativo (Otsu)...');
    let binData = ctx.getImageData(0, 0, width, height);
    const thresholdUsado = aplicarThresholdAdaptativo(binData);
    console.log(`Threshold adaptativo aplicado: ${thresholdUsado}`);
    relatorio.etapas.push({
      etapa: 'Otsu',
      threshold: thresholdUsado,
      brancos: contarPixelsBrancos(binData)
    });

    if (CONFIG.clusteringEnabled) {
      loaderText.textContent = 'Agrupando bordas (DBSCAN)...';
      await yieldToMain();

      const statsCluster = aplicarClusteringDBSCAN(binData, width, height, {
        eps: CONFIG.clusterEps,
        minPts: CONFIG.clusterMinPts,
        minClusterSize: CONFIG.minClusterSize
      });
      relatorio.dbscan = statsCluster;
      relatorio.etapas.push({
        etapa: 'DBSCAN',
        brancos: contarPixelsBrancos(binData),
        mantidos: statsCluster.keptPoints,
        removidos: statsCluster.removedPoints,
        clustersValidos: statsCluster.validClusters
      });

      console.log(
        `DBSCAN: ${statsCluster.totalPoints} pontos, ${statsCluster.keptPoints} mantidos, ` +
        `${statsCluster.removedPoints} removidos, ${statsCluster.validClusters}/${statsCluster.clustersFound} clusters válidos ` +
        `(eps=${statsCluster.eps}, minPts=${statsCluster.minPts}, minCluster=${statsCluster.minClusterSize})`
      );
    }

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
      maskCtx.drawImage(roiCanvas, 0, 0);
      
      console.log('Imagem com bordas detectadas copiada para máscara');
      
      // Verifica se a máscara tem pixels brancos
      let checkData = maskCtx.getImageData(0, 0, width, height);
      let whitePixels = contarPixelsBrancos(checkData);
      console.log(`Máscara com bordas: ${whitePixels} pixels brancos de ${width * height} total`);
      relatorio.etapas.push({
        etapa: 'MascaraInicial',
        brancos: whitePixels
      });

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

      checkData = maskCtx.getImageData(0, 0, width, height);
      relatorio.etapas.push({
        etapa: 'Morfologia',
        brancos: contarPixelsBrancos(checkData)
      });
      
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
      whitePixels = contarPixelsBrancos(checkData);
      console.log(`Após inversão: ${whitePixels} pixels brancos`);
      relatorio.etapas.push({
        etapa: 'Inversao',
        brancos: whitePixels
      });
      
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
        relatorio.resultadoFinal = {
          featuresWasm: geojsonResult.features?.length || 0,
          featuresAposFiltro: geojsonConvertido.features.length
        };
        try {
          await salvarRunAprendizado({
            runId: activeRunId,
            createdAt: activeRunStartedAt,
            finishedAt: new Date().toISOString(),
            config: { ...CONFIG },
            relatorio,
            bounds: {
              north: bounds.getNorth(),
              south: bounds.getSouth(),
              east: bounds.getEast(),
              west: bounds.getWest()
            },
            features: geojsonConvertido.features.map((f) => ({
              featureId: f.properties?.id,
              geometry: f.geometry,
              properties: f.properties,
              feedbackStatus: f.properties?.feedback_status || 'pendente',
              feedbackReason: f.properties?.feedback_reason || ''
            }))
          });
        } catch (err) {
          console.error('Erro ao salvar execução no banco local:', err);
        }
        registrarRelatorioProcessamento(relatorio);

        if (geojsonConvertido.features.length === 0) {
          console.warn('Nenhum polígono encontrado após vetorização WASM');
          alert("⚠️ Nenhuma edificação detectada\n\nNão foram encontradas construções na área selecionada.\n\nDicas:\n• Escolha uma área com edificações visíveis\n• Ajuste os parâmetros de sensibilidade\n• Reduza o score mínimo de qualidade");
          drawnItems.removeLayer(selectionLayer); // Remove o polígono de seleção manual
        } else {
          const poligonosVetorizados = L.geoJSON(geojsonConvertido, {
            style: function(feature) {
              return getStyleByQuality(feature);
            },
            onEachFeature: function(feature, layer) {
              layer.bindPopup(criarPopupFeedback(feature));
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
        alert("❌ Erro ao processar imagem\n\n" + e.message + "\n\nVerifique o console do navegador (F12) para mais detalhes.");
        drawnItems.removeLayer(selectionLayer);
      }

      loader.style.display = 'none';

    } catch (error) {
      console.error("Erro Fatal:", error);
      if (error.message && error.message.includes('O modelo não retornou um SVG limpo')) {
        alert("❌ Erro no processamento\n\nNão foi possível processar a área selecionada.\n\nTente:\n• Desenhar uma área diferente\n• Verificar se há edificações visíveis\n• Ajustar os parâmetros de detecção");
      } else {
        alert("❌ Erro: " + error.message);
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
            quality: qualityScore.score >= 70 ? 'alta' : qualityScore.score >= 40 ? 'media' : 'baixa',
            run_id: activeRunId,
            feedback_status: 'pendente',
            feedback_reason: ''
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
  
  // FUSÃO DE POLÍGONOS PRÓXIMOS (reduz fragmentação)
  const mesclados = CONFIG.mergeDistance > 0 
    ? mesclarPoligonosProximos(featuresFinais, CONFIG.mergeDistance)
    : featuresFinais;
  
  // Recalcula propriedades após fusão e reaplica filtros finais
  const finaisComPropriedades = mesclados.map((feature, idx) => {
    const area = turf.area(feature);
    const qualityScore = calcularScoreConfianca(feature);
    const propsAnteriores = feature.properties || {};
    
    feature.properties = {
      id: `imovel_${geojsonFeatures.length + idx + 1}`,
      area_m2: area.toFixed(2),
      confidence_score: qualityScore.score,
      compactness: qualityScore.compactness,
      vertices: qualityScore.vertices,
      quality: qualityScore.score >= 70 ? 'alta' : qualityScore.score >= 40 ? 'media' : 'baixa',
      run_id: propsAnteriores.run_id || activeRunId,
      feedback_status: propsAnteriores.feedback_status || 'pendente',
      feedback_reason: propsAnteriores.feedback_reason || ''
    };
    
    return feature;
  }).filter((feature) => {
    const area = Number(feature.properties.area_m2 || 0);
    const score = Number(feature.properties.confidence_score || 0);
    return area >= CONFIG.minArea && score >= CONFIG.minQualityScore;
  });
  
  console.log(`✅ Total final após fusão: ${finaisComPropriedades.length} polígonos`);
  return turf.featureCollection(finaisComPropriedades);
}


// --- EXPORTAÇÃO ---
async function exportarShapefile() {
  if (geojsonFeatures.length === 0) {
    alert("⚠️ Não há polígonos para exportar.\n\nDesenhe uma área no mapa e aguarde o processamento.");
    return;
  }

  console.log(`Iniciando exportação de ${geojsonFeatures.length} features`);
  console.log('Primeira feature:', geojsonFeatures[0]);
  
  const geojson = { type: "FeatureCollection", features: geojsonFeatures };
  console.log('GeoJSON completo:', geojson);
  
  const options = { folder: 'mapeamento_ia', types: { polygon: 'edificacoes' } };

  loaderText.textContent = '💾 Gerando arquivo Shapefile...';
  loader.style.display = 'flex';

  try {
    console.log('Verificando shpwrite:', typeof window.shpwrite);
    
    if (!window.shpwrite) {
      throw new Error('Biblioteca de exportação não foi carregada. Recarregue a página.');
    }
    
    console.log('Chamando shpwrite.zip...');
    const zipData = await window.shpwrite.zip(geojson, options);
    
    console.log('ZIP gerado, tipo:', typeof zipData);
    console.log('ZIP tamanho:', zipData ? zipData.byteLength || zipData.length : 'undefined');
    
    if (!zipData) {
      throw new Error('Não foi possível gerar o arquivo. Tente novamente.');
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
    alert(`✅ Exportação concluída!\n\n📦 ${geojsonFeatures.length} polígonos exportados no formato Shapefile.\n\nO arquivo foi salvo como 'mapeamento_edificacoes.zip'`);
  } catch (e) {
    console.error("Erro ao exportar:", e);
    console.error("Stack trace:", e.stack);
    alert("❌ Erro ao gerar arquivo Shapefile:\n\n" + e.message);
  } finally {
    loader.style.display = 'none';
  }
}

// Expõe para o botão do HTML
window.exportarShapefile = exportarShapefile;
window.exportarDatasetAprendizado = exportarDatasetAprendizado;
window.aplicarPreset = aplicarPreset;
window.resetarParametros = resetarParametros;
window.limparResultados = limparResultados;
window.marcarFeedbackPoligono = marcarFeedbackPoligono;