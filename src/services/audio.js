/* Conversão de áudio gravado no navegador (webm/mp4) para OGG/Opus, o formato de mensagem de voz do WhatsApp. */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch { /* sem ffmpeg: áudio gravado não é suportado */ }

function isAvailable() {
  return Boolean(ffmpegPath);
}

/** Recebe o buffer gravado e devolve { buffer, mimetype, seconds }. */
async function toVoiceNote(input, ext = 'webm') {
  if (!ffmpegPath) throw new Error('Conversor de áudio indisponível no servidor');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sos-audio-'));
  const inPath = path.join(dir, `in.${ext.replace(/[^a-z0-9]/gi, '') || 'webm'}`);
  const outPath = path.join(dir, 'out.ogg');
  try {
    await fs.writeFile(inPath, input);
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inPath,
        '-vn', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip', '-ar', '48000', '-ac', '1',
        '-f', 'ogg', outPath,
      ], { timeout: 60000 }, (err, _stdout, stderr) => (err ? reject(new Error(`ffmpeg: ${stderr || err.message}`)) : resolve()));
    });
    const buffer = await fs.readFile(outPath);
    const seconds = await probeSeconds(outPath).catch(() => null);
    return { buffer, mimetype: 'audio/ogg; codecs=opus', seconds };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function probeSeconds(file) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-'], { timeout: 30000 }, (err, _out, stderr) => {
      const m = String(stderr || '').match(/time=(\d+):(\d+):(\d+\.?\d*)/g);
      if (!m) return err ? reject(err) : resolve(null);
      const last = m[m.length - 1].match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      resolve(Math.round(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])));
    });
  });
}

module.exports = { isAvailable, toVoiceNote };
