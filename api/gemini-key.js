module.exports = function handler(req, res) {
  // Permitir apenas GET para este endpoint
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não encontrada no .env' });
  }
  
  // Retorna a chave
  res.status(200).json({ geminiKey: apiKey });
};
