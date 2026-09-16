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

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg: ${String(stderr || '') || err.message}`));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Recebe o buffer gravado e devolve { buffer, mimetype, seconds, waveform }.
 * Parâmetros escolhidos para a mensagem de voz tocar em todos os aparelhos, inclusive iPhone:
 * Opus em OGG, mono, 48 kHz, 64 kb/s VBR, quadros de 60 ms, sem metadados e com timestamps a partir de zero.
 */
async function toVoiceNote(input, ext = 'webm') {
  if (!ffmpegPath) throw new Error('Conversor de áudio indisponível no servidor');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sos-audio-'));
  const inPath = path.join(dir, `in.${ext.replace(/[^a-z0-9]/gi, '') || 'webm'}`);
  const outPath = path.join(dir, 'out.ogg');
  try {
    await fs.writeFile(inPath, input);
    await run([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath,
      '-vn', '-map_metadata', '-1', '-avoid_negative_ts', 'make_zero',
      '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on', '-compression_level', '10', '-frame_duration', '60', '-application', 'voip',
      '-ar', '48000', '-ac', '1',
      '-f', 'ogg', outPath,
    ]);
    const buffer = await fs.readFile(outPath);
    const { seconds, waveform } = await analyze(outPath).catch(() => ({ seconds: null, waveform: null }));
    return { buffer, mimetype: 'audio/ogg; codecs=opus', seconds: seconds || (await probeSeconds(outPath).catch(() => null)) || 1, waveform };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Decodifica para PCM e extrai duração e forma de onda (64 pontos de 0 a 100, como o WhatsApp mostra na bolha). */
async function analyze(file) {
  const RATE = 16000;
  const { stdout } = await run(['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1']);
  const samples = stdout.length >> 1;
  if (!samples) return { seconds: null, waveform: null };
  const seconds = Math.max(1, Math.round(samples / RATE));
  const POINTS = 64;
  const block = Math.max(1, Math.floor(samples / POINTS));
  const avg = new Array(POINTS).fill(0);
  for (let i = 0; i < POINTS; i++) {
    let sum = 0;
    const start = i * block;
    for (let j = 0; j < block && start + j < samples; j++) sum += Math.abs(stdout.readInt16LE((start + j) * 2));
    avg[i] = sum / block;
  }
  const max = Math.max(...avg) || 1;
  const waveform = new Uint8Array(avg.map((v) => Math.min(100, Math.round((v / max) * 100))));
  return { seconds, waveform };
}

function probeSeconds(file) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-'], { timeout: 30000 }, (err, _out, stderr) => {
      const m = String(stderr || '').match(/time=(\d+):(\d+):(\d+\.?\d*)/g);
      if (!m) return err ? reject(err) : resolve(null);
      const last = m[m.length - 1].match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      resolve(Math.max(1, Math.round(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]))));
    });
  });
}

module.exports = { isAvailable, toVoiceNote };
