# Vetorizador de Imóveis - AI Agent Instructions

## Architecture Overview

**Hybrid WebAssembly + Classical Computer Vision Application**
- **Frontend**: Vanilla JS (`app.js`) with Leaflet for interactive maps, running via Vite dev server
- **WASM Module**: Rust-compiled contour detection (`vetoriza/src/lib.rs`) → `vetoriza/pkg/vetoriza.js`
- **Serverless APIs**: Node.js functions in `api/` deployed to Vercel (CommonJS only)
- **Deployment**: Vercel with minimal config, Vite handles static builds

### Data Flow (Classical CV Pipeline - No AI)
1. User draws rectangle on Leaflet map → captures canvas via `leafletImage()`
2. Canvas preprocessing in `app.js` (lines 140-320):
   - Contrast boost (×1.2 + 20)
   - **Sobel edge detection** (3×3 kernels, Gx/Gy gradients)
   - Binarization (threshold 128)
   - **Morphological closing** (dilate+erode, 3px kernel)
   - Color inversion (white edges → black, background → white)
3. Base64 image sent to WASM `vetorizar_imagem()` → GeoJSON polygons via `imageproc::contours`
4. Pixel coordinates converted to LatLng using map bounds
5. **Area filtering**: Rejects polygons < 1m² to remove noise
6. Results rendered as Leaflet GeoJSON layer → exported as Shapefile (Base64 ZIP)

## Critical Patterns

### WASM Integration (No-Modules Target)
**Current setup uses `--target no-modules` for UMD compatibility**:
```bash
cd vetoriza
wasm-pack build --target no-modules --release
git add pkg/  # MUST commit WASM artifacts
```

**Frontend loading** (app.js:13-17):
```javascript
await wasm_bindgen('vetoriza/pkg/vetoriza_bg.wasm');
vetorizar_imagem = wasm_bindgen.vetorizar_imagem;
```

**Rust function** (lib.rs:12): Returns GeoJSON string with Polygon geometry (not LineString):
```rust
let geometry = Geometry::new(Value::Polygon(vec![coordinates]));
```

### Shapefile Export (Base64 ZIP Issue)
**CRITICAL**: `shpwrite.zip()` returns **Base64-encoded ZIP**, not binary. Must decode before creating Blob:

```javascript
// app.js:534-542
const binaryString = atob(zipData);  // Decode Base64 first
const zipBuffer = new Uint8Array(binaryString.length);
for (let i = 0; i < binaryString.length; i++) {
  zipBuffer[i] = binaryString.charCodeAt(i);
}
const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });
```

Without `atob()` decoding, ZIP files are corrupted. Verify header: `[80, 75, 3, 4]` = "PK".

### Vercel Serverless Functions
**All API files MUST use CommonJS** (no `"type": "module"` in package.json):
```javascript
// ✅ Correct
module.exports = function handler(req, res) { ... }

// ❌ Wrong (causes 404)
export default function handler(req, res) { ... }
```

### Vite Build Plugin
**Custom plugin copies WASM + app.js to dist** (vite.config.js:17-37):
- Ensures `vetoriza/pkg/*.wasm` and `app.js` are available in build output
- Without this, production builds fail with 404s on WASM

## Developer Workflows

### Local Development
```bash
npm run dev              # Vite dev server on localhost:8080
```
**Browser caching issue**: After JS changes, use **Ctrl+Shift+R** (Windows) to force reload without cache.

### Vercel Deployment
```bash
vercel link              # First time only
vercel env add VAR_NAME  # Set environment variables
vercel --prod            # Deploy to production
```

### WASM Rebuild
```bash
cd vetoriza
wasm-pack build --target no-modules --release
cd ..
npm run build            # Test locally first
git add vetoriza/pkg/    # MUST commit
```

## Common Pitfalls

1. **Corrupted Shapefile ZIP**: Forgetting `atob()` decode for Base64 → binary conversion
2. **Browser cache**: Old `app.js` cached → use Ctrl+Shift+R or test in incognito
3. **WASM 404**: `vetoriza/pkg/` must be committed (no longer gitignored)
4. **Wrong WASM target**: `--target web` breaks UMD loading → use `--target no-modules`
5. **LineString vs Polygon**: Rust must return `Polygon` geometry, not `LineString` (shapefile requirement)
6. **Safari warnings**: "Tracking Prevention blocked access to storage" are ignorable browser-level warnings

## Key Files & Line References

- **app.js** (577 lines):
  - Lines 13-22: WASM initialization with `wasm_bindgen` namespace
  - Lines 140-320: Complete CV pipeline (Sobel → morphological ops → inversion)
  - Lines 432-471: Pixel→LatLng conversion + area filtering (< 1m² rejected)
  - Lines 485-565: Shapefile export with Base64 decoding (critical fix)

- **vetoriza/src/lib.rs**: 
  - Uses `imageproc::contours::find_contours` for contour detection
  - Returns `Polygon` geometry with closed rings (first point = last point)

- **vite.config.js**: 
  - Custom `copy-assets` plugin copies WASM files to `dist/` during build
  
- **vercel.json**: 
  - Minimal config with API rewrites only

## Testing Checklist
- [ ] WASM loads: Console shows "Módulo WASM carregado com sucesso"
- [ ] Map renders: Leaflet tiles appear (OpenStreetMap)
- [ ] Draw tool: Rectangle selection works
- [ ] Vectorization: Console shows polygon count (e.g., "534 features")
- [ ] Filtering: Console shows "APROVADA" for polygons ≥ 1m²
- [ ] Export: ZIP downloads and **extracts successfully** (verify with 7-Zip/WinRAR)
- [ ] Shapefile: Opens in ArcGIS Pro/QGIS without corruption
