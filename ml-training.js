// ==================== ML TRAINING MODULE - PHASE 3 ====================
// TensorFlow.js Neural Network para aprender ajustes de parâmetros
// Entrada: Imagem processada + parâmetros CV
// Saída: Qualidade predita + ajustes de parâmetros recomendados

import { salvarModeloGlobalFirestore, lerModeloGlobalFirestore, salvarFeedbackFirestore } from './firestore-service.js';

let modeloTreinado = null;
let ultimoRelatorioLimpezaML = null;
let ultimaConscienciaML = null;
let versaoModeloGlobalAtiva = null;
let ultimoOutliersDetectados = [];

const DEFAULT_TRAINING_CONFIG = {
    edgeThreshold: 90,
    morphologySize: 5,
    minArea: 15,
    contrastBoost: 1.3,
    minQualityScore: 35,
    simplification: 0.00001
};

const DATASET_HYGIENE_CONFIG = {
    madZThreshold: 3.5,
    maxOutlierRatio: 0.35,
    minSamplesForKmeans: 12,
    maxClusters: 3,
    kmeansIterations: 20,
    distanceSigmaMultiplier: 2.2,
    minClusterRatio: 0.08
};

function calcularScoreConscienciaML(relatorio, exemplosUsados = 0) {
    const base = 100;
    if (!relatorio) return base;

    const taxaRemocao = parseFloat(String(relatorio.taxaRemocao || '0').replace('%', '')) || 0;
    const penalidadeRemocao = Math.min(35, taxaRemocao * 0.7);
    const bonusVolume = Math.min(10, Math.floor((exemplosUsados || relatorio.totalFinal || 0) / 50));
    const fallbackPenalty = relatorio.fallbackAtivado ? 8 : 0;

    return Math.max(0, Math.min(100, Math.round(base - penalidadeRemocao - fallbackPenalty + bonusVolume)));
}

function atualizarConscienciaML({ fase, exemplosUsados = 0, observacao = '' } = {}) {
    const score = calcularScoreConscienciaML(ultimoRelatorioLimpezaML, exemplosUsados);
    const nivelRisco = score >= 80 ? 'baixo' : score >= 60 ? 'moderado' : 'alto';

    ultimaConscienciaML = {
        timestamp: new Date().toISOString(),
        fase: fase || 'execucao',
        score,
        risco: nivelRisco,
        exemplosUsados,
        limpeza: ultimoRelatorioLimpezaML,
        observacao
    };

    console.groupCollapsed(`🧠 [ML-Consciencia] fase=${ultimaConscienciaML.fase} score=${score} risco=${nivelRisco}`);
    console.log('Snapshot:', ultimaConscienciaML);
    if (ultimoRelatorioLimpezaML) {
        console.log('Limpeza dataset:', ultimoRelatorioLimpezaML);
    }
    console.groupEnd();

    return ultimaConscienciaML;
}

function distanciaEuclidiana(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Number.POSITIVE_INFINITY;

    let soma = 0;
    for (let i = 0; i < a.length; i += 1) {
        const diff = (a[i] || 0) - (b[i] || 0);
        soma += diff * diff;
    }

    return Math.sqrt(soma);
}

function calcularMediana(valores) {
    if (!Array.isArray(valores) || valores.length === 0) return 0;
    const ordenados = [...valores].sort((a, b) => a - b);
    const meio = Math.floor(ordenados.length / 2);
    if (ordenados.length % 2 === 0) {
        return (ordenados[meio - 1] + ordenados[meio]) / 2;
    }
    return ordenados[meio];
}

function detectarOutliersPorMAD(vetores, zThreshold = DATASET_HYGIENE_CONFIG.madZThreshold) {
    if (!Array.isArray(vetores) || vetores.length < 8) {
        return new Set();
    }

    const dimensoes = vetores[0] ?.length || 0;
    if (!dimensoes) return new Set();

    const medianas = [];
    const mads = [];

    for (let d = 0; d < dimensoes; d += 1) {
        const coluna = vetores.map((v) => v[d] || 0);
        const mediana = calcularMediana(coluna);
        const desvios = coluna.map((valor) => Math.abs(valor - mediana));
        const mad = calcularMediana(desvios) || 1e-6;
        medianas.push(mediana);
        mads.push(mad);
    }

    const candidatos = new Set();
    vetores.forEach((vetor, idx) => {
        let excedeu = false;
        for (let d = 0; d < dimensoes; d += 1) {
            const robustZ = 0.6745 * Math.abs((vetor[d] || 0) - medianas[d]) / mads[d];
            if (robustZ > zThreshold) {
                excedeu = true;
                break;
            }
        }
        if (excedeu) candidatos.add(idx);
    });

    const limite = Math.floor(vetores.length * DATASET_HYGIENE_CONFIG.maxOutlierRatio);
    if (candidatos.size > limite && limite > 0) {
        return new Set();
    }

    return candidatos;
}

function executarKMeans(vetores, totalClusters, iteracoes = DATASET_HYGIENE_CONFIG.kmeansIterations) {
    if (!Array.isArray(vetores) || vetores.length === 0) {
        return null;
    }

    const k = Math.max(1, Math.min(totalClusters, vetores.length));
    const centroides = [];
    const atribuicoes = new Array(vetores.length).fill(0);

    for (let i = 0; i < k; i += 1) {
        const base = vetores[Math.floor((i * vetores.length) / k)] || vetores[0];
        centroides.push([...base]);
    }

    for (let it = 0; it < iteracoes; it += 1) {
        let mudou = false;

        for (let i = 0; i < vetores.length; i += 1) {
            let melhorCluster = 0;
            let melhorDist = Number.POSITIVE_INFINITY;

            for (let c = 0; c < k; c += 1) {
                const dist = distanciaEuclidiana(vetores[i], centroides[c]);
                if (dist < melhorDist) {
                    melhorDist = dist;
                    melhorCluster = c;
                }
            }

            if (atribuicoes[i] !== melhorCluster) {
                atribuicoes[i] = melhorCluster;
                mudou = true;
            }
        }

        const novosCentroides = Array.from({ length: k }, () => new Array(vetores[0].length).fill(0));
        const contagens = new Array(k).fill(0);

        for (let i = 0; i < vetores.length; i += 1) {
            const cluster = atribuicoes[i];
            contagens[cluster] += 1;
            for (let d = 0; d < vetores[i].length; d += 1) {
                novosCentroides[cluster][d] += vetores[i][d];
            }
        }

        for (let c = 0; c < k; c += 1) {
            if (contagens[c] === 0) {
                novosCentroides[c] = [...vetores[Math.floor(Math.random() * vetores.length)]];
            } else {
                for (let d = 0; d < novosCentroides[c].length; d += 1) {
                    novosCentroides[c][d] /= contagens[c];
                }
            }
        }

        for (let c = 0; c < k; c += 1) {
            centroides[c] = novosCentroides[c];
        }

        if (!mudou) break;
    }

    return { centroides, atribuicoes };
}

function detectarSuspeitosPorKMeans(vetores) {
    if (!Array.isArray(vetores) || vetores.length < DATASET_HYGIENE_CONFIG.minSamplesForKmeans) {
        return new Set();
    }

    const kEstimado = Math.max(2, Math.min(DATASET_HYGIENE_CONFIG.maxClusters, Math.round(Math.sqrt(vetores.length / 2))));
    const resultado = executarKMeans(vetores, kEstimado);
    if (!resultado) return new Set();

    const { centroides, atribuicoes } = resultado;
    const suspeitos = new Set();
    const total = vetores.length;

    const tamanhosCluster = new Map();
    atribuicoes.forEach((cluster) => {
        tamanhosCluster.set(cluster, (tamanhosCluster.get(cluster) || 0) + 1);
    });

    const minClusterSize = Math.max(2, Math.floor(total * DATASET_HYGIENE_CONFIG.minClusterRatio));

    for (let i = 0; i < vetores.length; i += 1) {
        const cluster = atribuicoes[i];
        const tamanho = tamanhosCluster.get(cluster) || 0;
        if (tamanho < minClusterSize) {
            suspeitos.add(i);
            continue;
        }

        const dist = distanciaEuclidiana(vetores[i], centroides[cluster]);
        const distanciasDoCluster = vetores
            .map((v, idx) => ({
                idx,
                cluster: atribuicoes[idx],
                dist: distanciaEuclidiana(v, centroides[atribuicoes[idx]])
            }))
            .filter((item) => item.cluster === cluster)
            .map((item) => item.dist);

        const media = distanciasDoCluster.reduce((s, v) => s + v, 0) / Math.max(1, distanciasDoCluster.length);
        const variancia = distanciasDoCluster.reduce((s, v) => s + (v - media) ** 2, 0) / Math.max(1, distanciasDoCluster.length);
        const desvio = Math.sqrt(variancia);
        const limiteDist = media + (desvio * DATASET_HYGIENE_CONFIG.distanceSigmaMultiplier);
        if (dist > limiteDist) {
            suspeitos.add(i);
        }
    }

    return suspeitos;
}

function higienizarExemplosTreinamento(exemplosBrutos) {
    if (!Array.isArray(exemplosBrutos) || exemplosBrutos.length === 0) {
        return {
            exemplosFiltrados: [],
            outliersDetectados: [],
            relatorio: {
                totalOriginal: 0,
                removidosOutlierMAD: 0,
                removidosKMeans: 0,
                totalRemovidos: 0,
                totalFinal: 0,
                taxaRemocao: '0.0%'
            }
        };
    }

    const vetoresAnalise = exemplosBrutos.map((ex) => [
        ...(ex.entradaRaw || []),
        ex.saidaRaw ?.[0] || 0
    ]);

    const outliersMAD = detectarOutliersPorMAD(vetoresAnalise);
    const suspeitosKMeans = detectarSuspeitosPorKMeans(vetoresAnalise);

    const suspeitosTotais = new Set([...outliersMAD, ...suspeitosKMeans]);
    const outliersDetectados = exemplosBrutos
        .filter((_, idx) => suspeitosTotais.has(idx))
        .map((ex) => ex.meta)
        .filter((meta) => meta ?.runId && meta ?.featureId);
    const exemplosFiltrados = exemplosBrutos.filter((_, idx) => !suspeitosTotais.has(idx));

    if (exemplosFiltrados.length < 5) {
        return {
            exemplosFiltrados: exemplosBrutos,
            outliersDetectados: [],
            relatorio: {
                totalOriginal: exemplosBrutos.length,
                removidosOutlierMAD: 0,
                removidosKMeans: 0,
                totalRemovidos: 0,
                totalFinal: exemplosBrutos.length,
                taxaRemocao: '0.0%',
                fallbackAtivado: true,
                motivoFallback: 'Remoção excessiva reduziria dataset útil para treino.'
            }
        };
    }

    const totalRemovidos = exemplosBrutos.length - exemplosFiltrados.length;

    return {
        exemplosFiltrados,
        outliersDetectados,
        relatorio: {
            totalOriginal: exemplosBrutos.length,
            removidosOutlierMAD: outliersMAD.size,
            removidosKMeans: suspeitosKMeans.size,
            totalRemovidos,
            totalFinal: exemplosFiltrados.length,
            taxaRemocao: `${((totalRemovidos / exemplosBrutos.length) * 100).toFixed(1)}%`
        }
    };
}

function obterConfigTreinamento(feature, run) {
    const merged = {
        ...DEFAULT_TRAINING_CONFIG,
        ...(run ?.config || {}),
        ...(feature ?.config || {})
    };

    return {
        edgeThreshold: Number.isFinite(merged.edgeThreshold) ? merged.edgeThreshold : DEFAULT_TRAINING_CONFIG.edgeThreshold,
        morphologySize: Number.isFinite(merged.morphologySize) ? merged.morphologySize : DEFAULT_TRAINING_CONFIG.morphologySize,
        minArea: Number.isFinite(merged.minArea) ? merged.minArea : DEFAULT_TRAINING_CONFIG.minArea,
        contrastBoost: Number.isFinite(merged.contrastBoost) ? merged.contrastBoost : DEFAULT_TRAINING_CONFIG.contrastBoost,
        minQualityScore: Number.isFinite(merged.minQualityScore) ? merged.minQualityScore : DEFAULT_TRAINING_CONFIG.minQualityScore,
        simplification: Number.isFinite(merged.simplification) ? merged.simplification : DEFAULT_TRAINING_CONFIG.simplification
    };
}

function obterRotuloFeedback(feedback) {
    return feedback ?.label || feedback ?.status || feedback ?.feedbackStatus || 'neutro';
}


// Estrutura do modelo neural
async function criarModeloML() {
    // Carregar TensorFlow.js dinamicamente se não estiver disponível
    if (typeof tf === 'undefined' || typeof window.tf === 'undefined') {
        try {
            // Carregar via CDN
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.11.0';
            script.async = false;
            document.head.appendChild(script);

            // Aguardar carregamento
            await new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = reject;
            });

            // Aguardar tf estar disponível globalmente
            let attempts = 0;
            while ((typeof window.tf === 'undefined') && attempts < 50) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            if (typeof window.tf === 'undefined') {
                throw new Error('TensorFlow.js não carregou corretamente');
            }

            console.log('✅ TensorFlow.js carregado via CDN');
        } catch (error) {
            console.error('❌ TensorFlow.js não carregado!', error);
            alert('⚠️ TensorFlow.js não disponível. Verifique sua conexão ou instale via: npm install @tensorflow/tfjs');
            return null;
        }
    }

    // Verificar se tf está disponível após carregamento
    if (typeof window.tf === 'undefined') {
        console.error('❌ TensorFlow.js ainda não disponível após carregamento');
        return null;
    }

    // Usar window.tf para garantir acesso ao objeto global
    const modelo = window.tf.sequential({
        layers: [
            // Entrada: 6 parâmetros CV
            window.tf.layers.dense({
                inputShape: [6],
                units: 16,
                activation: 'relu',
                name: 'entrada'
            }),

            // Camada oculta 1
            window.tf.layers.dropout({ rate: 0.2 }),
            window.tf.layers.dense({
                units: 32,
                activation: 'relu',
                name: 'oculta_1'
            }),

            // Camada oculta 2
            window.tf.layers.dropout({ rate: 0.2 }),
            window.tf.layers.dense({
                units: 16,
                activation: 'relu',
                name: 'oculta_2'
            }),

            // Saída: 6 ajustes de parâmetros (normalized)
            window.tf.layers.dense({
                units: 6,
                activation: 'sigmoid',
                name: 'saida'
            })
        ]
    });

    modelo.compile({
        optimizer: window.tf.train.adam(0.01),
        loss: 'meanSquaredError',
        metrics: ['mae']
    });

    console.log('✅ Modelo ML criado:');
    modelo.summary();

    return modelo;
}

// Preparar dataset para treinamento
function prepararDatasetTreinamento(dataset) {
    const exemplosBrutos = [];

    if (!dataset.runs || dataset.runs.length === 0) {
        console.warn('⚠️ Nenhum run no dataset');
        return null;
    }

    // Iterar sobre cada run (vetorização)
    dataset.runs.forEach((run) => {
        if (!run.features || run.features.length === 0) return;

        // Iterar sobre feedback de cada feature
        dataset.feedback.forEach((fb) => {
            if (fb.trainingEligible === false) return;
            if (fb.runId !== run.runId) return;

            // Procurar feature correspondente
            const feature = run.features.find(f => f.featureId === fb.featureId);
            if (!feature) return;

            const config = obterConfigTreinamento(feature, run);

            // Criar entrada: [edgeThreshold, morphologySize, minArea, contrastBoost, minQualityScore, simplification]
            // Normalizar para [0, 1]
            const entradaRaw = [
                Math.min(config.edgeThreshold / 200, 1), // 0-200 → 0-1
                Math.min(config.morphologySize / 9, 1), // 0-9 → 0-1
                Math.min(config.minArea / 100, 1), // 0-100m² → 0-1
                Math.min(config.contrastBoost / 2, 1), // 0-2 → 0-1
                config.minQualityScore / 100, // 0-100 → 0-1
                Math.min(config.simplification * 100000, 1) // muito pequeno → 0-1
            ];

            // Criar saída: qualidade predita (feedback label)
            const rotuloFeedback = obterRotuloFeedback(fb);

            let qualidadeAlvo = 0.5; // padrão
            if (rotuloFeedback === 'aprovado' || rotuloFeedback === 'correto') qualidadeAlvo = 0.9; // Muito bom
            else if (rotuloFeedback === 'editado') qualidadeAlvo = 0.7; // Corrigível
            else if (rotuloFeedback === 'rejeitado') qualidadeAlvo = 0.2; // Ruim

            // Ajustes recomendados baseados em feedback
            const ajustesRecomendados = recomendarAjustes(feature, fb, run);

            exemplosBrutos.push({
                entradaRaw,
                saidaRaw: [
                    qualidadeAlvo,
                    ajustesRecomendados.edgeThreshold,
                    ajustesRecomendados.morphologySize,
                    ajustesRecomendados.contrastBoost,
                    ajustesRecomendados.minArea,
                    ajustesRecomendados.simplification
                ],
                meta: {
                    feedbackId: fb.feedbackId || fb.id || null,
                    runId: fb.runId,
                    featureId: fb.featureId,
                    status: rotuloFeedback,
                    reason: fb.reason || fb.feedbackReason || '',
                    timestamp: fb.timestamp || fb.createdAt || null
                }
            });
        });
    });

    const { exemplosFiltrados, outliersDetectados, relatorio } = higienizarExemplosTreinamento(exemplosBrutos);
    ultimoOutliersDetectados = Array.isArray(outliersDetectados) ? outliersDetectados : [];
    ultimoRelatorioLimpezaML = {
        ...relatorio,
        generatedAt: new Date().toISOString()
    };

    atualizarConscienciaML({
        fase: 'pre-treino',
        exemplosUsados: exemplosFiltrados.length,
        observacao: 'Dataset higienizado antes do treinamento.'
    });

    if (relatorio.totalRemovidos > 0) {
        console.warn('🧹 Higienização de dataset aplicada:', ultimoRelatorioLimpezaML);
    }

    console.log(`✅ Dataset preparado: ${exemplosFiltrados.length} exemplos para treinamento`);

    if (exemplosFiltrados.length < 10) {
        alert('⚠️ Poucos exemplos para treinamento! Recomendado: ≥10 exemplos, você tem: ' + exemplosFiltrados.length);
    }

    return exemplosFiltrados;
}

async function autoSanitizarOutliersPersistidos(outliers = []) {
    if (!Array.isArray(outliers) || outliers.length === 0) {
        return { total: 0, local: 0, remoto: 0 };
    }

    const dedup = new Map();
    outliers.forEach((item) => {
        if (!item ?.runId || !item ?.featureId) return;
        dedup.set(`${item.runId}::${item.featureId}`, item);
    });

    const candidatos = [...dedup.values()];
    if (candidatos.length === 0) {
        return { total: 0, local: 0, remoto: 0 };
    }

    const flags = ['auto_outlier_sanitized'];
    const outlierDetectedAt = new Date().toISOString();
    let localAtualizados = 0;
    let remotosAtualizados = 0;

    try {
        if (typeof window.idbGetAll === 'function' && typeof window.idbPut === 'function') {
            const feedbackLocal = await window.idbGetAll('feedback');
            const indiceLocal = new Map(
                (feedbackLocal || []).map((fb) => [`${fb.runId}::${fb.featureId}`, fb])
            );

            for (const item of candidatos) {
                const chave = `${item.runId}::${item.featureId}`;
                const atual = indiceLocal.get(chave);
                if (!atual) continue;

                if (atual.trainingEligible === false && atual.outlierAutoSanitized === true) {
                    continue;
                }

                await window.idbPut('feedback', {
                    ...atual,
                    trainingEligible: false,
                    outlierAutoSanitized: true,
                    outlierDetectedAt,
                    dataQualityFlags: Array.from(new Set([...(atual.dataQualityFlags || []), ...flags]))
                });
                localAtualizados += 1;
            }
        }
    } catch (error) {
        console.warn('⚠️ Falha ao auto-sanitizar outliers no IndexedDB:', error ?.message || error);
    }

    if (navigator.onLine) {
        for (const item of candidatos) {
            try {
                await salvarFeedbackFirestore(item.runId, item.featureId, {
                    status: item.status || 'pendente',
                    label: item.status || 'pendente',
                    reason: item.reason || 'Outlier identificado automaticamente',
                    trainingEligible: false,
                    outlierAutoSanitized: true,
                    outlierDetectedAt,
                    dataQualityFlags: flags,
                    timestamp: item.timestamp || outlierDetectedAt
                });
                remotosAtualizados += 1;
            } catch (error) {
                console.warn(`⚠️ Não foi possível sanitizar feedback remoto ${item.featureId}:`, error ?.message || error);
            }
        }
    }

    return {
        total: candidatos.length,
        local: localAtualizados,
        remoto: remotosAtualizados
    };
}

// Recomendar ajustes baseado em feedback
function recomendarAjustes(feature, feedback, run) {
    const rotuloFeedback = obterRotuloFeedback(feedback);
    const multiplier = rotuloFeedback === 'rejeitado' ? 0.8 :
        rotuloFeedback === 'editado' ? 0.95 : 1.0;

    const config = obterConfigTreinamento(feature, run);

    return {
        edgeThreshold: Math.min(config.edgeThreshold * multiplier / 200, 1),
        morphologySize: Math.min(config.morphologySize * multiplier / 9, 1),
        contrastBoost: Math.min(config.contrastBoost * multiplier / 2, 1),
        minArea: Math.min(config.minArea * multiplier / 100, 1),
        simplification: Math.min(config.simplification * multiplier * 100000, 1)
    };
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const subArray = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, subArray);
    }

    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(String(base64 || ''));
    const len = binary.length;
    const bytes = new Uint8Array(len);

    for (let i = 0; i < len; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes.buffer;
}

async function extrairArtefatosModelo(modelo) {
    let artifactsCapturados = null;

    await modelo.save(window.tf.io.withSaveHandler(async(modelArtifacts) => {
        artifactsCapturados = modelArtifacts;

        return {
            modelArtifactsInfo: {
                dateSaved: new Date(),
                modelTopologyType: 'JSON',
                modelTopologyBytes: JSON.stringify(modelArtifacts.modelTopology || {}).length,
                weightSpecsBytes: JSON.stringify(modelArtifacts.weightSpecs || []).length,
                weightDataBytes: modelArtifacts.weightData ?.byteLength || 0
            }
        };
    }));

    return artifactsCapturados;
}

async function publicarModeloGlobalFirestore(modelo, metadata = {}) {
    const artifacts = await extrairArtefatosModelo(modelo);
    if (!artifacts ?.modelTopology || !artifacts ?.weightSpecs || !artifacts ?.weightData) {
        throw new Error('Artefatos do modelo inválidos para publicação global.');
    }

    const payload = {
        modelTopology: artifacts.modelTopology,
        weightSpecs: artifacts.weightSpecs,
        weightDataBase64: arrayBufferToBase64(artifacts.weightData),
        metadata: {
            ...metadata,
            weightDataBytes: artifacts.weightData.byteLength || 0
        }
    };

    const publishResult = await salvarModeloGlobalFirestore(payload);
    versaoModeloGlobalAtiva = publishResult ?.version || null;
    return publishResult;
}

// Treinar modelo com dataset
async function treinarModeloML(dataset) {
    console.log('🧠 Iniciando treinamento do modelo ML...');

    // Validar e preparar dataset
    const exemplos = prepararDatasetTreinamento(dataset);
    if (!exemplos || exemplos.length < 5) {
        alert('❌ Dataset insuficiente para treinamento!\n\nMínimo: 5 exemplos de feedback\nVocê tem: ' + (exemplos ?.length || 0));
        return false;
    }

    if (ultimoOutliersDetectados.length > 0) {
        const resultadoSanitizacao = await autoSanitizarOutliersPersistidos(ultimoOutliersDetectados);
        console.log('🧼 Auto-sanitização de outliers concluída:', resultadoSanitizacao);
    }

    // Criar modelo
    const modelo = await criarModeloML();
    if (!modelo) return false;

    try {
        // Preparar tensores
        const xs = window.tf.tensor2d(exemplos.map(ex => ex.entradaRaw));
        const ys = window.tf.tensor2d(exemplos.map(ex => ex.saidaRaw));

        // Treinar modelo com callbacks para UI
        console.log('📊 Treinando em', exemplos.length, 'exemplos...');
        const history = await modelo.fit(xs, ys, {
            epochs: 50,
            batchSize: Math.max(2, Math.floor(exemplos.length / 4)),
            validationSplit: 0.2,
            shuffle: true,
            verbose: 0, // Silencioso (usaremos nosso callback)
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    // Atualizar UI a cada época
                    const progresso = Math.round((epoch / 50) * 100);

                    // Atualizar elemento de loader se existente
                    const loaderText = document.getElementById('loader-text');
                    if (loaderText) {
                        loaderText.innerHTML = `🧠 Treinando modelo ML...<br><br>` +
                            `Época: ${epoch + 1}/50<br>` +
                            `Progresso: ${progresso}%<br>` +
                            `Loss: ${logs.loss.toFixed(4)}<br>` +
                            `Val Loss: ${logs.val_loss.toFixed(4)}`;
                    }

                    // Log a cada 10 épocas
                    if (epoch % 10 === 0) {
                        console.log(`Epoch ${epoch}: loss=${logs.loss.toFixed(4)}, val_loss=${logs.val_loss.toFixed(4)}`);
                    }
                }
            }
        });

        // Salvar modelo
        modeloTreinado = modelo;

        // Salvar no localStorage para próximas sessões
        await salvarModeloLocalStorage(modelo);

        const lossInicial = history.history.loss[0].toFixed(4);
        const lossFinal = history.history.loss[history.history.loss.length - 1].toFixed(4);
        const melhoria = (((parseFloat(lossInicial) - parseFloat(lossFinal)) / parseFloat(lossInicial)) * 100).toFixed(1);

        try {
            const publishResult = await publicarModeloGlobalFirestore(modelo, {
                source: dataset ?.source || 'desconhecida',
                exemplosTotal: exemplos.length,
                lossFinal: Number(lossFinal),
                generatedAt: new Date().toISOString()
            });
            console.log(`🌐 Modelo global atualizado com sucesso (v${publishResult?.version || 'n/a'})`);
        } catch (publishError) {
            console.warn('⚠️ Não foi possível publicar modelo global no Firestore:', publishError ?.message || publishError);
        }

        console.log('✅ Modelo treinado com sucesso!');
        console.log('📈 Loss inicial:', lossInicial);
        console.log('📉 Loss final:', lossFinal);
        console.log('🎯 Melhoria:', melhoria + '%');

        atualizarConscienciaML({
            fase: 'pos-treino',
            exemplosUsados: exemplos.length,
            observacao: `Treino finalizado. Melhoria de loss: ${melhoria}%.`
        });

        // Limpar memória
        xs.dispose();
        ys.dispose();


        // Atualizar UI final
        const loaderText = document.getElementById('loader-text');
        if (loaderText) {
            loaderText.innerHTML = `✅ Modelo treinado com sucesso!<br><br>` +
                `Exemplos: ${exemplos.length}<br>` +
                `Loss: ${lossInicial} → ${lossFinal}<br>` +
                `Melhoria: ${melhoria}%<br><br>` +
                `📊 Pronto para auto-ajuste!`;
        }

        setTimeout(() => {
            const loader = document.getElementById('loader-overlay');
            if (loader) loader.style.display = 'none';
        }, 2000);

        return true;

    } catch (error) {
        console.error('❌ Erro ao treinar modelo:', error);
        alert('❌ Erro no treinamento: ' + error.message);
        return false;
    }
}

// Fazer predição com modelo
async function fazerPredictionML(parametrosCurrent) {
    if (!modeloTreinado) {
        console.warn('⚠️ Nenhum modelo treinado disponível');
        return null;
    }

    try {
        // Preparar entrada normalizada
        const entrada = window.tf.tensor2d([
            [
                Math.min(parametrosCurrent.edgeThreshold / 200, 1),
                Math.min(parametrosCurrent.morphologySize / 9, 1),
                Math.min(parametrosCurrent.minArea / 100, 1),
                Math.min(parametrosCurrent.contrastBoost / 2, 1),
                parametrosCurrent.minQualityScore / 100,
                Math.min(parametrosCurrent.simplification * 100000, 1)
            ]
        ]);

        // Predizer
        const saida = modeloTreinado.predict(entrada);
        const valores = await saida.data();

        entrada.dispose();
        saida.dispose();

        // Desnormalizar saída
        return {
            qualidadePredita: valores[0],
            edgeThresholdRecomendado: Math.round(valores[1] * 200),
            morphologySizeRecomendado: Math.round(valores[2] * 9),
            contrastBoostRecomendado: Math.round((valores[3] * 2) * 10) / 10,
            minAreaRecomendada: Math.round(valores[4] * 100 * 10) / 10,
            simplificationRecomendada: Math.round(valores[5] / 100000 * 1000000) / 1000000
        };

    } catch (error) {
        console.error('❌ Erro na predição:', error);
        return null;
    }
}

// Salvar modelo no localStorage
async function salvarModeloLocalStorage(modelo) {
    try {
        // TensorFlow.js suporta salvar em IndexedDB
        await modelo.save('indexeddb://vetorizador-modelo-ml');
        console.log('💾 Modelo salvo em IndexedDB');
    } catch (error) {
        console.error('⚠️ Erro ao salvar modelo:', error);
    }
}

// Carregar modelo do localStorage
async function carregarModeloLocalStorage() {
    try {
        const modelo = await window.tf.loadLayersModel('indexeddb://vetorizador-modelo-ml');
        modeloTreinado = modelo;
        console.log('✅ Modelo carregado do IndexedDB');
        return modelo;
    } catch (error) {
        console.log('⚠️ Nenhum modelo salvo encontrado:', error.message);
        return null;
    }
}

async function carregarModeloGlobalFirestore() {
    try {
        const data = await lerModeloGlobalFirestore();
        if (!data) {
            console.log('⚠️ Nenhum modelo global encontrado no Firestore');
            return null;
        }

        const weightData = base64ToArrayBuffer(data.weightDataBase64);
        const handler = window.tf.io.fromMemory({
            modelTopology: data.modelTopology,
            weightSpecs: data.weightSpecs,
            weightData
        });
        const modelo = await window.tf.loadLayersModel(handler);

        modeloTreinado = modelo;
        versaoModeloGlobalAtiva = data.version || null;

        try {
            await salvarModeloLocalStorage(modelo);
        } catch {
            // best-effort cache local
        }

        console.log(`✅ Modelo global carregado do Firestore (v${data.version || 'n/a'})`);
        return modelo;
    } catch (error) {
        console.warn('⚠️ Falha ao carregar modelo global do Firestore:', error ?.message || error);
        return null;
    }
}

// Auto-ajustar parâmetros com modelo ML
async function autoajustarParametrosML() {
    if (!modeloTreinado) {
        alert('⚠️ Nenhum modelo treinado!\n\nTreina o modelo primeiro:\n1. Exportar Dataset ML\n2. Clique "Treinar Modelo"');
        return;
    }

    const configLocal = window.CONFIG || {};
    const prediction = await fazerPredictionML(configLocal);
    if (!prediction) {
        alert('❌ Erro ao fazer predição');
        return;
    }

    console.log('🤖 Predição do modelo:', prediction);

    // Ajustar parâmetros com segurança
    const confianca = (prediction.qualidadePredita * 100).toFixed(0);

    if (confianca < 50) {
        alert(`⚠️ Confiança baixa (${confianca}%)\n\nTreina com mais exemplos!`);
        return;
    }

    if (window.CONFIG) {
        window.CONFIG.edgeThreshold = prediction.edgeThresholdRecomendado;
        window.CONFIG.morphologySize = prediction.morphologySizeRecomendado;
        window.CONFIG.contrastBoost = prediction.contrastBoostRecomendado;
        window.CONFIG.minArea = prediction.minAreaRecomendada;
        window.CONFIG.simplification = prediction.simplificationRecomendada;

        // Atualizar UI
        document.getElementById('edgeThreshold').value = window.CONFIG.edgeThreshold;
        document.getElementById('edgeThresholdInput').value = window.CONFIG.edgeThreshold;
        document.getElementById('morphologySize').value = window.CONFIG.morphologySize;
        document.getElementById('morphologySizeInput').value = window.CONFIG.morphologySize;
        document.getElementById('minArea').value = window.CONFIG.minArea;
        document.getElementById('minAreaInput').value = window.CONFIG.minArea.toFixed(0);
        document.getElementById('contrastBoost').value = window.CONFIG.contrastBoost;
        document.getElementById('contrastBoostInput').value = window.CONFIG.contrastBoost.toFixed(1);
        document.getElementById('simplification').value = window.CONFIG.simplification;
        document.getElementById('simplificationInput').value = window.CONFIG.simplification.toFixed(6);
    }

    if (window.mostrarNotificacao) {
        window.mostrarNotificacao(
            `🤖 Parâmetros ajustados automaticamente!\n\n` +
            `Confiança: ${confianca}%\n` +
            `Qualidade predita: ${(prediction.qualidadePredita * 100).toFixed(0)}/100`,
            'success'
        );
    }
}

// Exportar funções
window.treinarModeloML = treinarModeloML;
window.autoajustarParametrosML = autoajustarParametrosML;
window.carregarModeloLocalStorage = carregarModeloLocalStorage;
window.carregarModeloGlobalFirestore = carregarModeloGlobalFirestore;
window.fazerPredictionML = fazerPredictionML;
window.obterRelatorioLimpezaML = () => ultimoRelatorioLimpezaML;
window.obterConscienciaML = () => ultimaConscienciaML;
window.logConscienciaML = () => atualizarConscienciaML({ fase: 'manual', observacao: 'Snapshot manual solicitado pela equipe.' });
window.obterVersaoModeloGlobal = () => versaoModeloGlobalAtiva;