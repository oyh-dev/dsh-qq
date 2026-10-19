import { randomId, sleep } from './util.js';

/**
 * Minimal OneBot 11 client over a forward WebSocket.
 *
 * Works with NapCat / LLOneBot / Lagrange.OneBot. Authentication is carried in
 * the URL query (`access_token`) so the same code works with the built-in
 * Node/Electron WebSocket and with the `ws` package.
 */
export class OneBotClient {
  constructor(options) {
    this.url = options.url;
    this.token = options.token || '';
    this.logger = options.logger ?? (() => {});
    this.onEvent = options.onEvent ?? (() => {});
    this.onStatus = options.onStatus ?? (() => {});
    this.selfId = null;
    this.nickname = '';
    this._pending = new Map();
    this._seq = 0;
    this._stopped = true;
    this._socket = null;
    this._wsLib = null;
    this._backoff = 1000;
    this._lastEvent = 0;
    this._heartbeatTimer = null;
    this._connected = false;
  }

  get connected() {
    return this._connected;
  }

  async start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._loop();
  }

  async stop() {
    this._stopped = true;
    this._connected = false;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._rejectPending(new Error('OneBot 连接已关闭'));
    const socket = this._socket;
    this._socket = null;
    try {
      socket?.close?.();
    } catch {
      /* ignore */
    }
  }

  async _loop() {
    while (!this._stopped) {
      try {
        await this._connectOnce();
      } catch (error) {
        this.logger(`OneBot 连接失败: ${error?.message ?? error}`);
        this._emitStatus('disconnected', { error: String(error?.message ?? error) });
      }
      if (this._stopped) break;
      const wait = this._backoff;
      this._backoff = Math.min(Math.round(this._backoff * 1.8), 30000);
      await sleep(wait);
    }
  }

  async _loadWebSocket() {
    if (this._wsLib) return this._wsLib;
    try {
      const mod = await import('ws');
      this._wsLib = mod.default?.WebSocket ?? mod.WebSocket ?? mod.default;
    } catch {
      this._wsLib = globalThis.WebSocket;
    }
    if (!this._wsLib) throw new Error('当前运行时没有可用的 WebSocket 实现');
    return this._wsLib;
  }

  async _connectOnce() {
    const WS = await this._loadWebSocket();
    const target = new URL(this.url);
    if (this.token) target.searchParams.set('access_token', this.token);
    const isNodeWs = typeof WS === 'function' && WS.prototype?.on === 'function' && typeof WS.prototype?.send === 'function' && !('onopen' in WS.prototype);

    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const connectTimer = setTimeout(() => {
        try {
          this._socket?.close?.();
        } catch {
          /* ignore */
        }
        settle(reject, new Error('WebSocket 连接超时'));
      }, 10000);

      let socket;
      try {
        socket = new WS(target.toString());
      } catch (error) {
        clearTimeout(connectTimer);
        reject(error);
        return;
      }
      this._socket = socket;

      const handleOpen = () => {
        clearTimeout(connectTimer);
        this._connected = true;
        this._backoff = 1000;
        this._lastEvent = Date.now();
        this._emitStatus('connected', {});
        this._startHeartbeat();
      };
      const handleMessage = async (data) => {
        this._lastEvent = Date.now();
        let text;
        try {
          text = await decodeData(data);
        } catch {
          return;
        }
        this._onRaw(text);
      };
      const handleClose = () => {
        clearTimeout(connectTimer);
        if (this._socket === socket) this._socket = null;
        const wasConnected = this._connected;
        this._connected = false;
        if (this._heartbeatTimer) {
          clearInterval(this._heartbeatTimer);
          this._heartbeatTimer = null;
        }
        this._rejectPending(new Error('OneBot 连接已断开'));
        if (wasConnected) this._emitStatus('disconnected', {});
        settle(resolve);
      };
      const handleError = (error) => {
        clearTimeout(connectTimer);
        if (!settled && !this._connected) {
          settle(reject, error instanceof Error ? error : new Error(String(error)));
          return;
        }
        try {
          socket.close();
        } catch {
          /* close handler settles */
        }
      };

      if (isNodeWs) {
        socket.on('open', handleOpen);
        socket.on('message', handleMessage);
        socket.on('close', handleClose);
        socket.on('error', handleError);
      } else {
        socket.onopen = handleOpen;
        socket.onmessage = (event) => handleMessage(event.data);
        socket.onclose = handleClose;
        socket.onerror = () => handleError(new Error('WebSocket 错误'));
      }
    });
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected) return;
      if (Date.now() - this._lastEvent > 90000) {
        this.logger('OneBot 心跳超时，主动重连');
        try {
          this._socket?.close?.();
        } catch {
          /* ignore */
        }
      }
    }, 30000);
  }

  _rejectPending(error) {
    for (const [echo, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this._pending.delete(echo);
    }
  }

  _emitStatus(state, extra) {
    try {
      this.onStatus({ state, selfId: this.selfId, nickname: this.nickname, ...extra });
    } catch {
      /* ignore */
    }
  }

  _onRaw(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (payload && typeof payload === 'object' && payload.echo && this._pending.has(payload.echo)) {
      const entry = this._pending.get(payload.echo);
      this._pending.delete(payload.echo);
      clearTimeout(entry.timer);
      if (payload.status === 'failed' || (payload.retcode !== 0 && payload.retcode !== undefined)) {
        const message = payload.wording || payload.message || payload.msg || `OneBot 调用失败 (retcode=${payload.retcode})`;
        entry.reject(new Error(message));
      } else {
        entry.resolve(payload.data ?? null);
      }
      return;
    }
    if (payload?.post_type) {
      try {
        this.onEvent(payload);
      } catch (error) {
        this.logger(`OneBot 事件处理异常: ${error?.message ?? error}`);
      }
    }
  }

  async call(action, params = {}, timeoutMs = 30000) {
    if (!this._connected || !this._socket) throw new Error('OneBot 未连接，请确认 NapCat 已启动并登录 QQ');
    const echo = randomId(`dsh_${++this._seq}_`);
    const payload = JSON.stringify({ action, params, echo });
    const socket = this._socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error(`OneBot 调用超时: ${action}`));
      }, timeoutMs);
      this._pending.set(echo, { resolve, reject, timer });
      try {
        if (typeof socket.send === 'function') socket.send(payload);
        else throw new Error('WebSocket 无法发送数据');
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(echo);
        reject(error);
      }
    });
  }
}

async function decodeData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (typeof data?.text === 'function') return data.text();
  return String(data);
}
