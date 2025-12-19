# Vetorizador de Edificações

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Web-brightgreen.svg)
![WebAssembly](https://img.shields.io/badge/WebAssembly-Rust-orange.svg)

Sistema web profissional para detecção e vetorização automática de edificações a partir de imagens de satélite, utilizando técnicas avançadas de visão computacional e WebAssembly para processamento de alta performance totalmente no navegador.

## 🎯 Características

### Core Features
- **Processamento 100% Client-Side**: Toda detecção ocorre no navegador via WebAssembly (sem dependência de APIs externas)
- **Visão Computacional Avançada**: 
  - Sobel edge detection com threshold configurável
  - **Threshold Adaptativo Otsu** para binarização inteligente
  - Operações morfológicas (dilatação/erosão) com kernel ajustável
- **Exportação para Shapefile**: Gera arquivos `.shp` compatíveis com ArcGIS Pro e QGIS
- **Interface Interativa**: Baseada em Leaflet.js para seleção de áreas e visualização de resultados
- **Alta Performance**: Rust compilado para WASM garante processamento rápido de imagens

### Advanced Features
- **🎚️ Controles Profissionais Ajustáveis**:
  - Sensibilidade de bordas (30-200)
  - Kernel morfológico ajustável (1-9px)
  - Área mínima de detecção configurável
  - Fusão automática de fragmentos (0-10m)
  - Tolerância de simplificação Douglas-Peucker
  - Realce de contraste (1.0-2.0x)

- **🎯 Sistema de Qualidade Avançado**:
  - Score automático (0-100) baseado em múltiplos critérios
  - Análise de compacidade geométrica
  - Avaliação de número de vértices
  - Razão perímetro/área
  - Classificação: Alta (≥70) / Média (40-69) / Baixa (<40)

- **🔗 Fusão Inteligente de Polígonos**:
  - Detecta e mescla fragmentos da mesma edificação
  - Reduz drasticamente falsos positivos
  - Algoritmo baseado em distância entre centróides
  - Configurável via interface (0-10 metros)

- **🎨 Visualização Profissional**:
  - Cores dinâmicas por qualidade (Verde/Amarelo/Vermelho)
  - Popups detalhados com todas as métricas
  - Painel de estatísticas em tempo real
  - Contadores por categoria de qualidade

- **🔧 Limpeza e Validação Automática**:
  - Remoção de buracos internos
  - Correção de auto-interseções via buffer(0)
  - Validação topológica completa
  - Simplificação de geometrias complexas

## 🚀 Demonstração Online

🔗 **[https://vetorizador-javascript.vercel.app](https://vetorizador-javascript.vercel.app)**

Experimente agora mesmo no Multi-Critério

Cada polígono detectado passa por análise automática recebendo um **Score de Confiança (0-100)** baseado em múltiplos critérios geométricos:

### Critérios de Avaliação

| Critério | Peso | Faixa Ideal | Descrição |
|----------|------|-------------|-----------|
| **Área** | 35 pts | 25-400m² | Edificações residenciais/comerciais típicas |
| **Compacidade** | 35 pts | > 0.65 | Formas compactas vs lineares (sombras/estradas) |
| **Vértices** | 20 pts | 4-15 vértices | Geometrias regulares vs ruído |
| **Razão P/√A** | 10 pts | 3.5-5.5 | Relação perímetro/área normalizada |

**Fórmula de Compacidade**: `(4π × Área) / Perímetro²` onde círculo perfeito = 1.0 e linha = 0.0

### Classificação Automática

- **🟢 Alta Qualidade (70-100)**: Edificações bem definidas, geometria regular e compacta
- **🟡 Média Qualidade (40-69)**: Edificações válidas com geometria irregular
- **🔴 Baixa Qualidade (0-39)**: Possíveis falsos positivos, recomenda-se validação manual

### Atributos Exportados (Shapefile)

Cada polígono no arquivo `.shp` exportado contém os seguintes atributos profissionais:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | String | Identificador único (ex: `imovel_1`) |
| `area_m2` | Float | Área em metros quadrados (2 decimais) |
| `confidence_score` | Integer | Score de confiança (0-100) |
| `quality` | String | Classificação (`alta`, `media`, `baixa`) |
| `compactness` | Float | Índice de compacidade (0.0-1.0) |
| `vertices` | Integer | Número de vértices do polígono |

Totalmente compatível com ArcGIS Pro, QGIS e AutoCAD Map 3D./media/baixa)
- `compactness`: Índice de compacidade (0-1)
- `vertices`: Número de vértices

## 📋 Pré-requisitos

- Node.js >= 16
- Rust + wasm-pack (para desenvolvimento do módulo WASM)
- Navegador moderno com suporte a WebAssembly

## 🔧 Instalação

```bash
# Clone o repositório
git clone https://github.com/marcosnunes/Vetorizador-Javascript.git
cd Vetorizador-Javascript

# Instale as dependências
npm install

# Inicie o servidor de desenvolvimento
npm run dev
```

A aplicação estará disponível em `http://localhost:8080`

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (app.js)                        │
│  - Leaflet.js (mapa interativo)                             │
│  - Canvas API (pré-processamento de imagem)                 │
│  - Leaflet Draw (seleção de área)                           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│            Pipeline de Visão Computacional                  │
│  1. Captura de canvas (leafletImage)                        │
│  2. Realce de contraste (×1.2 + 20)                         │
│  3. Sobel edge detection (kernels 3×3)                      │
│  4. Binarização (threshold 128)                             │
│  5. Morphological closing (dilate + erode)                  │
│  6. Inversão de cores                                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│          Módulo WASM (Rust - vetoriza/src/lib.rs)          │
│  - imageproc::contours::find_contours                       │
│  - Geração de GeoJSON (Polygon)                             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Pós-processamento (app.js)                     │
│  - Conversão pixel → LatLng                                 │
│  - Filtragem por área (≥ 1m²)                               │
│  - Simplificação de polígonos (turf.js)                     │
│  - Exportação Shapefile (shp-write)                         │
└─────────────────────────────────────────────────────────────┘
```

## 📦 Estrutura do Projeto

```
.
├── app.js                    # Lógica principal da aplicação
├── index.html                # Interface HTML
├── style.css                 # Estilos da aplicação
├── vetoriza/                 # Módulo Rust/WASM
│   ├── src/
│   │   └── lib.rs           # Detecção de contornos
│   ├── pkg/                 # Artefatos WASM compilados
│   └── Cargo.toml           # Dependências Rust
├── vite.config.js           # Configuração de build
└── vercel.json              # Configuração de deployment
```

## 🛠️ Desenvolvimento

### Build Local

```bash
# Build da aplicação web
npm run build

# Preview do build
npm run preview
```

### Reconstruir Módulo WASM

```bash
cd vetoriza
wasm-pack build --target no-modules --release
cd ..
npm run build
git add vetoriza/pkg/  # Importante: commitar artefatos WASM
```

### Deploy para Vercel

```bash
vercel --prod
```

## 📖 Como Usar

### Workflow Profissional

1. **Selecione um Preset** (recomendado para início rápido):
   - 🏘️ **Área Urbana**: Otimizado para edificações residenciais densas
   - 🌾 **Área Rural**: Configurado para edificações esparsas com vegetação
   - 🏭 **Galpões Industriais**: Ajustado para grandes estruturas

2. **Ou Configure Manualmente** os parâmetros avançados:
   - **Sensibilidade de Bordas**: Controla detecção de contornos (30-200)
   - **Kernel Morfológico**: Tamanho para fechamento de gaps (1-9px)
   - **Área Mínima**: Filtra pequenos ruídos (5-200m²)
   - **Fusão de Fragmentos**: Une polígonos da mesma edificação (0-10m)
   - **Simplificação**: Reduz número de vértices mantendo forma
   - **Realce de Contraste**: Melhora definição de bordas (1.0-2.0x)
   - **Qualidade Mínima**: Score mínimo para aceitar polígono (0-100)

3. **Navegue no Mapa**:
   - Use zoom e pan para localizar a área de interesse
   - Recomendado: **Zoom 17-18** para edificações residenciais
   - Recomendado: **Zoom 16-17** para galpões industriais

4. **Desenhe a Área de Interesse**:
   - Clique no ícone de polígono na barra lateral
   - Desenhe sobre a região desejada
   - Finalize clicando no primeiro ponto

5. **Processamento Automático** (30s - 2min dependendo da área):
   - 📸 Captura de imagem em alta resolução
   - 🔆 Realce de contraste adaptativo
   - 🎯 Detecção de bordas (Sobel 3×3)
   - 📊 Threshold inteligente (Otsu)
   - 🔧 Operações morfológicas (dilatação + erosão)
   - 🎨 Vetorização via WASM/Rust
   - 🔗 Fusão de fragmentos adjacentes
   - ✅ Análise de qualidade multi-critério
   - 🧹 Limpeza e validação de geometrias

6. **Visualize e Valide**:
   - Polígonos aparecem coloridos por qualidade (Verde/Amarelo/Vermelho)
   - Clique em qualquer polígono para ver métricas detalhadas
   - Painel de **Estatísticas** mostra resumo completo
   - **Total de polígonos, área total, distribuição de qualidade**

7. **Exporte Profissionalmente**:
   - Clique em **"Exportar para Shapefile"**
   - Arquivo `.zip` é baixado contendo:
     - `edificacoes.shp` (geometrias)
     - `edificacoes.shx` (índice)
     - `edificacoes.dbf` (atributos)
     - `edificacoes.prj` (projeção WGS84)
   - Compatível com **ArcGIS Pro, QGIS, AutoCAD Map 3D**

## 🔍 Pipeline de Processamento

### 1. Captura e Pré-processamento
- **Captura de Canvas**: Extração de imagem via `leafletImage()`
- **Realce de Contraste**: `pixel × CONFIG.contrastBoost + 20`
- **Sobel Edge Detection**: 
  - Kernels Gx e Gy 3×3 para detecção de gradientes
  - Magnitude: `√(Gx² + Gy²)`
  - Threshold configurável (30-200)
- **Otsu Adaptive Thresholding**: 
  - Análise de histograma automática
  - Maximização de variância inter-classes
  - Adapta-se a diferentes iluminações

### 2. Operações Morfológicas
- **Morphological Closing**: Dilatação + Erosão
- **Fechamento de Gaps**: União de bordas fragmentadas
- **Remoção de Ruído**: Filtragem de artefatos pequenos
- **Kernel Ajustável**: 1-9px configurável via interface

### 3. Vetorização WASM/Rust
- **Contour Detection**: Algoritmo `imageproc::find_contours`
- **GeoJSON Generation**: Conversão para formato padrão
- **Polygon Closure**: Fechamento automático de anéis
- **Alta Performance**: Processamento compiled nativo

### 4. Pós-processamento Geoespacial
- **Conversão de Coordenadas**: Pixel → LatLng WGS84
- **Douglas-Peucker Simplification**: Redução inteligente de vértices
- **Fusão de Fragmentos**: União de polígonos adjacentes (mesma edificação)
- **Buffer(0) Cleaning**: Correção de auto-interseções
- **Hole Removal**: Remoção de buracos internos
- **Topology Validation**: Garantia de geometrias válidas

### 5. Análise de Qualidade
- **Área Analysis**: Verifica faixa esperada (25-400m²)
- **Compactness Score**: `(4πA) / P²` para detectar formas lineares
- **Vertex Count**: Valida geometrias regulares (4-15 vértices)
- **Perimeter/Area Ratio**: Identifica polígonos irregulares
- **Confidence Score**: 0-100 baseado em múltiplos critérios
- **Quality Classification**: Alta/Média/Baixa automática

## � Tecnologias e Algoritmos

### Stack Tecnológica

**Frontend (JavaScript)**
- Vanilla JS - Lógica sem dependências de frameworks pesados
- Leaflet.js 1.9.4 - Mapas interativos e visualização geoespacial
- Leaflet Draw - Ferramentas profissionais de desenho
- Turf.js 6.5.0 - Operações geoespaciais (área, buffer, simplificação, união, validação)
- shp-write 3.3.0 - Geração de Shapefiles compatíveis com ArcGIS/QGIS
- leaflet-image - Captura de canvas em alta resolução

**Backend (Rust/WASM)**
- wasm-bindgen - Bridge JavaScript ↔ Rust para máxima performance
- imageproc - Algoritmos otimizados de visão computacional
- image - Carregamento e manipulação de imagens
- geojson - Serialização padrão OGC

**Algoritmos de Visão Computacional**
- Sobel Edge Detection (3×3 kernels)
- Otsu Adaptive Thresholding
- Morphological Operations (Dilation + Erosion)
- Contour Tracing (Suzuki-Abe algorithm)
- Douglas-Peucker Simplification
- Buffer(0) Topology Cleaning

**Build & Deploy**
- Vite 7.3 - Build tool ultra-rápido
- Vercel - Edge network global com CDN
- w🎯 Presets Profissionais

O sistema inclui 3 presets otimizados para diferentes cenários:

### 🏘️ Área Urbana Profissional
Otimizado para edificações residenciais/comerciais em áreas densas.

**Parâmetros:**
- Edge Threshold: 75
- Morphology Size: 7px
- Min Area: 25m²
- Simplification: 0.00003
- Contrast Boost: 1.5x
- Quality Score: ≥50
- Merge Distance: 3m

**Ideal para:** Bairros residenciais, centros comerciais, áreas urbanas consolidadas

---

### 🌾 Área Rural Profissional
Configurado para edificações esparsas em meio à vegetação.

**Parâmetros:**
- Edge Threshold: 65
- Morphology Size: 9px (fecha gaps grandes)
- Min Area: 40m²
- Simplification: 0.00004
- Contrast Boost: 1.6x (separa de vegetação)
- Quality Score: ≥45
- Merge Distance: 3m

**Ideal para:** Propriedades rurais, fazendas, chácaras, áreas agrícolas

---

### 🏭 Galpões Industriais Profissional
Ajustado para grandes estruturas retangulares.

**Parâmetros:**
- Edge Threshold: 70
- Morphology Size: 7px
- Min Area: 150m²
- Simplification: 0.00005 (formas muito simplificadas)
- Contrast Boost: 1.4x
- Quality Score: ≥50
- Merge Distance: 3m

**Ideal para:** Distritos industriais, armazéns, centros logísticos, fábricas
- Área Mínima: 20-30m²
- Verificar qualidade: filtrar score < 50

## 🤝 Contribuindo

Contribuições são bem-vindas! Por favor:

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/MinhaFeature`)
3. Commit suas mudanças (`git commit -m 'Adiciona MinhaFeature'`)
4. Push para a branch (`git push origin feature/MinhaFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

## 👤 Autor

**Marcos Nunes**
- GitHub: [@marcosnunes](https://github.com/marcosnunes)

## 🙏 Agradecimentos

- Biblioteca [imageproc](https://github.com/image-rs/imageproc) pela implementação robusta de algoritmos de visão computacional
- Comunidade Rust/WASM pelo excelente ecossistema
- Leaflet.js pela biblioteca de mapas leve e flexível

---

⭐ Se este projeto foi útil, considere dar uma estrela no GitHub!
