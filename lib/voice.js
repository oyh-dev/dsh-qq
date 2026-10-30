import path from 'node:path';
import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_VOICE = 'Microsoft Huihui Desktop';
const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoyiNeural';
/**
 * Breeze TTS（BreezeBlue）：用一句中文指令「导演」语气，比 Azure 的 express-as 细得多。
 * 2026-10-29 他试听后定的基准：**大肥鱼（迷糊版）+ speed 1.1 + guidance_scale 3**。
 * guidance_scale 是「多听话地执行指令」，默认 1.0 会导致「不高兴」听不出来；3 是他认可的那档。
 */
const BREEZE_BASE = 'https://api.breezeblue.ai';
const BREEZE_MODEL = 'breeze-tts-2';
const DEFAULT_BREEZE_VOICE = 'voc_8yud7hz7c9q2';  // 大肥鱼（迷糊版）
const DEFAULT_BREEZE_BRIGHT = 'voc_u3nxkd5578wc'; // 大肥鱼（机灵版）
const DEFAULT_BREEZE_SPEED = 1.1;
const DEFAULT_BREEZE_GUIDANCE = 3;

/** 心情 → 一句导演词。语速/力度交给 voice_settings，这里只管「怎么演」。 */
export function breezeInstruction(mood = {}, { energy = null } = {}) {
  const P = Number(mood?.P ?? 0);
  const A = Number(mood?.A ?? 0);
  const D = Number(mood?.D ?? 0);
  const B = Number(mood?.B ?? 0.35);
  const tired = Number(energy) > 0 && Number(energy) <= 0.3;
  if (P <= -0.15 && A >= 0.2) return '不高兴：声音压低、变硬，语速偏快，尾音往下砸，不带笑';
  if (P <= -0.2 && A < 0.2) return '没什么力气，声音轻、慢一点，尾音往下掉，像在忍着';
  if (tired || A <= -0.25) return '刚睡醒，软软地、慢一点，尾音拖长';
  if (P >= 0.25 && B >= 0.5) return '撒娇，声音软下来，尾音往上翘一点，带点笑';
  if (A >= 0.5) return '兴奋，语速偏快、声音亮一点';
  if (D >= 0.35) return '有点得意，语气干脆，尾音收得利落';
  return '正常聊天的语气，轻快自然';
}

/** 心情 → 挑哪个音色：闹腾的时候用机灵版，其余默认迷糊版（他挑的基准）。 */
export function breezeVoiceForMood(mood = {}, { bright = DEFAULT_BREEZE_BRIGHT, soft = DEFAULT_BREEZE_VOICE } = {}) {
  const A = Number(mood?.A ?? 0);
  const P = Number(mood?.P ?? 0);
  return A >= 0.35 && P >= 0.2 ? bright : soft;
}
const MAX_CHARS = 120;

const SHELL_CANDIDATES = [
  process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'powershell.exe',
  'pwsh.exe',
  'pwsh',
];

const PYTHON_CANDIDATES = [
  process.env.DSH_PYTHON || '',
  process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
    : '',
  'python.exe',
  'python',
  'py',
];

function resolveFirst(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const hasSeparator = candidate.includes(path.sep) || candidate.includes('/');
    if (hasSeparator) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    return candidate; // bare command name: let the OS resolve it
  }
  return candidates[candidates.length - 1] || '';
}

/** Strip things a TTS engine would read out literally. */
export function cleanForSpeech(text) {
  let out = String(text ?? '');
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/https?:\/\/\S+/gi, ' ');
  out = out.replace(/[*_`>#~|]/g, '');
  out = out.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  out = out.replace(/\((?:笑|哭|叹气|沉默|小声)[^)]*\)/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** Read sample rate/channels from a canonical WAV header. */
function wavFormat(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      return {
        channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12),
        byteRate: bytes.readUInt32LE(offset + 16),
        bitsPerSample: bytes.readUInt16LE(offset + 22),
        dataSize: size,
      };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * 估时长。原来是死按 48kbit 算（Azure 那档的输出格式），
 * 2026-10-29 Breeze 返回的是 128kbit，同一句话被算成 12.2 秒（实际 4.56 秒）。
 * 现在先读第一帧帧头的比特率，读不到才退回 48k。
 */
function mp3Seconds(bytes) {
  if (!bytes || bytes.length === 0) return 0;
  const brMpeg1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const brMpeg2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const srMpeg1 = [44100, 48000, 32000];
  const srMpeg2 = [22050, 24000, 16000];
  const srMpeg25 = [11025, 12000, 8000];
  for (let i = 0; i + 4 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (bytes[i + 1] >> 3) & 0x03; // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const layerBits = (bytes[i + 1] >> 1) & 0x03;   // 1=Layer III
    if (versionBits === 1 || layerBits === 0) continue;
    const mpeg1 = versionBits === 3;
    const bitrate = (mpeg1 ? brMpeg1 : brMpeg2)[(bytes[i + 2] >> 4) & 0x0f] * 1000;
    const rateTable = mpeg1 ? srMpeg1 : versionBits === 2 ? srMpeg2 : srMpeg25;
    const rate = rateTable[(bytes[i + 2] >> 2) & 0x03];
    if (!bitrate || !rate) continue;
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const factor = mpeg1 ? 144 : 72;
    const frameLength = Math.floor((factor * bitrate) / rate) + ((bytes[i + 2] >> 1) & 0x01);
    if (frameLength <= 0) continue;
    const next = i + frameLength;
    if (next + 1 >= bytes.length || bytes[next] !== 0xff || (bytes[next + 1] & 0xe0) !== 0xe0) continue;
    // 从这一帧开始数：帧数 × 每帧采样数 ÷ 采样率，比按文件大小估准
    let frames = 0;
    for (let at = i; at + 4 < bytes.length; at += frameLength) {
      if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) break;
      frames += 1;
    }
    if (frames > 0) return Number(((frames * samplesPerFrame) / rate).toFixed(1));
  }
  return Number(((bytes.length * 8) / 48000).toFixed(1));
}

/**
 * Text-to-speech for QQ voice messages.
 *
 * engine = 'edge'  -> Microsoft Edge neural voices through the edge-tts package
 *                     (natural, needs network; Python + edge-tts must exist)
 * engine = 'sapi'  -> Windows SAPI voices (offline, robotic but always works)
 *
 * Edge failures fall back to SAPI automatically so a QQ voice never silently dies.
 */
/**
 * 免费音色也能有起伏的办法：把一句话切碎，逐段换语速音高，段间塞真停顿。
 *
 * 这不是情感标签（edge 免费接口没有），但它能把「一口气念完」变成「一句一句说」。
 * 段数封顶 6，太长的话等待会成倍。
 */
export function splitExpressive(text, { maxSegments = 6, softLimit = 26, minChars = 2 } = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const sentences = raw.match(/[^。！？!?…；;\n]+[。！？!?…；;]?/g) || [raw];
  const pieces = [];
  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (!clean) continue;
    if (clean.length <= softLimit) {
      pieces.push(clean);
      continue;
    }
    // 长句再按逗号切，切完拼到 softLimit 以内
    let buf = '';
    for (const part of clean.split(/(?<=[，,、])/)) {
      if (!part) continue;
      if (buf && (buf + part).length > softLimit) {
        pieces.push(buf);
        buf = part;
      } else {
        buf += part;
      }
    }
    if (buf) pieces.push(buf);
  }
  // 太碎的段并回上一段，别一句话抖成五个音
  const merged = [];
  for (const piece of pieces) {
    if (merged.length > 0 && piece.length < minChars) merged[merged.length - 1] += piece;
    else merged.push(piece);
  }
  return merged.slice(0, Math.max(1, maxSegments));
}

/** 每段该用什么语速/音高/后接多长停顿，由标点和心情决定。 */
export function segmentProsody(segment, mood = {}) {
  const P = Number(mood?.P) || 0;
  const text = String(segment || '');
  const last = text.slice(-1);
  let rate = 0;
  let pitch = 0;
  let pauseMs = 80;
  if (/[！!]/.test(last)) {
    rate += 8;
    pitch += 8;
    pauseMs = 160;
  } else if (/[？?]/.test(last)) {
    rate += 3;
    pitch += 6;
    pauseMs = 260;
  } else if (last === '…') {
    rate -= 6;
    pitch -= 2;
    pauseMs = 420;
  } else if (/[，,、]/.test(last)) {
    pauseMs = 200;
  } else if (/[。；;]/.test(last)) {
    pauseMs = 150;
  }
  // 心情基调：高兴整体快一点亮一点，低落慢一点低一点
  if (P >= 0.3) rate += 4;
  else if (P <= -0.2) {
    rate -= 5;
    pitch -= 3;
  }
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  rate = clamp(rate, -30, 30);
  pitch = clamp(pitch, -20, 20);
  return {
    rate: `${rate >= 0 ? '+' : ''}${rate}%`,
    pitch: `${pitch >= 0 ? '+' : ''}${pitch}Hz`,
    pauseMs,
  };
}

export class VoiceEngine {
  constructor({
    dir,
    ffmpeg,
    logger,
    engine = 'edge',
    voiceName,
    rate = 1,
    pitch = 1.08,
    maxChars = MAX_CHARS,
    edgeVoice,
    edgeRate = '+5%',
    edgePitch = '+12Hz',
    pythonPath,
    breezeKey = '',
    breezeVoice = DEFAULT_BREEZE_VOICE,
    breezeVoiceBright = DEFAULT_BREEZE_BRIGHT,
    breezeSpeed = DEFAULT_BREEZE_SPEED,
    breezeGuidance = DEFAULT_BREEZE_GUIDANCE,
  }) {
    this.dir = dir;
    this.ffmpeg = ffmpeg || 'ffmpeg';
    this.logger = logger || (() => {});
    this.engine = ['sapi', 'breeze'].includes(engine) ? engine : 'edge';
    this.voiceName = voiceName || DEFAULT_VOICE;
    this.rate = Math.max(-10, Math.min(10, Number(rate) || 0));
    this.pitch = Math.max(0.8, Math.min(1.3, Number(pitch) || 1));
    this.maxChars = Math.max(10, Number(maxChars) || MAX_CHARS);
    this.edgeVoice = edgeVoice || DEFAULT_EDGE_VOICE;
    this.edgeRate = normalizePercent(edgeRate, '+5%');
    this.edgePitch = normalizeHertz(edgePitch, '+12Hz');
    this.pythonPath = pythonPath || '';
    this.breezeKey = String(breezeKey || '').trim();
    this.breezeVoice = String(breezeVoice || DEFAULT_BREEZE_VOICE).trim();
    this.breezeVoiceBright = String(breezeVoiceBright || DEFAULT_BREEZE_BRIGHT).trim();
    this.breezeSpeed = Math.max(0.5, Math.min(2, Number(breezeSpeed) || DEFAULT_BREEZE_SPEED));
    this.breezeGuidance = Math.max(1, Math.min(10, Number(breezeGuidance) || DEFAULT_BREEZE_GUIDANCE));
  }

  /** Breeze 有没有配好（缺 key 就等于没装）。 */
  breezeReady() {
    return Boolean(this.breezeKey);
  }

  async listVoices() {
    const sapi = await this._listSapi().catch(() => []);
    const edge = await this._listEdge().catch(() => []);
    return { engine: this.engine, sapi, edge };
  }

  async _listSapi() {
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture + "|" + $_.VoiceInfo.Gender };',
    ].join(' ');
    const { stdout } = await execFileAsync(resolveFirst(SHELL_CANDIDATES), ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000 });
    return String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, culture, gender] = line.split('|');
      return { name, culture, gender };
    });
  }

  async _listEdge() {
    const python = resolveFirst([this.pythonPath, ...PYTHON_CANDIDATES]);
    const { stdout } = await execFileAsync(python, ['-m', 'edge_tts', '--list-voices'], { timeout: 60000 });
    return String(stdout).split(/\r?\n/)
      .map((line) => line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean))
      .filter((parts) => parts[0]?.startsWith('zh-CN'))
      .map(([name, gender, ...rest]) => ({ name, gender, style: rest.join(' ') }));
  }

  /** Synthesize text to an audio file; returns { path, seconds, chars, cached, engine }. */
  async synthesize(text, options = {}) {
    const spoken = cleanForSpeech(text).slice(0, this.maxChars);
    if (!spoken) throw new Error('没有可朗读的文字');
    const engine = ['sapi', 'edge', 'breeze'].includes(options.engine) ? options.engine : this.engine;
    if (engine === 'breeze' && this.breezeReady()) {
      try {
        return await this._synthesizeBreeze(spoken, options);
      } catch (error) {
        this.logger(`Breeze TTS 失败，回退 Edge: ${error?.message ?? error}`);
      }
    }
    if (engine === 'breeze') {
      if (!this.breezeReady()) this.logger('Breeze 没配 key，按 Edge 处理');
      try {
        return await this._synthesizeEdgeExpressive(spoken, options);
      } catch (error) {
        this.logger(`Edge TTS 失败，回退 SAPI: ${error?.message ?? error}`);
        return await this._synthesizeSapi(spoken, options);
      }
    }
    if (engine === 'azure') {
      // Azure 已经删掉了（2026-10-29 停用），旧配置写 azure 的按 edge 走
      this.logger('engine 还写着 azure，但 Azure 那档已移除，按 Edge 处理');
      try {
        return await this._synthesizeEdgeExpressive(spoken, options);
      } catch (error) {
        this.logger(`Edge TTS 失败，回退 SAPI: ${error?.message ?? error}`);
        return await this._synthesizeSapi(spoken, options);
      }
    }
    if (engine === 'edge') {
      try {
        // 免费音色也能有起伏：切句 + 逐段变调 + 段间停顿
        if (options.expressive !== false) {
          return await this._synthesizeEdgeExpressive(spoken, options);
        }
        return await this._synthesizeEdge(spoken, options);
      } catch (error) {
        this.logger(`Edge TTS 失败，回退 SAPI: ${error?.message ?? error}`);
        return await this._synthesizeSapi(spoken, options);
      }
    }
    return await this._synthesizeSapi(spoken, options);
  }

  /**
   * 把一句话切成几段分别合成，段间塞真停顿，再拼回一条 mp3。
   * 段数 1 时直接走单次合成（别为一个字多跑几次）。
   */
  async _synthesizeEdgeExpressive(spoken, options = {}) {
    const segments = splitExpressive(spoken);
    if (segments.length <= 1) return this._synthesizeEdge(spoken, options);
    await mkdir(this.dir, { recursive: true });
    const mood = options.mood || {};
    const parts = [];
    for (const segment of segments) {
      const { rate, pitch, pauseMs } = segmentProsody(segment, mood);
      const piece = await this._synthesizeEdge(segment, {
        ...options,
        edgeRate: normalizePercent(rate, this.edgeRate),
        edgePitch: normalizeHertz(pitch, this.edgePitch),
      });
      parts.push(piece.path);
      if (pauseMs > 0) {
        try {
          parts.push(await this._silenceMs(pauseMs));
        } catch { /* 没 ffmpeg 就不加停顿，别整条失败 */ }
      }
    }
    const key = createHash('sha1')
      .update(`exp|${options.edgeVoice || this.edgeVoice}|${JSON.stringify(mood)}|${spoken}`)
      .digest('hex').slice(0, 16);
    const outPath = path.join(this.dir, `${key}.mp3`);
    if (await this._exists(outPath)) {
      return { path: outPath, seconds: mp3Seconds(await readFile(outPath)), chars: spoken.length, cached: true, engine: 'edge', segments: segments.length };
    }
    await this._concatMp3(parts, outPath);
    const bytes = await readFile(outPath);
    return { path: outPath, seconds: mp3Seconds(bytes), chars: spoken.length, cached: false, engine: 'edge', segments: segments.length };
  }

  /** 生成一小段静音（缓存按毫秒），用来做段间停顿。 */
  async _silenceMs(ms) {
    const out = path.join(this.dir, `sil_${ms}.mp3`);
    if (await this._exists(out)) return out;
    await mkdir(this.dir, { recursive: true });
    await execFileAsync(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
      '-t', String(Math.max(0.05, ms / 1000)),
      '-c:a', 'libmp3lame', '-b:a', '48k',
      out,
    ], { timeout: 30000 });
    return out;
  }

  async _concatMp3(paths, outPath) {
    const listPath = path.join(this.dir, `list_${createHash('sha1').update(paths.join('|')).digest('hex').slice(0, 8)}.txt`);
    const lines = paths.map((file) => `file '${String(file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');
    try {
      await execFileAsync(this.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', outPath,
      ], { timeout: 60000 });
    } finally {
      await rm(listPath, { force: true }).catch(() => {});
    }
    return outPath;
  }

  /**
   * Breeze TTS：一句中文指令「导演」语气，speed 保音高调速，guidance_scale 决定指令多硬。
   * 基准是他 2026-10-29 试听挑的：迷糊版 + speed 1.1 + guidance 3。
   */
  async _synthesizeBreeze(spoken, options = {}) {
    const mood = options.mood || {};
    const voice = String(options.breezeVoice || breezeVoiceForMood(mood, {
      bright: this.breezeVoiceBright,
      soft: this.breezeVoice,
    })).trim();
    const instruction = String(
      options.instruction || options.style || breezeInstruction(mood, { energy: options.energy ?? null }),
    ).trim();
    const speed = Math.max(0.5, Math.min(2, Number(options.breezeSpeed ?? this.breezeSpeed)));
    const guidance = Math.max(1, Math.min(10, Number(options.breezeGuidance ?? this.breezeGuidance)));
    const key = createHash('sha1')
      .update(`breeze|${voice}|${speed}|${guidance}|${instruction}|${spoken}`)
      .digest('hex').slice(0, 16);
    const outPath = path.join(this.dir, `${key}.mp3`);
    if (await this._exists(outPath)) {
      return { path: outPath, seconds: mp3Seconds(await readFile(outPath)), chars: spoken.length, cached: true, engine: 'breeze', voice, instruction };
    }
    await mkdir(this.dir, { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let res;
    try {
      res = await fetch(`${BREEZE_BASE}/v1/text-to-speech/${encodeURIComponent(voice)}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.breezeKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'dsh-qq',
        },
        body: JSON.stringify({
          text: spoken,
          model_id: BREEZE_MODEL,
          language_code: 'zh',
          instructions: instruction,
          voice_settings: { speed, guidance_scale: guidance },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Breeze ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 2000) throw new Error('Breeze 返回空音频');
    await writeFile(outPath, bytes);
    return { path: outPath, seconds: mp3Seconds(bytes), chars: spoken.length, cached: false, engine: 'breeze', voice, instruction };
  }


  async _synthesizeEdge(spoken, options) {
    const voice = options.edgeVoice || options.voiceName || this.edgeVoice;
    const rate = normalizePercent(options.edgeRate, this.edgeRate);
    const pitch = normalizeHertz(options.edgePitch, this.edgePitch);
    const key = createHash('sha1').update(`edge|${voice}|${rate}|${pitch}|${spoken}`).digest('hex').slice(0, 16);
    const outPath = path.join(this.dir, `${key}.mp3`);
    if (await this._exists(outPath)) {
      return { path: outPath, seconds: mp3Seconds(await readFile(outPath)), chars: spoken.length, cached: true, engine: 'edge' };
    }
    await mkdir(this.dir, { recursive: true });
    const python = resolveFirst([this.pythonPath, ...PYTHON_CANDIDATES]);
    await execFileAsync(python, [
      '-m', 'edge_tts',
      `--voice=${voice}`,
      // `--flag=value` form: a bare "-8%" would otherwise be parsed as a flag.
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      '--text', spoken,
      `--write-media=${outPath}`,
    ], { timeout: 90000 });
    const bytes = await readFile(outPath);
    if (bytes.length < 2000) throw new Error('Edge TTS 返回空音频');
    return { path: outPath, seconds: mp3Seconds(bytes), chars: spoken.length, cached: false, engine: 'edge', voice };
  }

  async _synthesizeSapi(spoken, options) {
    const voiceName = options.voiceName || this.voiceName;
    const rate = Number.isFinite(Number(options.rate)) ? Number(options.rate) : this.rate;
    const pitch = Number.isFinite(Number(options.pitch)) ? Number(options.pitch) : this.pitch;
    const key = createHash('sha1')
      .update(`sapi|${voiceName}|${rate}|${pitch}|${spoken}`)
      .digest('hex')
      .slice(0, 16);
    const rawPath = path.join(this.dir, `${key}-raw.wav`);
    const outPath = path.join(this.dir, `${key}.wav`);
    if (await this._exists(outPath)) {
      return { path: outPath, seconds: await this._wavSeconds(outPath), chars: spoken.length, cached: true, engine: 'sapi' };
    }
    await mkdir(this.dir, { recursive: true });

    const b64 = Buffer.from(spoken, 'utf8').toString('base64');
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      `$s.SelectVoice(${psQuote(voiceName)});`,
      `$s.Rate = ${Math.round(rate)};`,
      `$s.SetOutputToWaveFile(${psQuote(rawPath)});`,
      `$s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')));`,
      '$s.Dispose();',
    ].join(' ');
    await execFileAsync(resolveFirst(SHELL_CANDIDATES), ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60000 });

    const raw = await readFile(rawPath);
    const fmt = wavFormat(raw);
    if (pitch !== 1 && fmt) {
      const target = Math.round(fmt.sampleRate * pitch);
      const tempo = (1 / pitch).toFixed(5);
      await execFileAsync(this.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', rawPath,
        '-af', `asetrate=${target},aresample=${fmt.sampleRate},atempo=${tempo}`,
        '-ac', '1', '-ar', '24000',
        outPath,
      ], { timeout: 60000 });
    } else {
      await writeFile(outPath, raw);
    }
    await rm(rawPath, { force: true }).catch(() => {});
    return { path: outPath, seconds: await this._wavSeconds(outPath), chars: spoken.length, cached: false, engine: 'sapi', voice: voiceName };
  }

  async _wavSeconds(file) {
    try {
      const bytes = await readFile(file);
      const fmt = wavFormat(bytes);
      if (!fmt || !fmt.byteRate) return null;
      return Number(((bytes.length - 44) / fmt.byteRate).toFixed(1));
    } catch {
      return null;
    }
  }

  async _exists(file) {
    try {
      const info = await stat(file);
      return info.size > 1000;
    } catch {
      return false;
    }
  }
}

function normalizePercent(value, fallback) {
  const text = String(value ?? '').trim();
  if (/^[+-]?\d+(\.\d+)?%$/.test(text)) return text;
  const number = Number(text);
  if (Number.isFinite(number) && text !== '') return `${number >= 0 ? '+' : ''}${number}%`;
  return fallback;
}

function normalizeHertz(value, fallback) {
  const text = String(value ?? '').trim();
  if (/^[+-]?\d+(\.\d+)?Hz$/.test(text)) return text;
  const number = Number(text);
  if (Number.isFinite(number) && text !== '') return `${number >= 0 ? '+' : ''}${number}Hz`;
  return fallback;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
