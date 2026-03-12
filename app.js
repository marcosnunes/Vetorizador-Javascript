/**
 * Arquivo principal do Vetorizador.
 * Orquestra captura de ROI, pré-processamento, vetorização WASM,
 * pós-filtros, feedback do usuário e exportação.
 */

// Importação do WASM via wasm_bindgen (no-modules target)
let vetorizar_imagem;

/* global L, leafletImage, turf, wasm_bindgen */

// ==================== IMPORTS DE FIREBASE/FIRESTORE ====================
// CRÍTICO: Ordem de imports importante - Firebase deve inicializar antes dos serviços
import { inicializarFirebase, estaOnline, monitorarConexao } from './firebase-config.js';
import {
    salvarRunFirestore,
    salvarFeaturesFirestore,
    salvarFeedbackFirestore,
    salvarAppBoundaryFirestore,
    lerAppBoundaryFirestore,
    limparAppBoundaryFirestore
} from './firestore-service.js';
import {
    inicializarFilaOffline,
    sincronizarFila,
    contarOperacoesPendentes
} from './offline-queue.js';

// --- CONFIGURAÇÃO INICIAL ---
const loader = document.getElementById('loader-overlay');
const loaderText = document.getElementById('loader-text');
let debugMaskLayer = null;
let searchResultMarker = null;
let modoCapturaCoordenada = false;
let modoVetorizacao = 'auto'; // 'auto' | 'manual'
let activeDrawHandler = null; // handler ativo do Leaflet.Draw (Modo Manual)
const geojsonFeatures = [];
const manualPolygonFeatures = []; // Polígonos desenhados manualmente para aprendizado
let activeRunId = null;
let activeRunStartedAt = null;
let appBoundaryGeoJSON = null;
let appBoundaryMetadata = null;
let currentSelectionMaskFeature = null;

const APP_STORAGE_KEY = 'vetorizador_app_boundary_v1';

const FEEDBACK_QUALITY_MIN_SCORE = 60;
const HARD_NEGATIVE_CATEGORIES = new Set(['vegetacao', 'solo', 'rua']);
const HARD_NEGATIVE_OVERLAP_THRESHOLD = 0.28;
const REJECTION_REASON_CATEGORIES = [
    'sombra',
    'vegetacao',
    'solo',
    'agua',
    'rua',
    'fragmentado',
    'ruido',
    'borda'
];

const TIPOS_BENFEITORIA = {
    trapiche: 'Trapiche',
    edificacao: 'Edificação',
    outra: 'Outra benfeitoria',
    nao_classificada: 'Não classificada'
};

const CALIBRACAO_PRESET_LIMITES = {
    minQualityScore: { min: 20, max: 85 },
    minArea: { min: 5, max: 220 },
    edgeThreshold: { min: 45, max: 170 }
};

const ASSIST_TELEMETRY_KEY = 'vetorizador_assist_telemetry_v1';
const ASSIST_TELEMETRY_MAX = 400;
const ASSIST_STATE_KEY = 'vetorizador_assist_state_v1';
const ASSIST_DELTA_LIMITS = {
    edgeThresholdAbs: 18,
    morphologySizeAbs: 2,
    minAreaRel: 0.45,
    contrastBoostAbs: 0.3,
    simplificationRel: 1.0
};
const ASSIST_SMOOTH_ALPHA = 0.4;
const ASSIST_SCENARIO_GUARDRAILS = {
    urbano: {
        edgeThreshold: [70, 145],
        morphologySize: [3, 9],
        minArea: [20, 120],
        contrastBoost: [1.1, 1.9],
        simplification: [0.000005, 0.00008]
    },
    cobertura: {
        edgeThreshold: [50, 125],
        morphologySize: [1, 7],
        minArea: [6, 80],
        contrastBoost: [1.2, 2.1],
        simplification: [0.000003, 0.00005]
    },
    rural: {
        edgeThreshold: [45, 120],
        morphologySize: [5, 13],
        minArea: [20, 220],
        contrastBoost: [1.2, 2.0],
        simplification: [0.00001, 0.00012]
    },
    industrial: {
        edgeThreshold: [55, 130],
        morphologySize: [5, 11],
        minArea: [60, 350],
        contrastBoost: [1.1, 1.8],
        simplification: [0.00001, 0.00015]
    },
    trapiche: {
        edgeThreshold: [35, 95],
        morphologySize: [1, 5],
        minArea: [3, 40],
        contrastBoost: [1.3, 2.3],
        simplification: [0.000002, 0.00002]
    },
    manual: {
        edgeThreshold: [45, 140],
        morphologySize: [3, 11],
        minArea: [5, 160],
        contrastBoost: [1.0, 2.0],
        simplification: [0.000005, 0.0001]
    }
};

const LEARNING_DB_NAME = 'vetorizador_learning_db';
const LEARNING_DB_VERSION = 1;
let learningDbPromise = null;

// Variáveis de sincronização Firebase
let firebaseInicializado = false;
let modoOffline = false;
let sincronizacaoEmAndamento = false;
const FIRESTORE_WRITE_HEARTBEAT_KEY = 'vetorizador_firestore_last_ok_at_v1';

function registrarHeartbeatFirestoreOk() {
    const agora = Date.now();
    window.__firestoreLastOkAt = agora;
    try {
        localStorage.setItem(FIRESTORE_WRITE_HEARTBEAT_KEY, String(agora));
    } catch {
        // sem-op
    }
}

// --- PARÂMETROS AJUSTÁVEIS ---
/**
 * CONFIG = Fonte única da verdade para parâmetros de processamento de imagens
 * Mantém defaults dos controles e é atualizado por sliders/inputs e presets.
 */
let CONFIG = {
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

const DEBUG_LOGS = false;

function debugLog(...args) {
    if (DEBUG_LOGS) {
        console.log(...args);
    }
}

/**
 * Sincroniza slider/input com a chave correspondente em CONFIG.
 */
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

function inicializarToggleMenuLateral() {
    const mainContainer = document.querySelector('#vetorizador-content .main-container');
    const toggleButton = document.getElementById('sidebar-toggle');

    if (!mainContainer || !toggleButton) return;

    const atualizarEstadoBotao = (colapsado) => {
        toggleButton.textContent = colapsado ? '▶' : '◀';
        toggleButton.setAttribute('aria-expanded', String(!colapsado));
        toggleButton.setAttribute('aria-label', colapsado ? 'Exibir menu lateral' : 'Ocultar menu lateral');
        toggleButton.title = colapsado ? 'Exibir menu lateral' : 'Ocultar menu lateral';
    };

    atualizarEstadoBotao(false);

    toggleButton.addEventListener('click', () => {
        const colapsado = mainContainer.classList.toggle('sidebar-collapsed');
        atualizarEstadoBotao(colapsado);

        if (typeof window.map ?.invalidateSize === 'function') {
            setTimeout(() => {
                window.map.invalidateSize();
            }, 320);
        }
    });
}

// Inicializa listeners dos controles
window.addEventListener('DOMContentLoaded', () => {
    inicializarToggleMenuLateral();

    const mapSearchInput = document.getElementById('mapSearchInput');
    const mapSearchBtn = document.getElementById('mapSearchBtn');
    const btnCapturePoint = document.getElementById('btnCapturePoint');
    if (mapSearchBtn) {
        mapSearchBtn.addEventListener('click', buscarLocalNoMapa);
    }
    if (btnCapturePoint) {
        btnCapturePoint.addEventListener('click', () => {
            definirModoCapturaCoordenada(!modoCapturaCoordenada);
        });
    }
    if (mapSearchInput) {
        mapSearchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                buscarLocalNoMapa();
            }
        });
    }

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

    const btnCarregarAppZip = document.getElementById('btnCarregarAppZip');
    if (btnCarregarAppZip) {
        btnCarregarAppZip.addEventListener('click', carregarAppShapefileZip);
    }

    const btnLimparAppZip = document.getElementById('btnLimparAppZip');
    if (btnLimparAppZip) {
        btnLimparAppZip.addEventListener('click', () => {
            limparAppPersistida().catch((err) => {
                console.error('Erro ao limpar APP:', err);
            });
        });
    }

    restaurarAppPersistida();
    atualizarUiCapturaCoordenada();

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
    } catch (err) {
        console.error('❌ Erro ao inicializar banco local:', err);
    }

    // 2. Inicializar fila offline
    try {
        await inicializarFilaOffline();
        console.log('✅ Fila offline inicializada');
    } catch {
        console.error('❌ Erro ao inicializar fila offline');
    }

    // 3. Inicializar Firebase/Firestore (Phase 2)
    try {
        const { db, auth } = inicializarFirebase();
        if (db && auth) {
            firebaseInicializado = true;
            console.log('✅ Firebase/Firestore inicializado');

            await restaurarAppPersistidaDoFirestoreSeNecessario();
            setTimeout(() => {
                restaurarAppPersistidaDoFirestoreSeNecessario().catch((err) => {
                    console.warn('⚠️ Falha no retry de restauração APP no Firestore:', err);
                });
            }, 1800);

            // 4. Monitorar conexão e sincronizar quando online
            monitorarConexao(
                async() => {
                    modoOffline = false;
                    await sincronizarFilaPendente();

                    if (appBoundaryGeoJSON) {
                        await persistirAppBoundary(appBoundaryGeoJSON, appBoundaryMetadata || {});
                    } else {
                        await restaurarAppPersistidaDoFirestoreSeNecessario();
                    }
                },
                () => {
                    modoOffline = true;
                }
            );

            // 5. Sincronizar fila pendente (se houver operações offline)
            await sincronizarFilaPendente();
        }
    } catch {
        console.error('⚠️ Firebase não inicializado - rodando apenas com IndexedDB local');
        firebaseInicializado = false;
    }

    // 6. Auto-carregar modelo treinado para inferência
    try {
        const modeloCarregado = await window.autocarregarModeloML ?.();
        if (modeloCarregado) {
            console.log('✅ Modelo auto-carregado para inferência automática');
        }
    } catch {
        console.log('⚠️ Nenhum modelo salvo para auto-inferência');
    }

    // 7. Inicializar sistema de aprendizado contínuo
    try {
        const phase5Ok = await window.inicializarPhase5 ?.();
        if (phase5Ok) {
            console.log('✅ Sistema de aprendizado contínuo inicializado');
        }
    } catch {
        console.log('⚠️ Erro ao inicializar aprendizado contínuo');
    }

    atualizarIndicadorConexao();
}

// ==================== SINCRONIZAR FILA PENDENTE ====================
async function sincronizarFilaPendente() {
    if (!firebaseInicializado || !estaOnline()) {
        return;
    }

    if (sincronizacaoEmAndamento) {
        return;
    }

    const pendentes = await contarOperacoesPendentes();
    if (pendentes === 0) {
        return;
    }

    sincronizacaoEmAndamento = true;
    console.log(`🔄 Sincronizando ${pendentes} operações pendentes...`);

    try {
        const resultado = await sincronizarFila(async(operationType, payload) => {
            switch (operationType) {
                case 'run':
                    await salvarRunFirestore(payload.runId, payload.dadosRun);
                    registrarHeartbeatFirestoreOk();
                    break;
                case 'features':
                    await salvarFeaturesFirestore(payload.runId, payload.features);
                    registrarHeartbeatFirestoreOk();
                    break;
                case 'feedback':
                    await salvarFeedbackFirestore(payload.runId, payload.featureId, normalizarFeedbackPayload(payload.feedback));
                    registrarHeartbeatFirestoreOk();
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
    } finally {
        sincronizacaoEmAndamento = false;
    }
}

function normalizarFeedbackPayload(feedbackPayload = {}) {
    return {
        status: feedbackPayload.feedbackStatus || feedbackPayload.status || feedbackPayload.label || 'pendente',
        reason: feedbackPayload.feedbackReason || feedbackPayload.reason || '',
        editedGeometry: feedbackPayload.editedGeometry || feedbackPayload.geometriaCorrigida,
        originalGeometry: feedbackPayload.originalGeometry || feedbackPayload.geometriaOriginal,
        timestamp: feedbackPayload.timestamp || feedbackPayload.createdAt || new Date().toISOString()
    };
}

function obterAnelExternoDescritor(geometry) {
    if (!geometry) return null;

    if (geometry.type === 'Polygon') {
        return Array.isArray(geometry.coordinates?.[0]) ? geometry.coordinates[0] : null;
    }

    if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
        const candidatos = geometry.coordinates
            .map((poly) => (Array.isArray(poly?.[0]) ? poly[0] : null))
            .filter((ring) => Array.isArray(ring) && ring.length >= 4);
        if (candidatos.length === 0) return null;

        let melhor = candidatos[0];
        let melhorArea = 0;
        candidatos.forEach((ring) => {
            let area = 0;
            for (let i = 0; i < ring.length - 1; i++) {
                const [x1, y1] = ring[i];
                const [x2, y2] = ring[i + 1];
                area += (x1 * y2) - (x2 * y1);
            }
            const absArea = Math.abs(area);
            if (absArea > melhorArea) {
                melhorArea = absArea;
                melhor = ring;
            }
        });
        return melhor;
    }

    return null;
}

function pontoDentroPoligono(x, y, pontos) {
    let inside = false;
    for (let i = 0, j = pontos.length - 1; i < pontos.length; j = i++) {
        const xi = pontos[i].x;
        const yi = pontos[i].y;
        const xj = pontos[j].x;
        const yj = pontos[j].y;

        const intersecta = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
        if (intersecta) inside = !inside;
    }
    return inside;
}

function arredondarNumero(valor, casas = 4) {
    if (!Number.isFinite(valor)) return 0;
    return Number(valor.toFixed(casas));
}

async function extrairDescritoresVisuaisCompactos(geometry) {
    if (!geometry || typeof leafletImage !== 'function' || !window.map) return null;

    const ring = obterAnelExternoDescritor(geometry);
    if (!Array.isArray(ring) || ring.length < 4) return null;

    const canvas = await new Promise((resolve) => {
        leafletImage(window.map, (err, mapCanvas) => {
            if (err || !mapCanvas) {
                resolve(null);
                return;
            }
            resolve(mapCanvas);
        });
    });

    if (!canvas) return null;

    let imageData;
    try {
        imageData = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    } catch {
        return null;
    }

    const pontos = ring.map(([lng, lat]) => window.map.latLngToContainerPoint([lat, lng]));
    if (pontos.length < 3) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    pontos.forEach((p) => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    });

    minX = Math.max(1, Math.floor(minX));
    minY = Math.max(1, Math.floor(minY));
    maxX = Math.min(canvas.width - 2, Math.ceil(maxX));
    maxY = Math.min(canvas.height - 2, Math.ceil(maxY));

    const bboxW = Math.max(0, maxX - minX + 1);
    const bboxH = Math.max(0, maxY - minY + 1);
    if (bboxW === 0 || bboxH === 0) return null;

    const alvoAmostras = 4000;
    const stride = Math.max(1, Math.floor(Math.sqrt((bboxW * bboxH) / alvoAmostras)));
    const data = imageData.data;
    const width = imageData.width;

    let n = 0;
    let somaR = 0;
    let somaG = 0;
    let somaB = 0;
    let somaL = 0;
    let somaR2 = 0;
    let somaG2 = 0;
    let somaB2 = 0;
    let somaL2 = 0;
    let somaGrad = 0;
    let somaGrad2 = 0;
    let bordas = 0;

    for (let y = minY; y <= maxY; y += stride) {
        for (let x = minX; x <= maxX; x += stride) {
            if (!pontoDentroPoligono(x + 0.5, y + 0.5, pontos)) continue;

            const idx = ((y * width) + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const lum = (0.299 * r) + (0.587 * g) + (0.114 * b);

            const idxL = ((y * width) + (x - 1)) * 4;
            const idxR = ((y * width) + (x + 1)) * 4;
            const idxU = (((y - 1) * width) + x) * 4;
            const idxD = (((y + 1) * width) + x) * 4;

            const lumL = (0.299 * data[idxL]) + (0.587 * data[idxL + 1]) + (0.114 * data[idxL + 2]);
            const lumR = (0.299 * data[idxR]) + (0.587 * data[idxR + 1]) + (0.114 * data[idxR + 2]);
            const lumU = (0.299 * data[idxU]) + (0.587 * data[idxU + 1]) + (0.114 * data[idxU + 2]);
            const lumD = (0.299 * data[idxD]) + (0.587 * data[idxD + 1]) + (0.114 * data[idxD + 2]);

            const gx = (lumR - lumL) * 0.5;
            const gy = (lumD - lumU) * 0.5;
            const grad = Math.sqrt((gx * gx) + (gy * gy));

            somaR += r;
            somaG += g;
            somaB += b;
            somaL += lum;
            somaR2 += r * r;
            somaG2 += g * g;
            somaB2 += b * b;
            somaL2 += lum * lum;
            somaGrad += grad;
            somaGrad2 += grad * grad;
            if (grad >= 28) bordas += 1;
            n += 1;
        }
    }

    if (n < 40) return null;

    const mediaR = somaR / n;
    const mediaG = somaG / n;
    const mediaB = somaB / n;
    const mediaL = somaL / n;
    const mediaGrad = somaGrad / n;

    const stdR = Math.sqrt(Math.max(0, (somaR2 / n) - (mediaR * mediaR)));
    const stdG = Math.sqrt(Math.max(0, (somaG2 / n) - (mediaG * mediaG)));
    const stdB = Math.sqrt(Math.max(0, (somaB2 / n) - (mediaB * mediaB)));
    const stdL = Math.sqrt(Math.max(0, (somaL2 / n) - (mediaL * mediaL)));
    const stdGrad = Math.sqrt(Math.max(0, (somaGrad2 / n) - (mediaGrad * mediaGrad)));

    return {
        version: 'vd_v1',
        sampleCount: n,
        samplingStridePx: stride,
        colorMeanRgb: [arredondarNumero(mediaR, 2), arredondarNumero(mediaG, 2), arredondarNumero(mediaB, 2)],
        colorStdRgb: [arredondarNumero(stdR, 2), arredondarNumero(stdG, 2), arredondarNumero(stdB, 2)],
        luminanceMean: arredondarNumero(mediaL, 2),
        luminanceStd: arredondarNumero(stdL, 2),
        gradientMean: arredondarNumero(mediaGrad, 3),
        gradientStd: arredondarNumero(stdGrad, 3),
        edgeDensity: arredondarNumero(bordas / n, 4)
    };
}

async function enriquecerFeedbackComDescritoresVisuais(feedbackPayload = {}) {
    if (!feedbackPayload || feedbackPayload.visualDescriptors) return feedbackPayload;

    const geometry = feedbackPayload.editedGeometry || feedbackPayload.featureGeometry || feedbackPayload.originalGeometry;
    if (!geometry) return feedbackPayload;

    try {
        const visualDescriptors = await extrairDescritoresVisuaisCompactos(geometry);
        if (!visualDescriptors) return feedbackPayload;
        return {
            ...feedbackPayload,
            visualDescriptors
        };
    } catch {
        return feedbackPayload;
    }
}

function normalizarTextoLivre(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function categorizarMotivoRejeicao(motivo = '') {
    const texto = normalizarTextoLivre(motivo);
    if (!texto) return 'sem_motivo';

    if (texto.includes('sombra')) return 'sombra';
    if (texto.includes('grama') || texto.includes('relva') || texto.includes('veget') || texto.includes('arvore') || texto.includes('mato')) return 'vegetacao';
    if (texto.includes('solo') || texto.includes('terra') || texto.includes('areia') || texto.includes('chao') || texto.includes('barro')) return 'solo';
    if (texto.includes('agua') || texto.includes('rio') || texto.includes('lago') || texto.includes('reservatorio')) return 'agua';
    if (texto.includes('rua') || texto.includes('asfalto') || texto.includes('estrada') || texto.includes('pista')) return 'rua';
    if (texto.includes('fragment') || texto.includes('quebrado') || texto.includes('incompleto')) return 'fragmentado';
    if (texto.includes('ruido') || texto.includes('noise') || texto.includes('artefato')) return 'ruido';
    if (texto.includes('borda') || texto.includes('limite') || texto.includes('contorno')) return 'borda';

    return 'outro';
}

function avaliarQualidadeFeedback(feedbackPayload = {}) {
    const status = feedbackPayload.feedbackStatus || feedbackPayload.status || 'pendente';
    const reason = String(feedbackPayload.feedbackReason || feedbackPayload.reason || '').trim();
    const scoreConfianca = Number(feedbackPayload.featureSnapshot ?.confidenceScore || 0);
    const areaM2 = Number(feedbackPayload.featureSnapshot ?.areaM2 || 0);
    const flags = [];
    let score = 100;

    if (status === 'rejeitado') {
        const categoria = categorizarMotivoRejeicao(reason);

        if (reason.length < 3) {
            score -= 50;
            flags.push('motivo-curto');
        }

        if (!REJECTION_REASON_CATEGORIES.includes(categoria)) {
            score -= 10;
            flags.push('categoria-fraca');
        }
    }

    if (status === 'aprovado' || status === 'correto') {
        if (scoreConfianca < 20) {
            score -= 40;
            flags.push('aprovacao-score-muito-baixo');
        } else if (scoreConfianca < 35) {
            score -= 20;
            flags.push('aprovacao-score-baixo');
        }
    }

    if (status === 'editado') {
        if (!feedbackPayload.editedGeometry || !feedbackPayload.originalGeometry) {
            score -= 50;
            flags.push('edicao-sem-geometria');
        }
        if (reason.length < 5) {
            score -= 20;
            flags.push('edicao-motivo-fraco');
        }
    }

    if (Number.isFinite(areaM2) && areaM2 > 0 && areaM2 < Math.max(5, CONFIG.minArea * 0.35)) {
        score -= 10;
        flags.push('area-muito-pequena');
    }

    score = Math.max(0, Math.min(100, score));
    return {
        score,
        flags,
        aptoTreino: score >= FEEDBACK_QUALITY_MIN_SCORE
    };
}

function median(values = []) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function snapshotConfigAssist(config = CONFIG) {
    return {
        edgeThreshold: Number(config.edgeThreshold),
        morphologySize: Number(config.morphologySize),
        minArea: Number(config.minArea),
        simplification: Number(config.simplification),
        contrastBoost: Number(config.contrastBoost),
        minQualityScore: Number(config.minQualityScore),
        mergeDistance: Number(config.mergeDistance),
        clusteringEnabled: Boolean(config.clusteringEnabled),
        clusterEps: Number(config.clusterEps),
        clusterMinPts: Number(config.clusterMinPts),
        minClusterSize: Number(config.minClusterSize),
        presetProfile: String(config.presetProfile || 'manual')
    };
}

function sincronizarControlesComConfig(config = CONFIG) {
    document.getElementById('edgeThreshold').value = config.edgeThreshold;
    document.getElementById('edgeThresholdInput').value = config.edgeThreshold;
    document.getElementById('morphologySize').value = config.morphologySize;
    document.getElementById('morphologySizeInput').value = config.morphologySize;
    document.getElementById('minArea').value = config.minArea;
    document.getElementById('minAreaInput').value = Number(config.minArea).toFixed(0);
    document.getElementById('contrastBoost').value = config.contrastBoost;
    document.getElementById('contrastBoostInput').value = Number(config.contrastBoost).toFixed(1);
    document.getElementById('simplification').value = config.simplification;
    document.getElementById('simplificationInput').value = Number(config.simplification).toFixed(6);
}

function aplicarGuardrailsAssist(candidato, preset) {
    const presetKey = String(preset || 'manual').toLowerCase();
    const ranges = ASSIST_SCENARIO_GUARDRAILS[presetKey] || ASSIST_SCENARIO_GUARDRAILS.manual;

    return {
        ...candidato,
        edgeThreshold: Math.round(clamp(candidato.edgeThreshold, ranges.edgeThreshold[0], ranges.edgeThreshold[1])),
        morphologySize: Math.max(1, Math.round(clamp(candidato.morphologySize, ranges.morphologySize[0], ranges.morphologySize[1]))),
        minArea: Number(clamp(candidato.minArea, ranges.minArea[0], ranges.minArea[1]).toFixed(2)),
        contrastBoost: Number(clamp(candidato.contrastBoost, ranges.contrastBoost[0], ranges.contrastBoost[1]).toFixed(2)),
        simplification: Number(clamp(candidato.simplification, ranges.simplification[0], ranges.simplification[1]).toFixed(6))
    };
}

function carregarTelemetriaAssist() {
    try {
        const raw = localStorage.getItem(ASSIST_TELEMETRY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function salvarTelemetriaAssist(lista = []) {
    try {
        localStorage.setItem(ASSIST_TELEMETRY_KEY, JSON.stringify(lista.slice(-ASSIST_TELEMETRY_MAX)));
    } catch {
        // sem-op
    }
}

function carregarEstadoAssist() {
    try {
        const raw = localStorage.getItem(ASSIST_STATE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function salvarEstadoAssist(state = {}) {
    try {
        localStorage.setItem(ASSIST_STATE_KEY, JSON.stringify(state));
    } catch {
        // sem-op
    }
}

function limitarDeltaAssist(configBaseline, configCandidata) {
    const base = configBaseline;
    const cand = configCandidata;
    const out = { ...cand };

    out.edgeThreshold = Math.round(clamp(
        Number(cand.edgeThreshold),
        Number(base.edgeThreshold) - ASSIST_DELTA_LIMITS.edgeThresholdAbs,
        Number(base.edgeThreshold) + ASSIST_DELTA_LIMITS.edgeThresholdAbs
    ));

    out.morphologySize = Math.max(1, Math.round(clamp(
        Number(cand.morphologySize),
        Number(base.morphologySize) - ASSIST_DELTA_LIMITS.morphologySizeAbs,
        Number(base.morphologySize) + ASSIST_DELTA_LIMITS.morphologySizeAbs
    )));

    const areaMin = Number(base.minArea) * (1 - ASSIST_DELTA_LIMITS.minAreaRel);
    const areaMax = Number(base.minArea) * (1 + ASSIST_DELTA_LIMITS.minAreaRel);
    out.minArea = Number(clamp(Number(cand.minArea), areaMin, areaMax).toFixed(2));

    out.contrastBoost = Number(clamp(
        Number(cand.contrastBoost),
        Number(base.contrastBoost) - ASSIST_DELTA_LIMITS.contrastBoostAbs,
        Number(base.contrastBoost) + ASSIST_DELTA_LIMITS.contrastBoostAbs
    ).toFixed(2));

    const simpMin = Number(base.simplification) * (1 - ASSIST_DELTA_LIMITS.simplificationRel);
    const simpMax = Number(base.simplification) * (1 + ASSIST_DELTA_LIMITS.simplificationRel);
    out.simplification = Number(clamp(Number(cand.simplification), simpMin, simpMax).toFixed(6));

    return out;
}

function suavizarConfigAssistPorHistorico(configCandidata, preset) {
    const estado = carregarEstadoAssist();
    const presetKey = String(preset || 'manual').toLowerCase();
    const ultimo = estado[presetKey]?.lastApplied;
    if (!ultimo || typeof ultimo !== 'object') {
        return { ...configCandidata };
    }

    const blend = (anterior, atual) => {
        if (!Number.isFinite(anterior) || !Number.isFinite(atual)) return atual;
        return (anterior * (1 - ASSIST_SMOOTH_ALPHA)) + (atual * ASSIST_SMOOTH_ALPHA);
    };

    return {
        ...configCandidata,
        edgeThreshold: Math.round(blend(Number(ultimo.edgeThreshold), Number(configCandidata.edgeThreshold))),
        morphologySize: Math.max(1, Math.round(blend(Number(ultimo.morphologySize), Number(configCandidata.morphologySize)))),
        minArea: Number(blend(Number(ultimo.minArea), Number(configCandidata.minArea)).toFixed(2)),
        contrastBoost: Number(blend(Number(ultimo.contrastBoost), Number(configCandidata.contrastBoost)).toFixed(2)),
        simplification: Number(blend(Number(ultimo.simplification), Number(configCandidata.simplification)).toFixed(6))
    };
}

function atualizarEstadoAssistPosExecucao(configAplicada, preset) {
    const estado = carregarEstadoAssist();
    const presetKey = String(preset || 'manual').toLowerCase();
    estado[presetKey] = {
        ...(estado[presetKey] || {}),
        lastApplied: {
            edgeThreshold: Number(configAplicada.edgeThreshold),
            morphologySize: Number(configAplicada.morphologySize),
            minArea: Number(configAplicada.minArea),
            contrastBoost: Number(configAplicada.contrastBoost),
            simplification: Number(configAplicada.simplification)
        },
        updatedAt: new Date().toISOString()
    };
    salvarEstadoAssist(estado);
}

function obterFatorPesoAssistPorTelemetria(preset) {
    const dados = carregarTelemetriaAssist();
    const presetKey = String(preset || 'manual').toLowerCase();
    const recentes = dados
        .filter((item) => String(item?.preset || '').toLowerCase() === presetKey)
        .slice(-20);

    if (recentes.length < 6) return 1;

    const mediaQualidade = recentes.reduce((acc, item) => acc + Number(item?.qualityIndex || 0), 0) / recentes.length;
    const benchValidos = recentes
        .map((item) => Number(item?.benchmark?.f1 || NaN))
        .filter((n) => Number.isFinite(n));
    const mediaF1 = benchValidos.length > 0 ?
        (benchValidos.reduce((a, b) => a + b, 0) / benchValidos.length) :
        null;

    let fator = 1;
    if (mediaQualidade < 0.45) fator -= 0.12;
    else if (mediaQualidade > 0.7) fator += 0.08;

    if (mediaF1 !== null) {
        if (mediaF1 < 0.35) fator -= 0.12;
        else if (mediaF1 > 0.65) fator += 0.08;
    }

    return clamp(fator, 0.7, 1.2);
}

function construirBoundsFeature(bounds) {
    if (!bounds) return null;
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    return turf.polygon([[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south]
    ]]);
}

function obterReferenciasManuaisBenchmark(bounds) {
    const bboxFeature = construirBoundsFeature(bounds);
    if (!bboxFeature) return [];

    return manualPolygonFeatures
        .filter((f) => normalizarTipoBenfeitoria(f?.properties?.tipo_benfeitoria) !== 'nao_classificada')
        .map((f) => ({ type: 'Feature', geometry: f.geometry, properties: f.properties || {} }))
        .filter((f) => {
            try {
                return turf.booleanIntersects(f, bboxFeature);
            } catch {
                return false;
            }
        });
}

function calcularIoUFeatures(featureA, featureB) {
    try {
        if (!turf.booleanIntersects(featureA, featureB)) return 0;
        const inter = intersectSafe(featureA, featureB);
        if (!inter) return 0;
        const areaInter = turf.area(inter);
        const areaA = turf.area(featureA);
        const areaB = turf.area(featureB);
        const areaUniao = areaA + areaB - areaInter;
        if (!Number.isFinite(areaUniao) || areaUniao <= 0) return 0;
        return areaInter / areaUniao;
    } catch {
        return 0;
    }
}

function calcularBenchmarkCenario(autoFeatures = [], referenciasManuais = []) {
    if (!Array.isArray(autoFeatures) || !Array.isArray(referenciasManuais) || referenciasManuais.length === 0) {
        return null;
    }

    const usadosRef = new Set();
    let tp = 0;
    let somaIou = 0;

    autoFeatures.forEach((autoF) => {
        let melhorIou = 0;
        let melhorIdx = -1;

        referenciasManuais.forEach((refF, idx) => {
            if (usadosRef.has(idx)) return;
            const iou = calcularIoUFeatures(autoF, refF);
            if (iou > melhorIou) {
                melhorIou = iou;
                melhorIdx = idx;
            }
        });

        if (melhorIou >= 0.5 && melhorIdx >= 0) {
            tp += 1;
            somaIou += melhorIou;
            usadosRef.add(melhorIdx);
        }
    });

    const fp = Math.max(0, autoFeatures.length - tp);
    const fn = Math.max(0, referenciasManuais.length - tp);
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const iouMedio = tp > 0 ? somaIou / tp : 0;

    return {
        tp,
        fp,
        fn,
        precision: Number(precision.toFixed(4)),
        recall: Number(recall.toFixed(4)),
        f1: Number(f1.toFixed(4)),
        iouMedio: Number(iouMedio.toFixed(4)),
        referencias: referenciasManuais.length,
        autos: autoFeatures.length
    };
}

function registrarTelemetriaAssist(payload = {}) {
    const historico = carregarTelemetriaAssist();
    historico.push(payload);
    salvarTelemetriaAssist(historico);
}

async function calibrarPresetComHistorico(tipoPreset, presetBase) {
    try {
        const [runs, feedback] = await Promise.all([
            idbGetAll('runs'),
            idbGetAll('feedback')
        ]);

        if (!Array.isArray(runs) || !Array.isArray(feedback) || runs.length === 0 || feedback.length === 0) {
            return { applied: false, reason: 'sem_historico' };
        }

        const runIdsPreset = new Set(
            runs
            .filter((run) => run ?.config ?.presetProfile === tipoPreset)
            .map((run) => run.runId)
            .filter(Boolean)
        );

        if (runIdsPreset.size === 0) {
            return { applied: false, reason: 'sem_runs_do_preset' };
        }

        const feedbackElegivel = feedback.filter((fb) => {
            if (!runIdsPreset.has(fb.runId)) return false;
            if (fb.trainingEligible === false) return false;
            const status = fb.label || fb.feedbackStatus || fb.status || '';
            return status === 'aprovado' || status === 'correto' || status === 'rejeitado';
        });

        if (feedbackElegivel.length < 12) {
            return { applied: false, reason: 'amostra_pequena', sample: feedbackElegivel.length };
        }

        const aprovados = feedbackElegivel.filter((fb) => {
            const status = fb.label || fb.feedbackStatus || fb.status || '';
            return status === 'aprovado' || status === 'correto';
        });
        const rejeitados = feedbackElegivel.filter((fb) => (fb.label || fb.feedbackStatus || fb.status || '') === 'rejeitado');

        const approvedScores = aprovados
            .map((fb) => Number(fb.featureSnapshot ?.confidenceScore ?? fb.finalQualityScore ?? NaN))
            .filter((n) => Number.isFinite(n));
        const rejectedScores = rejeitados
            .map((fb) => Number(fb.featureSnapshot ?.confidenceScore ?? fb.finalQualityScore ?? NaN))
            .filter((n) => Number.isFinite(n));

        const approvedAreas = aprovados
            .map((fb) => Number(fb.featureSnapshot ?.areaM2 ?? NaN))
            .filter((n) => Number.isFinite(n) && n > 0);
        const rejectedAreas = rejeitados
            .map((fb) => Number(fb.featureSnapshot ?.areaM2 ?? NaN))
            .filter((n) => Number.isFinite(n) && n > 0);

        const baseQuality = Number(presetBase.minQualityScore);
        const baseArea = Number(presetBase.minArea);
        const baseEdge = Number(presetBase.edgeThreshold);

        const medApprovedScore = median(approvedScores);
        const medRejectedScore = median(rejectedScores);
        const medApprovedArea = median(approvedAreas);
        const medRejectedArea = median(rejectedAreas);

        const aprovadosBaixoScore = approvedScores.filter((s) => s < baseQuality).length;
        const rejeitadosAltoScore = rejectedScores.filter((s) => s >= baseQuality).length;
        const ratioAprovadosBaixo = approvedScores.length > 0 ? aprovadosBaixoScore / approvedScores.length : 0;
        const ratioRejeitadosAlto = rejectedScores.length > 0 ? rejeitadosAltoScore / rejectedScores.length : 0;

        let deltaQuality = 0;
        deltaQuality += (ratioRejeitadosAlto * 14);
        deltaQuality -= (ratioAprovadosBaixo * 12);

        if (medApprovedScore && medRejectedScore) {
            const midpoint = (medApprovedScore + medRejectedScore) / 2;
            deltaQuality += (midpoint - baseQuality) * 0.18;
        }

        const aprovadosPequenos = approvedAreas.filter((a) => a < baseArea).length;
        const rejeitadosPequenos = rejectedAreas.filter((a) => a < baseArea).length;
        const ratioAprovadosPequenos = approvedAreas.length > 0 ? aprovadosPequenos / approvedAreas.length : 0;
        const ratioRejeitadosPequenos = rejectedAreas.length > 0 ? rejeitadosPequenos / rejectedAreas.length : 0;

        let deltaArea = 0;
        deltaArea += ratioRejeitadosPequenos * 8;
        deltaArea -= ratioAprovadosPequenos * 7;

        if (medApprovedArea && medRejectedArea) {
            const midpointArea = (medApprovedArea + medRejectedArea) / 2;
            deltaArea += (midpointArea - baseArea) * 0.12;
        }

        const categoriasRejeicao = rejeitados.reduce((acc, fb) => {
            const cat = fb.hardNegativeCategory || categorizarMotivoRejeicao(fb.feedbackReason || fb.reason || '');
            acc[cat] = (acc[cat] || 0) + 1;
            return acc;
        }, {});

        let deltaEdge = 0;
        const totalRejeitados = rejeitados.length || 1;
        const ratioRuidoSombra = ((categoriasRejeicao.ruido || 0) + (categoriasRejeicao.sombra || 0)) / totalRejeitados;
        const ratioFragmentado = (categoriasRejeicao.fragmentado || 0) / totalRejeitados;
        deltaEdge += ratioRuidoSombra * 10;
        deltaEdge -= ratioFragmentado * 8;

        const ajustes = {
            minQualityScore: Math.round(clamp(
                baseQuality + deltaQuality,
                CALIBRACAO_PRESET_LIMITES.minQualityScore.min,
                CALIBRACAO_PRESET_LIMITES.minQualityScore.max
            )),
            minArea: Number(clamp(
                baseArea + deltaArea,
                CALIBRACAO_PRESET_LIMITES.minArea.min,
                CALIBRACAO_PRESET_LIMITES.minArea.max
            ).toFixed(1)),
            edgeThreshold: Math.round(clamp(
                baseEdge + deltaEdge,
                CALIBRACAO_PRESET_LIMITES.edgeThreshold.min,
                CALIBRACAO_PRESET_LIMITES.edgeThreshold.max
            ))
        };

        const changed = (
            ajustes.minQualityScore !== presetBase.minQualityScore ||
            ajustes.minArea !== presetBase.minArea ||
            ajustes.edgeThreshold !== presetBase.edgeThreshold
        );

        return {
            applied: changed,
            ajustes,
            stats: {
                amostra: feedbackElegivel.length,
                aprovados: aprovados.length,
                rejeitados: rejeitados.length,
                medApprovedScore,
                medRejectedScore,
                medApprovedArea,
                medRejectedArea
            }
        };
    } catch (error) {
        console.warn('⚠️ Calibração de preset não aplicada:', error);
        return { applied: false, reason: 'erro', error: error ?.message || String(error) };
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

function parseCoordBusca(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;

    const cleaned = rawValue
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/;/g, ',');

    const match = cleaned.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*,\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (!match) return null;

    const first = Number(match[1].replace(',', '.'));
    const second = Number(match[2].replace(',', '.'));

    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;

    let lat = first;
    let lng = second;

    if (Math.abs(first) > 90 && Math.abs(second) <= 90) {
        lat = second;
        lng = first;
    }

    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

    return { lat, lng };
}

function criarPopupCoordenada(lat, lng, titulo = 'Coordenada capturada') {
    const texto = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    return `
    <strong>${titulo}</strong><br>
    <code>${texto}</code><br>
    <button type="button" onclick="copiarCoordenadaCapturada('${texto}')" style="margin-top: 6px;">Copiar</button>
  `;
}

function atualizarUiCapturaCoordenada() {
    const btn = document.getElementById('btnCapturePoint');
    const status = document.getElementById('capturePointStatus');
    if (!btn || !status) return;

    if (modoCapturaCoordenada) {
        btn.textContent = '❌ Cancelar Captura de Coordenada';
        btn.style.background = '#dc2626';
        btn.style.color = '#ffffff';
        status.textContent = 'Modo ativo: clique em um ponto no mapa para capturar latitude e longitude.';
        status.style.color = '#b91c1c';
    } else {
        btn.textContent = '📍 Capturar Coordenada';
        btn.style.background = '';
        btn.style.color = '';
        status.textContent = 'Modo desativado. Clique no botao para capturar um ponto no mapa.';
        status.style.color = '#6b7280';
    }
}

function definirModoCapturaCoordenada(ativo) {
    modoCapturaCoordenada = Boolean(ativo);
    if (window.map ?.getContainer) {
        window.map.getContainer().style.cursor = modoCapturaCoordenada ? 'crosshair' : '';
    }

    atualizarUiCapturaCoordenada();
    if (modoCapturaCoordenada) {
        mostrarNotificacao('📍 Modo captura ativo. Clique no mapa para obter a coordenada.', 'info');
    }
}

async function copiarCoordenadaCapturada(texto) {
    try {
        if (navigator ?.clipboard ?.writeText) {
            await navigator.clipboard.writeText(texto);
        } else {
            const area = document.createElement('textarea');
            area.value = texto;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
        }
        mostrarNotificacao(`📋 Coordenada copiada: ${texto}`, 'success');
    } catch (error) {
        console.error('Erro ao copiar coordenada:', error);
        alert(`Não foi possível copiar automaticamente.\n\nCoordenada: ${texto}`);
    }
}

function capturarCoordenadaNoMapa(evento) {
    if (!modoCapturaCoordenada || !evento ?.latlng) return;

    const lat = Number(evento.latlng.lat);
    const lng = Number(evento.latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const popupHtml = criarPopupCoordenada(lat, lng, 'Ponto capturado');
    marcarResultadoBusca(lat, lng, popupHtml, { zoom: map.getZoom() });
    definirModoCapturaCoordenada(false);
}

function marcarResultadoBusca(lat, lng, label = 'Local encontrado', opcoes = {}) {
    if (!window.map) return;

    const zoomDestino = Number.isFinite(opcoes.zoom) ? opcoes.zoom : 19;

    if (searchResultMarker) {
        map.removeLayer(searchResultMarker);
    }

    searchResultMarker = L.marker([lat, lng]).addTo(map);
    searchResultMarker.bindPopup(label).openPopup();
    map.setView([lat, lng], zoomDestino);
}

async function buscarLocalNoMapa() {
    const input = document.getElementById('mapSearchInput');
    if (!input) return;

    const query = input.value.trim();
    if (!query) {
        alert('Informe um endereço ou coordenada para buscar.');
        return;
    }

    const coord = parseCoordBusca(query);
    if (coord) {
        marcarResultadoBusca(coord.lat, coord.lng, `Coordenada: ${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)}`);
        return;
    }

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
            headers: {
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Falha na busca (${response.status})`);
        }

        const results = await response.json();
        const first = Array.isArray(results) ? results[0] : null;

        if (!first) {
            alert('Nenhum resultado encontrado para este endereço.');
            return;
        }

        const lat = Number(first.lat);
        const lng = Number(first.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            alert('Resultado de endereço inválido.');
            return;
        }

        marcarResultadoBusca(lat, lng, first.display_name || 'Endereço encontrado');
    } catch (error) {
        console.error('Erro ao buscar endereço no mapa:', error);
        alert('Não foi possível buscar o endereço agora. Tente novamente em instantes.');
    }
}

function atualizarStatusAppUi(mensagem, isErro = false) {
    const status = document.getElementById('appStatus');
    if (!status) return;
    status.textContent = mensagem;
    status.style.color = isErro ? '#b91c1c' : '#374151';
}

function arrayBufferParaBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function normalizarGeoJsonApp(geojson) {
    if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('GeoJSON APP inválido: esperado FeatureCollection com features.');
    }

    const featuresValidas = geojson.features.filter((feature) => {
        const tipo = feature ?.geometry ?.type;
        return tipo === 'Polygon' || tipo === 'MultiPolygon';
    });

    if (featuresValidas.length === 0) {
        throw new Error('APP sem polígonos válidos (Polygon/MultiPolygon).');
    }

    return {
        type: 'FeatureCollection',
        features: featuresValidas
    };
}

async function persistirAppBoundary(geojson, metadata = {}) {
    appBoundaryGeoJSON = geojson;
    appBoundaryMetadata = {
        loadedAt: new Date().toISOString(),
        ...metadata
    };

    localStorage.setItem(APP_STORAGE_KEY, JSON.stringify({
        geojson: appBoundaryGeoJSON,
        metadata: appBoundaryMetadata
    }));

    if (firebaseInicializado && estaOnline()) {
        try {
            await salvarAppBoundaryFirestore({
                geojson: appBoundaryGeoJSON,
                metadata: appBoundaryMetadata
            });
            console.log('✅ APP persistida no Firestore global compartilhado.');
        } catch (error) {
            console.warn('⚠️ Não foi possível persistir APP no Firestore. Mantido em cache local.', error);
        }
    }
}

function restaurarAppPersistida() {
    try {
        const raw = localStorage.getItem(APP_STORAGE_KEY);
        if (!raw) {
            atualizarStatusAppUi('Nenhum arquivo APP carregado.');
            return;
        }

        const parsed = JSON.parse(raw);
        appBoundaryGeoJSON = normalizarGeoJsonApp(parsed ?.geojson);
        appBoundaryMetadata = parsed ?.metadata || null;

        const qtd = appBoundaryGeoJSON.features.length;
        const nomeArquivo = appBoundaryMetadata ?.fileName || 'arquivo salvo';
        atualizarStatusAppUi(`APP ativa (${qtd} polígonos) • ${nomeArquivo}`);
    } catch (err) {
        console.warn('Falha ao restaurar APP persistida, limpando cache local:', err);
        localStorage.removeItem(APP_STORAGE_KEY);
        appBoundaryGeoJSON = null;
        appBoundaryMetadata = null;
        atualizarStatusAppUi('Nenhum arquivo APP carregado.');
    }
}

async function restaurarAppPersistidaDoFirestoreSeNecessario() {
    if (!firebaseInicializado || !estaOnline()) {
        return;
    }

    if (appBoundaryGeoJSON) {
        return;
    }

    try {
        const remoto = await lerAppBoundaryFirestore();
        const geojsonRemoto = normalizarGeoJsonApp(remoto ?.geojson);
        const metadataRemota = remoto ?.metadata || {};

        appBoundaryGeoJSON = geojsonRemoto;
        appBoundaryMetadata = metadataRemota;

        localStorage.setItem(APP_STORAGE_KEY, JSON.stringify({
            geojson: appBoundaryGeoJSON,
            metadata: appBoundaryMetadata
        }));

        const qtd = appBoundaryGeoJSON.features.length;
        const nomeArquivo = appBoundaryMetadata ?.fileName || 'arquivo salvo na nuvem';
        atualizarStatusAppUi(`APP ativa (${qtd} polígonos) • ${nomeArquivo}`);
        console.log('☁️ APP global restaurada do Firestore para esta instância.');
    } catch (error) {
        if (String(error ?.message || '').includes('inválido')) {
            console.warn('⚠️ APP remota ignorada por formato inválido:', error ?.message || error);

            try {
                await limparAppBoundaryFirestore();
                console.warn('🧹 APP remota inválida removida do Firestore para evitar novos avisos.');
            } catch (cleanupError) {
                console.warn('⚠️ Falha ao remover APP remota inválida do Firestore:', cleanupError ?.message || cleanupError);
            }

            localStorage.removeItem(APP_STORAGE_KEY);
            appBoundaryGeoJSON = null;
            appBoundaryMetadata = null;
            atualizarStatusAppUi('Nenhum arquivo APP carregado.');
            return;
        }
        console.warn('⚠️ Falha ao restaurar APP do Firestore:', error);
    }
}

async function limparAppPersistida() {
    appBoundaryGeoJSON = null;
    appBoundaryMetadata = null;
    localStorage.removeItem(APP_STORAGE_KEY);

    if (firebaseInicializado && estaOnline()) {
        try {
            await limparAppBoundaryFirestore();
            console.log('✅ APP removida do Firestore global compartilhado.');
        } catch (error) {
            console.warn('⚠️ Não foi possível remover APP no Firestore.', error);
        }
    }

    atualizarStatusAppUi('Nenhum arquivo APP carregado.');
    alert('🧹 APP removida do sistema.');
}

async function carregarAppShapefileZip() {
    const input = document.getElementById('appShpZipInput');
    const file = input ?.files ?.[0];

    if (!file) {
        alert('Selecione um arquivo shapefile compactado (.zip).');
        return;
    }

    if (!file.name.toLowerCase().endsWith('.zip')) {
        alert('Arquivo inválido. Envie um shapefile no formato ZIP.');
        return;
    }

    loaderText.textContent = '📥 Convertendo shapefile APP para GeoJSON...';
    loader.style.display = 'flex';
    atualizarStatusAppUi('Processando APP...');

    try {
        const arrayBuffer = await file.arrayBuffer();
        const zipBase64 = arrayBufferParaBase64(arrayBuffer);

        let geojson = null;
        let source = 'shapefile-zip-frontend-fallback';

        try {
            loaderText.textContent = '📥 Convertendo APP localmente...';
            geojson = await converterShapefileZipLocal(arrayBuffer);
        } catch (frontendError) {
            console.warn('⚠️ Conversão local falhou; tentando backend de contingência:', frontendError ?.message || frontendError);
            loaderText.textContent = '📥 Conversão local falhou; tentando backend...';

            const response = await fetch('/api/shp-to-geojson', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    fileName: file.name,
                    zipBase64
                })
            });

            const rawText = await response.text();
            let payload = null;
            if (rawText) {
                try {
                    payload = JSON.parse(rawText);
                } catch {
                    payload = null;
                }
            }

            if (!response.ok || !payload ?.success) {
                throw new Error(payload ?.error || `Falha ao converter APP (${response.status})`);
            }

            geojson = normalizarGeoJsonApp(payload.geojson);
            source = 'shapefile-zip-backend-contingencia';
        }

        await persistirAppBoundary(geojson, {
            fileName: file.name,
            source
        });

        atualizarStatusAppUi(`APP ativa (${geojson.features.length} polígonos) • ${file.name}`);
        alert(`✅ APP carregada com sucesso!\n\nPolígonos APP: ${geojson.features.length}\n\nA camada foi salva de forma oculta para cálculo de sobreposição.`);
    } catch (error) {
        console.error('Erro ao carregar APP:', error);
        atualizarStatusAppUi(`Erro ao carregar APP: ${error.message}`, true);
        alert(`❌ Erro ao carregar APP\n\n${error.message}`);
    } finally {
        loader.style.display = 'none';
    }
}

function normalizarResultadoShpJs(result) {
    if (!result) return null;

    if (result.type === 'FeatureCollection' && Array.isArray(result.features)) {
        return result;
    }

    if (Array.isArray(result)) {
        const features = result
            .filter((item) => item ?.type === 'FeatureCollection' && Array.isArray(item.features))
            .flatMap((item) => item.features || []);

        return {
            type: 'FeatureCollection',
            features
        };
    }

    return null;
}

async function converterShapefileZipLocal(arrayBuffer) {
    const moduleShp = await
    import ('shpjs');
    const shp = moduleShp ?.default || moduleShp;
    const bruto = await shp(arrayBuffer);
    const geojson = normalizarResultadoShpJs(bruto);

    if (!geojson) {
        throw new Error('Não foi possível interpretar o ZIP da APP localmente.');
    }

    return normalizarGeoJsonApp(geojson);
}

function intersectSafe(featureA, featureB) {
    try {
        return turf.intersect(featureA, featureB);
    } catch {
        // compatibilidade com assinatura que recebe FeatureCollection
    }

    try {
        return turf.intersect(turf.featureCollection([featureA, featureB]));
    } catch {
        return null;
    }
}

function normalizarTipoBenfeitoria(tipo) {
    const valor = String(tipo || '').toLowerCase().trim();
    if (valor === 'trapiche') return 'trapiche';
    if (valor === 'edificacao' || valor === 'edificação') return 'edificacao';
    if (valor === 'outra' || valor === 'outra_benfeitoria') return 'outra';
    return 'nao_classificada';
}

function obterRotuloTipoBenfeitoria(tipo) {
    const key = normalizarTipoBenfeitoria(tipo);
    return TIPOS_BENFEITORIA[key] || TIPOS_BENFEITORIA.nao_classificada;
}

function obterMascaraVetorizacaoAtiva() {
    if (!currentSelectionMaskFeature) return null;
    const tipo = currentSelectionMaskFeature ?.geometry ?.type;
    if (tipo !== 'Polygon' && tipo !== 'MultiPolygon') return null;
    return currentSelectionMaskFeature;
}

function recortarAppDoRequerente() {
    const mask = obterMascaraVetorizacaoAtiva();
    if (!appBoundaryGeoJSON || !Array.isArray(appBoundaryGeoJSON.features) || !mask) {
        return turf.featureCollection([]);
    }

    const recortes = [];
    for (const appFeature of appBoundaryGeoJSON.features) {
        try {
            if (!turf.booleanIntersects(appFeature, mask)) continue;

            let clipped = null;
            if (turf.booleanWithin(appFeature, mask)) {
                clipped = appFeature;
            } else {
                clipped = intersectSafe(appFeature, mask);
            }

            if (!clipped) continue;
            recortes.push(clipped);
        } catch (error) {
            console.warn('⚠️ Falha ao recortar APP pela máscara de vetorização:', error);
        }
    }

    return turf.featureCollection(recortes);
}

function gerarRelatorioIntersecaoApp() {
    const appDoRequerente = recortarAppDoRequerente();
    const appFeatures = appDoRequerente.features || [];
    const detalhes = [];
    let areaTotalPoligonos = 0;
    let areaTotalIntersecao = 0;
    const areaAppDoRequerente = appFeatures.reduce((acc, f) => acc + turf.area(f), 0);

    for (const feature of geojsonFeatures) {
        const areaPoligono = turf.area(feature);
        areaTotalPoligonos += areaPoligono;

        let areaIntersecao = 0;

        for (const appFeature of appFeatures) {
            const intersecao = intersectSafe(feature, appFeature);
            if (!intersecao) continue;
            areaIntersecao += turf.area(intersecao);
        }

        areaTotalIntersecao += areaIntersecao;

        detalhes.push({
            id: feature ?.properties ?.id || '-',
            tipoBenfeitoria: normalizarTipoBenfeitoria(feature ?.properties ?.tipo_benfeitoria),
            tipoBenfeitoriaLabel: obterRotuloTipoBenfeitoria(feature ?.properties ?.tipo_benfeitoria),
            areaPoligonoM2: areaPoligono,
            areaIntersecaoM2: areaIntersecao,
            percentualIntersecao: areaPoligono > 0 ? (areaIntersecao / areaPoligono) * 100 : 0,
            taxaOcupacao: areaPoligono > 0 ? (areaIntersecao / areaPoligono) * 100 : 0
        });
    }

    const taxaOcupacaoApp = areaAppDoRequerente > 0 ?
        (areaTotalIntersecao / areaAppDoRequerente) * 100 :
        0;

    const percentualBenfeitoriasEmApp = areaTotalPoligonos > 0 ?
        (areaTotalIntersecao / areaTotalPoligonos) * 100 :
        0;

    return {
        generatedAt: new Date().toISOString(),
        appMetadata: appBoundaryMetadata || {},
        appCarregada: Boolean(appBoundaryGeoJSON),
        mascaraVetorizacaoAtiva: Boolean(obterMascaraVetorizacaoAtiva()),
        totalPoligonos: geojsonFeatures.length,
        areaAppDoRequerente,
        areaTotalPoligonos,
        areaTotalIntersecao,
        areaOcupada: areaTotalIntersecao,
        percentualSobreposicaoGeral: percentualBenfeitoriasEmApp,
        taxaOcupacao: taxaOcupacaoApp,
        detalhes
    };
}

function exportarRelatorioAppPdf() {
    if (geojsonFeatures.length === 0) {
        alert('⚠️ Não há polígonos vetorizados para gerar relatório.');
        return;
    }

    const jsPDF = window.jspdf ?.jsPDF;
    if (!jsPDF) {
        alert('❌ Biblioteca de PDF não carregada. Recarregue a página.');
        return;
    }

    let relatorio;
    try {
        relatorio = gerarRelatorioIntersecaoApp();
    } catch (error) {
        alert(`❌ Erro ao calcular relatório: ${error.message}`);
        return;
    }

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const dataHora = new Date(relatorio.generatedAt).toLocaleString('pt-BR');
    const appNome = relatorio.appCarregada ?
        (relatorio.appMetadata ?.fileName || 'APP carregada') :
        'Não carregada';

    let y = 12;
    const addLine = (texto, espacamento = 6) => {
        if (y > 285) {
            doc.addPage();
            y = 12;
        }
        doc.text(texto, 12, y);
        y += espacamento;
    };

    doc.setFontSize(14);
    addLine('Relatório Técnico Preliminar - Ocupação em APP', 8);
    doc.setFontSize(10);
    addLine(`Data e hora da análise: ${dataHora}`);
    addLine(`Base APP utilizada: ${appNome}`);
    addLine(`APP do requerente (m²): ${relatorio.areaAppDoRequerente.toFixed(2)}`);
    addLine(`Quantidade de benfeitorias vetorizadas: ${relatorio.totalPoligonos}`);
    addLine(`Área total das benfeitorias (m²): ${relatorio.areaTotalPoligonos.toFixed(2)}`);
    addLine(`Área ocupada em APP (m²): ${relatorio.areaOcupada.toFixed(2)}`);
    addLine(`Taxa de ocupação em APP (%): ${relatorio.taxaOcupacao.toFixed(2)}`);
    addLine('Observação: valores 0,00 m² podem indicar ausência de APP carregada, APP fora da máscara ou ausência de interseção.', 5);
    addLine('');
    addLine('Detalhamento por benfeitoria vetorizada:');

    relatorio.detalhes.forEach((item) => {
        addLine(
            `${item.id} | Classe: ${item.tipoBenfeitoriaLabel} | Área da benfeitoria: ${item.areaPoligonoM2.toFixed(2)} m² | Área ocupada em APP: ${item.areaIntersecaoM2.toFixed(2)} m² | Percentual da benfeitoria em APP: ${item.percentualIntersecao.toFixed(2)}%`,
            5
        );
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    doc.save(`relatorio_intersecao_app_${stamp}.pdf`);
}

// Função para aplicar pré-configurações
async function aplicarPreset(tipo) {
    let preset;

    switch (tipo) {
        case 'urbano':
            preset = {
                edgeThreshold: 105, // Mais seletivo para reduzir bordas espúrias urbanas
                morphologySize: 5, // Preserva telhados sem unir objetos distintos
                minArea: 35.0, // Remove pequenos artefatos em área densa
                simplification: 0.00002, // Mantém melhor o footprint dos telhados
                contrastBoost: 1.4, // Realce moderado para não estourar sombras
                minQualityScore: 60, // Filtro mais rígido em qualidade
                clusteringEnabled: true,
                clusterEps: 2.2,
                clusterMinPts: 8,
                minClusterSize: 90,
                nome: 'Área Urbana (Precisão Alta)'
            };
            break;

        case 'cobertura':
            preset = {
                edgeThreshold: 72, // Mais sensível para recuperar telhados com bordas fracas
                morphologySize: 3, // Preserva separação entre casas próximas
                minArea: 10.0, // Aceita anexos e telhados menores
                simplification: 0.00001, // Mantém mais detalhes do contorno
                contrastBoost: 1.6, // Realce extra para telhados com pouco contraste
                minQualityScore: 22, // Relaxa o corte por heurística para maximizar recall
                mergeDistance: 1.5, // Evita fundir telhados vizinhos em área densa
                clusteringEnabled: true,
                clusterEps: 2.0,
                clusterMinPts: 4,
                minClusterSize: 20,
                nome: 'Cobertura Máxima (Mais Telhados)'
            };
            break;

        case 'rural':
            preset = {
                edgeThreshold: 65, // Reduzido para capturar edificações em vegetação
                morphologySize: 9, // Muito maior para fechar gaps grandes
                minArea: 40.0, // Aumentado - edificações rurais são maiores
                simplification: 0.00004, // Mais simplificação para reduzir vértices
                contrastBoost: 1.6, // Alto contraste para separar de vegetação
                minQualityScore: 45, // Filtro médio para área rural
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
                minArea: 150.0, // Galpões são grandes
                simplification: 0.00005, // Muita simplificação - formas retangulares
                contrastBoost: 1.4,
                minQualityScore: 50,
                clusteringEnabled: true,
                clusterEps: 2.0,
                clusterMinPts: 7,
                minClusterSize: 60,
                nome: 'Galpões Industriais (Profissional)'
            };
            break;

        case 'trapiche':
            preset = {
                edgeThreshold: 52, // Alta sensibilidade para trapiches estreitos sobre água
                morphologySize: 2, // Evita engrossar passarelas finas durante closing
                minArea: 6.0, // Mantém segmentos menores de píer
                simplification: 0.000005, // Mantém detalhes do contorno
                contrastBoost: 1.8, // Realça bordas fracas em água/sombra
                minQualityScore: 24, // Mais permissivo para geometrias lineares válidas
                mergeDistance: 2.0, // Fusão moderada para evitar unir casas distantes
                clusteringEnabled: true,
                clusterEps: 1.6,
                clusterMinPts: 4,
                minClusterSize: 16,
                nome: 'Trapiches + Telhados (Alta Sensibilidade)'
            };
            break;

        default:
            return;
    }

    const resultadoCalibracao = await calibrarPresetComHistorico(tipo, preset);
    if (resultadoCalibracao ?.applied) {
        preset = {
            ...preset,
            ...resultadoCalibracao.ajustes,
            nome: `${preset.nome} • Calibrado`
        };
        console.log('🤖 Preset calibrado automaticamente:', resultadoCalibracao);
    }

    // Aplicar configurações
    CONFIG.edgeThreshold = preset.edgeThreshold;
    CONFIG.morphologySize = preset.morphologySize;
    CONFIG.minArea = preset.minArea;
    CONFIG.simplification = preset.simplification;
    CONFIG.contrastBoost = preset.contrastBoost;
    CONFIG.minQualityScore = preset.minQualityScore;
    CONFIG.mergeDistance = preset.mergeDistance ?? 3;
    CONFIG.clusteringEnabled = preset.clusteringEnabled;
    CONFIG.clusterEps = preset.clusterEps;
    CONFIG.clusterMinPts = preset.clusterMinPts;
    CONFIG.minClusterSize = preset.minClusterSize;
    CONFIG.presetProfile = tipo;

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
    document.getElementById('mergeDistance').value = CONFIG.mergeDistance;
    document.getElementById('mergeDistanceInput').value = Number(CONFIG.mergeDistance).toFixed(1);
    document.getElementById('clusteringEnabled').checked = preset.clusteringEnabled;
    document.getElementById('clusterEps').value = preset.clusterEps;
    document.getElementById('clusterEpsInput').value = preset.clusterEps.toFixed(1);
    document.getElementById('clusterMinPts').value = preset.clusterMinPts;
    document.getElementById('clusterMinPtsInput').value = preset.clusterMinPts;
    document.getElementById('minClusterSize').value = preset.minClusterSize;
    document.getElementById('minClusterSizeInput').value = preset.minClusterSize;

    let mensagem = `✅ Preset "${preset.nome}" aplicado!\n\n🎯 Configurações profissionais ativadas:\n• Fusão automática de fragmentos\n• Filtros de qualidade otimizados\n• Geometrias simplificadas`;

    if (resultadoCalibracao ?.applied) {
        mensagem += `\n\n🤖 Calibração automática aplicada\nAmostra usada: ${resultadoCalibracao.stats?.amostra || 0} feedbacks elegíveis`;
    }

    alert(mensagem);
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
        minClusterSize: 40,
        presetProfile: 'manual'
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

async function aplicarAutoajustePreVetorizacao() {
    if (!window.autoInferirParametros) {
        return { aplicado: false, estrategia: 'sem_modulo' };
    }

    try {
        const configBaseline = snapshotConfigAssist(CONFIG);
        const prediction = await window.autoInferirParametros(configBaseline);
        if (!prediction) {
            return { aplicado: false, estrategia: 'sem_predicao' };
        }

        const confianca = Number(prediction.qualidadePredita || 0.5);
        const fatorTelemetria = obterFatorPesoAssistPorTelemetria(configBaseline.presetProfile);
        // Sempre auxilia o WASM: baixa confiança => ajuste leve, alta confiança => ajuste mais forte.
        const peso = clamp(clamp(confianca, 0.15, 0.85) * fatorTelemetria, 0.1, 0.9);
        const blend = (base, recomendado) => {
            if (!Number.isFinite(base) || !Number.isFinite(recomendado)) return base;
            return base + (recomendado - base) * peso;
        };

        const configAssistidaCandidata = {
            ...configBaseline,
            edgeThreshold: Math.round(blend(configBaseline.edgeThreshold, Number(prediction.edgeThresholdRecomendado))),
            morphologySize: Math.max(1, Math.round(blend(configBaseline.morphologySize, Number(prediction.morphologySizeRecomendado)))),
            contrastBoost: Number(blend(configBaseline.contrastBoost, Number(prediction.contrastBoostRecomendado)).toFixed(2)),
            minArea: Number(blend(configBaseline.minArea, Number(prediction.minAreaRecomendada)).toFixed(2)),
            simplification: Number(blend(configBaseline.simplification, Number(prediction.simplificationRecomendada)).toFixed(6))
        };

        const configAssistidaComGuardrails = aplicarGuardrailsAssist(
            configAssistidaCandidata,
            configBaseline.presetProfile
        );

        const configAssistidaComDelta = limitarDeltaAssist(
            configBaseline,
            configAssistidaComGuardrails
        );

        const configAssistida = suavizarConfigAssistPorHistorico(
            configAssistidaComDelta,
            configBaseline.presetProfile
        );

        let scoreBaseline = null;
        let scoreAssistido = null;
        if (window.fazerPredictionML) {
            try {
                const [pBaseline, pAssist] = await Promise.all([
                    window.fazerPredictionML(configBaseline),
                    window.fazerPredictionML(configAssistida)
                ]);
                scoreBaseline = Number(pBaseline?.qualidadePredita ?? NaN);
                scoreAssistido = Number(pAssist?.qualidadePredita ?? NaN);
            } catch {
                // sem-op
            }
        }

        const usarAssistido = Number.isFinite(scoreBaseline) && Number.isFinite(scoreAssistido) ?
            scoreAssistido >= (scoreBaseline + 0.005) :
            true;

        const configEscolhida = usarAssistido ? configAssistida : configBaseline;

        CONFIG.edgeThreshold = configEscolhida.edgeThreshold;
        CONFIG.morphologySize = configEscolhida.morphologySize;
        CONFIG.contrastBoost = configEscolhida.contrastBoost;
        CONFIG.minArea = configEscolhida.minArea;
        CONFIG.simplification = configEscolhida.simplification;

        atualizarEstadoAssistPosExecucao(configEscolhida, configBaseline.presetProfile);

        sincronizarControlesComConfig(CONFIG);

        console.log(
            `🤖 Assistência WASM (confiança ${(prediction.qualidadePredita * 100).toFixed(0)}%, peso ${peso.toFixed(2)}, estratégia ${usarAssistido ? 'assistida' : 'baseline'})`
        );

        return {
            aplicado: true,
            estrategia: usarAssistido ? 'assistida' : 'baseline',
            confianca: Number(confianca.toFixed(4)),
            peso: Number(peso.toFixed(4)),
            fatorTelemetria: Number(fatorTelemetria.toFixed(4)),
            scoreBaseline: Number.isFinite(scoreBaseline) ? Number(scoreBaseline.toFixed(4)) : null,
            scoreAssistido: Number.isFinite(scoreAssistido) ? Number(scoreAssistido.toFixed(4)) : null,
            configBaseline,
            configAssistidaComGuardrails,
            configAssistidaComDelta,
            configAssistida,
            configAplicada: snapshotConfigAssist(CONFIG)
        };
    } catch (error) {
        console.warn('⚠️ Não foi possível aplicar autoajuste pré-vetorização:', error);
        return { aplicado: false, estrategia: 'erro', erro: error?.message || String(error) };
    }
}

// Função para limpar resultados
function limparResultados() {
    geojsonFeatures.length = 0;
    manualPolygonFeatures.length = 0;
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
    const allFeatures = [...geojsonFeatures, ...manualPolygonFeatures];
    const totalPolygons = allFeatures.length;
    const totalArea = allFeatures.reduce((sum, f) => sum + parseFloat(f.properties.area_m2 || 0), 0);
    const highQ = geojsonFeatures.filter(f => f.properties.quality === 'alta').length;
    const medQ = geojsonFeatures.filter(f => f.properties.quality === 'media').length;
    const lowQ = geojsonFeatures.filter(f => f.properties.quality === 'baixa').length;
    const manualQ = manualPolygonFeatures.length;

    document.getElementById('totalPolygons').textContent = totalPolygons;
    document.getElementById('totalArea').textContent = totalArea.toFixed(2);
    document.getElementById('highQuality').textContent = highQ;
    document.getElementById('medQuality').textContent = medQ;
    document.getElementById('lowQuality').textContent = lowQ + (manualQ > 0 ? ` (+${manualQ} manuais)` : '');
    document.getElementById('lastProcessTime').textContent = new Date().toLocaleTimeString('pt-BR');
}

// Obter estilo baseado na qualidade
function getStyleByQuality(feature) {
    const colorByQuality = document.getElementById('colorByQuality') ?.checked;

    if (!colorByQuality) {
        return { color: '#00ffcc', weight: 2, fillOpacity: 0.3 };
    }

    const quality = feature.properties.quality;
    let color;

    switch (quality) {
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

function removerPoligonoRejeitado(featureId) {
    if (!featureId) return;

    const idx = geojsonFeatures.findIndex((f) => f.properties ?.id === featureId);
    if (idx >= 0) {
        geojsonFeatures.splice(idx, 1);
    }

    if (window.lastGeoJSONLayer && typeof window.lastGeoJSONLayer.eachLayer === 'function') {
        const layersParaRemover = [];
        window.lastGeoJSONLayer.eachLayer((layer) => {
            if (layer ?.feature ?.properties ?.id === featureId) {
                layersParaRemover.push(layer);
            }
        });

        layersParaRemover.forEach((layer) => {
            window.lastGeoJSONLayer.removeLayer(layer);
        });
    }

    atualizarEstatisticas();
}

function gerarRunId() {
    const random = Math.random().toString(36).slice(2, 8);
    return `run_${Date.now()}_${random}`;
}


function criarPopupFeedback(feature) {
    const props = feature.properties || {};
    const featureId = props.id || '';
    const tipoAtual = normalizarTipoBenfeitoria(props.tipo_benfeitoria);

    return `
    <strong>ID:</strong> ${props.id}<br>
    <strong>Área:</strong> ${props.area_m2} m²<br>
    <strong>Score:</strong> ${props.confidence_score}/100<br>
    <strong>Qualidade:</strong> ${props.quality}<br>
    <strong>Compacidade:</strong> ${props.compactness}<br>
    <strong>Vértices:</strong> ${props.vertices}<br>
    <div style="margin-top: 8px;">
      <label for="tipo_${featureId}"><strong>Classificação:</strong></label><br>
      <select id="tipo_${featureId}" onchange="definirTipoBenfeitoria('${featureId}', this.value)">
        <option value="nao_classificada" ${tipoAtual === 'nao_classificada' ? 'selected' : ''}>Não classificada</option>
        <option value="trapiche" ${tipoAtual === 'trapiche' ? 'selected' : ''}>Trapiche</option>
        <option value="edificacao" ${tipoAtual === 'edificacao' ? 'selected' : ''}>Edificação</option>
        <option value="outra" ${tipoAtual === 'outra' ? 'selected' : ''}>Outra benfeitoria</option>
      </select>
    </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
                <button onclick="ativarEdicaoPoligonoExportacao('${featureId}')" style="flex:1;background:#d97706;color:white;border:none;border-radius:4px;padding:7px 10px;font-size:11px;font-weight:600;cursor:pointer;">✏️ Ajustar Polígono</button>
                <button onclick="deletarPoligonoExportacao('${featureId}')" style="flex:1;background:#dc2626;color:white;border:none;border-radius:4px;padding:7px 10px;font-size:11px;font-weight:600;cursor:pointer;">🗑️ Deletar</button>
        </div>
        <small style="color:#6b7280; font-size:10px; display:block; margin-top:6px;">ℹ️ Ajustes neste polígono afetam apenas a exportação (não entram em feedback/aprendizado).</small>
  `;
}

function definirTipoBenfeitoria(featureId, tipo) {
    const feature = geojsonFeatures.find((f) => f.properties ?.id === featureId);
    if (!feature) return;

    const tipoNormalizado = normalizarTipoBenfeitoria(tipo);
    feature.properties.tipo_benfeitoria = tipoNormalizado;
    feature.properties.feedback_updated_at = new Date().toISOString();

    atualizarVisualizacao();
    mostrarNotificacao(`🏷️ Tipo atualizado para: ${obterRotuloTipoBenfeitoria(tipoNormalizado)}`, 'info');
}

function ativarEdicaoPoligonoExportacao(featureId) {
    window.map.closePopup();

    const feature = geojsonFeatures.find((f) => f.properties?.id === featureId);
    if (!feature) {
        alert('⚠️ Polígono não encontrado para ajuste.');
        return;
    }

    let targetLayer = null;
    if (window.lastGeoJSONLayer) {
        window.lastGeoJSONLayer.eachLayer((layer) => {
            if (layer.feature?.properties?.id === featureId) {
                targetLayer = layer;
            }
        });
    }

    if (!targetLayer) {
        alert('⚠️ Layer não encontrado no mapa para ajuste.');
        return;
    }

    const geometriaOriginal = JSON.parse(JSON.stringify(feature.geometry));
    const latlngs = targetLayer.getLatLngs();
    window.lastGeoJSONLayer.removeLayer(targetLayer);

    const editablePolygon = L.polygon(latlngs, {
        color: '#d97706',
        weight: 4,
        fillOpacity: 0.2,
        fillColor: '#d97706'
    }).addTo(window.map);

    editablePolygon.editing.enable();

    setTimeout(() => {
        const markers = editablePolygon.editing._markers;
        if (markers) {
            markers.forEach((marker) => {
                marker.setIcon(L.divIcon({
                    className: 'leaflet-div-icon-edit-tiny',
                    html: '<div style="width:6px;height:6px;background:white;border:1.5px solid #d97706;border-radius:50%;cursor:move;"></div>',
                    iconSize: [6, 6],
                    iconAnchor: [3, 3]
                }));

                marker.on('click', (e) => {
                    if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) {
                        e.originalEvent.preventDefault();
                        e.originalEvent.stopPropagation();
                        if (editablePolygon.editing._markers.length > 3) {
                            editablePolygon.editing._deleteMarker(marker);
                        } else {
                            alert('⚠️ Um polígono precisa de no mínimo 3 vértices!');
                        }
                    }
                });
            });
        }
    }, 50);

    const instrucoes = L.control({ position: 'bottomright' });
    instrucoes.onAdd = function () {
        const div = L.DomUtil.create('div', 'edit-instructions');
        div.style.cssText = 'background:rgba(0,0,0,0.75);padding:12px;border-radius:6px;max-width:280px;z-index:1000;color:white;backdrop-filter:blur(4px);';
        div.innerHTML = `
      <strong style="color:#f59e0b;font-size:13px;display:block;margin-bottom:8px;">✏️ Ajuste para Exportação</strong>
      <p style="margin:0 0 10px;font-size:11px;line-height:1.5;color:#E0E0E0;">
        <strong>Mover vértice:</strong> arraste os pontos<br>
        <strong>Adicionar ponto:</strong> clique nas linhas<br>
        <strong>Remover vértice:</strong> <kbd style="background:#333;padding:2px 4px;border-radius:2px;">Ctrl</kbd> + Clique<br>
        <strong>Obs:</strong> não registra feedback/aprendizado
      </p>
      <button id="salvar-edicao-export" style="background:#16a34a;color:white;border:none;padding:10px 12px;border-radius:4px;cursor:pointer;width:100%;margin-bottom:6px;font-weight:bold;font-size:12px;">✅ Aplicar Ajuste</button>
      <button id="cancelar-edicao-export" style="background:#dc2626;color:white;border:none;padding:8px 12px;border-radius:4px;cursor:pointer;width:100%;font-size:11px;">❌ Cancelar</button>
    `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    instrucoes.addTo(window.map);

    setTimeout(() => {
        const btnSalvar = document.getElementById('salvar-edicao-export');
        const btnCancelar = document.getElementById('cancelar-edicao-export');

        if (btnSalvar) {
            btnSalvar.addEventListener('click', () => {
                const geometriaEditada = editablePolygon.toGeoJSON().geometry;
                feature.geometry = geometriaEditada;
                feature.properties.vertices = contarVerticesGeometria(geometriaEditada);
                feature.properties.area_m2 = calcularAreaGeometriaM2(geometriaEditada).toFixed(2);

                feature.properties.export_adjusted_at = new Date().toISOString();
                feature.properties.geometria_original_export = geometriaOriginal;

                window.map.removeLayer(editablePolygon);
                instrucoes.remove();
                atualizarVisualizacao();

                mostrarNotificacao('✅ Ajuste aplicado para exportação (sem feedback/aprendizado).', 'info');
            });
        }

        if (btnCancelar) {
            btnCancelar.addEventListener('click', () => {
                window.map.removeLayer(editablePolygon);
                instrucoes.remove();
                atualizarVisualizacao();
            });
        }
    }, 100);
}

function deletarPoligonoExportacao(featureId) {
    if (!featureId) return;

    const feature = geojsonFeatures.find((f) => f.properties?.id === featureId);
    if (!feature) {
        alert('⚠️ Polígono não encontrado para exclusão.');
        return;
    }

    const confirmado = window.confirm('Deseja realmente deletar este polígono? Esta ação afeta apenas o resultado atual para exportação.');
    if (!confirmado) return;

    window.map.closePopup();
    removerPoligonoRejeitado(featureId);
    mostrarNotificacao('🗑️ Polígono removido da exportação atual (sem feedback/aprendizado).', 'info');
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

async function salvarRunLocalExecucao(runPayload) {
    // Execuções automáticas devem persistir apenas localmente
    // (base para exportação SHP e relatório), sem envio para Firestore.
    await idbPut('runs', runPayload);
}

async function salvarRunAprendizado(runPayload) {
    if (!firebaseInicializado || !estaOnline()) {
        throw new Error('Firestore indisponível no momento. Verifique a conexão e tente novamente.');
    }

    // Persistência cloud-only para aprendizado manual
    await salvarRunFirestore(runPayload.runId, runPayload);
    if (runPayload.features && runPayload.features.length > 0) {
        await salvarFeaturesFirestore(runPayload.runId, runPayload.features);
    }

    registrarHeartbeatFirestoreOk();
    console.log(`✅ Run ${runPayload.runId.substring(0, 8)} salva no Firestore`);
}

/**
 * Persiste feedback para aprendizado contínuo em modo cloud-only.
 */
async function salvarFeedbackAprendizado(feedbackPayload) {
    const feedbackComDescritores = await enriquecerFeedbackComDescritoresVisuais(feedbackPayload);
    const feedbackNormalizado = normalizarFeedbackPayload(feedbackComDescritores);
    const tipoBenfeitoria = normalizarTipoBenfeitoria(
        feedbackComDescritores.tipoBenfeitoria || feedbackComDescritores.featureSnapshot ?.tipoBenfeitoria
    );
    const avaliacaoQualidade = avaliarQualidadeFeedback({
        ...feedbackComDescritores,
        ...feedbackNormalizado
    });
    const statusNormalizado = feedbackNormalizado.status;
    const hardNegativeCategory = statusNormalizado === 'rejeitado' ?
        categorizarMotivoRejeicao(feedbackNormalizado.reason) :
        null;

    const payloadFirestore = {
        ...feedbackNormalizado,
        label: statusNormalizado,
        tipoBenfeitoria,
        trainingEligible: avaliacaoQualidade.aptoTreino,
        dataQualityScore: avaliacaoQualidade.score,
        dataQualityFlags: avaliacaoQualidade.flags,
        hardNegativeCategory,
        visualDescriptors: feedbackComDescritores.visualDescriptors
    };

    if (!firebaseInicializado || !estaOnline()) {
        throw new Error('Firestore indisponível no momento. Verifique a conexão e tente novamente.');
    }

    await salvarFeedbackFirestore(
        feedbackComDescritores.runId,
        feedbackComDescritores.featureId,
        payloadFirestore
    );
    registrarHeartbeatFirestoreOk();
    console.log(`✅ Feedback ${feedbackPayload.feedbackId} salvo no Firestore`);

    // Atualiza contagem de exemplos em background para não travar UI.
    if (window.atualizarContagemExemplos) {
        setTimeout(() => {
            window.atualizarContagemExemplos()
                .then(() => {
                    console.log('✅ atualizarContagemExemplos completado (background)');
                })
                .catch((err) => {
                    debugLog('⚠️ Erro ao atualizar contagem de exemplos:', err);
                });
        }, 0);
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

function obterGeometriaFeedbackRejeitado(feedback = {}) {
    return feedback.featureGeometry ||
        feedback.editedGeometry ||
        feedback.originalGeometry ||
        feedback.geometriaCorrigida ||
        feedback.geometriaOriginal ||
        null;
}

function obterStatusFeedback(feedback = {}) {
    return feedback.feedbackStatus || feedback.status || feedback.label || '';
}

function obterCategoriaHardNegative(feedback = {}) {
    if (feedback.hardNegativeCategory) return feedback.hardNegativeCategory;
    return categorizarMotivoRejeicao(feedback.feedbackReason || feedback.reason || '');
}

async function filtrarFeaturesPorMemoriaRejeicao(features, selectionMaskFeature = null) {
    if (!Array.isArray(features) || features.length === 0) return features;

    try {
        const feedbacks = await idbGetAll('feedback');
        if (!Array.isArray(feedbacks) || feedbacks.length === 0) return features;

        const rejeicoes = feedbacks
            .filter((fb) => obterStatusFeedback(fb) === 'rejeitado')
            .filter((fb) => HARD_NEGATIVE_CATEGORIES.has(obterCategoriaHardNegative(fb)))
            .map((fb) => {
                const geometry = obterGeometriaFeedbackRejeitado(fb);
                if (!geometry) return null;
                if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
                return turf.feature(geometry);
            })
            .filter(Boolean)
            .filter((f) => {
                if (!selectionMaskFeature) return true;
                try {
                    return turf.booleanIntersects(f, selectionMaskFeature);
                } catch {
                    return false;
                }
            });

        if (rejeicoes.length === 0) return features;

        const filtradas = features.filter((feature) => {
            const areaFeature = turf.area(feature);
            if (!Number.isFinite(areaFeature) || areaFeature <= 0) return true;

            for (const rejeicao of rejeicoes) {
                try {
                    if (!turf.booleanIntersects(feature, rejeicao)) continue;
                    const intersecao = intersectSafe(feature, rejeicao);
                    if (!intersecao) continue;

                    const overlap = turf.area(intersecao) / areaFeature;
                    if (overlap >= HARD_NEGATIVE_OVERLAP_THRESHOLD) return false;
                } catch {
                    continue;
                }
            }

            return true;
        });

        const removidas = features.length - filtradas.length;
        if (removidas > 0) {
            console.log(`Memória de rejeição aplicada: ${features.length} -> ${filtradas.length} (${removidas} removidas).`);
        }
        return filtradas;
    } catch (error) {
        console.warn('⚠️ Falha ao aplicar memória de rejeição:', error);
        return features;
    }
}

/**
 * Aplica feedback do usuário na feature e persiste dados para aprendizado contínuo.
 * Mantém sincronismo entre layer do mapa, run local e dataset de feedback.
 */
async function marcarFeedbackPoligono(featureId, status) {
    const feature = geojsonFeatures.find((f) => f.properties ?.id === featureId);
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
        feedbackStatus: status,
        feedbackReason: feedbackReason,
        featureGeometry: JSON.parse(JSON.stringify(feature.geometry)),
        featureSnapshot: {
            confidenceScore: Number(feature.properties.confidence_score || 0),
            areaM2: Number(feature.properties.area_m2 || 0),
            tipoBenfeitoria: normalizarTipoBenfeitoria(feature.properties.tipo_benfeitoria),
            quality: feature.properties.quality || '',
            compactness: Number(feature.properties.compactness || 0),
            vertices: Number(feature.properties.vertices || 0)
        },
        timestamp: new Date().toISOString()
    };

    try {
        await salvarFeedbackAprendizado(feedbackPayload);
        await atualizarFeedbackNoRun(
            feedbackPayload.runId,
            featureId,
            status,
            feedbackReason
        );

        if (status === 'rejeitado') {
            removerPoligonoRejeitado(featureId);
            mostrarNotificacao('🗑️ Polígono rejeitado removido e registrado para aprendizado.', 'info');
            return;
        }

        atualizarVisualizacao();
    } catch (err) {
        console.error('Erro ao salvar feedback no banco local:', err);
    }
}

// Nova função para ativar modo de edição visual
function ativarEdicaoPoligono(featureId, feature) {
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

    // Procurar o layer correspondente no mapa
    let targetLayer = null;
    if (window.lastGeoJSONLayer) {
        window.lastGeoJSONLayer.eachLayer((layer) => {
            if (layer.feature ?.properties ?.id === featureId) {
                targetLayer = layer;
            }
        });
    }

    if (!targetLayer) {
        alert('⚠️ Layer não encontrado no mapa para edição.');
        return;
    }

    // Salvar geometria original antes de editar
    const geometriaOriginal = JSON.parse(JSON.stringify(feature.geometry));

    // Obter coordenadas do polígono
    const latlngs = targetLayer.getLatLngs();

    // Remover layer do GeoJSON temporariamente
    window.lastGeoJSONLayer.removeLayer(targetLayer);

    // Criar polígono editável
    const editablePolygon = L.polygon(latlngs, {
        color: '#FF6B00',
        weight: 4,
        fillOpacity: 0.2,
        fillColor: '#FF6B00'
    }).addTo(window.map);

    // Habilitar edição usando Leaflet.Draw
    editablePolygon.editing.enable();

    // Redimensionar os marcadores de vértice AINDA MAIS PEQUENOS
    setTimeout(() => {
        const markers = editablePolygon.editing._markers;
        if (markers) {
            markers.forEach((marker, idx) => {
                marker.setIcon(L.divIcon({
                    className: 'leaflet-div-icon-edit-tiny',
                    html: '<div style="width: 6px; height: 6px; background: white; border: 1.5px solid #FF6B00; border-radius: 50%; cursor: move; box-shadow: 0 0 3px rgba(255,107,0,0.8);"></div>',
                    iconSize: [6, 6],
                    iconAnchor: [3, 3]
                }));

                // Adicionar listener para remover vértice com Ctrl+Click
                marker.on('click', (e) => {
                    if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) {
                        e.originalEvent.preventDefault();
                        e.originalEvent.stopPropagation();

                        // Remover vértice
                        if (editablePolygon.editing._markers.length > 3) { // Mínimo 3 vértices para polígono
                            editablePolygon.editing._deleteMarker(marker);
                            console.log(`🗑️ Vértice #${idx} removido`);
                        } else {
                            alert('⚠️ Um polígono precisa de no mínimo 3 vértices!');
                        }
                    }
                });
            });
        }
    }, 50);

    // Criar painel de instruções temporário - COMPACTO E TRANSPARENTE
    const instrucoes = L.control({ position: 'bottomright' });
    instrucoes.onAdd = function() {
        const div = L.DomUtil.create('div', 'edit-instructions');
        div.style.background = 'rgba(0, 0, 0, 0.75)';
        div.style.padding = '12px';
        div.style.borderRadius = '6px';
        div.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
        div.style.maxWidth = '280px';
        div.style.zIndex = '1000';
        div.style.color = 'white';
        div.style.backdropFilter = 'blur(4px)';
        div.innerHTML = `
      <strong style="color: #FFA500; font-size: 14px; display: block; margin-bottom: 8px;">✏️ Editando Polígono</strong>
      <p style="margin: 0 0 10px 0; font-size: 11px; line-height: 1.5; color: #E0E0E0;">
        <strong>Adicionar ponto:</strong><br>
        • Clique nas linhas<br>
        <br>
        <strong>Mover vértice:</strong><br>
        • Arraste os quadrados<br>
        <br>
        <strong>Remover vértice:</strong><br>
        • <kbd style="background: #333; padding: 2px 4px; border-radius: 2px;">Ctrl</kbd> + Clique
      </p>
      <button id="salvar-edicao" style="background: #28a745; color: white; border: none; padding: 10px 12px; border-radius: 4px; cursor: pointer; width: 100%; margin-bottom: 6px; font-weight: bold; font-size: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
        ✅ Salvar
      </button>
      <button id="cancelar-edicao" style="background: #dc3545; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; width: 100%; font-size: 11px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
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
            btnSalvar.addEventListener('click', async() => {
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
                feature.properties.geometria_original = geometriaOriginal; // GOLD para ML!

                // Salvar feedback com ambas geometrias
                const feedbackPayload = {
                    feedbackId: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    runId: feature.properties.run_id || activeRunId || 'sem_run',
                    featureId: featureId,
                    feedbackStatus: 'editado',
                    feedbackReason: motivo,
                    featureGeometry: geometriaEditada,
                    tipoBenfeitoria: normalizarTipoBenfeitoria(feature.properties.tipo_benfeitoria),
                    featureSnapshot: {
                        confidenceScore: Number(feature.properties.confidence_score || 0),
                        areaM2: Number(feature.properties.area_m2 || 0),
                        tipoBenfeitoria: normalizarTipoBenfeitoria(feature.properties.tipo_benfeitoria),
                        quality: feature.properties.quality || '',
                        compactness: Number(feature.properties.compactness || 0),
                        vertices: Number(feature.properties.vertices || 0)
                    },
                    geometriaOriginal: geometriaOriginal,
                    geometriaCorrigida: geometriaEditada,
                    editedGeometry: geometriaEditada,
                    originalGeometry: geometriaOriginal,
                    timestamp: new Date().toISOString()
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

// ==================== HELPER: NOTIFICAÇÕES ====================
function mostrarNotificacao(mensagem, tipo = 'info') {
    console.log(`[${tipo.toUpperCase()}] ${mensagem}`);
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

/**
 * Calcula score heurístico (0-100) para filtrar falsos positivos.
 * Retorna score, compacidade e número de vértices para classificação.
 */
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

function contarVerticesGeometria(geometry) {
    const ring = geometry?.type === 'Polygon'
        ? geometry?.coordinates?.[0]
        : geometry?.type === 'MultiPolygon'
            ? geometry?.coordinates?.[0]?.[0]
            : null;

    if (!Array.isArray(ring) || ring.length < 3) return 0;

    const primeiro = ring[0];
    const ultimo = ring[ring.length - 1];
    const fechado = Array.isArray(primeiro) && Array.isArray(ultimo) && primeiro[0] === ultimo[0] && primeiro[1] === ultimo[1];

    return fechado ? Math.max(0, ring.length - 1) : ring.length;
}

function calcularAreaGeometriaM2(geometry) {
    try {
        const area = turf.area({ type: 'Feature', geometry, properties: {} });
        return Number.isFinite(area) ? area : 0;
    } catch {
        return 0;
    }
}

/**
 * Normaliza a geometria para reduzir falhas no pós-processamento e exportação.
 * Estratégia: remove anéis internos e resolve topologia com buffer(0),
 * preservando o maior polígono quando o resultado for MultiPolygon.
 */
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

/**
 * Mescla fragmentos próximos para reduzir duplicidade de uma mesma edificação.
 * Usa distância entre centroides, união com buffer/debuffer e valida área mínima.
 */
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
                    turf.centerOfMass(otherFeature), { units: 'meters' }
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
        console.log('🔄 Iniciando carregamento do WASM...');
        console.log('Tentando carregar: vetoriza/pkg/vetoriza_bg.wasm');

        // Com --target no-modules, o namespace é wasm_bindgen
        await wasm_bindgen({ module_or_path: 'vetoriza/pkg/vetoriza_bg.wasm' });
        console.log('✅ wasm_bindgen carregado com sucesso');
        console.log('Objeto wasm_bindgen:', wasm_bindgen);

        vetorizar_imagem = wasm_bindgen.vetorizar_imagem;

        if (typeof vetorizar_imagem === 'function') {
            console.log('✅ Módulo WASM carregado com sucesso.');
            console.log('Função vetorizar_imagem está disponível:', vetorizar_imagem);
        } else {
            console.error('❌ vetorizar_imagem não é uma função!', typeof vetorizar_imagem);
            throw new Error('vetorizar_imagem não está disponível no objeto wasm_bindgen');
        }
    } catch (e) {
        console.error("❌ Falha ao carregar WASM:", e);
        console.error("Stack trace:", e.stack);
        alert("❌ Erro crítico ao carregar o módulo de processamento\n\nO sistema de vetorização não pôde ser inicializado.\n\nDetalhes técnicos: " + e.message + "\n\nSolução: Verifique se o arquivo 'vetoriza/pkg/vetoriza_bg.wasm' existe e recarregue a página (F5).");
    }
}

function testarObjetoGlobalWasm() {
    if (typeof wasm_bindgen !== 'undefined') {
        console.log('✅ Objeto global wasm_bindgen encontrado:', wasm_bindgen);
        inicializarWasm();
    } else {
        console.error('❌ Nenhum objeto global WASM encontrado (wasm_bindgen). Verifique o build e a ordem dos scripts.');
        alert('❌ Erro ao carregar módulo WASM\n\nVerifique o console (F12) para mais detalhes.');
    }
}

window.addEventListener('DOMContentLoaded', testarObjetoGlobalWasm);

// --- MAPA ---
const MAP_CENTER = [-25.706923, -52.385530];
const map = L.map('map').setView(MAP_CENTER, 15);
window.map = map; // Tornar acessível globalmente para edição de polígonos

const satelliteMap = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps',
    maxZoom: 21,
    maxNativeZoom: 21,
    preferCanvas: true,
    crossOrigin: 'anonymous'
});
satelliteMap.addTo(map);

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

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

/**
 * LEAFLET-DRAW: Controles de desenho do mapa
 * 
 * CONFIGURAÇÃO MINIMALISTA:
 * • Apenas polígono habilitado (desenhar área de vetorização)
 * • Edit mode desativado (sem ícones de edição/deletar)
 * • Marker, polyline, circle, rectangle desativados
 * • Zoom automático mantido pelo Leaflet
 * 
 * RESULTADO: UI limpa com apenas:
 *   - Zoom +/-  (Leaflet padrão)
 *   - Desenhar polígono (Draw tool)
 */
const drawControl = new L.Control.Draw({
    position: 'topleft',
    draw: {
        polygon: {
            allowIntersection: false,
            shapeOptions: {
                color: '#007bff',
                fillOpacity: 0.1,
                weight: 2
            }
        },
        marker: false,
        polyline: false,
        circle: false,
        rectangle: false,
        circlemarker: false
    },
    edit: false // Desativa completamente o modo edição (remove ícones de editar/deletar)
});
map.addControl(drawControl);

// --- EVENTOS DO MAPA ---
map.on(L.Draw.Event.CREATED, (e) => {
    if (e.layerType === 'polygon') {
        const layer = e.layer;

        // Modo manual: polígono desenhado é diretamente uma benfeitoria para aprendizado
        if (modoVetorizacao === 'manual') {
            adicionarPoligonoManual(layer);
            return;
        }

        // Modo automático: vetoriza a área desenhada com WASM
        geojsonFeatures.length = 0; // Limpa features anteriores

        // Limpeza de debug anterior
        if (debugMaskLayer) {
            map.removeLayer(debugMaskLayer);
            debugMaskLayer = null;
        }

        const bounds = layer.getBounds();
        // Apenas adicionamos o layer aqui. NÃO REMOVEMOS (layer.remove()) antes da captura!
        drawnItems.addLayer(layer);

        // Pequeno delay para garantir que a UI atualizou
        setTimeout(() => processarAreaDesenhada(bounds, layer), 500); // Passamos o layer para remoção posterior
    }
});

map.on(L.Draw.Event.DRAWSTART, () => {
    if (modoCapturaCoordenada) {
        definirModoCapturaCoordenada(false);
    }
});

// Quando o desenho para (concluío ou cancelado) resetar botão do Modo Manual
map.on(L.Draw.Event.DRAWSTOP, () => {
    activeDrawHandler = null;
    if (modoVetorizacao === 'manual') {
        const btn = document.getElementById('btnDesenharBenfeitoria');
        if (btn) {
            btn.textContent = '✏️ Desenhar Benfeitoria';
            btn.style.background = '#7c3aed';
        }
    }
});

map.on('click', capturarCoordenadaNoMapa);

// --- Lógica principal ---
/**
 * Pipeline principal de vetorização para a área desenhada.
 * Executa captura de ROI, pré-processamento, chamada WASM e pós-filtros.
 */
async function processarAreaDesenhada(bounds, selectionLayer) {
    loaderText.textContent = '📸 Capturando imagem da área selecionada...';
    loader.style.display = 'flex';
    activeRunId = gerarRunId();
    activeRunStartedAt = new Date().toISOString();
    const configBaselineExecucao = snapshotConfigAssist(CONFIG);
    let assistenciaWasmMeta = { aplicado: false, estrategia: 'nao_iniciado' };
    const selectionMaskGeoJSON = selectionLayer ?.toGeoJSON ?.() || null;
    currentSelectionMaskFeature = selectionMaskGeoJSON;

    try {
        assistenciaWasmMeta = await aplicarAutoajustePreVetorizacao();
    } catch {
        // sem-op
    }
    loaderText.textContent = '📸 Capturando imagem da área selecionada...';

    // Usamos os bounds do polígono desenhado para a captura
    leafletImage(map, async(err, mainCanvas) => {
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
            imgData.data[i] = Math.min(255, imgData.data[i] * CONFIG.contrastBoost + 20); // R
            imgData.data[i + 1] = Math.min(255, imgData.data[i + 1] * CONFIG.contrastBoost + 20); // G
            imgData.data[i + 2] = Math.min(255, imgData.data[i + 2] * CONFIG.contrastBoost + 20); // B
        }
        ctx.putImageData(imgData, 0, 0);

        // 2. Filtro de bordas (Sobel simplificado)
        // (aplica apenas no canal vermelho para simplificação)
        let sobelData = ctx.getImageData(0, 0, width, height);
        let outData = new Uint8ClampedArray(sobelData.data.length);
        const kernelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
        const kernelY = [-1, -2, -1,
            0, 0, 0,
            1, 2, 1
        ];
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                let gx = 0,
                    gy = 0;
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

            // DEBUG: Máscara de bordas (comentada para deixar frame transparente)
            // if (debugMaskLayer) map.removeLayer(debugMaskLayer);
            // debugMaskLayer = L.imageOverlay(maskCanvas.toDataURL(), bounds, { opacity: 0.7 });
            // debugMaskLayer.addTo(map);

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

            // DEBUG: Máscara final (comentada para deixar frame transparente)
            // if (window.debugMorphLayer) map.removeLayer(window.debugMorphLayer);
            // window.debugMorphLayer = L.imageOverlay(maskCanvas.toDataURL(), bounds, { opacity: 0.9 });
            // window.debugMorphLayer.addTo(map);

            loaderText.textContent = 'Vetorizando polígonos...';
            await yieldToMain();

            // Prepara para o WASM
            const base64Mask = maskCanvas.toDataURL('image/png').split(',')[1];
            debugLog('📍 [DEBUG] Base64 gerado, tamanho:', base64Mask.length);
            debugLog('📍 [DEBUG] Enviando para WASM vetorizar_imagem...');
            debugLog('📍 [DEBUG] Verificando tipo de vetorizar_imagem:', typeof vetorizar_imagem);
            debugLog('📍 [DEBUG] Verificando se é função:', typeof vetorizar_imagem === 'function');

            try {
                // Verifica se WASM foi carregado
                if (!vetorizar_imagem || typeof vetorizar_imagem !== 'function') {
                    console.error('❌ [FATAL] vetorizar_imagem não é uma função!');
                    console.error('   Tipo:', typeof vetorizar_imagem);
                    console.error('   Valor:', vetorizar_imagem);
                    throw new Error('WASM não foi carregado corretamente. Função vetorizar_imagem está ' + (typeof vetorizar_imagem) + '. Recarregue a página (F5).');
                }

                debugLog('✅ [DEBUG] Chamando WASM...');
                // Chama o Rust/WASM para transformar pixels em GeoJSON
                let geojsonStr;
                try {
                    geojsonStr = vetorizar_imagem(base64Mask);
                    debugLog('✅ [DEBUG] WASM retornou com sucesso');
                } catch (wasmError) {
                    console.error('❌ [WASM_ERROR] Erro ao executar função WASM:', wasmError);
                    throw new Error('Erro ao executar WASM: ' + wasmError.message);
                }

                debugLog('📍 [DEBUG] GeoJSON string recebido, tamanho:', geojsonStr ?.length || 0);
                debugLog('📍 [DEBUG] Primeiros 100 caracteres:', geojsonStr ?.substring(0, 100));

                const geojsonResult = JSON.parse(geojsonStr);
                debugLog('✅ [DEBUG] GeoJSON parseado com sucesso');
                debugLog('📍 [DEBUG] Features recebidas:', geojsonResult.features ?.length || 0);

                // Converte coordenadas de pixel (0,0) para Lat/Lng reais
                const geojsonConvertido = converterPixelsParaLatLng(geojsonResult, maskCanvas, bounds, selectionMaskGeoJSON, roiCanvas);
                debugLog(`📍 [DEBUG] Conversão para LatLng completa: ${geojsonConvertido.features.length} features`);
                debugLog('📍 [DEBUG] Primeiros dados de features:', geojsonConvertido.features.slice(0, 2));
                relatorio.resultadoFinal = {
                    featuresWasm: geojsonResult.features ?.length || 0,
                    featuresAposFiltro: geojsonConvertido.features.length
                };
                relatorio.assistenciaWasm = assistenciaWasmMeta;
                try {
                    await salvarRunLocalExecucao({
                        runId: activeRunId,
                        createdAt: activeRunStartedAt,
                        finishedAt: new Date().toISOString(),
                        config: {...CONFIG },
                        relatorio,
                        bounds: {
                            north: bounds.getNorth(),
                            south: bounds.getSouth(),
                            east: bounds.getEast(),
                            west: bounds.getWest()
                        },
                        features: geojsonConvertido.features.map((f) => ({
                            featureId: f.properties ?.id,
                            geometry: f.geometry,
                            properties: f.properties,
                            feedbackStatus: f.properties ?.feedback_status || 'pendente',
                            feedbackReason: f.properties ?.feedback_reason || ''
                        }))
                    });
                } catch (err) {
                    console.error('Erro ao salvar execução automática no banco local:', err);
                }
                registrarRelatorioProcessamento(relatorio);

                if (geojsonConvertido.features.length === 0) {
                    console.warn('Nenhum polígono encontrado após vetorização WASM');
                    alert("⚠️ Nenhuma edificação detectada\n\nNão foram encontradas construções na área selecionada.\n\nDicas:\n• Escolha uma área com edificações visíveis\n• Ajuste os parâmetros de sensibilidade\n• Reduza o score mínimo de qualidade");
                    drawnItems.removeLayer(selectionLayer); // Remove o polígono de seleção manual
                } else {
                    // Remove o polígono de seleção manual
                    drawnItems.removeLayer(selectionLayer);

                    // PHASE 4: Aplicar auto-inferência para reduzir falsos positivos
                    let featuresProcessados = geojsonConvertido.features;
                    if (window.aplicarAutoInferenciaAoProcesamento) {
                        try {
                            const featuresDados = geojsonConvertido.features.map(f => ({
                                area: f.properties.area_m2,
                                qualityScore: f.properties.confidence_score || 50,
                                featureId: f.properties.id
                            }));

                            const processados = await window.aplicarAutoInferenciaAoProcesamento(featuresDados);

                            // Filtrar features pela lista de processados (inclui caso vazio = rejeitar todos)
                            if (Array.isArray(processados)) {
                                const processadosIds = new Set(processados.map(p => p.featureId));
                                featuresProcessados = geojsonConvertido.features.filter(f =>
                                    processadosIds.has(f.properties.id)
                                );
                                console.log(`Phase 4 aplicado: ${geojsonConvertido.features.length} → ${featuresProcessados.length} features`);
                            }
                        } catch (error) {
                            console.warn('⚠️ Erro ao aplicar Phase 4 auto-inferência:', error);
                            // Continua com features originais se houver erro
                        }
                    }

                    featuresProcessados = await filtrarFeaturesPorMemoriaRejeicao(
                        featuresProcessados,
                        selectionMaskGeoJSON
                    );

                    // Adiciona os vetores
                    const poligonosVetorizados = L.geoJSON(featuresProcessados, {
                        style: function(feature) {
                            return getStyleByQuality(feature);
                        },
                        onEachFeature: function(feature, layer) {
                            layer.bindPopup(criarPopupFeedback(feature));
                        }
                    });
                    drawnItems.addLayer(poligonosVetorizados);
                    // Guarda referência para atualização de visualização
                    window.lastGeoJSONLayer = poligonosVetorizados;
                    // Guarda para exportação
                    geojsonFeatures.push(...featuresProcessados);

                    // Atualiza estatísticas na UI
                    atualizarEstatisticas();

                    const totalArea = featuresProcessados.reduce((sum, f) => sum + parseFloat(f.properties.area_m2 || 0), 0);
                    const highQ = featuresProcessados.filter(f => f.properties.quality === 'alta').length;
                    const medQ = featuresProcessados.filter(f => f.properties.quality === 'media').length;
                    const lowQ = featuresProcessados.filter(f => f.properties.quality === 'baixa').length;

                    const referenciasManuais = obterReferenciasManuaisBenchmark(bounds);
                    const benchmark = calcularBenchmarkCenario(featuresProcessados, referenciasManuais);
                    const qualityIndex = featuresProcessados.length > 0 ?
                        ((highQ + (medQ * 0.6) + (lowQ * 0.2)) / featuresProcessados.length) :
                        0;

                    registrarTelemetriaAssist({
                        runId: activeRunId,
                        timestamp: new Date().toISOString(),
                        preset: String(CONFIG.presetProfile || 'manual').toLowerCase(),
                        configBaseline: configBaselineExecucao,
                        configAplicada: snapshotConfigAssist(CONFIG),
                        assistencia: assistenciaWasmMeta,
                        totalFeaturesWasm: geojsonConvertido.features.length,
                        totalFeaturesFinal: featuresProcessados.length,
                        quality: { highQ, medQ, lowQ, qualityIndex: Number(qualityIndex.toFixed(4)) },
                        benchmark
                    });

                    if (benchmark) {
                        console.log(`📐 Benchmark cenário (${CONFIG.presetProfile || 'manual'}): IoU médio=${benchmark.iouMedio}, F1=${benchmark.f1}, P=${benchmark.precision}, R=${benchmark.recall}`);
                    }

                    alert(`✅ Processamento concluído!\n\n📊 ${featuresProcessados.length} polígonos detectados\n📐 Área total: ${totalArea.toFixed(2)} m²\n\n🎯 Qualidade:\n  🟢 Alta: ${highQ}\n  🟡 Média: ${medQ}\n  🔴 Baixa: ${lowQ}`);
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
            outData[outIndex] = bestVal; // R
            outData[outIndex + 1] = bestVal; // G
            outData[outIndex + 2] = bestVal; // B
            outData[outIndex + 3] = 255; // Alpha
        }
    }
    ctx.putImageData(processedData, 0, 0);
}

function pontoDentroPoligonoPixel(point, polygonCoords) {
    const x = point[0];
    const y = point[1];
    let dentro = false;

    for (let i = 0, j = polygonCoords.length - 1; i < polygonCoords.length; j = i++) {
        const xi = polygonCoords[i][0];
        const yi = polygonCoords[i][1];
        const xj = polygonCoords[j][0];
        const yj = polygonCoords[j][1];

        const intersecta = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);

        if (intersecta) dentro = !dentro;
    }

    return dentro;
}

function pixelPareceAgua(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturacao = max > 0 ? (max - min) / max : 0;
    const brilho = (r + g + b) / 3;
    const azulDominante = b > (g * 1.05) && b > (r * 1.08);
    const verdeAzulado = g > (r * 1.02) && b > (r * 1.05);

    return (azulDominante || verdeAzulado) &&
        saturacao > 0.12 &&
        brilho < 180;
}

function obterLimiteRejeicaoAgua() {
    const perfil = String(CONFIG.presetProfile || '').toLowerCase();

    if (perfil === 'trapiche') return 0.42;
    if (perfil === 'rural') return 0.70;
    if (perfil === 'urbano') return 0.78;
    if (perfil === 'industrial') return 0.75;

    return 0.72;
}

function estimarProporcaoAguaNoPoligono(coordsPixel, sourceCanvas) {
    if (!sourceCanvas || !coordsPixel || coordsPixel.length < 3) return null;

    const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    coordsPixel.forEach((p) => {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
    });

    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(sourceCanvas.width - 1, Math.ceil(maxX));
    maxY = Math.min(sourceCanvas.height - 1, Math.ceil(maxY));

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width < 2 || height < 2) return null;

    const step = Math.max(1, Math.round(Math.max(width, height) / 90));
    const data = ctx.getImageData(minX, minY, width, height).data;

    let totalAmostras = 0;
    let amostrasAgua = 0;

    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const globalX = minX + x + 0.5;
            const globalY = minY + y + 0.5;

            if (!pontoDentroPoligonoPixel([globalX, globalY], coordsPixel)) continue;

            const idx = ((y * width) + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            totalAmostras += 1;
            if (pixelPareceAgua(r, g, b)) {
                amostrasAgua += 1;
            }
        }
    }

    if (totalAmostras === 0) return null;
    return amostrasAgua / totalAmostras;
}

function aplicarPosFiltroContextual(features = [], presetProfile = '') {
    const preset = String(presetProfile || '').toLowerCase();
    if (!Array.isArray(features) || features.length < 2) return features;
    if (preset !== 'urbano' && preset !== 'cobertura') return features;

    const distanciaVizinhoM = preset === 'cobertura' ? 26 : 20;
    const areaMinContextual = preset === 'cobertura' ? 8 : 12;
    const scoreMinContextual = preset === 'cobertura' ? 26 : 32;
    const resumo = features.map((feature, idx) => {
        let centroide = null;
        try {
            centroide = turf.centroid(feature);
        } catch {
            centroide = null;
        }

        return {
            idx,
            feature,
            area: Number(feature?.properties?.area_m2 || 0),
            compactness: Number(feature?.properties?.compactness || 0),
            score: Number(feature?.properties?.confidence_score || 0),
            centroide
        };
    });

    const filtradas = resumo.filter((item) => {
        if (!item.centroide) return false;
        if (item.score >= 70) return true;

        const vizinhosCompativeis = resumo.filter((other) => {
            if (other.idx === item.idx || !other.centroide) return false;
            const areaBase = Math.max(1, item.area);
            const ratioArea = other.area / areaBase;
            if (ratioArea < 0.4 || ratioArea > 2.6) return false;

            try {
                const distanciaKm = turf.distance(item.centroide, other.centroide, { units: 'kilometers' });
                return (distanciaKm * 1000) <= distanciaVizinhoM;
            } catch {
                return false;
            }
        });

        const clusterizado = vizinhosCompativeis.length >= 2;
        const isolado = vizinhosCompativeis.length === 0;
        const muitoLinear = item.compactness < 0.12;
        const compactacaoFraca = item.compactness < 0.18;
        const pequeno = item.area < areaMinContextual;
        const scoreBaixo = item.score < scoreMinContextual;

        if (muitoLinear && isolado) return false;
        if (pequeno && isolado && compactacaoFraca) return false;
        if (scoreBaixo && isolado && item.compactness < 0.22) return false;

        if (preset === 'cobertura' && clusterizado && item.score < 40 && item.compactness >= 0.18 && item.area >= areaMinContextual) {
            item.feature.properties.confidence_score = Math.max(item.score, 40);
            item.feature.properties.quality = 'media';
        }

        return true;
    }).map((item) => item.feature);

    const removidas = features.length - filtradas.length;
    if (removidas > 0) {
        console.log(`🏘️ Pós-filtro contextual (${preset}): ${features.length} -> ${filtradas.length} (${removidas} removidas)`);
    }

    return filtradas;
}

/**
 * Converte coordenadas em pixel para Lat/Lng e aplica filtros geométricos finais.
 */
function converterPixelsParaLatLng(geojson, canvas, mapBounds, selectionMaskFeature = null, sourceCanvas = null) {
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

    // Usa polígono exato da seleção quando disponível; fallback para bbox.
    const selectionMask = selectionMaskFeature && (selectionMaskFeature.geometry ?.type === 'Polygon' || selectionMaskFeature.geometry ?.type === 'MultiPolygon') ?
        selectionMaskFeature :
        turf.bboxPolygon([
            mapBounds.getWest(),
            mapBounds.getSouth(),
            mapBounds.getEast(),
            mapBounds.getNorth()
        ]);

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

            // Filtro espacial exato: mantém apenas a parte dentro da seleção desenhada.
            let masked = null;
            try {
                if (!turf.booleanIntersects(simplified, selectionMask)) {
                    console.log(`Feature ${idx}: ❌ REJEITADA - Fora da área de seleção`);
                    return;
                }

                if (turf.booleanWithin(simplified, selectionMask)) {
                    masked = simplified;
                } else {
                    masked = intersectSafe(simplified, selectionMask);
                    if (!masked) {
                        console.log(`Feature ${idx}: ❌ REJEITADA - Interseção vazia com área de seleção`);
                        return;
                    }
                }
            } catch (error) {
                console.warn(`Feature ${idx}: ⚠️ Erro ao aplicar máscara da seleção:`, error);
                return;
            }

            // Se vier MultiPolygon após recorte, preserva o maior fragmento para footprint principal.
            if (masked.geometry ?.type === 'MultiPolygon') {
                const partes = masked.geometry.coordinates
                    .map(coordsMulti => turf.polygon(coordsMulti))
                    .filter(Boolean)
                    .sort((a, b) => turf.area(b) - turf.area(a));

                if (partes.length === 0) {
                    console.log(`Feature ${idx}: ❌ REJEITADA - Recorte gerou geometria inválida`);
                    return;
                }

                masked = partes[0];
            }

            const area = turf.area(masked);
            if (idx < 3) {
                console.log(`Feature ${idx}: área calculada = ${area.toFixed(6)}m² (original ${coords.length} pontos)`);
            }

            const proporcaoAgua = estimarProporcaoAguaNoPoligono(coords, sourceCanvas);
            const limiteAgua = obterLimiteRejeicaoAgua();
            if (Number.isFinite(proporcaoAgua) && proporcaoAgua > limiteAgua) {
                if (idx < 8) {
                    console.log(`Feature ${idx}: ❌ REJEITADA POR ÁGUA - proporção ${(proporcaoAgua * 100).toFixed(1)}% > ${(limiteAgua * 100).toFixed(1)}%`);
                }
                return;
            }

            // AQUI é onde os filtros são aplicados.
            if (area >= MIN_AREA_METERS) {
                // Limpar geometria: remove buracos e corrige auto-interseções
                let cleaned = limparGeometria(masked);

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
                        tipo_benfeitoria: 'nao_classificada',
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
    const mesclados = CONFIG.mergeDistance > 0 ?
        mesclarPoligonosProximos(featuresFinais, CONFIG.mergeDistance) :
        featuresFinais;

    // Recalcula propriedades após fusão e reaplica filtros finais
    const finaisComPropriedades = mesclados.map((feature, idx) => {
        // Reaplica máscara da seleção após fusão para evitar vazamento geométrico.
        let maskedPosFusao = null;
        if (turf.booleanWithin(feature, selectionMask)) {
            maskedPosFusao = feature;
        } else {
            maskedPosFusao = intersectSafe(feature, selectionMask);
        }

        if (!maskedPosFusao) {
            return null;
        }

        if (maskedPosFusao.geometry ?.type === 'MultiPolygon') {
            const partes = maskedPosFusao.geometry.coordinates
                .map(coordsMulti => turf.polygon(coordsMulti))
                .filter(Boolean)
                .sort((a, b) => turf.area(b) - turf.area(a));
            maskedPosFusao = partes[0] || null;
        }

        if (!maskedPosFusao) {
            return null;
        }

        const featureLimpa = limparGeometria(maskedPosFusao);
        const area = turf.area(featureLimpa);
        const qualityScore = calcularScoreConfianca(featureLimpa);
        const propsAnteriores = feature.properties || {};

        featureLimpa.properties = {
            id: `imovel_${geojsonFeatures.length + idx + 1}`,
            area_m2: area.toFixed(2),
            confidence_score: qualityScore.score,
            compactness: qualityScore.compactness,
            vertices: qualityScore.vertices,
            quality: qualityScore.score >= 70 ? 'alta' : qualityScore.score >= 40 ? 'media' : 'baixa',
            tipo_benfeitoria: normalizarTipoBenfeitoria(propsAnteriores.tipo_benfeitoria),
            run_id: propsAnteriores.run_id || activeRunId,
            feedback_status: propsAnteriores.feedback_status || 'pendente',
            feedback_reason: propsAnteriores.feedback_reason || ''
        };

        return featureLimpa;
    }).filter((feature) => {
        if (!feature) return false;
        const area = Number(feature.properties.area_m2 || 0);
        const score = Number(feature.properties.confidence_score || 0);
        return area >= CONFIG.minArea && score >= CONFIG.minQualityScore;
    });

    const finaisContextualizados = aplicarPosFiltroContextual(
        finaisComPropriedades,
        CONFIG.presetProfile
    );

    console.log(`✅ Total final após fusão: ${finaisComPropriedades.length} polígonos`);
    return turf.featureCollection(finaisContextualizados);
}


// --- Exportação ---
function normalizarNumeroShp(valor, casas = 2) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(casas));
}

function normalizarInteiroShp(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
}

function normalizarTextoShp(valor, fallback = '') {
    if (valor === null || valor === undefined) return fallback;
    return String(valor).trim();
}

function mapearFeatureParaShapefile(feature) {
    if (!feature || !feature.geometry) return null;

    const props = feature.properties || {};
    return {
        type: 'Feature',
        geometry: feature.geometry,
        properties: {
            ID: normalizarTextoShp(props.id),
            AREA_M2: normalizarNumeroShp(props.area_m2, 2),
            SCORE: normalizarNumeroShp(props.confidence_score, 2),
            QUALID: normalizarTextoShp(props.quality),
            COMPACT: normalizarNumeroShp(props.compactness, 4),
            VERTICES: normalizarInteiroShp(props.vertices),
            TIPO: normalizarTipoBenfeitoria(props.tipo_benfeitoria),
            SOURCE: normalizarTextoShp(props.source),
            RUN_ID: normalizarTextoShp(props.run_id),
            FB_STAT: normalizarTextoShp(props.feedback_status),
            FB_REAS: normalizarTextoShp(props.feedback_reason)
        }
    };
}

/**
 * Exporta os polígonos atuais em Shapefile ZIP.
 * Compatível com retorno Base64 do shpwrite (decodifica antes de criar Blob).
 */
async function exportarShapefile() {
    const todasFeatures = [...geojsonFeatures, ...manualPolygonFeatures];
    if (todasFeatures.length === 0) {
        alert("⚠️ Não há polígonos para exportar.\n\nDesenhe uma área no mapa e aguarde o processamento, ou use o Modo Manual.");
        return;
    }

    console.log(`Iniciando exportação de ${todasFeatures.length} features (${geojsonFeatures.length} auto + ${manualPolygonFeatures.length} manuais)`);
    console.log('Primeira feature original:', todasFeatures[0]);

    const featuresShp = todasFeatures
        .map(mapearFeatureParaShapefile)
        .filter((f) => !!f);

    if (featuresShp.length === 0) {
        alert('⚠️ Não há geometrias válidas para exportar.');
        return;
    }

    const geojson = { type: "FeatureCollection", features: featuresShp };
    console.log('Primeira feature mapeada para SHP:', featuresShp[0]);
    console.log('GeoJSON exportável (SHP):', geojson);

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
        alert(`✅ Exportação concluída!\n\n📦 ${todasFeatures.length} polígonos exportados no formato Shapefile (${geojsonFeatures.length} automáticos + ${manualPolygonFeatures.length} manuais).\n\nO arquivo foi salvo como 'mapeamento_edificacoes.zip'`);
    } catch (e) {
        console.error("Erro ao exportar:", e);
        console.error("Stack trace:", e.stack);
        alert("❌ Erro ao gerar arquivo Shapefile:\n\n" + e.message);
    } finally {
        loader.style.display = 'none';
    }
}

// ==================== MODO DE VETORIZAÇÃO MANUAL ====================

/**
 * Alterna entre vetorização automática (WASM) e manual (desenho direto para aprendizado).
 */
function definirModoVetorizacao(modo) {
    modoVetorizacao = modo;
    const btnAuto = document.getElementById('btnModoAuto');
    const btnManual = document.getElementById('btnModoManual');
    const desc = document.getElementById('modoVetorizacaoDesc');
    const btnDraw = document.getElementById('btnDesenharBenfeitoria');

    if (btnAuto) btnAuto.classList.toggle('mode-btn-active', modo === 'auto');
    if (btnManual) btnManual.classList.toggle('mode-btn-active', modo === 'manual');

    // Mostrar/ocultar botão de desenho manual
    if (btnDraw) {
        btnDraw.style.display = modo === 'manual' ? 'block' : 'none';
        // Resetar estado do botão ao trocar modo
        btnDraw.textContent = '✏️ Desenhar Benfeitoria';
        btnDraw.style.background = '#7c3aed';
    }

    // Cancela draw ativo ao voltar para Automático
    if (modo === 'auto' && activeDrawHandler) {
        try { activeDrawHandler.disable(); } catch { /* sem-op */ }
        activeDrawHandler = null;
    }

    if (modo === 'manual') {
        L.drawLocal.draw.toolbar.buttons.polygon = 'Desenhar benfeitoria';
        L.drawLocal.draw.handlers.polygon.tooltip.start = 'Clique para começar a desenhar o contorno da benfeitoria';
        L.drawLocal.draw.handlers.polygon.tooltip.cont = 'Continue clicando para adicionar vértices — duplo clique no último ponto para finalizar';
        L.drawLocal.draw.handlers.polygon.tooltip.end = 'Clique no primeiro ponto para fechar o polígono';
        if (desc) desc.textContent = 'Clique em Desenhar Benfeitoria e trace o contorno. Duplo clique no último ponto para finalizar.';
    } else {
        L.drawLocal.draw.toolbar.buttons.polygon = 'Desenhar área';
        L.drawLocal.draw.handlers.polygon.tooltip.start = 'Clique para começar a desenhar a área';
        L.drawLocal.draw.handlers.polygon.tooltip.cont = 'Clique para continuar desenhando';
        L.drawLocal.draw.handlers.polygon.tooltip.end = 'Clique no primeiro ponto para fechar';
        if (desc) desc.textContent = 'Desenhe uma área no mapa para detectar edificações automaticamente via IA';
    }

    mostrarNotificacao(
        modo === 'manual'
            ? '✏️ Modo Manual ativo. Clique em Desenhar Benfeitoria para começar.'
            : '🤖 Modo Automático: desenhe uma área para vetorizar com IA.',
        'info'
    );
}

/**
 * Ativa ou cancela o modo de desenho manual de polígono via Leaflet.Draw.
 * Chamado pelo botão "Desenhar Benfeitoria" no painel lateral.
 */
function iniciarDesenhoManual() {
    const btn = document.getElementById('btnDesenharBenfeitoria');
    if (activeDrawHandler) {
        // Cancela draw em andamento
        try { activeDrawHandler.disable(); } catch { /* sem-op */ }
        activeDrawHandler = null;
        if (btn) {
            btn.textContent = '✏️ Desenhar Benfeitoria';
            btn.style.background = '#7c3aed';
        }
        return;
    }
    const drawOptions = {
        shapeOptions: {
            color: '#7c3aed',
            weight: 2,
            fillOpacity: 0.18,
            fillColor: '#7c3aed'
        },
        allowIntersection: false,
        showLength: true
    };
    activeDrawHandler = new L.Draw.Polygon(map, drawOptions);
    activeDrawHandler.enable();
    if (btn) {
        btn.textContent = '❌ Cancelar Desenho';
        btn.style.background = '#dc2626';
    }
    mostrarNotificacao('Clique para adicionar vértices. Duplo clique no último ponto para finalizar o polígono.', 'info');
}

/**
 * Registra um polígono desenhado manualmente como exemplo de aprendizado.
 * Chamado pelo evento draw:created quando modoVetorizacao === 'manual'.
 */
function obterEstiloPoligonoManual(feature) {
    const salvoNuvem = feature?.properties?.feedback_status === 'aprovado';

    if (salvoNuvem) {
        return {
            color: '#166534',
            fillColor: '#22c55e',
            weight: 4,
            fillOpacity: 0.55
        };
    }

    return {
        color: '#5b21b6',
        fillColor: '#7c3aed',
        weight: 3,
        fillOpacity: 0.38
    };
}

function adicionarPoligonoManual(layer) {
    const featureId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const geojsonBruto = layer.toGeoJSON();
    let areaM2 = 0;
    try { areaM2 = turf.area(geojsonBruto); } catch { areaM2 = 0; }
    const nVertices = contarVerticesGeometria(geojsonBruto.geometry);
    const manualRunId = `manual_run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const feature = {
        type: 'Feature',
        geometry: geojsonBruto.geometry,
        properties: {
            id: featureId,
            area_m2: Number(areaM2).toFixed(2),
            confidence_score: 100,
            quality: 'manual',
            compactness: '-',
            vertices: nVertices,
            tipo_benfeitoria: 'nao_classificada',
            source: 'manual_draw',
            feedback_status: 'pendente',
            feedback_reason: '',
            run_id: manualRunId
        }
    };

    layer.setStyle(obterEstiloPoligonoManual(feature));
    layer.feature = feature;
    manualPolygonFeatures.push(feature);
    drawnItems.addLayer(layer);
    atualizarEstatisticas();
    layer.bindPopup(criarPopupPoligonoManual(featureId), { maxWidth: 320, minWidth: 240 }).openPopup();
}

/**
 * Cria o HTML do popup para um polígono manual (classificação + salvar + editar).
 */
function criarPopupPoligonoManual(featureId) {
    const feature = manualPolygonFeatures.find(f => f.properties?.id === featureId);
    if (!feature) return '<p>Polígono não encontrado.</p>';
    const props = feature.properties;
    const tipoAtual = normalizarTipoBenfeitoria(props.tipo_benfeitoria);
    const jaSalvo = props.feedback_status === 'aprovado';
        const statusTexto = jaSalvo ? 'Salvo na Nuvem' : 'Somente Local';
        const statusStyle = jaSalvo
                ? 'background:#dcfce7;color:#166534;border:1px solid #86efac;'
                : 'background:#f3f4f6;color:#374151;border:1px solid #d1d5db;';

    return `
    <div style="min-width:230px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <strong style="color:#7c3aed;font-size:13px;">✏️ Polígono Manual</strong>
                <span style="${statusStyle}font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;white-space:nowrap;">${statusTexto}</span>
            </div>
      <span style="font-size:11px;color:#6b7280;">Área: ${props.area_m2} m² &nbsp;|&nbsp; Vértices: ${props.vertices}</span>
      <div style="margin-top:8px;">
        <label style="font-size:12px;font-weight:600;">Classificação:</label><br>
        <select id="tipo_manual_${featureId}" style="width:100%;margin-top:4px;padding:6px;border-radius:4px;border:1px solid #d1d5db;font-size:12px;" onchange="atualizarTipoManual('${featureId}', this.value)">
          <option value="nao_classificada" ${tipoAtual === 'nao_classificada' ? 'selected' : ''}>— Selecione o tipo —</option>
          <option value="edificacao" ${tipoAtual === 'edificacao' ? 'selected' : ''}>🏠 Edificação / Telhado</option>
          <option value="trapiche" ${tipoAtual === 'trapiche' ? 'selected' : ''}>🛶 Trapiche / Píer</option>
          <option value="outra" ${tipoAtual === 'outra' ? 'selected' : ''}>📦 Outra benfeitoria</option>
        </select>
      </div>
      <div style="margin-top:10px;display:flex;gap:6px;">
        <button onclick="salvarPoligonoManual('${featureId}')" style="background:${jaSalvo ? '#15803d' : '#7c3aed'};flex:2;padding:8px 6px;font-size:11px;font-weight:600;border-radius:4px;border:none;color:white;cursor:pointer;">${jaSalvo ? '✅ Salvo' : '💾 Salvar para Aprendizado'}</button>
        <button onclick="ativarEdicaoPoligonoManual('${featureId}')" style="background:#d97706;flex:1;padding:8px 6px;font-size:11px;font-weight:600;border-radius:4px;border:none;color:white;cursor:pointer;">✏️ Editar</button>
                <button onclick="deletarPoligonoManual('${featureId}')" style="background:#dc2626;flex:1;padding:8px 6px;font-size:11px;font-weight:600;border-radius:4px;border:none;color:white;cursor:pointer;">🗑️ Deletar</button>
      </div>
            ${jaSalvo ? '<small style="color:#15803d;margin-top:6px;display:block;">✅ Exemplo salvo na nuvem para aprendizado!</small>' : '<small style="color:#9ca3af;margin-top:6px;display:block;">Selecione o tipo e clique em Salvar (requer conexão com a nuvem).</small>'}
    </div>
  `;
}

/**
 * Atualiza o tipo de benfeitoria de um polígono manual (chamado pelo select no popup).
 */
function atualizarTipoManual(featureId, tipo) {
    const feature = manualPolygonFeatures.find(f => f.properties?.id === featureId);
    if (!feature) return;
    feature.properties.tipo_benfeitoria = normalizarTipoBenfeitoria(tipo);
}

function deletarPoligonoManual(featureId) {
    if (!featureId) return;

    const idx = manualPolygonFeatures.findIndex((f) => f.properties?.id === featureId);
    if (idx < 0) {
        alert('⚠️ Polígono manual não encontrado.');
        return;
    }

    const feature = manualPolygonFeatures[idx];
    const jaSalvoNuvem = feature?.properties?.feedback_status === 'aprovado';
    const mensagemConfirmacao = jaSalvoNuvem
        ? 'Este polígono já foi salvo na nuvem para aprendizado.\n\nDeseja removê-lo apenas do mapa atual? (o registro salvo na nuvem será mantido)'
        : 'Deseja realmente deletar este polígono manual do mapa atual?';

    if (!window.confirm(mensagemConfirmacao)) return;

    manualPolygonFeatures.splice(idx, 1);

    const layersParaRemover = [];
    drawnItems.eachLayer((layer) => {
        if (layer?.feature?.properties?.id === featureId) {
            layersParaRemover.push(layer);
        }
    });
    layersParaRemover.forEach((layer) => drawnItems.removeLayer(layer));

    window.map.closePopup();
    atualizarEstatisticas();

    const mensagem = jaSalvoNuvem
        ? '🗑️ Polígono removido do mapa atual. O exemplo já salvo na nuvem foi preservado.'
        : '🗑️ Polígono manual removido do mapa atual.';
    mostrarNotificacao(mensagem, 'info');
}

/**
 * Salva o polígono manual no banco de aprendizado (cloud-only / Firestore).
 */
async function salvarPoligonoManual(featureId) {
    const feature = manualPolygonFeatures.find(f => f.properties?.id === featureId);
    if (!feature) {
        alert('⚠️ Polígono não encontrado.');
        return;
    }
    const tipoBenfeitoria = normalizarTipoBenfeitoria(feature.properties.tipo_benfeitoria);
    if (tipoBenfeitoria === 'nao_classificada') {
        alert('⚠️ Selecione uma classificação antes de salvar (Edificação, Trapiche ou Outra).');
        return;
    }

    const manualRunId = feature.properties.run_id || `manual_run_${Date.now()}`;

    try {
        await salvarRunAprendizado({
            runId: manualRunId,
            createdAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            source: 'manual_draw',
            config: { ...CONFIG },
            bounds: null,
            features: [{
                featureId,
                geometry: feature.geometry,
                properties: feature.properties,
                feedbackStatus: 'aprovado',
                feedbackReason: 'manual_draw'
            }]
        });

        const feedbackPayload = {
            feedbackId: `fb_manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            runId: manualRunId,
            featureId,
            feedbackStatus: 'aprovado',
            feedbackReason: 'manual_draw',
            featureGeometry: JSON.parse(JSON.stringify(feature.geometry)),
            tipoBenfeitoria,
            source: 'manual_draw',
            featureSnapshot: {
                confidenceScore: 100,
                areaM2: Number(feature.properties.area_m2 || 0),
                tipoBenfeitoria,
                quality: 'manual',
                compactness: 0,
                vertices: Number(feature.properties.vertices || 0)
            },
            timestamp: new Date().toISOString()
        };
        await salvarFeedbackAprendizado(feedbackPayload);

        feature.properties.feedback_status = 'aprovado';
        feature.properties.tipo_benfeitoria = tipoBenfeitoria;
        mostrarNotificacao(`✅ Polígono manual salvo! Tipo: ${obterRotuloTipoBenfeitoria(tipoBenfeitoria)}`, 'success');

        // Atualiza popup e cor do layer
        drawnItems.eachLayer((l) => {
            if (l.feature?.properties?.id === featureId) {
                l.setStyle(obterEstiloPoligonoManual(feature));
                l.setPopupContent(criarPopupPoligonoManual(featureId));
            }
        });
    } catch (err) {
        console.error('Erro ao salvar polígono manual:', err);
        const mensagemErro = String(err ?.message || 'Falha desconhecida ao salvar.');
        const indisponivelNuvem = mensagemErro.includes('Firestore indisponível no momento');

        if (indisponivelNuvem) {
            const aviso = '⚠️ Não foi possível salvar na nuvem agora. Verifique sua conexão e tente novamente.';
            mostrarNotificacao(aviso, 'warning');
            alert(aviso);
            return;
        }

        alert(`❌ Erro ao salvar: ${mensagemErro}`);
    }
}

/**
 * Ativa edição visual de um polígono manual desenhado diretamente no mapa.
 */
function ativarEdicaoPoligonoManual(featureId) {
    window.map.closePopup();

    const feature = manualPolygonFeatures.find(f => f.properties?.id === featureId);
    if (!feature) {
        alert('⚠️ Polígono não encontrado.');
        return;
    }

    let targetLayer = null;
    drawnItems.eachLayer((l) => {
        if (l.feature?.properties?.id === featureId) targetLayer = l;
    });

    if (!targetLayer) {
        alert('⚠️ Layer não encontrado no mapa para edição.');
        return;
    }

    const geometriaOriginal = JSON.parse(JSON.stringify(feature.geometry));
    const latlngs = targetLayer.getLatLngs();
    drawnItems.removeLayer(targetLayer);

    const editablePolygon = L.polygon(latlngs, {
        color: '#7c3aed', weight: 4, fillOpacity: 0.2, fillColor: '#7c3aed'
    }).addTo(window.map);
    editablePolygon.editing.enable();

    setTimeout(() => {
        const markers = editablePolygon.editing._markers;
        if (markers) {
            markers.forEach((marker) => {
                marker.setIcon(L.divIcon({
                    className: 'leaflet-div-icon-edit-tiny',
                    html: '<div style="width:6px;height:6px;background:white;border:1.5px solid #7c3aed;border-radius:50%;cursor:move;"></div>',
                    iconSize: [6, 6], iconAnchor: [3, 3]
                }));
                marker.on('click', (e) => {
                    if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) {
                        e.originalEvent.preventDefault();
                        e.originalEvent.stopPropagation();
                        if (editablePolygon.editing._markers.length > 3) {
                            editablePolygon.editing._deleteMarker(marker);
                        } else {
                            alert('⚠️ Um polígono precisa de no mínimo 3 vértices!');
                        }
                    }
                });
            });
        }
    }, 50);

    const instrucoes = L.control({ position: 'bottomright' });
    instrucoes.onAdd = function () {
        const div = L.DomUtil.create('div', 'edit-instructions');
        div.style.cssText = 'background:rgba(0,0,0,0.75);padding:12px;border-radius:6px;max-width:260px;z-index:1000;color:white;backdrop-filter:blur(4px);';
        div.innerHTML = `
      <strong style="color:#a78bfa;font-size:13px;display:block;margin-bottom:8px;">✏️ Editando Polígono Manual</strong>
      <p style="margin:0 0 10px;font-size:11px;line-height:1.5;color:#E0E0E0;">
        <strong>Mover vértice:</strong> arraste os pontos<br>
        <strong>Adicionar ponto:</strong> clique nas linhas<br>
        <strong>Remover vértice:</strong> <kbd style="background:#333;padding:2px 4px;border-radius:2px;">Ctrl</kbd> + Clique
      </p>
      <button id="salvar-edicao-manual" style="background:#7c3aed;color:white;border:none;padding:10px 12px;border-radius:4px;cursor:pointer;width:100%;margin-bottom:6px;font-weight:bold;font-size:12px;">✅ Confirmar Edição</button>
      <button id="cancelar-edicao-manual" style="background:#dc2626;color:white;border:none;padding:8px 12px;border-radius:4px;cursor:pointer;width:100%;font-size:11px;">❌ Cancelar</button>
    `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    instrucoes.addTo(window.map);

    setTimeout(() => {
        const btnSalvar = document.getElementById('salvar-edicao-manual');
        const btnCancelar = document.getElementById('cancelar-edicao-manual');

        if (btnSalvar) {
            btnSalvar.addEventListener('click', () => {
                const geometriaEditada = editablePolygon.toGeoJSON().geometry;
                feature.geometry = geometriaEditada;
                feature.properties.vertices = contarVerticesGeometria(geometriaEditada);
                feature.properties.area_m2 = calcularAreaGeometriaM2(geometriaEditada).toFixed(2);
                feature.properties.geometria_original = geometriaOriginal;

                window.map.removeLayer(editablePolygon);
                instrucoes.remove();

                // Readicionar layer atualizado
                const novoLayer = L.polygon(
                    L.GeoJSON.coordsToLatLngs(geometriaEditada.coordinates[0]),
                    obterEstiloPoligonoManual(feature)
                );
                novoLayer.feature = feature;
                drawnItems.addLayer(novoLayer);
                novoLayer.bindPopup(criarPopupPoligonoManual(featureId), { maxWidth: 320, minWidth: 240 }).openPopup();
                mostrarNotificacao('✅ Edição confirmada. Clique em Salvar para Aprendizado para registrar.', 'info');
            });
        }
        if (btnCancelar) {
            btnCancelar.addEventListener('click', () => {
                window.map.removeLayer(editablePolygon);
                instrucoes.remove();
                // Rebind original layer
                const novoLayer = L.polygon(
                    L.GeoJSON.coordsToLatLngs(geometriaOriginal.coordinates[0]),
                    obterEstiloPoligonoManual(feature)
                );
                novoLayer.feature = feature;
                drawnItems.addLayer(novoLayer);
                novoLayer.bindPopup(criarPopupPoligonoManual(featureId), { maxWidth: 320, minWidth: 240 });
            });
        }
    }, 100);
}

// Expõe para o botão do HTML
window.exportarShapefile = exportarShapefile;
window.aplicarPreset = aplicarPreset;
window.resetarParametros = resetarParametros;
window.limparResultados = limparResultados;
window.marcarFeedbackPoligono = marcarFeedbackPoligono;
window.definirTipoBenfeitoria = definirTipoBenfeitoria;
window.buscarLocalNoMapa = buscarLocalNoMapa;
window.copiarCoordenadaCapturada = copiarCoordenadaCapturada;
window.idbPut = idbPut;
window.idbGetAll = idbGetAll; // ✨ Para continuous-learning.js
window.exportarRelatorioAppPdf = exportarRelatorioAppPdf;
window.definirModoVetorizacao = definirModoVetorizacao;
window.iniciarDesenhoManual = iniciarDesenhoManual;
window.salvarPoligonoManual = salvarPoligonoManual;
window.ativarEdicaoPoligonoManual = ativarEdicaoPoligonoManual;
window.ativarEdicaoPoligonoExportacao = ativarEdicaoPoligonoExportacao;
window.deletarPoligonoExportacao = deletarPoligonoExportacao;
window.deletarPoligonoManual = deletarPoligonoManual;
window.atualizarTipoManual = atualizarTipoManual;