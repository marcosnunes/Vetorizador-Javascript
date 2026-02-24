// ==================== AUTO-INFERENCE MODULE ====================
// Auto-loads trained model and provides real-time parameter optimization
// with confidence scoring and false positive reduction

let modeloAutocarregado = null;
let metricsHistorico = [];
let autoInferenceAtivo = false;

// Auto-load model on app startup
async function autocarregarModeloML() {
  try {
    if (!window.carregarModeloLocalStorage) {
      console.warn('⚠️ ML module não carregado');
      return false;
    }

    const modelo = await window.carregarModeloLocalStorage();
    if (modelo) {
      modeloAutocarregado = modelo;
      autoInferenceAtivo = true;
      console.log('✅ Modelo ML auto-carregado para inferência');
      return true;
    } else {
      console.log('⚠️ Nenhum modelo salvo encontrado');
      return false;
    }
  } catch (error) {
    console.error('❌ Erro ao auto-carregar modelo:', error);
    return false;
  }
}

// Auto-infer optimal parameters for current settings
async function autoInferirParametros(configAtual) {
  if (!modeloAutocarregado || !autoInferenceAtivo) {
    return null;
  }

  try {
    const prediction = await window.fazerPredictionML(configAtual);
    if (prediction) {
      
      return prediction;
    }
  } catch (error) {
    console.error('❌ Erro na auto-inferência:', error);
  }

  return null;
}

// Post-processing com confiança do modelo
async function posProcessarComConfianca(features, modelPrediction) {
  if (!modelPrediction || !features || features.length === 0) {
    return features; // Retorna features não processadas
  }

  const confianca = modelPrediction.qualidadePredita;
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
  if (!autoInferenceAtivo || !features || features.length === 0) {
    return features;
  }

  try {
    // 1. Auto-inferir parâmetros
    const configLocal = window.CONFIG || {};
    const prediction = await autoInferirParametros(configLocal);
    
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
    morphologySize: prediction.morphologySizeRecomendado
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

// Toggle auto-inferência
function toggleAutoInferencia() {
  if (!modeloAutocarregado) {
    alert('⚠️ Nenhum modelo carregado!\n\nTreina um modelo primeiro.');
    return;
  }

  autoInferenceAtivo = !autoInferenceAtivo;
  
  const estado = autoInferenceAtivo ? '🤖 ATIVO' : '⚪ INATIVO';
  console.log(`Auto-Inferência: ${estado}`);
  
  if (window.mostrarNotificacao) {
    window.mostrarNotificacao(
      `Auto-Inferência ${autoInferenceAtivo ? 'ATIVADA ✅' : 'DESATIVADA ⚪'}`,
      autoInferenceAtivo ? 'success' : 'info'
    );
  }

  // Atualizar UI se existir
  const toggle = document.getElementById('auto-inference-toggle');
  if (toggle) {
    toggle.textContent = `${autoInferenceAtivo ? '✅' : '⚪'} Auto-Inferência`;
    toggle.style.background = autoInferenceAtivo ? '#10b981' : '#6c757d';
  }
}

// Exportar funções
window.autocarregarModeloML = autocarregarModeloML;
window.autoInferirParametros = autoInferirParametros;
window.posProcessarComConfianca = posProcessarComConfianca;
window.reduzirFalsosPositivos = reduzirFalsosPositivos;
window.aplicarAutoInferenciaAoProcesamento = aplicarAutoInferenciaAoProcesamento;
window.obterMetricasAutoInferencia = obterMetricasAutoInferencia;
window.toggleAutoInferencia = toggleAutoInferencia;
