# Vetorizador de Edificações

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Web-brightgreen.svg)
![WebAssembly](https://img.shields.io/badge/WebAssembly-Rust-orange.svg)

Aplicação web de alta performance para detecção e vetorização automática de edificações a partir de imagens de satélite, utilizando técnicas de visão computacional clássica e WebAssembly.

## 🎯 Características

- **Processamento 100% Client-Side**: Toda detecção ocorre no navegador via WebAssembly (sem dependência de APIs externas)
- **Visão Computacional Clássica**: Utiliza Sobel edge detection e operações morfológicas (dilatação/erosão)
- **Exportação para Shapefile**: Gera arquivos `.shp` compatíveis com ArcGIS Pro e QGIS
- **Interface Interativa**: Baseada em Leaflet.js para seleção de áreas e visualização de resultados
- **Filtragem Inteligente**: Remove automaticamente ruídos e detecções < 1m²
- **Alta Performance**: Rust compilado para WASM garante processamento rápido de imagens

## 🚀 Demonstração

🔗 **[https://vetorizador-javascript.vercel.app](https://vetorizador-javascript.vercel.app)**

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

1. **Navegue até a área desejada** no mapa utilizando zoom e pan
2. **Desenhe um retângulo** sobre a região que deseja vetorizar (use a ferramenta de desenho)
3. **Aguarde o processamento** - o sistema irá:
   - Capturar a imagem da área selecionada
   - Aplicar filtros de detecção de bordas
   - Vetorizar edificações encontradas
   - Filtrar ruídos (polígonos < 1m²)
4. **Visualize os resultados** - polígonos detectados aparecem em ciano no mapa
5. **Exporte para Shapefile** - clique no botão "Exportar Shapefile" para download do arquivo `.zip`

## 🔍 Pipeline de Processamento Detalhado

### 1. Pré-processamento (Canvas)
- **Realce de Contraste**: `pixel * 1.2 + 20` para melhorar definição de bordas
- **Sobel Edge Detection**: Detecção de gradientes horizontais (Gx) e verticais (Gy)
- **Binarização**: Threshold 128 para criar máscara binária

### 2. Limpeza Morfológica
- **Dilatação** (3×3 kernel): Fecha pequenos gaps nas bordas
- **Erosão** (3×3 kernel): Remove ruídos isolados
- **Inversão**: Prepara para detecção de contornos (fundo branco, edificações pretas)

### 3. Vetorização (WASM)
- **Detecção de Contornos**: Algoritmo `find_contours` da biblioteca `imageproc`
- **Geração de GeoJSON**: Converte contornos em geometrias Polygon

### 4. Pós-processamento
- **Conversão de Coordenadas**: Pixel (x,y) → Lat/Lng usando bounds do mapa
- **Cálculo de Área**: Utiliza `turf.js` para área em m²
- **Filtragem**: Remove polígonos com área < 1m²
- **Simplificação**: Reduz número de vértices mantendo forma

## 🐛 Resolução de Problemas

### WASM não carrega
- **Sintoma**: Console mostra "Falha ao carregar WASM"
- **Solução**: Verifique se `vetoriza/pkg/` foi commitado no Git e deployed no Vercel

### Shapefile corrompido
- **Sintoma**: ZIP não extrai ou ArcGIS não abre
- **Solução**: Verificar se os primeiros 4 bytes são `[80, 75, 3, 4]` (assinatura "PK")
- **Causa comum**: Cache do navegador - use Ctrl+Shift+R para forçar reload

### JavaScript não atualiza
- **Sintoma**: Mudanças no código não aparecem
- **Solução**: Limpar cache do navegador (Ctrl+Shift+R) ou testar em modo anônimo

### Nenhum polígono detectado
- **Possíveis causas**:
  - Zoom muito alto/baixo (edificações muito pequenas/grandes)
  - Imagem de satélite com baixo contraste
  - Área sem edificações visíveis
- **Solução**: Ajustar zoom e tentar em área com edificações bem definidas

## 📊 Tecnologias Utilizadas

- **Frontend**: Vanilla JavaScript, Leaflet.js, Turf.js
- **Backend WASM**: Rust, wasm-bindgen, imageproc
- **Build Tool**: Vite
- **Deployment**: Vercel
- **Bibliotecas de Processamento**:
  - `imageproc` - Detecção de contornos
  - `image` - Manipulação de imagens
  - `geojson` - Serialização de geometrias
  - `shp-write` - Exportação de Shapefiles

## 📝 Limitações Conhecidas

- Detecção funciona melhor em imagens de satélite de alta resolução (zoom 16-18)
- Edificações com telhados da mesma cor do entorno podem não ser detectadas
- Sombras e vegetação podem gerar falsos positivos (mitigado pelo filtro de área)
- Polígonos muito complexos podem ter simplificação de geometria

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
