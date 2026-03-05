// ==================== CONTINUOUS LEARNING MODULE ====================
// Auto-retrains model every 100 examples, tracks metrics, and provides REST API

import { exportarDatasetCompartilhadoFirestore } from './firestore-service.js';

let exemploColetados = 0;
let ultimoTreinamento = null;
let dashboardMetricas = {
  precision: 0,
  recall: 0,
  f1Score: 0,
  areaTotal: 0,
  tempoMedioProcessamento: 0,
  acuraciaQualidade: 0
};

const DATASET_COMPARTILHADO_CACHE_MS = 60000;
let ultimoDatasetCompartilhado = null;
let ultimoDatasetCompartilhadoAt = 0;

function obterRotuloFeedback(fb = {}) {
  return fb.label || fb.feedbackStatus || fb.status || fb.feedbackStatus || 'neutro';
}

function filtrarFeedbackElegivelTreino(feedback = []) {
  return feedback.filter((fb) => fb.trainingEligible !== false);
}

async function obterDatasetLocalTreino() {
  const idbGetAll = window.idbGetAll || (() => []);
  const runs = await idbGetAll('runs');
  const feedback = await idbGetAll('feedback');

  return {
    exportedAt: new Date().toISOString(),
    app: 'vetorizador-edificacoes',
    version: 'fase5-continuous-learning',
    source: 'indexeddb-local',
    runs,
    feedback,
    exemplosTotal: feedback.length
  };
}

async function obterDatasetTreinoCompartilhado({ forcarAtualizacao = false } = {}) {
  const agora = Date.now();
  const cacheValido =
    !forcarAtualizacao &&
    ultimoDatasetCompartilhado &&
    (agora - ultimoDatasetCompartilhadoAt) < DATASET_COMPARTILHADO_CACHE_MS;

  if (cacheValido) {
    return ultimoDatasetCompartilhado;
  }

  try {
    const datasetGlobal = await exportarDatasetCompartilhadoFirestore(400);
    const datasetNormalizado = {
      exportedAt: datasetGlobal.exportDate || new Date().toISOString(),
      app: 'vetorizador-edificacoes',
      version: 'fase5-continuous-learning-global',
      source: 'firestore-global-shared',
      runs: Array.isArray(datasetGlobal.runs) ? datasetGlobal.runs : [],
      feedback: Array.isArray(datasetGlobal.feedback) ? datasetGlobal.feedback : []
    };

    datasetNormalizado.exemplosTotal = datasetNormalizado.feedback.length;
    ultimoDatasetCompartilhado = datasetNormalizado;
    ultimoDatasetCompartilhadoAt = agora;
    return datasetNormalizado;
  } catch (error) {
    console.warn('⚠️ Falha ao obter dataset compartilhado, usando dataset local:', error?.message || error);
    const datasetLocal = await obterDatasetLocalTreino();
    ultimoDatasetCompartilhado = datasetLocal;
    ultimoDatasetCompartilhadoAt = agora;
    return datasetLocal;
  }
}

// ==================== PARTE 1: MONITORAMENTO CONTÍNUO ====================

// Atualizar contador de exemplos coletados
async function atualizarContagemExemplos() {
  try {
    const dataset = await obterDatasetTreinoCompartilhado();
    const feedback = Array.isArray(dataset.feedback) ? dataset.feedback : [];
    const feedbackElegivel = filtrarFeedbackElegivelTreino(feedback);
    exemploColetados = feedbackElegivel.length;
    
    console.log(`📊 Exemplos coletados: ${exemploColetados}`);
    console.log(`📦 Dados feedback recuperados: total=${feedback.length}, elegiveis=${feedbackElegivel.length}, origem=${dataset.source || 'desconhecida'}`);

    // ✨ Atualizar UI da barra de progresso
    atualizarUIAprendizadoContinuo(exemploColetados);

    // Se atingiu 100 exemplos, sugerir retreinamento
    if (exemploColetados % 100 === 0 && exemploColetados > 0) {
      console.log(`🎉 MARCO: ${exemploColetados} exemplos coletados!`);
      sugerirRetreinar();
    }

    return exemploColetados;
  } catch (error) {
    console.error('❌ Erro ao atualizar contagem:', error);
    return 0;
  }
}

// ✨ NOVA FUNÇÃO: Atualizar UI com progresso de aprendizado contínuo
function atualizarUIAprendizadoContinuo(exemplos) {
  const elementoContagem = document.getElementById('exemplosColetados');
  const elementoBarra = document.getElementById('progressoAprendizado');
  const btnTreinarAgora = document.getElementById('btnTreinarAgora');
  
  if (!elementoContagem || !elementoBarra) return;

  // Atualizar texto de contagem
  elementoContagem.textContent = exemplos;
  
  // Calcular progresso (0-100)
  const progresso = Math.min(100, (exemplos % 100));
  const percentual = (progresso / 100) * 100;
  
  // Atualizar barra visual
  elementoBarra.style.width = percentual + '%';
  
  // Se tiver conteúdo, mostrar o número
  if (percentual > 15) {
    elementoBarra.textContent = Math.round(progresso) + '/100';
  } else {
    elementoBarra.textContent = '';
  }

  // Mostrar botão "Treinar Agora" quando atingir 100
  if (exemplos > 0 && exemplos % 100 === 0) {
    if (btnTreinarAgora) {
      btnTreinarAgora.style.display = 'block';
      btnTreinarAgora.textContent = `⚡ Treinar Modelo Agora (${exemplos} exemplos atingidos!)`;
    }
  } else {
    if (btnTreinarAgora) {
      btnTreinarAgora.style.display = 'none';
    }
  }
}


// Sugerir retreinamento automático
function sugerirRetreinar() {
  const mensagem = `
🎉 Você atingiu ${exemploColetados} exemplos de treinamento!

Quer treinar uma nova versão do modelo?
- Melhor precisão com mais dados
- Auto-ajuste de parâmetros mais confiável
- Próxima sugestão: ${exemploColetados + 100} exemplos

OK = Treinar agora
Cancelar = Treinar depois
  `;

  const treinar = confirm(mensagem);
  if (treinar) {
    executarRetreninamentoAutomatico();
  }
}

// Retreinamento automático
async function executarRetreninamentoAutomatico() {
  if (exemploColetados < 10) {
    alert('⚠️ Mínimo 10 exemplos necessários para retreinar');
    return;
  }

  const loader = document.getElementById('loader-overlay');
  const loaderText = document.getElementById('loader-text');
  if (loader) loader.style.display = 'flex';
  if (loaderText) loaderText.textContent = '🔄 Retreinando modelo com novos dados...\n\nIsso pode levar 30-60 segundos...';

  try {
    const dataset = await obterDatasetTreinoCompartilhado({ forcarAtualizacao: true });

    // Retreinar modelo
    const sucesso = await window.treinarModeloML(dataset);
    
    if (sucesso) {
      ultimoTreinamento = {
        timestamp: new Date().toISOString(),
        exemplosUsados: exemploColetados,
        versao: Math.floor(new Date().getTime() / 1000)
      };

      // Salvar checkpoint da versão
      const idbSet = window.idbSet || (() => {});
      await idbSet('model-versions', ultimoTreinamento.versao.toString(), ultimoTreinamento);

      console.log('✅ Retreinamento concluído com sucesso!');
      
      if (loader) loader.style.display = 'none';
      if (window.mostrarNotificacao) {
        window.mostrarNotificacao(
          `✅ Modelo retreinado com ${exemploColetados} exemplos (${dataset.source || 'dataset compartilhado'})!`,
          'success'
        );
      }
    }
  } catch (error) {
    if (loader) loader.style.display = 'none';
    console.error('❌ Erro no retreinamento:', error);
    alert('❌ Erro ao retreinar: ' + error.message);
  }
}

// ==================== PARTE 2: CÁLCULO DE MÉTRICAS ====================

// Calcular precision/recall/F1 score
function calcularMetricasQualidade(feedbackData) {
  if (!feedbackData || feedbackData.length === 0) {
    return null;
  }

  try {
    // Verdadeiros positivos: features aprovadas com qualidade alta
    const tp = feedbackData.filter(fb => 
      (obterRotuloFeedback(fb) === 'aprovado' || obterRotuloFeedback(fb) === 'correto') && fb.finalQualityScore >= 70
    ).length;

    // Falsos positivos: features rejeitadas mas marcadas como boas
    const fp = feedbackData.filter(fb => 
      obterRotuloFeedback(fb) === 'rejeitado' && fb.finalQualityScore >= 60
    ).length;

    // Falsos negativos: features rejeitadas mas deveriam ser aceitas
    const fn = feedbackData.filter(fb => 
      obterRotuloFeedback(fb) === 'rejeitado' && String(fb.feedbackReason || fb.feedback || '').includes('deveria')
    ).length;

    // Verdadeiros negativos: features rejeitadas corretamente
    const tn = feedbackData.filter(fb => 
      obterRotuloFeedback(fb) === 'rejeitado' && fb.finalQualityScore < 60
    ).length;

    const precision = tp / (tp + fp) || 0;
    const recall = tp / (tp + fn) || 0;
    const f1 = 2 * (precision * recall) / (precision + recall) || 0;
    const acuracia = (tp + tn) / (tp + tn + fp + fn) || 0;

    return {
      precision: (precision * 100).toFixed(1) + '%',
      recall: (recall * 100).toFixed(1) + '%',
      f1Score: (f1 * 100).toFixed(1) + '%',
      acuracia: (acuracia * 100).toFixed(1) + '%',
      tp, fp, fn, tn,
      total: feedbackData.length
    };
  } catch (error) {
    console.error('❌ Erro ao calcular métricas:', error);
    return null;
  }
}

// Confirmar e atualizar métricas do dashboard
async function atualizarDashboardMetricas() {
  try {
    // Obter feedback para cálculo de métricas
    const idbGetAll = window.idbGetAll || (() => []);
    const feedback = await idbGetAll('feedback');
    const feedbackElegivel = filtrarFeedbackElegivelTreino(feedback);
    const runs = await idbGetAll('runs');

    if (feedbackElegivel.length === 0) {
      console.log('⚠️ Sem dados de feedback para calcular métricas');
      return null;
    }

    // Calcular qualidade
    const metricas = calcularMetricasQualidade(feedbackElegivel);
    
    if (metricas) {
      dashboardMetricas.precision = metricas.precision;
      dashboardMetricas.recall = metricas.recall;
      dashboardMetricas.f1Score = metricas.f1Score;
      dashboardMetricas.acuraciaQualidade = metricas.acuracia;

      // Calcular área total processada
      let areaTotal = 0;
      runs.forEach(run => {
        if (run.features) {
          run.features.forEach(feat => {
            areaTotal += feat.area || 0;
          });
        }
      });
      dashboardMetricas.areaTotal = areaTotal.toFixed(2) + ' m²';

      // Tempo médio (simular baseado em quantidade)
      dashboardMetricas.tempoMedioProcessamento = (runs.length > 0 ? 2.5 : 0) + 's';

      console.log('✅ Métricas do dashboard atualizadas:', dashboardMetricas);
    }

    return dashboardMetricas;
  } catch (error) {
    console.error('❌ Erro ao atualizar métricas:', error);
    return null;
  }
}

// Obter dashboard completo
async function obterDashboardCompleto() {
  await atualizarContagemExemplos();
  await atualizarDashboardMetricas();

  const autoInferenciasMetricas = window.obterMetricasAutoInferencia?.();
  const relatorioLimpezaML = window.obterRelatorioLimpezaML?.() || null;

  return {
    timestamp: new Date().toISOString(),
    fase: 'Phase 5 - Continuous Learning',
    exemplos: {
      coletados: exemploColetados,
      proximoMarcao: Math.ceil((exemploColetados + 1) / 100) * 100
    },
    ultimoTreinamento,
    metricas: dashboardMetricas,
    autoInferencia: autoInferenciasMetricas || null,
    higieneDatasetML: relatorioLimpezaML,
    statusGeral: {
      fase: 'contínuo',
      ativo: true,
      progresso: exemploColetados
    }
  };
}

// ==================== PARTE 3: API REST PARA INTEGRAÇÃO ====================

// Criar servidor REST (simulado - para integração com sistemas corporativos)
const APIEndpoints = {
  // GET /api/modelo/status
  obterStatusModelo: async function() {
    return {
      status: 'ativo',
      versao: ultimoTreinamento?.versao || 'não-treinado',
      exemplosUsados: exemploColetados,
      autoInferencia: window.autoInferenceAtivo || false,
      ultimoTreinamento,
      timestamp: new Date().toISOString()
    };
  },

  // GET /api/metricas/dashboard
  obterMetricasDashboard: async function() {
    return await obterDashboardCompleto();
  },

  // GET /api/metricas/historico
  obterHistoricoMetricas: async function(limit = 50) {
    const autoInferencias = window.metricsHistorico || [];
    return {
      totalRegistros: autoInferencias.length,
      registros: autoInferencias.slice(-limit),
      timestamp: new Date().toISOString()
    };
  },

  // POST /api/vetorizar (com auto-inferência)
  vetorizarComAutoInferencia: async function(imageData, configOverride = null) {
    try {
      const configLocal = window.CONFIG || {};
      
      // Aplicar config override se fornecido
      if (configOverride) {
        Object.assign(configLocal, configOverride);
      }

      // Auto-inferir parâmetros
      const prediction = await window.autoInferirParametros(configLocal);
      
      if (prediction && window.autoInferenceAtivo) {
        // Aplicar predição automática
        configLocal.edgeThreshold = prediction.edgeThresholdRecomendado;
        configLocal.morphologySize = prediction.morphologySizeRecomendado;
        // ... outros parâmetros
      }

      // Processar imagem (aqui entraria o algoritmo real de vetorização)
      const resultado = {
        sucesso: true,
        timestamp: new Date().toISOString(),
        configUsada: configLocal,
        prediction: prediction || null,
        aviso: 'Simulated - use app.js processarImagem() para vetorização real'
      };

      return resultado;
    } catch (error) {
      return {
        sucesso: false,
        erro: error.message
      };
    }
  },

  // POST /api/feedback/registrar
  registrarFeedback: async function(featureId, label, minhasAnotacoes = '') {
    const feedback = {
      timestamp: new Date().toISOString(),
      featureId,
      label,
      anotacoes: minhasAnotacoes,
      confiancaModelo: (window && window.ultimaPrediction) ? window.ultimaPrediction.qualidadePredita : null
    };

    try {
      const idbSet = window.idbSet || (() => {});
      await idbSet('feedback', featureId + '_' + Date.now(), feedback);
      await atualizarContagemExemplos();
      return { sucesso: true, feedback };
    } catch (error) {
      return { sucesso: false, erro: error.message };
    }
  },

  // GET /api/export/dataset
  exportarDatasetParaIntegracao: async function() {
    try {
      const idbGetAll = window.idbGetAll || (() => []);
      const runs = await idbGetAll('runs');
      const feedback = await idbGetAll('feedback');

      return {
        sucesso: true,
        dataset: {
          timestamp: new Date().toISOString(),
          versao: '1.0',
          totalRuns: runs.length,
          totalFeedback: feedback.length,
          runs,
          feedback,
          metricas: dashboardMetricas
        }
      };
    } catch (error) {
      return { sucesso: false, erro: error.message };
    }
  },

  // GET /api/modelo/recomendacoes
  obterRecomendacoes: async function() {
    const idbGetAll = window.idbGetAll || (() => []);
    const feedback = await idbGetAll('feedback');
    const pendentes = feedback.filter(fb => fb.label === 'editado').length;
    const rejeitadas = feedback.filter(fb => fb.label === 'rejeitado').length;
    const relatorioLimpezaML = window.obterRelatorioLimpezaML?.() || null;

    let recomendacoes = [];

    if (exemploColetados >= 100 && exemploColetados % 100 === 0) {
      recomendacoes.push({
        tipo: 'retreinar',
        prioridade: 'alta',
        mensagem: `${exemploColetados} exemplos coletados. Considere retreinar o modelo.`
      });
    }

    if (rejeitadas > pendentes * 2) {
      recomendacoes.push({
        tipo: 'revisar-parametros',
        prioridade: 'média',
        mensagem: `Taxa de rejeição alta (${rejeitadas}). Revise os parâmetros CV.`
      });
    }

    if (exemploColetados < 50) {
      recomendacoes.push({
        tipo: 'coletar-mais',
        prioridade: 'média',
        mensagem: `Apenas ${exemploColetados} exemplos. Recomenda-se 100+ para melhor performance.`
      });
    }

    if (relatorioLimpezaML?.totalRemovidos > 0) {
      recomendacoes.push({
        tipo: 'higiene-dataset',
        prioridade: relatorioLimpezaML.totalRemovidos > 20 ? 'alta' : 'média',
        mensagem: `Autolimpeza removeu ${relatorioLimpezaML.totalRemovidos} exemplo(s) suspeito(s) no último treino (${relatorioLimpezaML.taxaRemocao}).`
      });
    }

    return {
      timestamp: new Date().toISOString(),
      recomendacoes,
      exemplosAtuais: exemploColetados,
      higieneDatasetML: relatorioLimpezaML
    };
  }
};

// ==================== PARTE 4: INICIALIZAÇÃO AUTOMÁTICA ====================

// Inicializar Phase 5 na startup
async function inicializarPhase5() {
  console.log('🚀 Iniciando Phase 5: Continuous Learning Loop...');
  
  try {
    // 1. Atualizar contagem de exemplos
    await atualizarContagemExemplos();
    
    // 2. Atualizar métricas
    await atualizarDashboardMetricas();
    
    // 3. Restaurar último treinamento
    try {
      const idbGetAll = window.idbGetAll || (() => []);
      const versoes = await idbGetAll('model-versions');
      if (versoes.length > 0) {
        ultimoTreinamento = versoes[versoes.length - 1];
      }
    } catch {
      console.log('⚠️ Sem histórico de treinamentos');
    }

    console.log('✅ Phase 5 inicializado com sucesso');
    console.log(`📊 Exemplos coletados: ${exemploColetados}`);
    console.log('📈 Métricas disponíveis via API');

    return true;
  } catch (error) {
    console.error('❌ Erro ao inicializar Phase 5:', error);
    return false;
  }
}

// ==================== EXPORTAR FUNÇÕES ====================

window.atualizarContagemExemplos = atualizarContagemExemplos;
window.atualizarUIAprendizadoContinuo = atualizarUIAprendizadoContinuo;
window.executarRetreninamentoAutomatico = executarRetreninamentoAutomatico;
window.obterDashboardCompleto = obterDashboardCompleto;
window.calcularMetricasQualidade = calcularMetricasQualidade;
window.atualizarDashboardMetricas = atualizarDashboardMetricas;
window.APIEndpoints = APIEndpoints;
window.inicializarPhase5 = inicializarPhase5;

