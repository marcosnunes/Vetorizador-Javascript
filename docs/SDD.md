# Software Design Document (SDD)

## 1. Visão Geral

### 1.1 Objetivo

O Vetorizador-Javascript é uma aplicação web para vetorização de feições geográficas (principalmente edificações e benfeitorias) a partir de imagem de mapa/satélite, com processamento local em navegador, persistência híbrida online/offline e exportação geoespacial.

### 1.2 Escopo da solução

- Vetorização interativa em mapa (Leaflet).
- Pipeline CV + WASM para extração de contornos e geração de GeoJSON.
- Fluxo de feedback humano para melhoria contínua.
- Compartilhamento de aprendizado entre instâncias anônimas via Firestore (dataset global + modelo global).
- Módulo documental integrado (`pdfspliter/`) via iframe.
- Serviços backend para conversão de PDF/SHP para GeoJSON.

### 1.3 Tecnologias principais

- Frontend: JavaScript ES Modules, Vite, Leaflet, Turf, TensorFlow.js.
- Persistência: Firebase Auth (anônimo), Firestore, IndexedDB.
- Vetorização: Rust + wasm-bindgen (`--target no-modules`).
- Backend API: Node.js 20 (Azure Functions + handlers em `api/`).

## 2. Drivers de Design

### 2.1 Requisitos funcionais relevantes

- Usuário desenha ROI no mapa e recebe polígonos vetorizados.
- Usuário aplica presets e ajustes finos de parâmetros (`CONFIG`).
- Usuário exporta resultado em Shapefile ZIP.
- Sistema registra runs/features/feedback online (Firestore) e offline (fila IndexedDB).
- Sistema publica e consome modelo global compartilhado (`shared/global_ml_model`) entre sessões anônimas.
- Modelo de inferência local pode apoiar pós-processamento/autoajuste.

### 2.2 Requisitos não funcionais relevantes

- Operar com baixa latência no cliente (processamento in-browser).
- Tolerar perda de conectividade (modo offline + replay).
- Manter compatibilidade com GIS (GeoJSON Polygon e export SHP válido).
- Permitir deploy estático do frontend.
- Manter política de autenticação exclusivamente anônima no cliente e nas regras Firestore.

## 3. Arquitetura de Alto Nível

### 3.1 Visão lógica por módulos

- `app.js`: orquestra UI, mapa, pipeline CV, chamada WASM, filtros, export, integração com persistência e ML.
- `ml-training.js`: treinamento/local model management + publicação de artefatos do modelo global no Firestore.
- `auto-inference.js`: inferência automática e pós-processamento orientado por confiança, priorizando modelo global.
- `continuous-learning.js`: monitoramento de feedback e gatilhos de retreinamento usando dataset compartilhado.
- `firebase-config.js`: bootstrap Firebase/Auth e monitor de conectividade (somente sessões anônimas).
- `firestore-service.js`: persistência estruturada de runs/features/feedback, APP boundary e modelo global.
- `offline-queue.js`: fila de operações pendentes em IndexedDB com retry.
- `vetoriza/src/lib.rs`: função `vetorizar_imagem` em Rust/WASM que retorna GeoJSON.
- `api/`: endpoints de conversão documental/geoespacial.

### 3.2 Fronteiras de execução

- **Cliente (browser)**: mapa, processamento de imagem, inferência local/global, export SHP, IndexedDB.
- **WASM local**: extração de contornos a partir da máscara binária.
- **Firebase**: identidade anônima + persistência remota + distribuição de modelo global.
- **Azure Functions / API handlers**: conversões PDF→GeoJSON e SHP→GeoJSON.

## 4. Fluxos Principais

### 4.1 Fluxo de vetorização no mapa

1. Usuário desenha área no Leaflet.
2. `app.js` captura imagem da ROI e executa pré-processamento (contraste, Sobel, Otsu, morfologia, opcional DBSCAN).
3. Máscara binária é convertida para base64 e enviada para `vetorizar_imagem` (WASM).
4. Retorno GeoJSON é convertido/filtrado por área, score de qualidade e regras de fusão/simplificação.
5. Resultado é renderizado no mapa e disponibilizado para feedback/exportação.

### 4.2 Fluxo de persistência híbrida

- **Online**: gravação direta via `firestore-service.js`.
- **Offline**: operações entram na fila (`offline-queue.js`, store `pending-operations`) com `operationType` em `run|features|feedback`.
- Na reconexão: `sincronizarFila()` reprocesa operações; após 3 falhas a operação é descartada.

### 4.3 Fluxo de aprendizado contínuo

1. Feedback humano é salvo localmente/remotamente.
2. `window.atualizarContagemExemplos()` atualiza progresso em `continuous-learning.js` usando dataset compartilhado no Firestore (com fallback local).
3. Marcos (ex.: 100 exemplos) podem disparar sugestão de retreinamento.
4. `ml-training.js` treina modelo, salva localmente e publica artefatos no doc global `shared/global_ml_model`.
5. Novas instâncias carregam o modelo global no startup e uniformizam inferência.

## 5. Design de Dados

### 5.1 Firestore (modelo principal)

- Coleção `runs/{runId}`: metadados da execução, config e timestamps.
- Subcoleção `runs/{runId}/features/{featureId}`: metadados de feições (área, score, qualidade, etc.).
- Subcoleção `runs/{runId}/feedback/{featureId}`: avaliação humana e metadados de geometria original/editada.
- Documento de APP por usuário: `users/{userId}/settings/appBoundary`.
- Documento de modelo global: `shared/global_ml_model` com `modelTopology`, `weightSpecs`, `weightDataBase64`, versão e metadados.

### 5.2 IndexedDB local

- DB fila offline: `vetorizador-offline-queue`.
- Store: `pending-operations` com campos de operação, timestamp e tentativas.
- Outras stores de aprendizado são acessadas via utilitários globais (`window.idbGetAll`, `window.idbSet`) no fluxo de ML.

### 5.3 Contratos geoespaciais

- Saída do WASM deve ser `FeatureCollection` com geometrias `Polygon`.
- Anéis devem ser fechados (primeiro ponto repetido no final).
- Exportação SHP requer ZIP válido (`PK\x03\x04`).

## 6. Interfaces e Contratos

### 6.1 Contratos entre módulos frontend (globais)

A aplicação usa integração por `window.*`; nomes são contratos de runtime.

Exemplos consumidos em `app.js`:

- `window.autocarregarModeloML`
- `window.inicializarPhase5`
- `window.aplicarAutoInferenciaAoProcesamento`
- `window.atualizarContagemExemplos`
- `window.carregarModeloGlobalFirestore`

Mudanças nesses nomes/assinaturas quebram a orquestração.

### 6.2 APIs backend

- `POST /api/pdf-to-geojson`: converte PDF (base64) em GeoJSON.
- `POST /api/shp-to-geojson`: converte ZIP SHP (base64) em GeoJSON.
- Ambos suportam `OPTIONS` e política CORS configurável por env vars.

### 6.3 Dependências externas críticas

- CDN scripts no `index.html` (Leaflet, Turf, shpwrite, jsPDF, etc.).
- `vetoriza/pkg/vetoriza.js` + `vetoriza_bg.wasm` precisam estar servidos com caminho estável.

## 7. Decisões de Design Relevantes

1. **Orquestração central em `app.js`**
   - Simplifica coordenação de UI, pipeline e persistência, mas aumenta acoplamento.
2. **Processamento local no browser**
   - Reduz dependência de backend para vetorização e melhora privacidade de dados de imagem.
3. **WASM para etapa de contorno**
   - Balanceia performance com portabilidade no frontend.
4. **Persistência híbrida online/offline**
   - Garante continuidade operacional em campo com conexão instável.
5. **Integração por globais**
   - Facilita carregamento modular em scripts independentes; exige disciplina de compatibilidade.
6. **Modelo global compartilhado via Firestore**
   - Uniformiza comportamento entre instâncias com fallback local para resiliência.

## 8. Build, Empacotamento e Deploy

### 8.1 Frontend

- `npm run dev` (Vite, porta 8080)
- `npm run build` / `npm run preview`
- `npm run lint`

### 8.2 WASM

- Rebuild após mudanças Rust:
  - `wasm-pack build --target no-modules --release` (em `vetoriza/`)

### 8.3 Empacotamento de assets

`vite.config.js` executa `writeBundle` customizado para copiar:

- `vetoriza/pkg/vetoriza.js`
- `vetoriza/pkg/vetoriza_bg.wasm`
- pasta `pdfspliter/` completa
- `portfolio.html`

### 8.4 Backend

- Pasta `api/` com runtime Node >= 20.
- Estrutura inclui handlers para Azure Functions (`api/*/function.json`) e versões para execução direta.

## 9. Confiabilidade, Segurança e Observabilidade

### 9.1 Confiabilidade

- Retry da fila offline com descarte após 3 tentativas evita backlog infinito.
- Fallbacks de timestamp (`createdAt`) preservam rastreabilidade quando `serverTimestamp` não resolve imediatamente.

### 9.2 Segurança

- Auth anônimo Firebase obrigatório (sessões não anônimas são descartadas e recriadas como anônimas no bootstrap).
- CORS configurável nos endpoints backend.
- Firestore rules restringem acesso ao provider anônimo e permitem leitura global de dataset/modelo para aprendizado homogêneo.

### 9.3 Observabilidade

- Forte uso de logs no frontend (`console.log/warn/error`) para diagnóstico de WASM, CV e sincronização.
- Logs backend retornam erros estruturados em JSON para falhas de conversão.

## 10. Limitações e Riscos Técnicos

- `app.js` é extenso (alto acoplamento e custo de manutenção).
- Dependência de ordem de scripts em `index.html` (fragilidade de bootstrap).
- Dependência de CDNs em runtime para bibliotecas críticas.
- Contratos `window.*` não tipados aumentam risco de regressão silenciosa.
- Qualidade de vetorização depende de tuning de parâmetros e contexto da imagem.
- Em arquitetura 100% anônima client-side, governança rígida de publicação do modelo global exige mover publicação para backend confiável.

## 11. Troubleshooting Operacional

- Falha de vetorização: validar presença de `wasm_bindgen` e função `vetorizar_imagem`.
- Polígonos ruins: inspecionar threshold, métricas DBSCAN e filtros de qualidade.
- Erro de sync: verificar `contarOperacoesPendentes` e logs de `sincronizarFila`.
- Modelo global não aplica: validar documento `shared/global_ml_model` e permissões de leitura/escrita nas regras.
- ZIP SHP corrompido: confirmar decode base64 via `atob()` antes do `Blob`.

## 12. Referências de Código

- Frontend orquestrador: `app.js`
- Bootstrap Firebase: `firebase-config.js`
- Persistência remota: `firestore-service.js`
- Fila offline: `offline-queue.js`
- ML e inferência: `ml-training.js`, `auto-inference.js`, `continuous-learning.js`
- Regras de segurança: `firestore.rules`
- UI principal e ordem de scripts: `index.html`
- Vetorização WASM: `vetoriza/src/lib.rs`
- APIs backend: `api/pdf-to-geojson/index.js`, `api/shp-to-geojson/index.js`
- Build/cópia de assets: `vite.config.js`

---

**Documento atualizado em:** 2026-03-04
**Tipo:** SDD as-built (baseado no estado atual do repositório)
