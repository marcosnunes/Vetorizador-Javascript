// ==================== ML TRAINING MODULE - PHASE 3 ====================
// TensorFlow.js Neural Network para aprender ajustes de parâmetros
// Entrada: Imagem processada + parâmetros CV
// Saída: Qualidade predita + ajustes de parâmetros recomendados

let modeloTreinado = null;

const DEFAULT_TRAINING_CONFIG = {
  edgeThreshold: 90,
  morphologySize: 5,
  minArea: 15,
  contrastBoost: 1.3,
  minQualityScore: 35,
  simplification: 0.00001
};

function obterConfigTreinamento(feature, run) {
  const merged = {
    ...DEFAULT_TRAINING_CONFIG,
    ...(run?.config || {}),
    ...(feature?.config || {})
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
  const exemplos = [];
  
  if (!dataset.runs || dataset.runs.length === 0) {
    console.warn('⚠️ Nenhum run no dataset');
    return null;
  }

  // Iterar sobre cada run (vetorização)
  dataset.runs.forEach((run) => {
    if (!run.features || run.features.length === 0) return;

    // Iterar sobre feedback de cada feature
    dataset.feedback.forEach((fb) => {
      if (fb.runId !== run.runId) return;
      
      // Procurar feature correspondente
      const feature = run.features.find(f => f.featureId === fb.featureId);
      if (!feature) return;

      const config = obterConfigTreinamento(feature, run);

      // Criar entrada: [edgeThreshold, morphologySize, minArea, contrastBoost, minQualityScore, simplification]
      // Normalizar para [0, 1]
      const entrada = window.tf.tensor1d([
        Math.min(config.edgeThreshold / 200, 1),      // 0-200 → 0-1
        Math.min(config.morphologySize / 9, 1),       // 0-9 → 0-1
        Math.min(config.minArea / 100, 1),            // 0-100m² → 0-1
        Math.min(config.contrastBoost / 2, 1),        // 0-2 → 0-1
        config.minQualityScore / 100,                 // 0-100 → 0-1
        Math.min(config.simplification * 100000, 1)   // muito pequeno → 0-1
      ]);

      // Criar saída: qualidade predita (feedback label)
      let qualidadeAlvo = 0.5; // padrão
      if (fb.label === 'aprovado') qualidadeAlvo = 0.9;      // Muito bom
      else if (fb.label === 'editado') qualidadeAlvo = 0.7;  // Corrigível
      else if (fb.label === 'rejeitado') qualidadeAlvo = 0.2; // Ruim

      // Ajustes recomendados baseados em feedback
      const ajustesRecomendados = recomendarAjustes(feature, fb, run);

      exemplos.push({
        entrada,
        saida: window.tf.tensor1d([
          qualidadeAlvo,
          ajustesRecomendados.edgeThreshold,
          ajustesRecomendados.morphologySize,
          ajustesRecomendados.contrastBoost,
          ajustesRecomendados.minArea,
          ajustesRecomendados.simplification
        ])
      });
    });
  });

  console.log(`✅ Dataset preparado: ${exemplos.length} exemplos para treinamento`);
  
  if (exemplos.length < 10) {
    alert('⚠️ Poucos exemplos para treinamento! Recomendado: ≥10 exemplos, você tem: ' + exemplos.length);
  }

  return exemplos;
}

// Recomendar ajustes baseado em feedback
function recomendarAjustes(feature, feedback, run) {
  const multiplier = feedback.label === 'rejeitado' ? 0.8 : 
                     feedback.label === 'editado' ? 0.95 : 1.0;

  const config = obterConfigTreinamento(feature, run);

  return {
    edgeThreshold: Math.min(config.edgeThreshold * multiplier / 200, 1),
    morphologySize: Math.min(config.morphologySize * multiplier / 9, 1),
    contrastBoost: Math.min(config.contrastBoost * multiplier / 2, 1),
    minArea: Math.min(config.minArea * multiplier / 100, 1),
    simplification: Math.min(config.simplification * multiplier * 100000, 1)
  };
}

// Treinar modelo com dataset
async function treinarModeloML(dataset) {
  console.log('🧠 Iniciando treinamento do modelo ML...');
  
  // Validar e preparar dataset
  const exemplos = prepararDatasetTreinamento(dataset);
  if (!exemplos || exemplos.length < 5) {
    alert('❌ Dataset insuficiente para treinamento!\n\nMínimo: 5 exemplos de feedback\nVocê tem: ' + (exemplos?.length || 0));
    return false;
  }

  // Criar modelo
  const modelo = await criarModeloML();
  if (!modelo) return false;

  try {
    // Preparar tensores
    const xs = window.tf.concat(exemplos.map(ex => ex.entrada));
    const ys = window.tf.stack(exemplos.map(ex => ex.saida));

    // Treinar modelo com callbacks para UI
    console.log('📊 Treinando em', exemplos.length, 'exemplos...');
    const history = await modelo.fit(xs, ys, {
      epochs: 50,
      batchSize: Math.max(2, Math.floor(exemplos.length / 4)),
      validationSplit: 0.2,
      shuffle: true,
      verbose: 0,  // Silencioso (usaremos nosso callback)
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

    console.log('✅ Modelo treinado com sucesso!');
    console.log('📈 Loss inicial:', lossInicial);
    console.log('📉 Loss final:', lossFinal);
    console.log('🎯 Melhoria:', melhoria + '%');

    // Limpar memória
    xs.dispose();
    ys.dispose();
    exemplos.forEach(ex => {
      ex.entrada.dispose();
      ex.saida.dispose();
    });

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
    const entrada = window.tf.tensor2d([[
      Math.min(parametrosCurrent.edgeThreshold / 200, 1),
      Math.min(parametrosCurrent.morphologySize / 9, 1),
      Math.min(parametrosCurrent.minArea / 100, 1),
      Math.min(parametrosCurrent.contrastBoost / 2, 1),
      parametrosCurrent.minQualityScore / 100,
      Math.min(parametrosCurrent.simplification * 100000, 1)
    ]]);

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
window.fazerPredictionML = fazerPredictionML;
