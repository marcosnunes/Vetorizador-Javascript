/**
 * Firebase Configuration Module
 * Inicializa Firebase App, Firestore e Authentication
 */

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged, signOut } from 'firebase/auth';

// ==================== CONFIGURAÇÃO ====================
// Credenciais do projeto: Vetorizador-Inteligente
const firebaseConfig = {
  apiKey: "AIzaSyDXPFbnzX45AmIcANhndRUYPYI2UmGlCB4",
  authDomain: "vetorizador-inteligente.firebaseapp.com",
  projectId: "vetorizador-inteligente",
  storageBucket: "vetorizador-inteligente.firebasestorage.app",
  messagingSenderId: "1052673719804",
  appId: "1:1052673719804:web:e8f7bd35301e3c43334679",
  measurementId: "G-RFMXJ5RPPP"
};

// ==================== INICIALIZAÇÃO ====================
let app, db, auth;
let usuarioAtual = null;

export function inicializarFirebase() {
  try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);

    console.log('✅ Firebase inicializado com sucesso');
    
    // Autenticação anônima automática
    onAuthStateChanged(auth, (user) => {
      if (user) {
        if (user.isAnonymous) {
          usuarioAtual = user.uid;
          console.log(`🔐 Usuário anônimo autenticado: ${user.uid.substring(0, 8)}...`);
          return;
        }

        console.warn('⚠️ Sessão não anônima detectada. Forçando reautenticação anônima...');
        signOut(auth)
          .then(() => signInAnonymously(auth))
          .then((credential) => {
            usuarioAtual = credential.user.uid;
            console.log(`🆕 Novo usuário anônimo: ${usuarioAtual.substring(0, 8)}...`);
          })
          .catch((error) => {
            console.error('❌ Erro ao forçar sessão anônima:', error);
          });
      } else {
        // Auto-login anônimo se não houver usuário
        signInAnonymously(auth)
          .then((credential) => {
            usuarioAtual = credential.user.uid;
            console.log(`🆕 Novo usuário anônimo: ${usuarioAtual.substring(0, 8)}...`);
          })
          .catch((error) => {
            console.error('❌ Erro na autenticação anônima:', error);
          });
      }
    });

    return { db, auth };
  } catch (error) {
    console.error('❌ Erro ao inicializar Firebase:', error);
    return { db: null, auth: null };
  }
}

// ==================== GETTERS ====================
export function obterFirestore() {
  if (!db) {
    throw new Error('Firestore não inicializado. Chame inicializarFirebase() primeiro.');
  }
  return db;
}

export function obterAuth() {
  if (!auth) {
    throw new Error('Auth não inicializado. Chame inicializarFirebase() primeiro.');
  }
  return auth;
}

export function obterUsuarioAtual() {
  return usuarioAtual;
}

// ==================== VERIFICAÇÃO DE CONEXÃO ====================
export function estaOnline() {
  return navigator.onLine;
}

// Listener para mudanças no status de conexão
export function monitorarConexao(callbackOnline, callbackOffline) {
  window.addEventListener('online', () => {
    console.log('🌐 Conexão restaurada');
    if (callbackOnline) callbackOnline();
  });

  window.addEventListener('offline', () => {
    console.log('📵 Sem conexão - modo offline ativado');
    if (callbackOffline) callbackOffline();
  });
}
