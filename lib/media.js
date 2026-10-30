import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir, exists, safeFileName } from './util.js';

const IMAGE_MAGIC = [
  { mediaType: 'image/png', ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mediaType: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: 'image/gif', ext: '.gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mediaType: 'image/webp', ext: '.webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/amr': '.amr',
  'application/octet-stream': '.bin',
};

export function detectImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const entry of IMAGE_MAGIC) {
    try {
      if (entry.test(b)) return { mediaType: entry.mediaType, ext: entry.ext };
    } catch {
      /* short buffer */
    }
  }
  return null;
}

/** Last-resort media type guess from the file name. */
export function guessTypeByName(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = match?.[1] || '';
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext] || '';
}

export function toFileUri(filePath) {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function fromFileUri(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export class MediaStore {
  constructor({ dir, ffmpeg, ffprobe, logger }) {
    this.dir = dir;
    this.ffmpeg = ffmpeg || 'ffmpeg';
    this.ffprobe = ffprobe || 'ffprobe';
    this.logger = logger ?? (() => {});
    this._ffmpegChecked = false;
    this._ffmpegPath = null;
  }

  async init() {
    await ensureDir(this.dir);
  }

  async download(url, { maxBytes = 50 * 1024 * 1024, prefix = 'media' } = {}) {
    if (!url) throw new Error('下载地址为空');
    if (url.startsWith('base64://')) {
      const raw = url.slice('base64://'.length);
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.byteLength > maxBytes) throw new Error(`媒体超过大小限制: ${bytes.byteLength} > ${maxBytes}`);
      const type = detectImageType(bytes);
      const ext = type?.ext ?? '.bin';
      const file = path.join(this.dir, `${prefix}_${hash(bytes)}${ext}`);
      await writeFile(file, bytes);
      return { path: file, bytes: bytes.byteLength, mediaType: type?.mediaType };
    }
    if (url.startsWith('file://')) {
      const local = fromFileUri(url);
      if (!local) throw new Error(`无法解析文件地址: ${url}`);
      return this.copyLocal(local, { maxBytes, prefix });
    }
    if (path.isAbsolute(url) || /^[a-zA-Z]:[\\/]/.test(url)) {
      return this.copyLocal(url, { maxBytes, prefix });
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxBytes) throw new Error(`媒体超过大小限制: ${length} > ${maxBytes}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`媒体超过大小限制: ${buffer.byteLength} > ${maxBytes}`);
    const type = detectImageType(buffer);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    const ext = type?.ext ?? MIME_EXT[contentType] ?? '.bin';
    const file = path.join(this.dir, `${prefix}_${hash(buffer)}${ext}`);
    await writeFile(file, buffer);
    return { path: file, bytes: buffer.byteLength, mediaType: type?.mediaType ?? (contentType.startsWith('image/') ? contentType : undefined), contentType };
  }

  async copyLocal(localPath, { maxBytes = 50 * 1024 * 1024, prefix = 'media' } = {}) {
    const bytes = await readFile(localPath);
    if (bytes.byteLength > maxBytes) throw new Error(`媒体超过大小限制: ${bytes.byteLength} > ${maxBytes}`);
    const type = detectImageType(bytes);
    const ext = type?.ext ?? path.extname(localPath).toLowerCase() ?? '.bin';
    const file = path.join(this.dir, `${prefix}_${hash(bytes)}${safeFileName(path.basename(localPath, path.extname(localPath)), 'media')}${ext}`);
    await copyFile(localPath, file);
    return { path: file, bytes: bytes.byteLength, mediaType: type?.mediaType };
  }

  async saveAttachment(attachments, bytes, { mediaType, name } = {}) {
    if (!attachments) throw new Error('附件服务不可用');
    const detected = detectImageType(bytes);
    let type = detected?.mediaType ?? mediaType ?? guessTypeByName(name);
    if (!type) {
      // Unknown container (AVIF/HEIC/BMP/odd exports): let ffmpeg normalise it.
      const converted = await this.convertToPng(bytes, name);
      if (converted) {
        return attachments.saveImage({ data: new Uint8Array(converted.bytes), mediaType: 'image/png', name: converted.name });
      }
      throw new Error('无法识别的图片格式（已尝试用 ffmpeg 转换）');
    }
    return attachments.saveImage({ data: new Uint8Array(bytes), mediaType: type, name });
  }

  /** Fallback: bytes -> temp file -> single PNG frame. Returns null on failure. */
  async convertToPng(bytes, name = 'image') {
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) return null;
    await mkdir(this.dir, { recursive: true });
    const stem = hash(bytes);
    const input = path.join(this.dir, `convert_${stem}`);
    const output = path.join(this.dir, `convert_${stem}.png`);
    try {
      await writeFile(input, bytes);
      await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', output], 30000);
      const pngBytes = await readFile(output);
      if (detectImageType(pngBytes)?.mediaType !== 'image/png') return null;
      const base = String(name || 'image').replace(/\.[^.]+$/, '') || 'image';
      return { bytes: pngBytes, name: `${base}.png` };
    } catch {
      return null;
    } finally {
      await rm(input, { force: true }).catch(() => {});
    }
  }

  async frameFromVideo(videoPath, { fps = 5, maxFrames = 24 } = {}) {
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) return { frames: [], error: '未找到 ffmpeg，无法从视频提取画面' };
    const outDir = path.join(this.dir, `video_${hash(videoPath)}`);
    await ensureDir(outDir);
    const duration = await this.probeDuration(videoPath);
    const rate = Math.max(0.5, Number(fps) || 5);
    const cap = Math.max(1, Number(maxFrames) || 24);
    const times = [];
    if (duration && duration > 0) {
      const wanted = Math.max(1, Math.ceil(duration * rate));
      const count = Math.min(wanted, cap);
      if (wanted <= cap) {
        // Short clip: sample at the requested fps.
        for (let i = 0; i < count; i += 1) {
          times.push(Math.min(Math.max(0, i / rate), Math.max(0, duration - 0.05)));
        }
      } else {
        // Long clip: proportional sampling across the whole duration, capped.
        for (let i = 0; i < count; i += 1) {
          times.push(Math.min(Math.max(0, ((i + 0.5) * duration) / count), Math.max(0, duration - 0.05)));
        }
      }
    } else {
      const count = Math.min(cap, 8);
      for (let i = 0; i < count; i += 1) times.push(i * 2);
    }
    const outputs = [];
    for (let i = 0; i < times.length; i++) {
      const out = path.join(outDir, `frame_${i + 1}.jpg`);
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(times[i]), '-i', videoPath, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', out];
      try {
        await runProcess(ffmpeg, args, 30000);
        if (await exists(out)) outputs.push(out);
      } catch (error) {
        this.logger(`视频取帧失败(${i + 1}): ${error?.message ?? error}`);
      }
    }
    return { frames: outputs, duration, fps: rate, sampled: times.length };
  }

  async probeDuration(videoPath) {
    const ffprobe = await this.findFfprobe();
    if (ffprobe) {
      try {
        const { stdout } = await runProcess(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath], 15000);
        const value = Number(String(stdout).trim());
        if (Number.isFinite(value) && value > 0) return value;
      } catch {
        /* fall through to ffmpeg */
      }
    }
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) return null;
    try {
      await runProcess(ffmpeg, ['-hide_banner', '-i', videoPath], 15000);
    } catch (error) {
      const match = String(error?.message ?? '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
    return null;
  }

  /** Width/height of an image (header sniffing first, ffprobe as fallback). */
  async probeImageSize(filePath) {
    try {
      const bytes = await readFile(filePath);
      const sniffed = imageSizeFromBuffer(bytes);
      if (sniffed) return sniffed;
    } catch {
      /* fall through to ffprobe */
    }
    const ffprobe = await this.findFfprobe();
    if (!ffprobe) return null;
    try {
      const { stdout } = await runProcess(ffprobe, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        filePath,
      ], 15000);
      const [width, height] = String(stdout).trim().split(',').map((value) => Number(value));
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return { width, height };
      }
    } catch {
      /* unreadable image, treated as unknown */
    }
    return null;
  }

  async findFfmpeg() {
    if (this._ffmpegChecked) return this._ffmpegPath;
    this._ffmpegChecked = true;
    const candidates = [
      this.ffmpeg,
      path.join(this.dir, 'ffmpeg.exe'),
      path.join(this.dir, '..', 'tools', 'ffmpeg.exe'),
      'ffmpeg',
    ].filter(Boolean);
    for (const candidate of candidates) {
      const found = await findOnPath(candidate);
      if (found) {
        this._ffmpegPath = found;
        return found;
      }
    }
    this._ffmpegPath = null;
    return null;
  }

  async findFfprobe() {
    const candidates = [this.ffprobe, path.join(path.dirname(this.dir), 'tools', 'ffprobe.exe'), 'ffprobe'];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const found = await findOnPath(candidate);
      if (found) return found;
    }
    return null;
  }
}

/** Read width/height straight from PNG/GIF/JPEG/WebP headers (no ffprobe needed). */
export function imageSizeFromBuffer(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  // PNG: IHDR at 16
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: logical screen descriptor at 6 (little endian)
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WEBP (VP8X / VP8 / VP8L)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG: walk segments to a start-of-frame marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}

function hash(input) {
  const data = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  return createHash('sha1').update(data).digest('hex').slice(0, 12);
}

export function runProcess(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`进程超时: ${command}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.trim().slice(-800) || stdout.trim().slice(-800)}`));
    });
  });
}

async function findOnPath(name) {
  if (!name) return null;
  if (path.isAbsolute(name) && (await exists(name))) return name;
  try {
    const { stdout } = await runProcess('where.exe', [name], 5000);
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}
