const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - allow semua origin (biar bisa dipanggil dari mastudio-app.pages.dev)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
}));

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    engine: 'MA Studio YT Engine',
    version: '1.0.0',
    status: 'running',
    endpoints: ['/info', '/download/mp3', '/download/mp4']
  });
});

// GET info video
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const info = await ytdl.getInfo(url);
    const videoDetails = info.videoDetails;
    res.json({
      title: videoDetails.title,
      author: videoDetails.author?.name || '',
      duration: parseInt(videoDetails.lengthSeconds),
      thumbnail: videoDetails.thumbnails?.slice(-1)[0]?.url || '',
      videoId: videoDetails.videoId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET download MP3 (audio only)
app.get('/download/mp3', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const info = await ytdl.getInfo(url);
    const videoTitle = title || info.videoDetails.title || 'audio';
    const safeTitle = videoTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().substring(0, 100);

    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');

    ytdl(url, {
      quality: 'highestaudio',
      filter: 'audioonly',
    }).pipe(res);

  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

// GET download MP4 (video+audio, 360p)
app.get('/download/mp4', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const info = await ytdl.getInfo(url);
    const videoTitle = title || info.videoDetails.title || 'video';
    const safeTitle = videoTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().substring(0, 100);

    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    ytdl(url, {
      quality: '18', // 360p mp4
      filter: 'audioandvideo',
    }).pipe(res);

  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

// POST download - sama tapi pakai body JSON
app.post('/download', async (req, res) => {
  const { url, format = 'mp3' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  // Redirect ke GET endpoint yang sesuai
  const encodedUrl = encodeURIComponent(url);
  if (format === 'mp4') {
    return res.redirect(`/download/mp4?url=${encodedUrl}`);
  }
  return res.redirect(`/download/mp3?url=${encodedUrl}`);
});

app.listen(PORT, () => {
  console.log(`MA Studio YT Engine running on port ${PORT}`);
});
