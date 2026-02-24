/**
 * Offline Queue Service
 * Gerencia fila de operações pendentes quando offline
 * Usa IndexedDB como buffer e sincroniza quando a conexão é restaurada
 */

// ==================== CONFIGURAÇÃO INDEXEDDB ====================
const QUEUE_DB_NAME = 'vetorizador-offline-queue';
const QUEUE_DB_VERSION = 1;
const QUEUE_STORE_NAME = 'pending-operations';

let queueDb = null;

// ==================== INICIALIZAÇÃO ====================
export async function inicializarFilaOffline() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB_NAME, QUEUE_DB_VERSION);

    request.onerror = () => {
      console.error('❌ Erro ao abrir banco de fila offline');
      reject(request.error);
    };

    request.onsuccess = () => {
      queueDb = request.result;
      console.log('✅ Fila offline inicializada');
      resolve(queueDb);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
        const store = db.createObjectStore(QUEUE_STORE_NAME, { 
          keyPath: 'id', 
          autoIncrement: true 
        });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('operationType', 'operationType', { unique: false });
        console.log('📦 Object store de fila criado');
      }
    };
  });
}

// ==================== ADICIONAR À FILA ====================
/**
 * Adiciona operação à fila quando offline
 * @param {string} operationType - 'run', 'features', 'feedback'
 * @param {Object} payload - Dados da operação
 */
export async function adicionarNaFila(operationType, payload) {
  if (!queueDb) {
    console.warn('⚠️ Banco de fila não inicializado');
    return false;
  }

  return new Promise((resolve, reject) => {
    const transaction = queueDb.transaction([QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);

    const operation = {
      operationType,
      payload,
      timestamp: Date.now(),
      tentativas: 0
    };

    const request = store.add(operation);

    request.onsuccess = () => {
      console.log(`📥 Operação adicionada à fila: ${operationType}`);
      resolve(request.result); // Retorna ID da operação
    };

    request.onerror = () => {
      console.error('❌ Erro ao adicionar operação na fila');
      reject(request.error);
    };
  });
}

// ==================== LISTAR OPERAÇÕES PENDENTES ====================
export async function listarOperacoesPendentes() {
  if (!queueDb) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const transaction = queueDb.transaction([QUEUE_STORE_NAME], 'readonly');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

// ==================== REMOVER DA FILA ====================
export async function removerDaFila(operationId) {
  if (!queueDb) {
    return false;
  }

  return new Promise((resolve, reject) => {
    const transaction = queueDb.transaction([QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const request = store.delete(operationId);

    request.onsuccess = () => {
      console.log(`🗑️ Operação ${operationId} removida da fila`);
      resolve(true);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

// ==================== INCREMENTAR TENTATIVAS ====================
export async function incrementarTentativas(operationId) {
  if (!queueDb) {
    return false;
  }

  return new Promise((resolve, reject) => {
    const transaction = queueDb.transaction([QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const getRequest = store.get(operationId);

    getRequest.onsuccess = () => {
      const operation = getRequest.result;
      if (operation) {
        operation.tentativas = (operation.tentativas || 0) + 1;
        operation.ultimaTentativa = Date.now();
        
        const putRequest = store.put(operation);
        putRequest.onsuccess = () => resolve(operation.tentativas);
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        resolve(0);
      }
    };

    getRequest.onerror = () => {
      reject(getRequest.error);
    };
  });
}

// ==================== SINCRONIZAR FILA ====================
/**
 * Tenta sincronizar todas as operações pendentes com Firestore
 * @param {Function} processarOperacao - Callback que recebe (operationType, payload)
 * @returns {Object} {sucesso: number, falhas: number, total: number}
 */
export async function sincronizarFila(processarOperacao) {
  const operacoes = await listarOperacoesPendentes();
  
  if (operacoes.length === 0) {
    console.log('✅ Nenhuma operação pendente na fila');
    return { sucesso: 0, falhas: 0, total: 0 };
  }

  console.log(`🔄 Sincronizando ${operacoes.length} operações pendentes...`);
  
  let sucesso = 0;
  let falhas = 0;

  for (const operacao of operacoes) {
    try {
      // Callback fornecido pelo app.js para processar cada tipo de operação
      await processarOperacao(operacao.operationType, operacao.payload);
      
      // Se sucesso, remove da fila
      await removerDaFila(operacao.id);
      sucesso++;
      
    } catch (error) {
      console.error(`❌ Erro ao sincronizar operação ${operacao.id}:`, error);
      
      // Incrementa tentativas
      const tentativas = await incrementarTentativas(operacao.id);
      
      // Remove da fila se exceder 3 tentativas
      if (tentativas >= 3) {
        console.warn(`⚠️ Operação ${operacao.id} descartada após 3 tentativas`);
        await removerDaFila(operacao.id);
      }
      
      falhas++;
    }
  }

  console.log(`✅ Sincronização completa: ${sucesso} sucesso, ${falhas} falhas`);
  return { sucesso, falhas, total: operacoes.length };
}

// ==================== LIMPAR FILA ====================
export async function limparFila() {
  if (!queueDb) {
    return false;
  }

  return new Promise((resolve, reject) => {
    const transaction = queueDb.transaction([QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => {
      console.log('🗑️ Fila offline limpa');
      resolve(true);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

// ==================== CONTAGEM DE OPERAÇÕES PENDENTES ====================
export async function contarOperacoesPendentes() {
  if (!queueDb) {
    return 0;
  }

  return new Promise((resolve, reject) => {
    const transaction = queueDb.transaction([QUEUE_STORE_NAME], 'readonly');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const request = store.count();

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}
