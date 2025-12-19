module.exports = async function handler(req, res) {
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Permitir apenas GET para este endpoint
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('GEMINI_API_KEY não encontrada nas variáveis de ambiente');
    return res.status(500).json({ 
      error: 'GEMINI_API_KEY não encontrada',
      env: Object.keys(process.env).filter(k => k.includes('GEMINI'))
    });
  }
  
  // Retorna a chave
  return res.status(200).json({ geminiKey: apiKey });
};
