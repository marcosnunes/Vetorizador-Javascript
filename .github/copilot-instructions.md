# Vetorizador de Imóveis - AI Agent Instructions

## Architecture Overview

**Hybrid WebAssembly + Serverless Application**
- **Frontend**: Vanilla JS (`app.js`) with Leaflet for interactive maps, running via Vite dev server
- **WASM Module**: Rust-compiled image vectorization (`vetoriza/src/lib.rs`) → `vetoriza/pkg/vetoriza.js`
- **Serverless APIs**: Node.js functions in `api/` deployed to Vercel (use CommonJS, not ES modules)
- **Deployment**: Vercel with auto-detection (no complex `builds` config needed)

### Data Flow
1. User draws rectangle on Leaflet map → captures canvas via `leafletImage()`
2. Canvas preprocessing in `app.js` (contrast, Sobel edge detection, binarization)
3. Base64 image sent to `/api/gemini-key` → Google Gemini AI generates SVG
4. Alternatively, WASM `vetorizar_imagem()` processes image → GeoJSON polygons
5. Results rendered as Leaflet layers → exported as Shapefile

## Critical Patterns

### Vercel Serverless Functions
**All API files must use CommonJS** (Vercel requirement):
```javascript
// ✅ Correct
module.exports = function handler(req, res) { ... }

// ❌ Wrong (causes 404)
export default function handler(req, res) { ... }
```

**Routing**: Use `vercel.json` rewrites, not complex builds:
```json
{
  "version": 2,
  "rewrites": [{"source": "/api/gemini-key", "destination": "/api/gemini-key.js"}]
}
```

### WASM Integration
- Build Rust: `cd vetoriza && wasm-pack build --target web --release`
- Output goes to `vetoriza/pkg/` (must be committed to Git for Vercel)
- Frontend loads via: `<script src="vetoriza/pkg/vetoriza.js"></script>` then `await window.vetoriza()`
- Function signature: `vetorizar_imagem(base64_img: &str) -> String` (returns GeoJSON)

### Canvas Processing Pipeline
See `app.js:140-210` for preprocessing:
1. Contrast boost (×1.2 + 20)
2. Sobel edge detection (3×3 kernels)
3. Binarization (threshold 128)
4. Pass to AI or WASM

## Developer Workflows

### Local Development
```bash
npm run dev              # Vite dev server on localhost:8080
```

### Vercel Deployment
```bash
vercel link              # First time only
vercel env add VAR_NAME  # Set environment variables
vercel --prod            # Deploy to production
```

### WASM Development
```bash
cd vetoriza
cargo build --release --target wasm32-unknown-unknown
wasm-pack build --target web --release
git add pkg/  # Must commit WASM artifacts
```

## Environment Variables
- `GEMINI_API_KEY`: Required in Vercel for `/api/gemini-key` and `/api/vetorizar`
- Check with: `vercel env ls`
- Already configured for Development, Preview, Production

## Common Pitfalls

1. **404 on APIs**: Ensure `api/*.js` uses `module.exports`, not ES modules
2. **WASM not found**: `vetoriza/pkg/` was previously gitignored - now must be committed
3. **CDN libraries**: Use unpkg.com for third-party libs (e.g., canvg) - local copies can have minification issues
4. **Safari warnings**: "Tracking Prevention blocked access to storage" are browser-level, ignorable
5. **Vercel builds**: Avoid `"builds": [...]` in vercel.json - let Vercel auto-detect

## Key Files
- `app.js`: Main application logic (477 lines), event handlers, canvas processing
- `api/gemini-key.js`: Returns GEMINI_API_KEY from Vercel env vars
- `api/vetorizar.js`: Full AI vectorization pipeline (Google Gemini + prompt engineering)
- `vetoriza/src/lib.rs`: WASM image processing (find_contours → GeoJSON)
- `vercel.json`: Simple rewrites only
- `vite.config.js`: Dev server on port 8080

## Testing Checklist
- [ ] WASM loads: Console shows "Módulo WASM carregado com sucesso"
- [ ] Map renders: Leaflet tiles appear
- [ ] Draw tool: Rectangle selection works
- [ ] API responds: `/api/gemini-key` returns JSON (not 404)
- [ ] Vectorization: Polygons appear after processing
- [ ] Export: Shapefile download works
