const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : `http://localhost:${PORT}`;

// Keep-alive ping tiap 4 menit
setInterval(() => {
  try {
    const url = new URL(SELF_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: url.hostname, path: '/', method: 'GET' });
    req.on('error', () => {});
    req.end();
  } catch(e) {}
}, 4 * 60 * 1000);

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ engine: 'MA Studio YT Engine', version: '5.0.0', status: 'running' });
});

app.get('/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  let output = '';
  const proc = spawn('yt-dlp', ['--no-warnings', '--no-playlist', '--print',
    '%(title)s|||%(uploader)s|||%(duration)s|||%(thumbnail)s|||%(id)s', '--no-download', url]);
  proc.stdout.on('data', d => output += d.toString());
  proc.on('close', code => {
    if (code !== 0 || !output.trim()) return res.status(500).json({ error: 'Failed' });
    const p = output.trim().split('|||');
    res.json({ title: p[0]||'', author: p[1]||'', duration: parseInt(p[2])||0, thumbnail: p[3]||'', videoId: p[4]||'' });
  });
});

app.get('/download/mp3', (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const safe = (title || 'audio').replace(/[^\w\s\-]/g, '').trim().slice(0, 100) || 'audio';
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.mp3"`);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const proc = spawn('yt-dlp', [
    '--no-warnings', '--no-playlist',
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
    '-o', '-', url
  ]);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
  proc.on('close', () => { if (!res.writableEnded) res.end(); });
  req.on('close', () => { try { proc.kill('SIGKILL'); } catch(e) {} });
});

app.head('/stream/mp3', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Cache-Control', 'no-cache');
  res.end();
});

app.get('/stream/mp3', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');
  const proc = spawn('yt-dlp', [
    '--no-warnings', '--no-playlist',
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
    '-o', '-', url
  ]);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
  proc.on('close', () => { if (!res.writableEnded) res.end(); });
  req.on('close', () => { try { proc.kill('SIGKILL'); } catch(e) {} });
});

app.post('/publish/roblox', async (req, res) => {
  const { url, title, apiKey } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!apiKey) return res.status(400).json({ error: 'API Key required' });

  const name = (title || 'audio').slice(0, 100);

  let audioBuffer;
  try {
    audioBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const proc = spawn('yt-dlp', [
        '--no-warnings', '--no-playlist',
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
        '-o', '-', url
      ]);
      proc.stdout.on('data', chunk => chunks.push(chunk));
      proc.on('close', code => {
        const buf = Buffer.concat(chunks);
        if (code !== 0 || buf.length < 1000) return reject(new Error('yt-dlp gagal atau file terlalu kecil'));
        resolve(buf);
      });
      proc.on('error', reject);
    });
  } catch(e) {
    return res.status(500).json({ error: 'Gagal download audio: ' + e.message });
  }

  try {
    const boundary = '----MAStudioBoundary' + Date.now();
    const requestJson = JSON.stringify({
      assetType: 'Audio',
      displayName: name,
      description: 'Uploaded via MA Studio',
      creationContext: { creator: req.body.userId ? { userId: parseInt(req.body.userId), creatorType: 'User' } : {} }
    });

    const bodyParts = [];
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${requestJson}\r\n`));
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="${name}.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`));
    bodyParts.push(audioBuffer);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(bodyParts);

    const uploadRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      body
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) {
      let msg = uploadData.message || uploadData.error || `HTTP ${uploadRes.status}`;
      if (uploadRes.status === 403) msg = 'API Key tidak valid atau tidak ada permission Audio.';
      if (uploadRes.status === 429) msg = 'Rate limit Roblox, tunggu beberapa menit.';
      return res.status(uploadRes.status).json({ error: msg });
    }

    if (uploadData.assetId) return res.json({ assetId: uploadData.assetId });

    const opPath = uploadData.path || uploadData.operationId;
    if (!opPath) return res.status(500).json({ error: 'Respons Roblox tidak valid.' });

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const opRes = await fetch(`https://apis.roblox.com/${opPath}`, { headers: { 'x-api-key': apiKey } });
      if (!opRes.ok) continue;
      const op = await opRes.json();
      if (op.done) {
        const assetId = op.response?.assetId || op.response?.asset?.assetId;
        if (assetId) return res.json({ assetId });
        return res.status(500).json({ error: 'Upload selesai tapi Asset ID tidak ditemukan.' });
      }
      if (op.error) return res.status(500).json({ error: op.error.message || 'Upload gagal di Roblox.' });
    }
    return res.status(500).json({ error: 'Timeout menunggu Roblox. Cek Creator Dashboard.' });

  } catch(e) {
    return res.status(500).json({ error: 'Gagal upload ke Roblox: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`MA Studio YT Engine v5 on port ${PORT}`));
