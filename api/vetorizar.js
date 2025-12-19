import dotenv from "dotenv";
import process from "process";
dotenv.config();
import { execFile } from "child_process";

export default async function handler(req, res) {
  // --- INÍCIO DA CORREÇÃO DE CORS ---
  const allowedOrigins = [
    'https://vetorizador.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:5500' // Adicione outras portas se necessário
  ];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Se a origem não estiver na lista (ex: requisições diretas), 
    // defina um valor padrão seguro ou omita o header (se preferir bloquear).
    // Usaremos o valor de produção como fallback.
    res.setHeader('Access-Control-Allow-Origin', 'https://vetorizador.vercel.app');
  }
  // --- FIM DA CORREÇÃO DE CORS ---

  // Adiciona outros cabeçalhos CORS (manter estes)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Trata requisição OPTIONS (preflight do navegador)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, width, height } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Imagem não fornecida' });
    }

    // Use environment variable safely in Next.js API routes (server-side only)
    const apiKey = process.env?.GEMINI_API_KEY;
    if (!apiKey) {
      // Este erro ocorrerá se a variável não estiver disponível.
      return res.status(500).json({
        error: 'ERRO CRÍTICO: Chave GEMINI_API_KEY ausente',
        details: 'A variável de ambiente não foi carregada. Verifique se está definida corretamente.'
      });
    }

    // Inicializa o Gemini
    const genAI = new GoogleGenerativeAI(apiKey);

    // Define o modelo. O Gemini 1.5 Flash é o ideal.
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
      Você é um especialista em visão computacional e em análise de imagens aéreas de alta precisão.
      Sua tarefa é analisar rigorosamente a imagem de satélite fornecida e criar uma **máscara de segmentação binária exclusiva** para **Edificações, Telhados e trapiches**, excluindo estritamente elementos como vegetação, estradas, água, sombras e solo desmatado/exposto. Você deve focar **apenas** nas estruturas construídas pelo homem (benfeitorias).

      RECOMENDAÇÃO: Dê prioridade à detecção clara dos **Trapiches** (piers/decks) que se estendem sobre a água, além das edificações principais.

      **REGRA CRÍTICA: Se não houver edifícios visíveis na imagem, o SVG deve retornar SOMENTE a tag <rect fill="black"/> e NENHUM outro polígono.**

      Exemplo de SVG esperado:
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="black"/>
        <polygon fill="white" points="10,10 100,10 100,100 10,100"/>
        <polygon fill="white" points="150,50 200,50 200,80 150,80"/>
      </svg>

      REPORTE APENAS CÓDIGO SVG VÁLIDO E NADA MAIS.

      Regras estritas para o SVG:
      1. O SVG deve ter viewBox="0 0 ${width} ${height}" e NENHUM outro atributo (como 'width' ou 'height').
      2. O fundo deve ser preto: **<rect width="100%" height="100%" fill="black"/>**.
      3. Desenhe polígonos brancos: use **<polygon fill="white" points="..."/>** (preferencialmente) ou **<path fill="white" d="..."/>** para cobrir exatamente o footprint de cada telhado/edificação/benfeitoria **DETECTADA** e **VISÍVEL** na imagem.
      4. A geometria deve ser o mais precisa possível e **corresponder à forma e localização dos objetos na imagem de entrada**.
      5. SEM texto, SEM explicação, SEM markdown, SEM comentários, SEM tag de XML declaration (<?xml...?>).
      6. Comece com <svg> e termine com </svg>.
    `;

    const imagePart = {
      inlineData: {
        // Chama o script Python para segmentação com SAM/Hugging Face
        const pythonScript = "./api/segment_anything.py";
        const { imageBase64 } = req.body;
        if (!imageBase64) {
          return res.status(400).json({ error: 'Imagem não fornecida' });
        }
        execFile("python", [pythonScript, imageBase64], (error, stdout, stderr) => {
          if (error) {
            return res.status(500).json({ error: 'Erro ao executar segmentação', details: stderr });
          }
          try {
            const result = JSON.parse(stdout);
            // Aqui você pode converter a máscara para SVG conforme necessário
            // Exemplo: return res.status(200).json({ svg: svgString });
            return res.status(200).json({ mask: result });
          } catch (e) {
            return res.status(500).json({ error: 'Erro ao processar resultado da segmentação', details: stdout });
          }
        });