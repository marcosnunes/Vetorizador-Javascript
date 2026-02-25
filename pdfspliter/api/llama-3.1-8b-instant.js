// Vercel Serverless Function: /api/llama-3.1-8b-instant.js
// Proxy seguro para chamada à Groq LLM (llama-3.1-8b-instant) usando variável de ambiente

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Chave da API Groq não configurada no ambiente.' });
  }
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt não fornecido ou inválido.' });
  }
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'Você é um assistente especialista em georreferenciamento de imóveis rurais brasileiros. Extraia apenas os vértices do polígono em UTM/SIRGAS2000, ordem correta, polígono fechado.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 2048
      })
    });
    const data = await groqRes.json();
    if (!groqRes.ok) {
      // Log detalhado do erro Groq
      console.error('[Groq API Error]', data);
      return res.status(groqRes.status).json({ error: data.error || 'Erro na API Groq', details: data });
    }
    return res.status(200).json(data);
  } catch (e) {
    console.error('[Groq Proxy Exception]', e);
    return res.status(500).json({ error: e.message });
  }
}
