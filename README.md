# Vetorizador de Edificações

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Web-brightgreen.svg)
![WebAssembly](https://img.shields.io/badge/WebAssembly-Rust-orange.svg)

Aplicação web de alta performance para detecção e vetorização automática de edificações a partir de imagens de satélite, utilizando técnicas de visão computacional clássica e WebAssembly.

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
- **🎚️ Controles Ajustáveis em Tempo Real**:
  - Sensibilidade de bordas (30-200)
  - Tamanho de kernel morfológico (1-7px)
  - Área mínima de detecção (0.5-10m²)
  - Tolerância de simplificação
  - Realce de contraste (1.0-2.0x)

- **🎯 Sistema de Confiança**:
  - Score automático (0-100) para cada polígono
  - Análise de compacidade e geometria
  - Classificação: Alta/Média/Baixa qualidade

- **🎨 Visualização Inteligente**:
  - Cores por qualidade (Verde/Amarelo/Vermelho)
  - Popups com métricas detalhadas
  - Estatísticas em tempo real

- **🔧 Limpeza Automática de Geometria**:
  - Remoção de buracos internos
  - Correção de auto-interseções
  - Validação topológica

## 🚀 Demonstração

🔗 **[https://vetorizador-javascript.vercel.app](https://vetorizador-javascript.vercel.app)**

## 🎯 Sistema de Qualidade

Cada polígono detectado recebe um **Score de Confiança (0-100)** baseado em múltiplos critérios:

### Critérios de Avaliação

| Critério | Pontos | Descrição |
|----------|--------|-----------|
| **Área Ideal** | 30 pts | 20-500m² (edificações típicas) |
| **Compacidade** | 30 pts | >0.6 (formas compactas, não lineares) |
| **Vértices** | 25 pts | 4-20 vértices (geometrias regulares) |
| **Razão P/A** | 15 pts | Perímetro/√Área entre 3-6 |

### Classificação

- **🟢 Alta Qualidade (70-100)**: Edificações bem definidas, geometria regular
- **🟡 Média Qualidade (40-69)**: Edificações válidas, geometria irregular
- **🔴 Baixa Qualidade (0-39)**: Possíveis falsos positivos, requer validação

### Métricas Exportadas

Cada polígono no Shapefile contém:
- `id`: Identificador único
- `area_m2`: Área em metros quadrados
- `confidence_score`: Score 0-100
- `quality`: Classificação (alta/media/baixa)
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

### Workflow Básico

1. **Ajuste os Parâmetros** (opcional, mas recomendado):
   - Configure **Sensibilidade de Bordas** conforme contraste da imagem
   - Ajuste **Área Mínima** baseado no zoom (edificações pequenas = menor valor)
   - Modifique **Suavização** se houver gaps nas bordas

2. **Navegue até a área desejada** no mapa utilizando zoom e pan
   - Recomendado: Zoom 16-18 para melhor resolução

3. **Desenhe um polígono** sobre a região que deseja vetorizar
   - Use a ferramenta de desenho (ícone de polígono)

4. **Aguarde o processamento automático**:
   - ✅ Captura de imagem
   - ✅ Realce de contraste
   - ✅ Detecção de bordas (Sobel)
   - ✅ Threshold adaptativo (Otsu)
   - ✅ Operações morfológicas
   - ✅ Vetorização via WASM
   - ✅ Análise de qualidade
   - ✅ Limpeza de geometria

5. **Visualize os Resultados**:
   - Polígonos aparecem no mapa com cores por qualidade (se ativado)
   - Clique em um polígono para ver detalhes (área, score, etc.)
   - Confira estatísticas no painel lateral

6. **Ajuste se Necessário**:
   - Se muitos falsos positivos → aumente Área Mínima
   - Se bordas desconectadas → aumente Suavização
   - Se poucas detecções → reduza Sensibilidade de Bordas

7. **Exporte para Shapefile**:
   - Clique em "Exportar Shapefile"
   - Arquivo `.zip` será baixado com todos os layers

## 🔍 Pipeline de Processamento Detalhado

### 1. Pré-processamento (Canvas)
- **Realce de Contraste**: `pixel * CONFIG.contrastBoost + 20` (configurável 1.0-2.0x)
- **Sobel Edge Detection**: 
  - Kernels 3×3 para gradientes Gx e Gy
  - Magnitude: `sqrt(Gx² + Gy²)`
  - Threshold configurável (30-200)
- **Binarização Adaptativa**: 
  - **Algoritmo Otsu**: Calcula threshold ótimo automaticamente
  - Analisa histograma e maximiza variância inter-classes
  - Adapta-se a diferentes condições de iluminação

### 2. Limpeza Morfológica
- **Morphological Closing**: 
  - Dilatação seguida de erosão
  - Kernel configurável (1-7px)
  - Fecha gaps e remove ruídos
- **Inversão de Cores**: Prepara máscara para WASM

### 3. Vetorização (WASM/Rust)
- **Detecção de Contornos**: 
  - Biblioteca `imageproc::find_contours`
  - Algoritmo de rastreamento de bordas
- **Geração de GeoJSON**: 
  - Converte contornos em Polygon
  - Fecha anéis automaticamente

### 4. Pós-processamento Avançado
- **Conversão de Coordenadas**: Pixel (x,y) → Lat/Lng usando bounds
- **Simplificação Douglas-Peucker**: 
  - Tolerância configurável (0.000001-0.0001)
  - Mantém forma com menos vértices
- **Limpeza de Geometria**:
  - Remove buracos internos
  - Corrige auto-interseções via `turf.buffer(0)`
  - Valida topologia
- **Análise de Qualidade**:
  - **Compacidade**: `(4πA) / P²` (círculo perfeito = 1.0)
  - **Score de Confiança**: 0-100 baseado em:
    - Área razoável (20-500m² = ideal)
    - Alta compacidade (>0.6 = ótimo)
    - Número de vértices (4-20 = típico)
    - Razão perímetro/área (3-6 = normal)
- **Classificação**: Alta (≥70) / Média (40-69) / Baixa (<40)
- **Filtragem por Área**: Remove polígonos < CONFIG.minArea m²

## 🐛 Resolução de Problemas

### WASM não carrega
- **Sintoma**: Console mostra "Falha ao carregar WASM"
- **Solução**: Verifique se `vetoriza/pkg/` foi commitado no Git e deployed no Vercel
- **Verificação**: Console deve mostrar "Módulo WASM carregado com sucesso"

### Shapefile corrompido
- **Sintoma**: ZIP não extrai ou ArcGIS não abre
- **Solução**: Verificar se os primeiros 4 bytes são `[80, 75, 3, 4]` (assinatura "PK")
- **Causa comum**: Cache do navegador - use Ctrl+Shift+R para forçar reload

### JavaScript não atualiza
- **Sintoma**: Mudanças no código não aparecem
- **Solução**: 
  - Limpar cache: Ctrl+Shift+R (Windows) ou Cmd+Shift+R (Mac)
  - Testar em modo anônimo
  - Verificar se o build foi executado (`npm run build`)

### Muitos falsos positivos
- **Sintoma**: Polígonos em áreas sem edificações (vegetação, sombras)
- **Solução**:
  1. **Aumentar Área Mínima** para 2-5m²
  2. **Aumentar Sensibilidade de Bordas** para 120-150
  3. **Reduzir Suavização** para 1-3px
  4. Verificar qualidade dos polígonos (usar visualização por cores)

### Poucas detecções
- **Sintoma**: Edificações não são detectadas
- **Solução**:
  1. **Reduzir Sensibilidade de Bordas** para 50-80
  2. **Aumentar Realce de Contraste** para 1.5-1.8x
  3. **Aumentar Suavização** para 5-7px para fechar gaps
  4. Verificar se zoom está adequado (16-18 recomendado)

### Bordas desconectadas
- **Sintoma**: Polígonos com gaps ou formas quebradas
- **Solução**:
  1. **Aumentar Suavização de Bordas** para 5-7px
  2. **Reduzir Sensibilidade** para detectar mais bordas fracas
  3. Usar zoom maior para capturar mais detalhes

### Polígonos com baixa qualidade
- **Sintoma**: Muitos polígonos vermelhos/amarelos
- **Solução**:
  1. Filtrar manualmente no shapefile exportado
  2. Ajustar **Área Mínima** para remover pequenos ruídos
  3. Usar **Simplificação** maior para suavizar geometrias
  4. Verificar popups para entender score de cada polígono

### Performance lenta
- **Sintoma**: Processamento demora muito
- **Solução**:
  1. Reduzir área de seleção (processar em partes menores)
  2. Aumentar **Simplificação** para reduzir vértices
  3. Aumentar **Área Mínima** para filtrar mais ruídos
  4. Usar navegador moderno (Chrome/Edge recomendados)

## 📊 Tecnologias Utilizadas

### Frontend
- **Vanilla JavaScript**: Lógica principal sem frameworks
- **Leaflet.js**: Mapas interativos e visualização
- **Leaflet Draw**: Ferramentas de desenho
- **Turf.js**: Operações geoespaciais avançadas (área, simplificação, buffer, validação)
- **shp-write**: Exportação de Shapefiles

### Backend WASM (Rust)
- **wasm-bindgen**: Ponte JS ↔ Rust
- **imageproc**: Algoritmos de visão computacional
  - `find_contours`: Detecção de contornos
  - `threshold`: Binarização
- **image**: Manipulação de imagens
- **geojson**: Serialização de geometrias

### Algoritmos Implementados
- **Sobel Edge Detection**: Detecção de gradientes
- **Otsu's Method**: Threshold adaptativo
- **Morphological Operations**: Dilatação e erosão
- **Douglas-Peucker**: Simplificação de polígonos
- **Buffer(0) Trick**: Correção de auto-interseções
- **Quality Scoring**: Análise multi-critério de confiança

### Build & Deploy
- **Vite 7.3**: Build tool rápido
- **Vercel**: Hosting com edge network global

## 📝 Limitações e Boas Práticas

### Limitações Conhecidas
- **Resolução**: Funciona melhor em zoom 16-18 (imagens de alta resolução)
- **Contraste**: Edificações com telhados similares ao entorno podem não ser detectadas
- **Falsos Positivos**: Sombras, vegetação densa e piscinas podem gerar detecções
  - Mitigado por: filtro de área, score de qualidade, análise de compacidade
- **Edificações Sobrepostas**: Muito próximas podem ser unidas em um único polígono
- **Geometrias Complexas**: Edificações com formas muito irregulares podem ter simplificação

### Boas Práticas

✅ **Para Melhores Resultados**:
- Use zoom 17-18 para edificações residenciais
- Use zoom 16 para galpões/indústrias grandes
- Processe áreas pequenas (< 1km²) por vez
- Configure parâmetros ANTES de processar
- Teste configurações em área pequena primeiro
- Ative "Colorir por Qualidade" para validação visual
- Exporte apenas após verificar estatísticas

✅ **Configurações Recomendadas por Cenário**:

**Área Urbana Densa** (muitas casas próximas):
- Sensibilidade: 80-100
- Suavização: 3-5px
- Área Mínima: 15-25m²
- Contraste: 1.3-1.5x

**Área Rural** (edificações esparsas):
- Sensibilidade: 60-80
- Suavização: 5-7px
- Área Mínima: 30-50m²
- Contraste: 1.4-1.6x

**Galpões Industriais** (grandes estruturas):
- Sensibilidade: 70-90
- Suavização: 5-7px
- Área Mínima: 100-200m²
- Contraste: 1.2-1.4x
- Simplificação: 0.00003-0.00005

**Área com Sombras** (muitos falsos positivos):
- Sensibilidade: 100-120
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
