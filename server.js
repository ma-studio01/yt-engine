const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : `http://localhost:${PORT}`;

// Cache: cacheKey -> { file, size, expires }
const audioCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 menit

// Cleanup expired cache files
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of audioCache.entries()) {
    if (now > entry.expires) {
      try { fs.unlinkSync(entry.file); } catch(e) {}
      audioCache.delete(key);
    }
  }
}, 2 * 60 * 1000);

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
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ engine: 'MA Studio YT Engine', version: '6.0.0', status: 'running' });
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

// Helper: download YT audio ke temp file, return path + size
function downloadToTemp(ytUrl) {
  return new Promise((resolve, reject) => {
    const tmpFile = require('path').join(os.tmpdir(), 'mastudio_' + crypto.randomBytes(8).toString('hex') + '.mp3');
    const proc = spawn('yt-dlp', [
      '--no-warnings', '--no-playlist', '--no-cache-dir',
      '--retries', '3', '--extractor-retries', '3',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
      '-o', tmpFile, ytUrl
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('yt-dlp failed: ' + stderr.slice(-200)));
      fs.stat(tmpFile, (err, stat) => {
        if (err || !stat || stat.size < 1000) return reject(new Error('File kosong atau tidak ada'));
        resolve({ file: tmpFile, size: stat.size });
      });
    });
  });
}

// In-progress downloads: prevent duplicate downloads for same URL
const inProgress = new Map();

// HEAD untuk stream - browser mobile butuh ini
app.head('/stream/mp3', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  const cacheKey = crypto.createHash('md5').update(url).digest('hex');
  if (audioCache.has(cacheKey)) {
    const entry = audioCache.get(cacheKey);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', entry.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=900');
    return res.end();
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.end();
});

// GET stream - download ke temp file dulu, serve dengan Content-Length (mobile friendly)
app.get('/stream/mp3', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const cacheKey = crypto.createHash('md5').update(url).digest('hex');

  try {
    let entry;

    if (audioCache.has(cacheKey)) {
      // Cache hit
      entry = audioCache.get(cacheKey);
      entry.expires = Date.now() + CACHE_TTL; // refresh TTL
      console.log('[stream/mp3] cache hit:', cacheKey);
    } else if (inProgress.has(cacheKey)) {
      // Tunggu download yang sedang berjalan
      console.log('[stream/mp3] waiting for in-progress download:', cacheKey);
      entry = await inProgress.get(cacheKey);
    } else {
      // Download baru
      console.log('[stream/mp3] downloading:', url);
      const promise = downloadToTemp(url).then(result => {
        const cacheEntry = { file: result.file, size: result.size, expires: Date.now() + CACHE_TTL };
        audioCache.set(cacheKey, cacheEntry);
        inProgress.delete(cacheKey);
        return cacheEntry;
      }).catch(err => {
        inProgress.delete(cacheKey);
        throw err;
      });
      inProgress.set(cacheKey, promise);
      entry = await promise;
    }

    // Serve file dengan proper headers
    const rangeHeader = req.headers.range;
    const fileSize = entry.size;

    if (rangeHeader) {
      // Support range request (mobile browser sering pakai ini)
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=900');

      const stream = fs.createReadStream(entry.file, { start, end });
      stream.pipe(res);
      stream.on('error', () => { if (!res.writableEnded) res.end(); });
    } else {
      // Full file
      res.status(200);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=900');

      const stream = fs.createReadStream(entry.file);
      stream.pipe(res);
      stream.on('error', () => { if (!res.writableEnded) res.end(); });
    }

  } catch(err) {
    console.error('[stream/mp3] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
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

app.listen(PORT, () => console.log(`MA Studio YT Engine v6 on port ${PORT}`));
