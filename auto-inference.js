// ==================== AUTO-INFERENCE MODULE ====================
// Auto-loads trained model and provides real-time parameter optimization
// with confidence scoring and false positive reduction

let modeloAutocarregado = null;
let metricsHistorico = [];
window.autoInferenceAtivo = false;
window.autoInferenceProvider = 'none';

const AZURE_ML_PROXY_PATH = '/api/ml-inference';

function normalizarPrediction(prediction = {}, provider = 'desconhecido') {
  const toNum = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const minArea = toNum(prediction.minAreaRecomendada, toNum(prediction.minAreaRecomendado, 15));
  const simplification = toNum(prediction.simplificationRecomendada, toNum(prediction.simplificationRecomendado, 0.00001));

  return {
    qualidadePredita: toNum(prediction.qualidadePredita, 0.5),
    edgeThresholdRecomendado: Math.round(toNum(prediction.edgeThresholdRecomendado, 90)),
    morphologySizeRecomendado: Math.max(1, Math.round(toNum(prediction.morphologySizeRecomendado, 5))),
    contrastBoostRecomendado: Number(toNum(prediction.contrastBoostRecomendado, 1.3).toFixed(3)),
    minAreaRecomendada: Number(minArea.toFixed(3)),
    simplificationRecomendada: Number(simplification.toFixed(6)),
    // Compatibilidade com nomenclatura alternativa
    minAreaRecomendado: Number(minArea.toFixed(3)),
    simplificationRecomendado: Number(simplification.toFixed(6)),
    provider: prediction.provider || provider,
    modelVersion: prediction.modelVersion || null,
    observacoes: Array.isArray(prediction.observacoes) ? prediction.observacoes : []
  };
}

async function inferirViaAzureProxy(configAtual, contexto = {}) {
  const response = await fetch(AZURE_ML_PROXY_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      configAtual,
      contexto
    })
  });

  const responseText = await response.text();
  let payload = null;

  try {
    payload = responseText ? JSON.parse(responseText) : null;
    if (typeof payload === 'string') {
      payload = JSON.parse(payload);
    }
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const details = payload?.details || payload?.error || responseText || `status ${response.status}`;
    throw new Error(`Azure proxy falhou: ${details}`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Azure proxy retornou payload inválido.');
  }

  return normalizarPrediction(payload, 'azure-ml');
}

async function probeAzureProxy() {
  try {
    const response = await fetch(AZURE_ML_PROXY_PATH, { method: 'GET' });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.available === true;
  } catch {
    return false;
  }
}

// Auto-load model on app startup
async function autocarregarModeloML() {
  try {
    let localDisponivel = false;
    const azureDisponivel = await probeAzureProxy();

    if (window.carregarModeloGlobalFirestore) {
      const modeloGlobal = await window.carregarModeloGlobalFirestore();
      if (modeloGlobal) {
        modeloAutocarregado = modeloGlobal;
        localDisponivel = true;
        console.log('✅ Modelo global auto-carregado para inferência');
      }
    }

    if (!localDisponivel && window.carregarModeloLocalStorage) {
      const modelo = await window.carregarModeloLocalStorage();
      if (modelo) {
        modeloAutocarregado = modelo;
        localDisponivel = true;
        console.log('✅ Modelo ML auto-carregado para inferência');
      }
    }

    window.autoInferenceAtivo = azureDisponivel || localDisponivel;
    window.autoInferenceProvider = azureDisponivel ? 'azure-ml' : (localDisponivel ? 'local-model' : 'none');

    if (!window.autoInferenceAtivo) {
      console.log('⚠️ Auto-inferência indisponível (sem Azure proxy e sem modelo local).');
    } else {
      console.log(`🤖 Auto-inferência ativa via ${window.autoInferenceProvider}`);
    }

    return window.autoInferenceAtivo;
  } catch (error) {
    window.autoInferenceAtivo = false;
    window.autoInferenceProvider = 'none';
    console.error('❌ Erro ao auto-carregar modelo:', error);
    return false;
  }
}

// Auto-infer optimal parameters for current settings
async function autoInferirParametros(configAtual, contexto = {}) {
  if (!window.autoInferenceAtivo) return null;

  try {
    const predictionAzure = await inferirViaAzureProxy(configAtual, contexto);
    if (predictionAzure) {
      window.autoInferenceProvider = 'azure-ml';
      return predictionAzure;
    }
  } catch (error) {
    console.warn('⚠️ Azure proxy indisponível, fallback para modelo local:', error?.message || error);
  }

  if (!modeloAutocarregado || !window.fazerPredictionML) {
    return null;
  }

  try {
    const predictionLocal = await window.fazerPredictionML(configAtual, contexto);
    if (predictionLocal) {
      window.autoInferenceProvider = 'local-model';
      return normalizarPrediction(predictionLocal, 'local-model');
    }
  } catch (error) {
    console.error('❌ Erro na auto-inferência local:', error);
  }

  return null;
}

// Post-processing com confiança do modelo
async function posProcessarComConfianca(features, modelPrediction) {
  if (!modelPrediction || !features || features.length === 0) {
    return features; // Retorna features não processadas
  }

  const confianca = Number(modelPrediction.qualidadePredita || 0);
  const processadas = [];

  features.forEach((feature) => {
    // Aplicar filtro de confiança
    const CONFIG = window.CONFIG || { minQualityScore: 35 };
    const minQualityScore = CONFIG.minQualityScore || 35;
    
    // Se confiança < 40%, aumentar threshold de qualidade
    if (confianca < 0.4) {
      if (feature.qualityScore < minQualityScore * 1.5) {
        console.log(`Feature: Rejeitada por baixa confiança do modelo (${(confianca * 100).toFixed(0)}%)`);
        return; // Rejeita
      }
    }

    // Se confiança > 70%, relaxar threshold
    if (confianca > 0.7) {
      if (feature.qualityScore >= minQualityScore * 0.8) {
        console.log(`Feature: Aprovada com confiança alta do modelo (${(confianca * 100).toFixed(0)}%)`);
        processadas.push(feature);
        return;
      }
    }

    // Caso normal: usar score original
    if (feature.qualityScore >= minQualityScore) {
      processadas.push(feature);
    }
  });

  console.log(`📊 Pós-processamento: ${features.length} → ${processadas.length} features (confiança: ${(confianca * 100).toFixed(0)}%)`);
  return processadas;
}

// Reduzir falsos positivos via ensemble voting
function reduzirFalsosPositivos(features) {
  if (!features || features.length < 2) return features;

  const consolidadas = [];
  const processados = new Set();

  features.forEach((feat1, i) => {
    if (processados.has(i)) return;

    let votoConfirmacao = 1; // O próprio feature conta como 1 voto
    const areaMinima = feat1.area * 0.8;
    const areaMaxima = feat1.area * 1.2;

    // Procurar features similares (agreement voting)
    features.forEach((feat2, j) => {
      if (i === j || processados.has(j)) return;

      // Se áreas parecidas e qualidade alta, aumentar votação
      if (feat2.area >= areaMinima && feat2.area <= areaMaxima &&
          feat2.qualityScore >= 60) {
        votoConfirmacao += 0.5;
      }
    });

    // Aprovar apenas se tiver "concordância" suficiente
    if (votoConfirmacao >= 1.5 || feat1.qualityScore >= 70) {
      consolidadas.push(feat1);
      processados.add(i);
    }
  });

  console.log(`🗳️ Ensemble voting: ${features.length} → ${consolidadas.length} features (falsos positivos reduzidos)`);
  return consolidadas;
}

// Aplicar auto-inferência no processamento de imagem
async function aplicarAutoInferenciaAoProcesamento(features) {
  if (!features || features.length === 0) {
    return features;
  }

  try {
    // 1. Auto-inferir parâmetros
    const configLocal = window.CONFIG || {};
    const prediction = await autoInferirParametros(configLocal, {
      presetProfile: configLocal.presetProfile || 'manual'
    });
    
    if (prediction && prediction.qualidadePredita > 0.5) {
      // 2. Pós-processar com confiança
      let processadas = await posProcessarComConfianca(features, prediction);
      
      // 3. Reduzir falsos positivos
      processadas = reduzirFalsosPositivos(processadas);
      
      // 4. Registrar métrica
      registrarMetricaAutoInferencia(features.length, processadas.length, prediction);
      
      return processadas;
    }
  } catch (error) {
    console.error('❌ Erro ao aplicar auto-inferência:', error);
  }

  return features; // Fallback: retorna features não processadas
}

// Registrar métrica de performance
function registrarMetricaAutoInferencia(totalAntes, totalDepois, prediction) {
  const metrica = {
    timestamp: new Date().toISOString(),
    totalAntes,
    totalDepois,
    reducao: ((1 - totalDepois / totalAntes) * 100).toFixed(1),
    confianca: (prediction.qualidadePredita * 100).toFixed(0),
    edgeThreshold: prediction.edgeThresholdRecomendado,
    morphologySize: prediction.morphologySizeRecomendado,
    provider: prediction.provider || window.autoInferenceProvider || 'desconhecido'
  };

  metricsHistorico.push(metrica);

  // Manter últimas 100 métricas
  if (metricsHistorico.length > 100) {
    metricsHistorico.shift();
  }

  console.log(`📊 Métrica: ${totalDepois}/${totalAntes} features, Redução: ${metrica.reducao}%, Confiança: ${metrica.confianca}%`);
}

// Obter métricas de performance
function obterMetricasAutoInferencia() {
  if (metricsHistorico.length === 0) {
    return null;
  }

  const total = metricsHistorico.length;
  const mediaReducao = (metricsHistorico.reduce((sum, m) => sum + parseFloat(m.reducao), 0) / total).toFixed(1);
  const mediaConfianca = (metricsHistorico.reduce((sum, m) => sum + parseFloat(m.confianca), 0) / total).toFixed(0);
  const ultimaMetrica = metricsHistorico[metricsHistorico.length - 1];

  return {
    totalProcessamentos: total,
    mediaReducaoFalsosPositivos: mediaReducao + '%',
    mediaConfiancaModelo: mediaConfianca + '%',
    ultimaMetrica,
    historicoCompleto: metricsHistorico
  };
}

// Exportar funções
window.autocarregarModeloML = autocarregarModeloML;
window.autoInferirParametros = autoInferirParametros;
window.posProcessarComConfianca = posProcessarComConfianca;
window.reduzirFalsosPositivos = reduzirFalsosPositivos;
window.aplicarAutoInferenciaAoProcesamento = aplicarAutoInferenciaAoProcesamento;
window.obterMetricasAutoInferencia = obterMetricasAutoInferencia;
