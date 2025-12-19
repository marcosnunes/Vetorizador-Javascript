import express from "express";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
/* global process */
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname)));
app.use("/vetoriza", express.static(path.join(__dirname, "vetoriza")));

// Rotas de API
app.use("/api/vetorizar", async (req, res, next) => {
  // Importação dinâmica para manter compatibilidade
  const { default: handler } = await import("./api/vetorizar.js");
  return handler(req, res, next);
});
app.use("/api/gemini-key", async (req, res, next) => {
  const { default: handler } = await import("./api/gemini-key.js");
  return handler(req, res, next);
});

// Fallback para index.html
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
