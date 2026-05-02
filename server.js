// server.js
// Node 18+ (uses global fetch). Run: node server.js

// ---- server (server.js) ----
// server.js (ESM)
import express from 'express';

const app = express();
const PORT = process.env.PORT || 8787;
const MAX_BYTES = 25 * 1024 * 1024;

app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// simple fetch proxy (uses Node 18+ global fetch)
app.get('/fetch', async (req, res) => {
  try {
    const raw = req.query.url || '';
    const u = new URL(String(raw));

    if (!['http:', 'https:'].includes(u.protocol)) {
      return res.status(400).json({ error: 'Only http/https allowed' });
    }

    const upstream = await fetch(u, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Macroscope/1.0',
        'Accept': 'application/vnd.rcuk.gtr.json-v7, application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5'
      }
    });

    const ctype = upstream.headers.get('content-type') || 'application/octet-stream';
    const body = await upstream.arrayBuffer();

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', ctype);
    res.set('Cache-Control', 'no-store');

    if (body.byteLength > MAX_BYTES) {
      return res.status(413).send('Upstream response too large');
    }

    return res.status(upstream.status).send(Buffer.from(body));

  } catch (e) {
    console.error('Fetch proxy failed:', e);
    return res.status(502).send(String(e?.message || e || 'Fetch failed'));
  }
});

// OpenAI relay (set OPENAI_API_KEY in your shell when starting)
app.post('/openai/chat', async (req, res) => {
  try {
    const { model = 'gpt-4o-mini', messages = [], max_tokens = 800, temperature = 0.2 } = req.body || {};
    const incomingAuth = req.get('Authorization');
    const key = (incomingAuth && incomingAuth.startsWith('Bearer '))
      ? incomingAuth.slice(7)
      : (process.env.OPENAI_API_KEY || '');
    if (!key) return res.status(401).json({ error: 'Missing API key' });
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, max_tokens, temperature })
    });
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.error('OpenAI proxy error:', e);
    res.status(502).json({ error: 'openai proxy failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
});
