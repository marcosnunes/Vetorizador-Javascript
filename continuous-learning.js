// ==================== CONTINUOUS LEARNING MODULE ====================
// Auto-retrains model every 50 examples, tracks metrics, and provides REST API

import { exportarDatasetCompartilhadoFirestore, contarFeedbackGlobalElegivelFirestore } from './firestore-service.js';

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
const TRAINING_BATCH_SIZE = 50;
const DATASET_GLOBAL_MAX_RUNS = 120;
const FIRESTORE_QUOTA_BACKOFF_MS = 30 * 60 * 1000;
const CLOUD_COUNT_CACHE_MS = 5 * 60 * 1000;
const UX_COUNT_REFRESH_INTERVAL_MS = 60 * 1000;
const UX_COUNT_MIN_GAP_MS = 5000;
const RETREINO_PENDENTE_QUOTA_KEY = 'vetorizador_retreino_pendente_quota_v1';
const RETREINO_PROMPT_COOLDOWN_MS = 10 * 60 * 1000;
let ultimoDatasetCompartilhado = null;
let ultimoDatasetCompartilhadoAt = 0;
let firestoreQuotaBackoffAte = 0;
let ultimoTotalNuvemTotal = null;
let ultimoResumoNuvem = null;
let ultimoResumoNuvemAt = 0;
let quotaExcedidaAtiva = false;
let retreinoPendentePorQuota = null;
let atualizacaoContagemEmAndamento = false;
let ultimoRefreshContagemAt = 0;
let monitoramentoContagemIniciado = false;

function isQuotaExceededError(error) {
    const code = String(error ?.code || '').toLowerCase();
    const message = String(error ?.message || '').toLowerCase();
    return (
        error ?.isQuotaExceeded === true ||
        code.includes('resource-exhausted') ||
        message.includes('quota exceeded') ||
        message.includes('resource_exhausted')
    );
}

function obterRotuloFeedback(fb = {}) {
    return fb.label || fb.feedbackStatus || fb.status || fb.feedbackStatus || 'neutro';
}

function filtrarFeedbackElegivelTreino(feedback = []) {
    return feedback.filter((fb) => fb.trainingEligible !== false);
}

function carregarRetreinoPendentePorQuota() {
    try {
        const raw = localStorage.getItem(RETREINO_PENDENTE_QUOTA_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

function salvarRetreinoPendentePorQuota(payload = null) {
    try {
        if (!payload) {
            localStorage.removeItem(RETREINO_PENDENTE_QUOTA_KEY);
            retreinoPendentePorQuota = null;
            return;
        }

        retreinoPendentePorQuota = payload;
        localStorage.setItem(RETREINO_PENDENTE_QUOTA_KEY, JSON.stringify(payload));
    } catch {
        retreinoPendentePorQuota = payload;
    }
}

function marcarRetreinoPendentePorQuota(exemplosUsados = 0) {
    const payload = {
        createdAt: Date.now(),
        lastPromptAt: 0,
        exemplosUsados,
        motivo: 'treino-parcial-por-cota'
    };
    salvarRetreinoPendentePorQuota(payload);
}

function tentarNotificarRetreinoPosQuota({ quotaAtiva = false } = {}) {
    if (quotaAtiva || !retreinoPendentePorQuota) return;

    const agora = Date.now();
    const ultimoPrompt = Number(retreinoPendentePorQuota.lastPromptAt || 0);
    if ((agora - ultimoPrompt) < RETREINO_PROMPT_COOLDOWN_MS) {
        return;
    }

    const exemplosBase = Number(retreinoPendentePorQuota.exemplosUsados || exemploColetados || 0);
    if (window.mostrarNotificacao) {
        window.mostrarNotificacao(
            '🌐 Cota da nuvem normalizada. Recomenda-se retreinar para incorporar o dataset global.',
            'info'
        );
    }

    const confirmar = confirm(
        `🌐 A cota do Firestore normalizou.\n\n` +
        `O último treino foi limitado por indisponibilidade temporária da nuvem.\n` +
        `Deseja retreinar agora usando dados da nuvem?\n\n` +
        `Base parcial anterior: ${exemplosBase} exemplos.`
    );

    if (confirmar) {
        salvarRetreinoPendentePorQuota(null);
        executarRetreninamentoAutomatico();
        return;
    }

    salvarRetreinoPendentePorQuota({
        ...retreinoPendentePorQuota,
        lastPromptAt: agora
    });
}

async function obterResumoNuvem({ forcarAtualizacao = false } = {}) {
    const agora = Date.now();
    const cacheValido = !forcarAtualizacao &&
        ultimoResumoNuvem &&
        (agora - ultimoResumoNuvemAt) < CLOUD_COUNT_CACHE_MS;

    if (cacheValido) {
        return ultimoResumoNuvem;
    }

    try {
        const resumo = await contarFeedbackGlobalElegivelFirestore();
        ultimoResumoNuvem = resumo;
        ultimoResumoNuvemAt = agora;
        return resumo;
    } catch {
        // Mantém último valor conhecido quando a leitura falhar pontualmente.
        return ultimoResumoNuvem;
    }
}

function atualizarResumoOrigemUI({ nuvemTotal = null, quotaAtiva = false, minutosRestantes = 0 } = {}) {
    const elementoNuvem = document.getElementById('exemplosNuvem');
    const avisoQuota = document.getElementById('quotaAvisoFirestore');

    if (elementoNuvem) {
        const nuvemDisponivel = Number.isFinite(nuvemTotal);
        elementoNuvem.textContent = nuvemDisponivel ? String(nuvemTotal) : '—';
        elementoNuvem.style.color = nuvemDisponivel ? '#0f766e' : '#9ca3af';
        elementoNuvem.style.fontStyle = 'normal';
    }

    if (!avisoQuota) return;

    if (quotaAtiva) {
        avisoQuota.style.display = 'block';
        avisoQuota.textContent = `⚠️ Firestore temporariamente indisponível${minutosRestantes > 0 ? ` (${minutosRestantes} min)` : ''}.`;
    } else {
        avisoQuota.style.display = 'none';
        avisoQuota.textContent = '';
    }
}

function atualizarPainelArquiteturaIA() {
    const elInference = document.getElementById('aiInferenceSource');
    const elLearning = document.getElementById('aiLearningStore');
    const elMode = document.getElementById('aiArchitectureMode');
    const elSummary = document.getElementById('aiFlowSummary');

    if (!elInference || !elLearning || !elMode || !elSummary) return;

    const status = window.obterStatusArquiteturaIA ?.() || {};
    const provider = String(status.inferenceProvider || window.autoInferenceProvider || 'none');
    const mode = String(status.architectureMode || 'hibrido');
    const details = String(status.details || '').trim();

    const mapProviderLabel = {
        'azure-ml': 'Azure ML',
        'local-model': 'Modelo local',
        none: 'Indisponível'
    };

    const mapModeLabel = {
        hibrido: 'Híbrido',
        'azure-only': 'Azure-only',
        'local-only': 'Local-only',
        indisponivel: 'Indisponível'
    };

    elInference.textContent = mapProviderLabel[provider] || provider;
    elMode.textContent = mapModeLabel[mode] || mode;
    elLearning.textContent = 'Firestore';

    elInference.className = `ai-badge ${provider === 'azure-ml' ? 'ai-badge-azure' : (provider === 'local-model' ? 'ai-badge-local' : 'ai-badge-neutral')}`;
    elMode.className = `ai-badge ${mode === 'hibrido' ? 'ai-badge-hybrid' : (mode === 'azure-only' ? 'ai-badge-azure' : (mode === 'local-only' ? 'ai-badge-local' : 'ai-badge-neutral'))}`;
    elLearning.className = 'ai-badge ai-badge-firestore';

    const resumoPadrao =
        'Híbrido: Azure ML para inferência online com fallback local; Firestore para feedback e contagem de exemplos.';
    elSummary.textContent = details || resumoPadrao;
}

async function obterDatasetTreinoCompartilhado({ forcarAtualizacao = false } = {}) {
    const agora = Date.now();
    const cacheValido = !forcarAtualizacao &&
        ultimoDatasetCompartilhado &&
        (agora - ultimoDatasetCompartilhadoAt) < DATASET_COMPARTILHADO_CACHE_MS;

    if (cacheValido) {
        return ultimoDatasetCompartilhado;
    }

    if (agora < firestoreQuotaBackoffAte) {
        const minutosRestantes = Math.ceil((firestoreQuotaBackoffAte - agora) / 60000);
        console.warn(`⚠️ Firestore em cooldown por cota (${minutosRestantes} min restantes).`);
        quotaExcedidaAtiva = true;
        throw new Error(`Firestore em cooldown por cota (${minutosRestantes} min restantes).`);
    }

    try {
        const datasetGlobal = await exportarDatasetCompartilhadoFirestore(DATASET_GLOBAL_MAX_RUNS);
        const datasetNormalizado = {
            exportedAt: datasetGlobal.exportDate || new Date().toISOString(),
            app: 'vetorizador-edificacoes',
            version: 'fase5-continuous-learning-global',
            source: 'firestore-global-shared',
            runs: Array.isArray(datasetGlobal.runs) ? datasetGlobal.runs : [],
            feedback: Array.isArray(datasetGlobal.feedback) ? datasetGlobal.feedback : []
        };

        datasetNormalizado.exemplosTotal = datasetNormalizado.feedback.length;
        quotaExcedidaAtiva = false;
        firestoreQuotaBackoffAte = 0;
        ultimoDatasetCompartilhado = datasetNormalizado;
        ultimoDatasetCompartilhadoAt = agora;
        return datasetNormalizado;
    } catch (error) {
        if (isQuotaExceededError(error)) {
            firestoreQuotaBackoffAte = agora + FIRESTORE_QUOTA_BACKOFF_MS;
            quotaExcedidaAtiva = true;
            console.warn('⏱️ Quota do Firestore excedida. Retreinamento cloud-only ficará temporariamente indisponível.');
        }
        throw error;
    }
}

// ==================== PARTE 1: MONITORAMENTO CONTÍNUO ====================

// Atualizar contador de exemplos coletados
async function atualizarContagemExemplos() {
    const agoraInicio = Date.now();
    if (atualizacaoContagemEmAndamento) {
        return exemploColetados;
    }
    if ((agoraInicio - ultimoRefreshContagemAt) < UX_COUNT_MIN_GAP_MS) {
        return exemploColetados;
    }

    atualizacaoContagemEmAndamento = true;

    try {
        if (!retreinoPendentePorQuota) {
            retreinoPendentePorQuota = carregarRetreinoPendentePorQuota();
        }

        // Contagem canônica para exibição: sempre vem direto do Firestore
        const resumoNuvem = await obterResumoNuvem();
        const nuvemOk = Number.isFinite(resumoNuvem?.total);
        if (nuvemOk) {
            ultimoTotalNuvemTotal = resumoNuvem.total;
            exemploColetados = resumoNuvem.total;
        } else if (Number.isFinite(ultimoTotalNuvemTotal)) {
            exemploColetados = ultimoTotalNuvemTotal;
        }

        const quotaAtiva = !nuvemOk && !Number.isFinite(ultimoTotalNuvemTotal);
        const minutosRestantes = 0;

        // Exibição: usa sempre o último total confirmado da nuvem.
        // Se a leitura falhar pontualmente, mantém valor anterior para evitar falso "indisponível".
        const exemplosExibicao = Number.isFinite(ultimoTotalNuvemTotal) ? ultimoTotalNuvemTotal : 0;

        atualizarResumoOrigemUI({
            nuvemTotal: Number.isFinite(ultimoTotalNuvemTotal) ? ultimoTotalNuvemTotal : null,
            quotaAtiva,
            minutosRestantes
        });
        atualizarPainelArquiteturaIA();

        tentarNotificarRetreinoPosQuota({ quotaAtiva });

        console.log(`📊 Exemplos na nuvem: ${ultimoTotalNuvemTotal ?? '?'} | leituraNuvemOK=${nuvemOk}`);

        // ✨ Atualizar UI da barra de progresso
        atualizarUIAprendizadoContinuo(exemplosExibicao);

        // Se atingiu o lote de treino, sugerir retreinamento
        if (exemplosExibicao % TRAINING_BATCH_SIZE === 0 && exemplosExibicao > 0) {
            console.log(`🎉 MARCO: ${exemplosExibicao} exemplos coletados!`);
            sugerirRetreinar();
        }

        return exemplosExibicao;
    } catch (error) {
        console.error('❌ Erro ao atualizar contagem:', error);
        return 0;
    } finally {
        atualizacaoContagemEmAndamento = false;
        ultimoRefreshContagemAt = Date.now();
    }
}

// ✨ NOVA FUNÇÃO: Atualizar UI com progresso de aprendizado contínuo
function atualizarUIAprendizadoContinuo(exemplos) {
    const elementoDescricaoObjetivo = document.getElementById('descricaoObjetivoAprendizado');
    const elementoBarra = document.getElementById('progressoAprendizado');
    const btnTreinarAgora = document.getElementById('btnTreinarAgora');

    if (!elementoBarra) return;

    if (elementoDescricaoObjetivo) {
        elementoDescricaoObjetivo.textContent = 'Objetivo: 50 exemplos para próximo retreinamento';
    }

    // Calcular progresso (0-100%) para o lote de treino atual
    const progresso = Math.min(TRAINING_BATCH_SIZE, (exemplos % TRAINING_BATCH_SIZE));
    const percentual = (progresso / TRAINING_BATCH_SIZE) * 100;

    // Atualizar barra visual
    elementoBarra.style.width = percentual + '%';

    // Se tiver conteúdo, mostrar o número
    if (percentual > 15) {
        elementoBarra.textContent = Math.round(progresso) + `/${TRAINING_BATCH_SIZE}`;
    } else {
        elementoBarra.textContent = '';
    }

    // Mostrar botão "Treinar Agora" quando atingir o lote de treino.
    if (exemplos > 0 && exemplos % TRAINING_BATCH_SIZE === 0) {
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
- Próxima sugestão: ${exemploColetados + TRAINING_BATCH_SIZE} exemplos

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
        const treinoParcialPorQuota = quotaExcedidaAtiva;

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
                    `✅ Modelo retreinado com ${exemploColetados} exemplos (nuvem)!`,
                    'success'
                );
            }

            if (treinoParcialPorQuota) {
                marcarRetreinoPendentePorQuota(exemploColetados);
                if (window.mostrarNotificacao) {
                    window.mostrarNotificacao(
                        '⚠️ Treino parcial por cota. Quando a nuvem normalizar, vamos recomendar um novo retreino.',
                        'warning'
                    );
                }
            } else {
                salvarRetreinoPendentePorQuota(null);
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
            tp,
            fp,
            fn,
            tn,
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

    const autoInferenciasMetricas = window.obterMetricasAutoInferencia ?.();
    const relatorioLimpezaML = window.obterRelatorioLimpezaML ?.() || null;

    return {
        timestamp: new Date().toISOString(),
        fase: 'Phase 5 - Continuous Learning',
        exemplos: {
            coletados: exemploColetados,
            proximoMarcao: Math.ceil((exemploColetados + 1) / TRAINING_BATCH_SIZE) * TRAINING_BATCH_SIZE
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
            versao: ultimoTreinamento ?.versao || 'não-treinado',
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
        const relatorioLimpezaML = window.obterRelatorioLimpezaML ?.() || null;

        let recomendacoes = [];

        if (exemploColetados >= TRAINING_BATCH_SIZE && exemploColetados % TRAINING_BATCH_SIZE === 0) {
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
                mensagem: `Apenas ${exemploColetados} exemplos. Recomenda-se ${TRAINING_BATCH_SIZE}+ para melhor performance.`
            });
        }

        if (relatorioLimpezaML ?.totalRemovidos > 0) {
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
        atualizarPainelArquiteturaIA();

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

        // 4. Monitoramento contínuo de contagem na UX (quase tempo real)
        if (!monitoramentoContagemIniciado) {
            monitoramentoContagemIniciado = true;

            window.addEventListener('ai-architecture-status-change', () => {
                atualizarPainelArquiteturaIA();
            });

            setInterval(() => {
                void atualizarContagemExemplos();
            }, UX_COUNT_REFRESH_INTERVAL_MS);

            window.addEventListener('focus', () => {
                void atualizarContagemExemplos();
            });

            window.addEventListener('online', () => {
                void atualizarContagemExemplos();
            });

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    void atualizarContagemExemplos();
                }
            });
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