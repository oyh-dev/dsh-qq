import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 测试要用的 `ws`。
 *
 * 插件本身零运行时依赖（WebSocket 由宿主提供），所以仓库里通常没有自己的
 * node_modules；这里按顺序找：本地依赖 → 宿主 profile 里的那份。
 * 都找不到就抛一条能照着做的错，而不是一个找不到模块的栈。
 */
export async function loadWs() {
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const candidates = [
    'ws',
    pathToFileURL(path.join(home, 'profiles', 'desktop', 'node_modules', 'ws', 'index.js')).href,
  ];
  const errors = [];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      return mod.default ?? mod;
    } catch (error) {
      errors.push(`${spec}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`找不到 ws，先装一下再跑测试（npm i -D ws）。试过：${errors.join(' | ')}`);
}

export default loadWs;
