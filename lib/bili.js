import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const data = await this._json('https://api.bilibili.com/x/v2/history?pn=1&ps=20', slot);
    if (data.code !== 0) throw new Error(`history code=${data.code}`);
    const list = data.data?.list || [];
    return list.map((item) => ({
      bvid: item.bvid,
      title: item.title,
      duration: Number(item.duration) || 0,
      author: item.owner?.name || '',
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
    return { cid: data.data.cid, title: data.data.title, duration: Number(data.data.duration) || 0, author: data.data.owner?.name || '' };
  }

  async playurl(bvid, cid, slot = 'main') {
    const data = await this._json(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=32&fnval=0&fnver=0&fourk=0`, slot);
    if (data.code !== 0) throw new Error(`playurl code=${data.code}`);
    return data.data?.durl?.[0]?.url || '';
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

  async downloadVideo(video, seconds, dir) {
    const slot = video.slot || 'main';
    const info = await this.view(video.bvid, slot);
    const url = await this.playurl(video.bvid, info.cid, slot);
    if (!url) throw new Error('playurl empty');
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, `${video.bvid}.mp4`);
    await this.download(url, seconds, out);
    return { info, path: out };
  }

  async contactSheet(framePaths, outPath, columns = 4) {
    if (framePaths.length === 0) return '';
    await mkdir(path.dirname(outPath), { recursive: true });
    const rows = Math.ceil(framePaths.length / columns);
    const pattern = path.join(path.dirname(framePaths[0]), 'frame_%d.jpg');
    await execFileAsync(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', '1', '-i', pattern,
      '-vf', `scale=480:270,tile=${columns}x${rows}`,
      '-frames:v', '1', outPath,
    ], { timeout: 60000 });
    return outPath;
  }
}
