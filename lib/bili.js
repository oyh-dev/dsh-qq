import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

/** Arc/search reports duration as "m:ss" (older items may be plain seconds). */
function parseDuration(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (!text.includes(':')) return Number(text) || 0;
  return text.split(':').reduce((total, part) => total * 60 + (Number(part) || 0), 0);
}

export class BiliClient {
  constructor({ dir, cookiesFile, ffmpeg, logger }) {
    this.dir = dir;
    this.cookiesFile = cookiesFile;
    this.ffmpeg = ffmpeg || 'ffmpeg';
    this.logger = logger || (() => {});
    this._buvid = null;
  }

  async _loadCookies(slot) {
    try {
      const store = JSON.parse(await readFile(this.cookiesFile, 'utf8'));
      return store?.[slot] || null;
    } catch {
      return null;
    }
  }

  async _cookieHeader(slot) {
    const jar = await this._loadCookies(slot);
    if (!jar) return '';
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async _ensureBuvid() {
    if (this._buvid) return this._buvid;
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': UA } });
    const data = await res.json();
    if (data.code === 0) this._buvid = data.data;
    return this._buvid;
  }

  async _headers(slot) {
    const buvid = await this._ensureBuvid();
    const cookies = [buvid ? `buvid3=${buvid.b_3}; buvid4=${buvid.b_4}` : '', await this._cookieHeader(slot)]
      .filter(Boolean)
      .join('; ');
    return {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      ...(cookies ? { Cookie: cookies } : {}),
    };
  }

  async _json(url, slot = 'main') {
    const res = await fetch(url, { headers: await this._headers(slot) });
    return res.json();
  }

  async history(slot) {
    // 新的 cursor 接口对部分账号才返回数据，老的 x/v2/history 会稳定返回空列表，两个都试。
    const endpoints = [
      'https://api.bilibili.com/x/web-interface/history/cursor?ps=20&type=archive',
      'https://api.bilibili.com/x/v2/history?pn=1&ps=20',
    ];
    let list = [];
    let lastError = null;
    for (const url of endpoints) {
      try {
        const data = await this._json(url, slot);
        if (data.code !== 0) {
          lastError = new Error(`history code=${data.code}`);
          continue;
        }
        const raw = Array.isArray(data.data) ? data.data : data.data?.list || [];
        if (raw.length > 0) {
          list = raw;
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (list.length === 0 && lastError) throw lastError;
    return list.map((item) => ({
      bvid: item.bvid || item.history?.bvid || '',
      title: item.title,
      duration: Number(item.duration) || 0,
      author: item.owner?.name || item.author_name || '',
    })).filter((item) => item.bvid && item.duration > 0);
  }

  async hot() {
    const data = await this._json('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', 'main');
    if (data.code !== 0) throw new Error(`hot code=${data.code}`);
    return (data.data?.list || []).map((item) => ({
      bvid: item.bvid,
      title: item.title,
      duration: Number(item.duration) || 0,
      author: item.owner?.name || '',
    })).filter((item) => item.bvid && item.duration > 0);
  }

  async view(bvid, slot = 'main') {
    const data = await this._json(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, slot);
    if (data.code !== 0) throw new Error(`view code=${data.code}`);
    return {
      cid: data.data.cid,
      title: data.data.title,
      duration: Number(data.data.duration) || 0,
      author: data.data.owner?.name || '',
      // 简介常有一两行关键信息，比瞎猜画面有用，顺手带回去
      desc: String(data.data.desc || '').slice(0, 400),
    };
  }

  async playurl(bvid, cid, slot = 'main') {
    const data = await this._json(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=32&fnval=0&fnver=0&fourk=0`, slot);
    if (data.code !== 0) throw new Error(`playurl code=${data.code}`);
    return data.data?.durl?.[0]?.url || '';
  }

  /**
   * 不落整条视频，直接对播放地址抽帧：ffmpeg 顺序读流，只把需要的帧写盘。
   *
   * 以前是「先下载前 40 秒 mp4，再抽帧」——等于只看开头就下结论，看不出这条视频
   * 到底讲什么，还会被开头几秒的标题党带偏。现在整条都读，但只有帧落盘。
   */
  async framesFromUrl(url, { duration, frames, dir, audioOut } = {}) {
    const total = Math.max(1, Number(duration) || 1);
    const count = Math.max(1, Math.min(120, Number(frames) || 12));
    const fps = count / total;
    await mkdir(dir, { recursive: true });
    const pattern = path.join(dir, 'frame_%03d.jpg');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-headers', `User-Agent: ${UA}\r\nReferer: https://www.bilibili.com/\r\n`,
      '-i', url,
      '-map', '0:v:0',
      '-vf', `fps=${fps.toFixed(4)},scale='min(1280,iw)':-2`,
      '-frames:v', String(count),
      '-q:v', '3',
      pattern,
    ];
    // 顺手把音轨也抠出来：同一次读流拿两样东西，别为了转写再读一遍
    if (audioOut) {
      await mkdir(path.dirname(audioOut), { recursive: true });
      args.push('-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioOut);
    }
    await execFileAsync(this.ffmpeg, args, { timeout: 900000 });
    const names = (await readdir(dir)).filter((name) => /^frame_\d+\.jpg$/i.test(name)).sort();
    return names.map((name) => path.join(dir, name));
  }

  /**
   * 从播放地址直接抽音轨成 16kHz 单声道 wav（whisper 只吃这个）。
   * 同样不落视频，读一遍流就够。
   */
  async audioFromUrl(url, outFile) {
    await mkdir(path.dirname(outFile), { recursive: true });
    await execFileAsync(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-headers', `User-Agent: ${UA}\r\nReferer: https://www.bilibili.com/\r\n`,
      '-i', url,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      outFile,
    ], { timeout: 900000 });
    return outFile;
  }

  async download(url, seconds, outPath) {
    const headers = `User-Agent: ${UA}\r\nReferer: https://www.bilibili.com/\r\n`;
    await execFileAsync(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-headers', headers,
      '-i', url,
      '-t', String(Math.max(1, seconds)),
      '-c', 'copy', outPath,
    ], { timeout: 120000 });
    return outPath;
  }

  async downloadVideo(video, seconds, dir, preInfo = null) {
    const slot = video.slot || 'main';
    // 已经查过 view 的就把 info 传进来，别为了一条视频请求两遍
    const info = preInfo || await this.view(video.bvid, slot);
    const url = await this.playurl(video.bvid, info.cid, slot);
    if (!url) throw new Error('playurl empty');
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, `${video.bvid}.mp4`);
    await this.download(url, seconds, out);
    return { info, path: out };
  }

  /**
   * Bilibili's newer space API requires WBI signing: mix the img/sub keys from
   * the nav endpoint through a fixed shuffle table, then md5(sorted query + key).
   */
  async _wbiKeys() {
    if (this._wbi && this._wbi.expire > Date.now()) return this._wbi;
    const data = await this._json('https://api.bilibili.com/x/web-interface/nav', 'main');
    const img = data?.data?.wbi_img?.img_url || '';
    const sub = data?.data?.wbi_img?.sub_url || '';
    const pick = (url) => (url.slice(url.lastIndexOf('/') + 1).split('.')[0] || '');
    const raw = pick(img) + pick(sub);
    if (raw.length < 64) throw new Error('wbi keys unavailable');
    const key = MIXIN_KEY_ENC_TAB.map((index) => raw[index]).join('').slice(0, 32);
    this._wbi = { key, expire: Date.now() + 3600000 };
    return this._wbi;
  }

  async _wbiSign(params) {
    const { key } = await this._wbiKeys();
    const all = { ...params, wts: String(Math.floor(Date.now() / 1000)) };
    const query = Object.keys(all)
      .sort()
      .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(String(all[name]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    const wRid = createHash('md5').update(query + key).digest('hex');
    return `${query}&w_rid=${wRid}`;
  }

  async spaceVideos(mid, { ps = 20, pn = 1 } = {}) {
    const query = await this._wbiSign({
      mid: String(mid),
      ps: String(ps),
      pn: String(pn),
      order: 'pubdate',
      platform: 'web',
      web_location: '1550101',
    });
    const data = await this._json(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`, 'main');
    if (data.code !== 0) throw new Error(`space code=${data.code}`);
    return (data.data?.list?.vlist || []).map((item) => ({
      bvid: item.bvid,
      title: item.title,
      duration: parseDuration(item.length),
      author: item.author || '',
      created: Number(item.created) || 0,
    })).filter((item) => item.bvid && item.duration > 0);
  }

  async contactSheet(framePaths, outPath, columns = 4) {
    if (framePaths.length === 0) return '';
    await mkdir(path.dirname(outPath), { recursive: true });
    // ffmpeg 的 image2 只认严格递增的文件名序号，传 -i frame_%d.jpg 时永远从 frame_1 开始读。
    // 直接把散帧目录甩给它，每张拼图都会拼成最开始那几帧（2026-10-28 踩过：6 张拼图字节数一模一样）。
    // 所以每张拼图先在临时目录里按 1..N 重排一份，再让 ffmpeg 读。
    const tileDir = path.join(path.dirname(outPath), `tiles_${path.basename(outPath, path.extname(outPath))}`);
    await rm(tileDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(tileDir, { recursive: true });
    try {
      for (let i = 0; i < framePaths.length; i += 1) {
        await copyFile(framePaths[i], path.join(tileDir, `frame_${i + 1}.jpg`));
      }
      const rows = Math.ceil(framePaths.length / columns);
      const pattern = path.join(tileDir, 'frame_%d.jpg');
      await execFileAsync(this.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-framerate', '1', '-i', pattern,
        '-vf', `scale=480:270,tile=${columns}x${rows}`,
        '-frames:v', '1', outPath,
      ], { timeout: 60000 });
    } finally {
      await rm(tileDir, { recursive: true, force: true }).catch(() => {});
    }
    return outPath;
  }
}
