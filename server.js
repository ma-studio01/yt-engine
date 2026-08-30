const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    engine: 'MA Studio YT Engine',
    version: '2.0.0',
    status: 'running',
    endpoints: ['/info', '/download/mp3', '/download/mp4']
  });
});

app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const args = [
    '--no-warnings', '--no-playlist',
    '--print', '%(title)s|||%(uploader)s|||%(duration)s|||%(thumbnail)s|||%(id)s',
    '--no-download', url
  ];

  let output = '';
  const proc = spawn('yt-dlp', args);
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', () => {});
  proc.on('close', code => {
    if (code !== 0 || !output.trim()) {
      return res.status(500).json({ error: 'Failed to get info' });
    }
    const parts = output.trim().split('|||');
    res.json({
      title: parts[0] || '',
      author: parts[1] || '',
      duration: parseInt(parts[2]) || 0,
      thumbnail: parts[3] || '',
      videoId: parts[4] || '',
    });
  });
});

app.get('/download/mp3', (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const safeTitle = (title || 'audio').replace(/[^\w\s\-]/g, '').trim().substring(0, 100) || 'audio';

  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"`);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const args = [
    '--no-warnings', '--no-playlist',
    '-f', 'bestaudio',
    '--extract-audio', '--audio-format', 'mp3',
    '--audio-quality', '128K',
    '-o', '-',
    url
  ];

  const proc = spawn('yt-dlp', args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', e => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

app.get('/download/mp4', (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const safeTitle = (title || 'video').replace(/[^\w\s\-]/g, '').trim().substring(0, 100) || 'video';

  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const args = [
    '--no-warnings', '--no-playlist',
    '-f', 'best[ext=mp4]/best',
    '-o', '-',
    url
  ];

  const proc = spawn('yt-dlp', args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', e => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

app.listen(PORT, () => {
  console.log(`MA Studio YT Engine running on port ${PORT}`);
});
