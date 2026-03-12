/**
 * Firestore Data Service
 * Gerencia persistência de runs, features e feedback em Firestore
 * Estrutura de coleções:
 * - runs/{runId} - metadados das execuções
 *   - features/{featureId} - polígonos detectados
 *   - feedback/{feedbackId} - avaliações humanas
 */

import {
    collection,
    collectionGroup,
    doc,
    setDoc,
    getDoc,
    deleteDoc,
    getDocs,
    getCountFromServer,
    query,
    where,
    orderBy,
    startAfter,
    limit,
    serverTimestamp,
    writeBatch
} from 'firebase/firestore';
import { obterFirestore, obterUsuarioAtual } from './firebase-config.js';

function obterRefAppBoundaryGlobal(db) {
    return doc(db, 'shared', 'global_app_boundary');
}

function obterRefModeloGlobal(db) {
    return doc(db, 'shared', 'global_ml_model');
}

function isQuotaExceededError(error) {
    const code = String(error ?.code || '').toLowerCase();
    const message = String(error ?.message || '').toLowerCase();
    return (
        code.includes('resource-exhausted') ||
        message.includes('quota exceeded') ||
        message.includes('resource_exhausted')
    );
}

// ==================== SALVAR RUN ====================
/**
 * Salva uma nova execução de vetorização
 * @param {string} runId - UUID da execução
 * @param {Object} dadosRun - Objeto contendo config, timestamp, bounds, etc
 */
export async function salvarRunFirestore(runId, dadosRun) {
    const db = obterFirestore();
    const userId = obterUsuarioAtual();

    try {
        const runRef = doc(db, 'runs', runId);

        // Sanear dados: remover arrays aninhados e campos undefined
        const dadosSaneados = {};
        for (const [key, value] of Object.entries(dadosRun)) {
            if (key === 'features') continue; // Features vai em subcoleção
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) continue; // Firestore não suporta arrays aninhados
            if (typeof value === 'object' && !value.type) continue;
            dadosSaneados[key] = value;
        }

        const dadosCompletos = {
            ...dadosSaneados,
            userId: userId,
            timestamp: serverTimestamp(),
            createdAt: new Date().toISOString() // Fallback para offline
        };

        await setDoc(runRef, dadosCompletos);
        console.log(`✅ Run ${runId.substring(0, 8)} salva em Firestore`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao salvar run em Firestore:', error);
        throw error;
    }
}

// ==================== SALVAR FEATURES (BATCH) ====================
/**
 * Salva todas as features detectadas de uma run como subcoleção
 * @param {string} runId - UUID da execução
 * @param {Array} features - Array de GeoJSON features
 */
export async function salvarFeaturesFirestore(runId, features) {
    const db = obterFirestore();

    try {
        const batch = writeBatch(db);
        const runRef = doc(db, 'runs', runId);

        features.forEach((feature, index) => {
            const featureId = `${runId}_feature_${index}`;
            const featureRef = doc(collection(runRef, 'features'), featureId);

            // Saneamento: extrair apenas dados não-aninhados e metadados importantes
            const featureSaneada = {
                id: feature.properties ?.id,
                area_m2: feature.properties ?.area_m2,
                score: feature.properties ?.score,
                quality: feature.properties ?.quality,
                compactness: feature.properties ?.compactness,
                vertices: feature.properties ?.vertices,
                feedback_status: feature.properties ?.feedback_status || 'pendente',
                feedback_reason: feature.properties ?.feedback_reason || '',
                geometryType: feature.geometry ?.type,
                coordinateCount: feature.geometry ?.coordinates ?.[0] ?.length || 0
            };

            // Remover campos undefined
            Object.keys(featureSaneada).forEach(key => {
                if (featureSaneada[key] === undefined) delete featureSaneada[key];
            });

            batch.set(featureRef, {
                ...featureSaneada,
                featureIndex: index,
                createdAt: serverTimestamp()
            });
        });

        await batch.commit();
        console.log(`✅ ${features.length} features salvas em Firestore (runId: ${runId.substring(0, 8)})`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao salvar features em Firestore:', error);
        throw error;
    }
}

// ==================== SALVAR FEEDBACK ====================
/**
 * Salva feedback do usuário sobre uma feature
 * @param {string} runId - UUID da execução
 * @param {string} featureId - ID da feature
 * @param {Object} feedback - {status, reason, editedGeometry?, timestamp}
 */
export async function salvarFeedbackFirestore(runId, featureId, feedback) {
    const db = obterFirestore();
    const userId = obterUsuarioAtual();

    try {
        const runRef = doc(db, 'runs', runId);
        const feedbackRef = doc(collection(runRef, 'feedback'), featureId);
        const statusSeguro = feedback ?.status || feedback ?.feedbackStatus || feedback ?.label || 'pendente';
        const reasonSeguro = feedback ?.reason || feedback ?.feedbackReason || '';
        const timestampSeguro = feedback ?.timestamp || feedback ?.createdAt || new Date().toISOString();

        const dadosFeedback = {
            status: statusSeguro,
            reason: reasonSeguro,
            userId: userId,
            featureId: featureId,
            timestamp: serverTimestamp(),
            createdAt: timestampSeguro // Fallback para offline
        };

        if (feedback ?.label) {
            dadosFeedback.label = feedback.label;
        }
        if (typeof feedback ?.trainingEligible === 'boolean') {
            dadosFeedback.trainingEligible = feedback.trainingEligible;
        }
        if (Number.isFinite(feedback ?.dataQualityScore)) {
            dadosFeedback.dataQualityScore = feedback.dataQualityScore;
        }
        if (Array.isArray(feedback ?.dataQualityFlags)) {
            dadosFeedback.dataQualityFlags = feedback.dataQualityFlags;
        }
        if (feedback ?.hardNegativeCategory) {
            dadosFeedback.hardNegativeCategory = feedback.hardNegativeCategory;
        }
        if (feedback ?.tipoBenfeitoria) {
            dadosFeedback.tipoBenfeitoria = feedback.tipoBenfeitoria;
        }
        if (feedback ?.outlierAutoSanitized === true) {
            dadosFeedback.outlierAutoSanitized = true;
            dadosFeedback.outlierDetectedAt = feedback.outlierDetectedAt || timestampSeguro;
        }

        // Adiciona geometrias apenas se existirem (evita undefined)
        if (feedback ?.editedGeometry || feedback ?.geometriaCorrigida) {
            const geom = feedback.editedGeometry || feedback.geometriaCorrigida;
            dadosFeedback.editedGeometryType = geom.type;
            dadosFeedback.editedGeometryCoordinateCount = geom.coordinates ?.[0] ?.length || 0;
        }
        if (feedback ?.originalGeometry || feedback ?.geometriaOriginal) {
            const geom = feedback.originalGeometry || feedback.geometriaOriginal;
            dadosFeedback.originalGeometryType = geom.type;
            dadosFeedback.originalGeometryCoordinateCount = geom.coordinates ?.[0] ?.length || 0;
        }

        await setDoc(feedbackRef, dadosFeedback);
        console.log(`✅ Feedback salvo em Firestore (featureId: ${featureId})`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao salvar feedback em Firestore:', error);
        throw error;
    }
}

// ==================== APP BOUNDARY (GLOBAL COMPARTILHADA) ====================
/**
 * Salva a APP carregada em documento global compartilhado.
 * @param {Object} payload - {geojson, metadata}
 */
export async function salvarAppBoundaryFirestore(payload = {}) {
    const db = obterFirestore();
    const userId = obterUsuarioAtual();

    if (!userId) {
        throw new Error('Sessão anônima não autenticada para salvar APP global.');
    }

    const geojson = payload ?.geojson;
    const metadata = payload ?.metadata || {};

    if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('GeoJSON APP inválido para persistência.');
    }

    let geojsonJson = '';
    try {
        geojsonJson = JSON.stringify(geojson);
    } catch {
        throw new Error('Não foi possível serializar o GeoJSON APP para persistência.');
    }

    const dados = {
        updatedBy: userId,
        geojsonJson,
        metadata,
        updatedAt: serverTimestamp(),
        updatedAtIso: new Date().toISOString()
    };

    const ref = obterRefAppBoundaryGlobal(db);
    await setDoc(ref, dados);
    return true;
}

/**
 * Lê a APP global compartilhada.
 * @returns {Object|null}
 */
export async function lerAppBoundaryFirestore() {
    const db = obterFirestore();
    const userId = obterUsuarioAtual();

    if (!userId) {
        return null;
    }

    const ref = obterRefAppBoundaryGlobal(db);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
        return null;
    }

    const data = snap.data() || {};
    let geojson = data.geojson || null;

    if (!geojson && typeof data.geojsonJson === 'string' && data.geojsonJson.trim()) {
        try {
            geojson = JSON.parse(data.geojsonJson);
        } catch {
            throw new Error('APP salva no Firestore está em formato inválido.');
        }
    }

    return {
        ...data,
        geojson
    };
}

/**
 * Remove a APP global compartilhada.
 */
export async function limparAppBoundaryFirestore() {
    const db = obterFirestore();
    const userId = obterUsuarioAtual();

    if (!userId) {
        return false;
    }

    const ref = obterRefAppBoundaryGlobal(db);
    await deleteDoc(ref);
    return true;
}

// ==================== LER RUN ====================
/**
 * Recupera metadados de uma run específica
 * @param {string} runId - UUID da execução
 */
export async function lerRunFirestore(runId) {
    const db = obterFirestore();

    try {
        const runRef = doc(db, 'runs', runId);
        const runSnap = await getDoc(runRef);

        if (runSnap.exists()) {
            return { id: runSnap.id, ...runSnap.data() };
        } else {
            console.warn(`⚠️ Run ${runId} não encontrada em Firestore`);
            return null;
        }
    } catch (error) {
        console.error('❌ Erro ao ler run de Firestore:', error);
        throw error;
    }
}

// ==================== LER FEATURES DE UMA RUN ====================
/**
 * Recupera todas as features de uma run
 * @param {string} runId - UUID da execução
 */
export async function lerFeaturesFirestore(runId) {
    const db = obterFirestore();

    try {
        const runRef = doc(db, 'runs', runId);
        const featuresRef = collection(runRef, 'features');
        const featuresSnap = await getDocs(featuresRef);

        const features = [];
        featuresSnap.forEach((doc) => {
            features.push({ id: doc.id, ...doc.data() });
        });

        return features;
    } catch (error) {
        console.error('❌ Erro ao ler features de Firestore:', error);
        throw error;
    }
}

// ==================== LER FEEDBACK DE UMA RUN ====================
/**
 * Recupera todos os feedbacks de uma run
 * @param {string} runId - UUID da execução
 */
export async function lerFeedbackFirestore(runId) {
    const db = obterFirestore();

    try {
        const runRef = doc(db, 'runs', runId);
        const feedbackRef = collection(runRef, 'feedback');
        const feedbackSnap = await getDocs(feedbackRef);

        const feedbacks = [];
        feedbackSnap.forEach((doc) => {
            feedbacks.push({ id: doc.id, ...doc.data() });
        });

        return feedbacks;
    } catch (error) {
        console.error('❌ Erro ao ler feedback de Firestore:', error);
        throw error;
    }
}

// ==================== LISTAR RUNS DO USUÁRIO ====================
/**
 * Lista todas as runs do usuário atual (últimas 50)
 * @param {number} maxResults - Número máximo de resultados (default: 50)
 */
export async function listarRunsUsuario(maxResults = 50) {
    const db = obterFirestore();
    const userId = obterUsuarioAtual();

    if (!userId) {
        console.warn('⚠️ Nenhum usuário autenticado');
        return [];
    }

    try {
        const runsRef = collection(db, 'runs');
        const q = query(
            runsRef,
            where('userId', '==', userId),
            orderBy('timestamp', 'desc'),
            limit(maxResults)
        );

        const querySnapshot = await getDocs(q);
        const runs = [];
        querySnapshot.forEach((doc) => {
            runs.push({ id: doc.id, ...doc.data() });
        });

        console.log(`📊 ${runs.length} runs encontradas para o usuário`);
        return runs;
    } catch (error) {
        console.error('❌ Erro ao listar runs do usuário:', error);
        throw error;
    }
}

// ==================== DATASET COMPLETO PARA ML ====================
/**
 * Exporta dataset completo: todas as runs com features e feedback
 * ATENÇÃO: Pode ser pesado - usar com cuidado em produção
 */
export async function exportarDatasetCompleto() {
    const db = obterFirestore();
    const userId = obterUsuarioAtual();

    try {
        console.log('🔍 Coletando dataset completo...');

        const runsRef = collection(db, 'runs');
        const q = query(runsRef, where('userId', '==', userId));
        const runsSnap = await getDocs(q);

        const dataset = {
            exportDate: new Date().toISOString(),
            userId: userId,
            runs: []
        };

        // Para cada run, buscar features e feedback
        for (const runDoc of runsSnap.docs) {
            const runData = { id: runDoc.id, ...runDoc.data() };

            // Buscar features
            const featuresSnap = await getDocs(collection(runDoc.ref, 'features'));
            const features = [];
            featuresSnap.forEach(doc => features.push({ id: doc.id, ...doc.data() }));

            // Buscar feedback
            const feedbackSnap = await getDocs(collection(runDoc.ref, 'feedback'));
            const feedbacks = [];
            feedbackSnap.forEach(doc => feedbacks.push({ id: doc.id, ...doc.data() }));

            dataset.runs.push({
                ...runData,
                features,
                feedbacks
            });
        }

        console.log(`✅ Dataset exportado: ${dataset.runs.length} runs`);
        return dataset;
    } catch (error) {
        console.error('❌ Erro ao exportar dataset:', error);
        throw error;
    }
}

// ==================== DATASET GLOBAL COMPARTILHADO (TODOS USUÁRIOS) ====================
/**
 * Exporta dataset de aprendizado compartilhado entre usuários anônimos.
 * Uso principal: retreinamento e contagem global de exemplos.
 *
 * @param {number|null} maxRuns - Limite opcional de runs; null/undefined = sem teto
 * @returns {Object} Dataset normalizado para pipeline de ML
 */
export async function exportarDatasetCompartilhadoFirestore(maxRuns = null) {
    const db = obterFirestore();

    try {
        const DEFAULT_MAX_RUNS = 120;
        const MAX_FEATURES_PER_RUN = 60;
        const MAX_FEEDBACK_PER_RUN = 120;
        const limiteNormalizado = Number.isFinite(maxRuns) && maxRuns > 0 ?
            Math.floor(maxRuns) :
            DEFAULT_MAX_RUNS;
        const pageSizeBase = 500;

        console.log(
                `🌐 Coletando dataset global compartilhado (${limiteNormalizado ? `até ${limiteNormalizado}` : 'sem limite'} runs)...`
    );

    const runsRef = collection(db, 'runs');
    const runDocs = [];

    try {
      let lastDoc = null;

      while (true) {
        const restante = limiteNormalizado == null
          ? pageSizeBase
          : (limiteNormalizado - runDocs.length);

        if (limiteNormalizado != null && restante <= 0) {
          break;
        }

        const pageSize = limiteNormalizado == null
          ? pageSizeBase
          : Math.min(pageSizeBase, restante);

        const qOrdenada = lastDoc
          ? query(runsRef, orderBy('timestamp', 'desc'), startAfter(lastDoc), limit(pageSize))
          : query(runsRef, orderBy('timestamp', 'desc'), limit(pageSize));

        const runsSnap = await getDocs(qOrdenada);
        if (runsSnap.empty) {
          break;
        }

        runDocs.push(...runsSnap.docs);
        lastDoc = runsSnap.docs[runsSnap.docs.length - 1];

        if (runsSnap.size < pageSize) {
          break;
        }
      }
    } catch (orderError) {
      console.warn('⚠️ Fallback consulta runs sem orderBy(timestamp):', orderError?.message || orderError);

      // Fallback sem ordenação: quando possível, mantém limite opcional.
      const qFallback = limiteNormalizado == null
        ? query(runsRef)
        : query(runsRef, limit(limiteNormalizado));
      const runsSnapFallback = await getDocs(qFallback);
      runDocs.push(...runsSnapFallback.docs);
    }

    const dataset = {
      exportDate: new Date().toISOString(),
      scope: 'global-shared',
      totalRuns: runDocs.length,
      runs: [],
      feedback: []
    };

    for (const runDoc of runDocs) {
      const runData = runDoc.data() || {};
      const runId = runData.runId || runDoc.id;

      const featuresSnap = await getDocs(query(collection(runDoc.ref, 'features'), limit(MAX_FEATURES_PER_RUN)));
      const feedbackSnap = await getDocs(query(collection(runDoc.ref, 'feedback'), limit(MAX_FEEDBACK_PER_RUN)));

      const features = [];
      featuresSnap.forEach((featureDoc) => {
        const featureData = featureDoc.data() || {};
        features.push({
          ...featureData,
          featureId: featureData.id || featureData.featureId || featureDoc.id
        });
      });

      dataset.runs.push({
        runId,
        config: runData.config || {},
        createdAt: runData.createdAt || null,
        presetProfile: runData?.config?.presetProfile || null,
        features
      });

      feedbackSnap.forEach((feedbackDoc) => {
        const feedbackData = feedbackDoc.data() || {};
        const status = feedbackData.status || feedbackData.feedbackStatus || feedbackData.label || 'pendente';

        dataset.feedback.push({
          ...feedbackData,
          runId,
          featureId: feedbackData.featureId || feedbackDoc.id,
          status,
          feedbackStatus: status,
          label: feedbackData.label || status,
          feedbackReason: feedbackData.reason || feedbackData.feedbackReason || ''
        });
      });
    }

    console.log(
      `✅ Dataset global exportado: ${dataset.runs.length} runs, ${dataset.feedback.length} feedbacks ` +
      `(limites: runs=${limiteNormalizado}, features/run=${MAX_FEATURES_PER_RUN}, feedback/run=${MAX_FEEDBACK_PER_RUN})`
    );
    return dataset;
  } catch (error) {
    if (isQuotaExceededError(error)) {
      error.isQuotaExceeded = true;
    }
    console.error('❌ Erro ao exportar dataset global compartilhado:', error);
    throw error;
  }
}

// ==================== MODELO GLOBAL COMPARTILHADO ====================
/**
 * Publica o modelo global compartilhado no Firestore.
 * Espera artefatos no formato do TensorFlow.js IOHandler.
 *
 * @param {Object} payload - {modelTopology, weightSpecs, weightDataBase64, metadata?}
 */
export async function salvarModeloGlobalFirestore(payload = {}) {
  const db = obterFirestore();
  const userId = obterUsuarioAtual();

  const modelTopology = payload?.modelTopology;
  const weightSpecs = payload?.weightSpecs;
  const weightDataBase64 = String(payload?.weightDataBase64 || '');
  const metadata = payload?.metadata || {};

  if (!modelTopology || !Array.isArray(weightSpecs) || !weightDataBase64) {
    throw new Error('Payload de modelo global inválido: topology/specs/weights ausentes.');
  }

  const tamanhoAproximado =
    JSON.stringify(modelTopology).length +
    JSON.stringify(weightSpecs).length +
    weightDataBase64.length;

  if (tamanhoAproximado > 850000) {
    throw new Error('Modelo global excede limite seguro para documento Firestore.');
  }

  const versao = Number(metadata?.version) || Date.now();

  const dados = {
    version: versao,
    modelTopology,
    weightSpecs,
    weightDataBase64,
    modelFormat: 'tfjs-layers-model',
    generatedBy: userId || 'anon',
    metadata: {
      ...metadata,
      publishedAtIso: new Date().toISOString()
    },
    updatedAt: serverTimestamp(),
    updatedAtIso: new Date().toISOString()
  };

  const ref = obterRefModeloGlobal(db);
  await setDoc(ref, dados);
  console.log(`✅ Modelo global publicado (v${versao})`);
  return { version: versao };
}

/**
 * Lê o modelo global compartilhado no Firestore.
 * @returns {Object|null}
 */
export async function lerModeloGlobalFirestore() {
  const db = obterFirestore();
  const ref = obterRefModeloGlobal(db);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    return null;
  }

  const data = snap.data() || {};
  if (!data.modelTopology || !Array.isArray(data.weightSpecs) || !data.weightDataBase64) {
    return null;
  }

  return {
    version: data.version || null,
    modelTopology: data.modelTopology,
    weightSpecs: data.weightSpecs,
    weightDataBase64: data.weightDataBase64,
    metadata: data.metadata || {},
    updatedAtIso: data.updatedAtIso || null
  };
}

// ==================== RESUMO GLOBAL DE FEEDBACK ====================
/**
 * Conta feedbacks globais no Firestore com consulta de agregação.
 * Retorna total e elegíveis para treino (total - trainingEligible=false).
 */
export async function contarFeedbackGlobalElegivelFirestore() {
    const db = obterFirestore();

    try {
        const feedbackRef = collectionGroup(db, 'feedback');
        const totalSnap = await getCountFromServer(query(feedbackRef));
        const inelegiveisSnap = await getCountFromServer(
            query(feedbackRef, where('trainingEligible', '==', false))
        );

        const total = Number(totalSnap.data()?.count || 0);
        const inelegiveis = Number(inelegiveisSnap.data()?.count || 0);
        const elegiveis = Math.max(0, total - inelegiveis);

        return {
            source: 'firestore-aggregate-count',
            total,
            inelegiveis,
            elegiveis
        };
    } catch (error) {
        // Fallback robusto: quando aggregate/collectionGroup falha por regra/índice,
        // calcula a contagem usando o export compartilhado por runs.
        try {
            console.warn('⚠️ Falha na contagem agregada de feedback; usando fallback por dataset compartilhado.');
            const dataset = await exportarDatasetCompartilhadoFirestore(120);
            const feedback = Array.isArray(dataset?.feedback) ? dataset.feedback : [];
            const inelegiveis = feedback.filter((fb) => fb?.trainingEligible === false).length;
            const total = feedback.length;
            const elegiveis = Math.max(0, total - inelegiveis);

            return {
                source: 'firestore-dataset-fallback-count',
                total,
                inelegiveis,
                elegiveis
            };
        } catch {
            // Segue para o fluxo padrão de erro abaixo.
        }

        if (isQuotaExceededError(error)) {
            error.isQuotaExceeded = true;
        }
        throw error;
    }
}