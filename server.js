const express = require('express');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

// Cookies dari environment variable — paste isi cookies.txt ke YOUTUBE_COOKIES di Railway
const COOKIES_CONTENT = process.env.YOUTUBE_COOKIES || '';
let COOKIES_FILE = null;

// Tulis cookies ke temp file kalau ada
if (COOKIES_CONTENT.trim()) {
  COOKIES_FILE = path.join(os.tmpdir(), 'yt_cookies.txt');
  fs.writeFileSync(COOKIES_FILE, COOKIES_CONTENT, 'utf8');
  console.log('[cookies] Loaded from env var, size:', COOKIES_CONTENT.length);
} else {
  console.log('[cookies] No cookies set — yt-dlp will run without login');
}

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Auto-update yt-dlp saat startup — pastikan selalu versi terbaru
const { execSync } = require('child_process');
try {
  console.log('[yt-dlp] Updating to latest version...');
  execSync('yt-dlp -U', { timeout: 60000, stdio: 'pipe' });
  const ver = execSync('yt-dlp --version', { stdio: 'pipe' }).toString().trim();
  console.log('[yt-dlp] Version:', ver);
} catch(e) {
  console.warn('[yt-dlp] Update failed (ok, will use installed version):', e.message?.slice(0,100));
}

// ─── KEEP ALIVE ──────────────────────────────────────────────────────────────
setInterval(() => {
  try {
    const u = new URL(SELF_URL);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({ hostname: u.hostname, path: '/', method: 'GET' });
    r.on('error', () => {});
    r.end();
  } catch (e) {}
}, 4 * 60 * 1000);

// ─── CACHE ───────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 20 * 60 * 1000;
const inFlight = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (now > v.expires) {
      try { fs.unlinkSync(v.file); } catch (_) {}
      cache.delete(k);
    }
  }
}, 3 * 60 * 1000);

// ─── YT-DLP ARGS ─────────────────────────────────────────────────────────────
function buildArgs(videoUrl, outFile) {
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-cache-dir',
    '--retries', '5',
    '--extractor-retries', '5',
    '--socket-timeout', '30',
    // Android client — paling susah di-block YouTube
    '--extractor-args', 'youtube:player_client=android',
    '--format-sort', 'abr',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '128K',
  ];

  // Pakai cookies kalau ada — ini yang bikin bypass bot detection
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }

  args.push('-o', outFile, videoUrl);
  return args;
}

// ─── DOWNLOAD TO TEMP FILE ───────────────────────────────────────────────────
async function downloadAudio(videoUrl) {
  const videoId = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1]
    || crypto.randomBytes(4).toString('hex');
  const cacheKey = crypto.createHash('md5').update(videoId).digest('hex');

  if (cache.has(cacheKey)) {
    const entry = cache.get(cacheKey);
    entry.expires = Date.now() + CACHE_TTL;
    return entry;
  }

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `ma_${cacheKey}.mp3`);

    if (fs.existsSync(tmpFile)) {
      const stat = fs.statSync(tmpFile);
      if (stat.size > 10000) {
        const entry = { file: tmpFile, size: stat.size, expires: Date.now() + CACHE_TTL };
        cache.set(cacheKey, entry);
        return resolve(entry);
      }
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }

    const args = buildArgs(videoUrl, tmpFile);
    console.log('[yt-dlp] downloading:', videoId, COOKIES_FILE ? '(with cookies)' : '(no cookies)');

    const proc = spawn('yt-dlp', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => {
      inFlight.delete(cacheKey);
      reject(new Error('yt-dlp not found: ' + err.message));
    });

    proc.on('close', code => {
      inFlight.delete(cacheKey);

      if (code !== 0) {
        console.error('[yt-dlp] FAILED:', videoId, '\n', stderr.slice(-400));
        try { fs.unlinkSync(tmpFile); } catch (_) {}

        let errMsg = 'Download gagal.';
        if (stderr.includes('Sign in') || stderr.includes('bot')) errMsg = 'YouTube minta verifikasi. Tambahkan cookies di Railway.';
        else if (stderr.includes('Private video')) errMsg = 'Video private, tidak bisa didownload.';
        else if (stderr.includes('not available')) errMsg = 'Video tidak tersedia di region ini.';
        return reject(new Error(errMsg));
      }

      // Cari file hasil (yt-dlp kadang rename saat convert)
      let finalFile = tmpFile;
      if (!fs.existsSync(tmpFile)) {
        const files = fs.readdirSync(os.tmpdir())
          .filter(f => f.startsWith(`ma_${cacheKey}`))
          .map(f => ({ f, t: fs.statSync(path.join(os.tmpdir(), f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (files.length > 0) finalFile = path.join(os.tmpdir(), files[0].f);
      }

      try {
        const stat = fs.statSync(finalFile);
        if (stat.size < 5000) throw new Error('File terlalu kecil');
        const entry = { file: finalFile, size: stat.size, expires: Date.now() + CACHE_TTL };
        cache.set(cacheKey, entry);
        console.log('[yt-dlp] done:', videoId, Math.round(stat.size / 1024) + 'KB');
        resolve(entry);
      } catch (e) {
        reject(new Error('File hasil tidak valid: ' + e.message));
      }
    });
  });

  inFlight.set(cacheKey, promise);
  return promise;
}

// ─── SERVE FILE WITH RANGE SUPPORT ──────────────────────────────────────────
function serveFile(entry, req, res, contentType) {
  const { file, size } = entry;
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : size - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Cache-Control': 'public, max-age=1200',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=1200',
    });
    fs.createReadStream(file).pipe(res);
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/', (_, res) => {
  res.json({
    engine: 'MA Studio Engine',
    version: '8.0.0',
    status: 'running',
    cookies: COOKIES_FILE ? 'loaded' : 'none',
  });
});

app.get('/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const args = ['--no-warnings', '--no-playlist',
    '--extractor-args', 'youtube:player_client=android',
    '--skip-download',
    '--print', '%(title)s|||%(uploader)s|||%(duration)s|||%(thumbnail)s|||%(id)s'];
  if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);
  args.push(url);

  let out = '';
  const proc = spawn('yt-dlp', args);
  proc.stdout.on('data', d => out += d.toString());
  proc.on('close', code => {
    if (code !== 0 || !out.trim()) return res.status(500).json({ error: 'Gagal ambil info' });
    const [title, author, dur, thumb, id] = out.trim().split('|||');
    res.json({ title: title || '', author: author || '', duration: parseInt(dur) || 0, thumbnail: thumb || '', videoId: id || '' });
  });
});

app.get('/stream/mp3', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const entry = await downloadAudio(url);
    serveFile(entry, req, res, 'audio/mpeg');
  } catch (err) {
    console.error('[/stream/mp3]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.head('/stream/mp3', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    const entry = await downloadAudio(url);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', entry.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.end();
  } catch { res.status(500).end(); }
});

app.get('/download/mp3', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const entry = await downloadAudio(url);
    const safe = (title || 'audio').replace(/[^\w\s\-]/g, '').trim().slice(0, 100) || 'audio';
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.mp3"`);
    serveFile(entry, req, res, 'audio/mpeg');
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/publish/roblox', async (req, res) => {
  const { url, title, apiKey, userId } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!apiKey) return res.status(400).json({ error: 'API Key required' });

  let audioBuffer;
  try {
    const entry = await downloadAudio(url);
    audioBuffer = fs.readFileSync(entry.file);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal download: ' + e.message });
  }

  try {
    const name = (title || 'audio').slice(0, 100);
    const boundary = '----MABoundary' + Date.now();
    const requestJson = JSON.stringify({
      assetType: 'Audio',
      displayName: name,
      description: 'Uploaded via MA Studio',
      creationContext: { creator: userId ? { userId: parseInt(userId), creatorType: 'User' } : {} },
    });

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${requestJson}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="${name}.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const uploadRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    });

    const data = await uploadRes.json();
    if (!uploadRes.ok) {
      let msg = data.message || data.error || `HTTP ${uploadRes.status}`;
      if (uploadRes.status === 403) msg = 'API Key tidak valid atau tidak punya permission Audio.';
      if (uploadRes.status === 429) msg = 'Rate limit Roblox, tunggu beberapa menit.';
      return res.status(uploadRes.status).json({ error: msg });
    }

    if (data.assetId) return res.json({ assetId: data.assetId });

    const opPath = data.path || data.operationId;
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
      if (op.error) return res.status(500).json({ error: op.error.message || 'Upload gagal.' });
    }
    return res.status(500).json({ error: 'Timeout. Cek Roblox Creator Dashboard.' });
  } catch (e) {
    return res.status(500).json({ error: 'Gagal upload ke Roblox: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`MA Studio Engine v8 | port ${PORT} | cookies: ${COOKIES_FILE ? 'YES' : 'NO'}`));
