# MA Studio YT Engine

Backend engine untuk download YouTube audio/video. Dibuat untuk MA Studio Music App.

## Endpoints

- `GET /` - Status engine
- `GET /info?url=YOUTUBE_URL` - Info video (judul, durasi, thumbnail)
- `GET /download/mp3?url=YOUTUBE_URL` - Download audio MP3
- `GET /download/mp4?url=YOUTUBE_URL` - Download video MP4 360p

## Deploy di Railway

1. Push repo ini ke GitHub
2. Railway → New Project → GitHub Repo → pilih repo ini
3. Railway otomatis detect Dockerfile dan deploy
4. Copy URL Railway → paste di MA Studio app
