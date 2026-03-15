import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = process.cwd();
const TEST_DIR = path.join(ROOT, 'pdfspliter', 'PDFtoArcgis', 'testes');
const API_URL = 'https://jolly-pebble-0487d1a1e.6.azurestaticapps.net/api/pdf-to-geojson';

function buildPageTextWithLines(textContent) {
  const items = (textContent.items || [])
    .map((it) => ({
      str: it.str || '',
      x: it.transform ? it.transform[4] : 0,
      y: it.transform ? it.transform[5] : 0
    }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  let out = '';
  let lastY = null;
  const lineThreshold = 2.0;

  for (const it of items) {
    if (!it.str) continue;
    if (lastY === null) lastY = it.y;
    if (Math.abs(it.y - lastY) > lineThreshold) {
      out += '\n';
      lastY = it.y;
    } else {
      out += ' ';
    }
    out += it.str;
  }
  return out;
}

async function listPdfs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPdfs(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      files.push(full);
    }
  }
  return files;
}

async function extractLocalText(pdfFile, maxPages = 40) {
  const bytes = await fs.readFile(pdfFile);
  const loadingTask = getDocument({ data: new Uint8Array(bytes), disableWorker: true });
  const pdf = await loadingTask.promise;
  const totalPages = Math.min(pdf.numPages || 0, maxPages);
  let fullText = '';

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    fullText += `\n\n--- PAGINA ${i} ---\n`;
    fullText += buildPageTextWithLines(textContent);
  }

  return { text: fullText.trim(), pages: totalPages };
}

async function main() {
  const pdfs = await listPdfs(TEST_DIR);
  const results = [];

  for (const pdfFile of pdfs) {
    const name = path.basename(pdfFile);
    try {
      const { text, pages } = await extractLocalText(pdfFile);
      const body = {
        fileName: name,
        totalPagesHint: pages,
        ocrText: text
      };

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const raw = await res.text();
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { raw };
      }

      results.push({
        file: name,
        status: res.status,
        success: !!payload.success,
        extractedVertices: payload.extractedVertices ?? null,
        textLength: text.length,
        error: payload.error || payload.raw || ''
      });
    } catch (err) {
      results.push({
        file: name,
        status: 0,
        success: false,
        extractedVertices: null,
        textLength: 0,
        error: String(err?.message || err)
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
