import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** whisper.cpp 的 Windows 包在不同版本里主程序名换过几次，都认一下。 */
const BIN_CANDIDATES = ['whisper-cli.exe', 'main.exe', 'whisper.exe'];
const MODEL_CANDIDATES = ['ggml-small-q5_1.bin', 'ggml-base.bin', 'ggml-small.bin', 'ggml-base-q5_1.bin'];

/**
 * 本地语音转写（whisper.cpp）。没有装就当没有这个能力——不下载、不联网、不报错刷屏。
 *
 * 只负责「音频 → 文字」。要不要留、留多少、总结成什么，全都交给上层决定，
 * 免得一个转写工具顺手把几万字灌进上下文。
 */
export class Asr {
  constructor({ dir, ffmpeg, logger, threads = 4 }) {
    this.dir = dir;
    this.ffmpeg = ffmpeg || 'ffmpeg';
    this.logger = logger || (() => {});
    this.threads = Math.max(1, Math.min(16, Number(threads) || 4));
    this._bin = undefined;
    this._model = undefined;
  }

  findBinary() {
    if (this._bin !== undefined) return this._bin;
    const roots = [this.dir, path.join(this.dir, 'bin'), path.join(this.dir, 'Release')];
    this._bin = null;
    for (const root of roots) {
      for (const name of BIN_CANDIDATES) {
        const full = path.join(root, name);
        if (existsSync(full)) {
          this._bin = full;
          return this._bin;
        }
      }
    }
    return this._bin;
  }

  findModel() {
    if (this._model !== undefined) return this._model;
    const roots = [path.join(this.dir, 'models'), this.dir];
    this._model = null;
    for (const root of roots) {
      for (const name of MODEL_CANDIDATES) {
        const full = path.join(root, name);
        if (existsSync(full)) {
          this._model = full;
          return this._model;
        }
      }
    }
    return this._model;
  }

  available() {
    return Boolean(this.findBinary() && this.findModel());
  }

  status() {
    return {
      available: this.available(),
      bin: this.findBinary(),
      model: this.findModel() ? path.basename(this.findModel()) : null,
      threads: this.threads,
    };
  }

  /**
   * 跑一遍转写。`audioFile` 得是 16kHz 单声道 wav（whisper.cpp 只吃这个）。
   * 返回纯文本；声音里没人说话时返回空串，不抛异常。
   */
  async transcribe(audioFile, { language = 'zh', maxSeconds = 1800 } = {}) {
    const bin = this.findBinary();
    const model = this.findModel();
    if (!bin || !model) throw new Error('whisper 未安装');
    const outBase = path.join(path.dirname(audioFile), `asr_${path.basename(audioFile, '.wav')}`);
    await mkdir(path.dirname(outBase), { recursive: true });
    try {
      const args = [
        '-m', model,
        '-f', audioFile,
        '-l', language,
        '-t', String(this.threads),
        '-otxt',
        '-of', outBase,
        '-np',
      ];
      // 不说这句，中文经常整段输出繁体；给个简体提示词就稳了（实测同一段音频由繁转简）
      if (language === 'zh') args.push('--prompt', '以下是普通话的句子。');
      await execFileAsync(bin, args, { timeout: Math.max(120, maxSeconds) * 1000, maxBuffer: 32 * 1024 * 1024 });
      const text = await readFile(`${outBase}.txt`, 'utf8').catch(() => '');
      return normalizeTranscript(text);
    } finally {
      await rm(`${outBase}.txt`, { force: true }).catch(() => {});
    }
  }
}

/** 去掉 whisper 输出里的时间戳行，把断句接回来；顺手压掉重复的空格。 */
export function normalizeTranscript(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
