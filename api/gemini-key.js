/* eslint-env node */
/* global process, module */
module.exports = function(req, res) {
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  // Permitir apenas GET para este endpoint
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('GEMINI_API_KEY não encontrada nas variáveis de ambiente');
    console.error('Variáveis disponíveis:', Object.keys(process.env));
    res.status(500).json({ 
      error: 'GEMINI_API_KEY não encontrada',
      available: Object.keys(process.env).filter(k => k.includes('GEMINI'))
    });
    return;
  }
  
  // Retorna a chave
  res.status(200).json({ geminiKey: apiKey });
};
