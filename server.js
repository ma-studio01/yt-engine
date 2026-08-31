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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
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
  res.setHeader('X-Accel-Buffering', 'no'); // matiin buffering di proxy/nginx
  const proc = spawn('yt-dlp', [
    '--no-warnings', '--no-playlist',
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
    '-o', '-', url
  ]);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
  proc.on('close', code => { if (code !== 0 && !res.headersSent) res.status(500).json({ error: 'yt-dlp failed' }); });
  req.on('close', () => { try { proc.kill('SIGKILL'); } catch(e) {} });
});

app.get('/stream/mp3', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');
  const proc = spawn('yt-dlp', [
    '--no-warnings', '--no-playlist',
    '-f', 'bestaudio',
    '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
    '-o', '-', url
  ]);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
  req.on('close', () => { try { proc.kill(); } catch(e) {} });
});



app.listen(PORT, () => console.log(`MA Studio YT Engine v5 on port ${PORT}`));
