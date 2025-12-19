# Vetorizador de Edificações - AI Agent Instructions

## Architecture Overview

**Hybrid WebAssembly + Classical Computer Vision Application**
- **Frontend**: Vanilla JS ([app.js](../app.js)) with Leaflet.js for interactive maps, Vite dev server
- **WASM Module**: Rust-compiled contour detection ([vetoriza/src/lib.rs](../vetoriza/src/lib.rs)) → `vetoriza/pkg/vetoriza.js`
- **Deployment**: Vercel with minimal config (`vercel.json`), Vite handles static builds
- **100% Client-Side**: No backend APIs or external services required
- **Key Libraries**: `turf.js` (geospatial analysis), `shpwrite.js` (Shapefile export), `leafletImage` (canvas capture)

### Data Flow (Classical CV Pipeline)
1. User draws polygon on Leaflet map → captures canvas via `leafletImage()`
2. Canvas preprocessing in [app.js](../app.js#L550-L650):
   - Contrast boost (configurable: `CONFIG.contrastBoost`, default ×1.3 + 20)
   - **Sobel edge detection** (3×3 kernels, Gx/Gy gradients, threshold: `CONFIG.edgeThreshold`)
   - **Otsu adaptive thresholding** ([app.js:258-304](../app.js#L258-L304)) - intelligent binarization
   - **Morphological closing** (dilate+erode, kernel: `CONFIG.morphologySize`)
   - Color inversion (white edges → black background)
3. Base64 image sent to WASM `vetorizar_imagem()` → GeoJSON polygons via `imageproc::contours`
4. Pixel coordinates converted to LatLng using map bounds ([app.js:802-897](../app.js#L802-L897))
5. **Quality scoring system** ([app.js:307-385](../app.js#L307-L385)):
   - Score 0-100 based on: area (35pts), compactness (35pts), vertices (20pts), perimeter/area ratio (10pts)
   - Filters out polygons with score < `CONFIG.minQualityScore` (default 35)
   - Classifies as: Alta (70-100), Média (40-69), Baixa (0-39)
6. **Geometry cleaning** ([app.js:387-408](../app.js#L387-L408)): removes inner holes, fixes self-intersections with `turf.buffer(0)`
7. Results rendered as Leaflet GeoJSON layer with color-coded quality → exported as Shapefile (Base64 ZIP)

### Configuration System
**All CV parameters are runtime-adjustable** via UI sliders synced with `CONFIG` object ([app.js:16-75](../app.js#L16-L75)):
```javascript
CONFIG = {
  edgeThreshold: 90,       // Sobel threshold (30-200)
  morphologySize: 5,       // Kernel size (1-7px)
  minArea: 15.0,           // Min polygon area (m²)
  simplification: 0.00001, // Douglas-Peucker tolerance
  contrastBoost: 1.3,      // Contrast multiplier
  minQualityScore: 35      // Quality filter (0-100)
}
```

**Presets** ([app.js:76-140](../app.js#L76-L140)): Urbano (dense buildings), Rural (sparse buildings), Industrial (large warehouses)

## Critical Patterns

### WASM Integration (No-Modules Target)
**Current setup uses `--target no-modules` for UMD compatibility** (required for direct script loading):
```bash
cd vetoriza
wasm-pack build --target no-modules --release
git add pkg/  # MUST commit WASM artifacts to repo
```

**Frontend loading** ([app.js:413-421](../app.js#L413-L421)):
```javascript
await wasm_bindgen('vetoriza/pkg/vetoriza_bg.wasm');
vetorizar_imagem = wasm_bindgen.vetorizar_imagem;
```

**Rust function** ([lib.rs:46-48](../vetoriza/src/lib.rs#L46-L48)): Returns GeoJSON string with **Polygon** geometry (not LineString):
```rust
// Polygon requires array of rings (outer + holes)
let geometry = Geometry::new(Value::Polygon(vec![coordinates]));
```

### Shapefile Export (Base64 ZIP Critical Fix)
**CRITICAL**: `shpwrite.zip()` returns **Base64-encoded ZIP**, not binary. Must decode before creating Blob ([app.js:938-946](../app.js#L938-L946)):

```javascript
const binaryString = atob(zipData);  // Decode Base64 FIRST
const zipBuffer = new Uint8Array(binaryString.length);
for (let i = 0; i < binaryString.length; i++) {
  zipBuffer[i] = binaryString.charCodeAt(i);
}
const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });
```

**Without `atob()` decoding, ZIP files are corrupted**. Verify header: `[80, 75, 3, 4]` = "PK" signature. Test exports by extracting with 7-Zip/WinRAR and opening `.shp` files in QGIS/ArcGIS Pro.

### Quality Scoring Algorithm
**Multi-factor heuristic** ([app.js:307-385](../app.js#L307-L385)) to filter false positives (shadows, roads, noise):

| Factor | Weight | Ideal Range | Penalty |
|--------|--------|-------------|---------|
| **Area** | 35pts | 25-400m² | -10pts if < 10m² |
| **Compactness** | 35pts | > 0.65 | -10pts if < 0.3 (linear shapes) |
| **Vertices** | 20pts | 4-15 | -5pts if > 40 (noisy) |
| **Perimeter/√Area** | 10pts | 3.5-5.5 | -10pts if > 8 (irregular) |

**Compactness formula**: `(4π × area) / perimeter²` - circle = 1.0, line = 0.0

### Vite Build Plugin
**Custom plugin copies WASM + app.js to dist** ([vite.config.js:17-42](../vite.config.js#L17-L42)):
```javascript
plugins: [{
  name: 'copy-assets',
  writeBundle() {
    // Ensures vetoriza/pkg/*.wasm available in dist/
    mkdirSync('dist/vetoriza/pkg', { recursive: true });
    copyFileSync('vetoriza/pkg/vetoriza_bg.wasm', 'dist/vetoriza/pkg/vetoriza_bg.wasm');
    // ... copies vetoriza.js and app.js
  }
}]
```
**Without this**, production builds fail with 404 errors on WASM files.

## Developer Workflows

### Local Development
```bash
npm install              # Install deps (first time)
npm run dev              # Vite dev server on localhost:8080
```
**Browser caching issue**: After JS changes, use **Ctrl+Shift+R** (Windows) or **Cmd+Shift+R** (Mac) to force reload without cache. Alternatively, test in incognito mode.

### Testing Changes
1. **Test locally first**: `npm run build && npm run preview` (serves dist/ on port 4173)
2. **Verify WASM loads**: Console should show "Módulo WASM carregado com sucesso"
3. **Test vectorization**: Draw polygon → check console for polygon count and quality scores
4. **Test export**: Download Shapefile → extract ZIP → open in QGIS/ArcGIS Pro

### WASM Rebuild (After Rust Changes)
```bash
cd vetoriza
wasm-pack build --target no-modules --release
cd ..
npm run build            # Test locally first
git add vetoriza/pkg/    # MUST commit WASM artifacts
git commit -m "Update WASM module"
```
**Note**: `vetoriza/pkg/` is **not** gitignored - WASM binaries must be committed for Vercel deployment.

### Vercel Deployment
```bash
vercel link              # First time only (links to project)
vercel --prod            # Deploy to production
```
**No environment variables required** - all processing is client-side. Build command: `npm run build`, output: `dist/`.

## Common Pitfalls

1. **Corrupted Shapefile ZIP**: Forgetting `atob()` decode for Base64 → binary conversion. ZIP starts with `[80, 75, 3, 4]` ("PK" magic bytes).
2. **Browser cache**: Old `app.js` cached → use Ctrl+Shift+R or test in incognito mode.
3. **WASM 404 in production**: `vetoriza/pkg/` must be committed (not in `.gitignore`).
4. **Wrong WASM target**: `--target web` breaks UMD loading → always use `--target no-modules`.
5. **LineString vs Polygon**: Rust must return `Polygon` geometry (array of rings), not `LineString` (Shapefile requirement).
6. **Polygon not closed**: First point must equal last point. Rust code handles this ([lib.rs:38-43](../vetoriza/src/lib.rs#L38-L43)).
7. **Safari warnings**: "Tracking Prevention blocked access to storage" are ignorable browser-level warnings, don't affect functionality.
8. **Low polygon count**: Check console for quality filtering stats. Lower `minQualityScore` or `edgeThreshold` to increase sensitivity.

## Project-Specific Conventions

### File Structure
```
app.js (1020 lines)      # Main application logic
├─ Lines 16-75:          CONFIG object + slider sync
├─ Lines 76-140:         Preset configurations
├─ Lines 258-304:        Otsu adaptive thresholding
├─ Lines 307-385:        Quality scoring algorithm
├─ Lines 387-408:        Geometry cleaning (turf.buffer)
├─ Lines 550-650:        Sobel + morphology preprocessing
├─ Lines 802-897:        Pixel→LatLng conversion + filtering
└─ Lines 938-946:        Shapefile Base64→binary fix

vetoriza/src/lib.rs      # Rust WASM module
└─ Single function:      vetorizar_imagem(base64) → GeoJSON string

vite.config.js           # Custom copy-assets plugin
vercel.json              # Minimal deployment config
```

### UI Patterns
- **Real-time parameter sync**: Sliders bidirectionally bound to number inputs ([app.js:24-56](../app.js#L24-L56))
- **Color-coded visualization**: Green (alta), Yellow (média), Red (baixa) quality
- **Popups on click**: Shows ID, area, score, compactness, vertices
- **Statistics panel**: Updates after each vectorization ([app.js:190-249](../app.js#L190-L249))

### Coordinate System Notes
- **Leaflet uses LatLng** (y, x): `[latitude, longitude]`
- **GeoJSON uses LngLat** (x, y): `[longitude, latitude]`
- **Image canvas**: Origin (0,0) at top-left, Y increases downward
- **Conversion formula** ([app.js:850-853](../app.js#L850-L853)):
  ```javascript
  lng = west + (pixelX / imgWidth) × (east - west)
  lat = north - (pixelY / imgHeight) × (north - south)  // Note the minus!
  ```

## Key Dependencies

### Frontend (from CDN in [index.html](../index.html))
- `leaflet@1.9.4`: Map rendering and interaction
- `leaflet-draw@1.0.4`: Polygon drawing tool
- `leaflet-image@0.4.0`: Canvas capture
- `turf@6.5.0`: Geospatial analysis (area, buffer, simplify)
- `shpwrite@3.3.0`: Shapefile generation

### Backend (npm packages in [package.json](../package.json))
- `vite@7.3.0`: Dev server + build tool
- `eslint@9.39.1`: Linting
- `canvg@3.0.11`: SVG → Canvas (unused, can be removed)

### Rust WASM ([vetoriza/Cargo.toml](../vetoriza/Cargo.toml))
- `wasm-bindgen`: JS/Rust interop
- `image`: Image loading/processing
- `imageproc`: Contour detection algorithms
- `geojson`: GeoJSON serialization
- `base64`: Base64 encoding/decoding (new API)

## Testing Checklist

When making changes, verify these behaviors:

- [ ] **WASM loads**: Console shows "Módulo WASM carregado com sucesso"
- [ ] **Map renders**: ArcGIS satellite tiles appear at São Paulo coordinates
- [ ] **Draw tool works**: Polygon drawing creates blue selection layer
- [ ] **Vectorization runs**: Console shows "X features recebidas do WASM"
- [ ] **Quality filtering**: Console shows "APROVADA" for polygons ≥ minArea and ≥ minQualityScore
- [ ] **Visualization**: Polygons colored green/yellow/red based on quality
- [ ] **Popups**: Clicking polygon shows ID, area, score, compactness, vertices
- [ ] **Statistics**: UI panel updates with polygon count and total area
- [ ] **Export**: Shapefile ZIP downloads with timestamp filename
- [ ] **ZIP extraction**: Extracts successfully with 7-Zip/WinRAR (not corrupted)
- [ ] **Shapefile opens**: QGIS/ArcGIS Pro loads `.shp` file with attribute table
- [ ] **Attributes present**: `id`, `area_m2`, `confidence_score`, `quality`, `compactness`, `vertices` columns

## Debugging Tips

### Console Logs to Watch
- `"Threshold Otsu calculado: X"` → Adaptive binarization threshold
- `"X features recebidas do WASM"` → Raw polygon count from Rust
- `"Feature X: área = Y m²"` → Individual polygon areas
- `"APROVADA" / "REJEITADA"` → Quality filter decisions
- `"Score: X, Compacidade: Y"` → Quality metrics for each polygon

### Common Issues
- **No polygons detected**: Lower `edgeThreshold` (try 60-70) or increase `contrastBoost` (try 1.5-1.8)
- **Too many false positives**: Increase `minQualityScore` (try 45-50) or `minArea` (try 20-30m²)
- **Incomplete buildings**: Increase `morphologySize` (try 7-9) to close gaps in edges
- **Over-simplified shapes**: Lower `simplification` tolerance (try 0.000005)

### Preset Configurations as Reference
- **Urbano**: edgeThreshold=85, morphologySize=5, minArea=15, minQualityScore=40
- **Rural**: edgeThreshold=70, morphologySize=7, minArea=30, minQualityScore=35
- **Industrial**: edgeThreshold=80, morphologySize=5, minArea=100, minQualityScore=40
