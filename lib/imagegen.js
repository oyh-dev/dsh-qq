/**
 * Image generation through a keyless public endpoint.
 * Kept deliberately small: build a URL, fetch bytes, hand them to the media store.
 * All network access goes through an injected fetch so tests stay offline.
 */
const DEFAULT_ENDPOINT = 'https://image.pollinations.ai/prompt';

/** Prompts that must never reach a generation endpoint. */
const BLOCKED = [
  /色情|裸聊|约炮|成人视频|福利姬/i,
  /\bnude\b|\bnaked\b|nsfw|explicit sex|\bhentai\b/i,
  /儿童色情|幼女|萝莉裸/i,
  /枪支|弹药|迷药|假证|代考/i,
  /诈骗|刷单|洗钱|跑分/i,
];

export function assertPromptAllowed(prompt) {
  const value = String(prompt || '').trim();
  if (!value) throw new Error('提示词为空');
  if (value.length > 600) throw new Error('提示词过长（上限 600 字）');
  for (const pattern of BLOCKED) {
    if (pattern.test(value)) throw new Error('这个提示词里含有不能生成的内容，换个说法');
  }
  return value;
}

export function buildImageUrl(prompt, { endpoint = DEFAULT_ENDPOINT, width = 768, height = 1024, seed = -1, model = '', token = '' } = {}) {
  const safe = assertPromptAllowed(prompt);
  const params = new URLSearchParams({
    width: String(Math.max(256, Math.min(1536, Number(width) || 768))),
    height: String(Math.max(256, Math.min(1536, Number(height) || 1024))),
    nologo: 'true',
    safe: 'true',
  });
  if (Number(seed) >= 0) params.set('seed', String(Math.trunc(seed)));
  if (model) params.set('model', String(model));
  if (token) params.set('token', String(token));
  return `${endpoint}/${encodeURIComponent(safe)}?${params.toString()}`;
}

export class ImageGen {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 90000, logger = () => {} } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(5000, Number(timeoutMs) || 90000);
    this.logger = logger;
  }

  /** Generate one image and return its bytes plus the prompt that produced it. */
  async generate({ prompt, width = 768, height = 1024, seed = -1, model = '', endpoint = DEFAULT_ENDPOINT, token = '' } = {}) {
    const url = buildImageUrl(prompt, { endpoint, width, height, seed, model, token });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`生图服务返回 ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength < 1024) throw new Error('生图服务返回的内容不对（太小）');
      const type = response.headers?.get?.('content-type') || 'image/jpeg';
      this.logger(`生图完成 ${buffer.byteLength} bytes ${type}`);
      return { buffer, url, prompt: String(prompt), contentType: type };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('生图超时了，等会儿再试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * OpenAI-compatible image endpoint: works for OpenAI, xAI/Grok, SiliconFlow,
   * Zhipu and anything else that speaks POST {baseUrl}/images/generations.
   */
  async generateCompatible({
    prompt,
    baseUrl,
    apiKey,
    model = 'gpt-image-1',
    size = '1024x1024',
    sizeField = 'size',
    extra = {},
  } = {}) {
    const safe = assertPromptAllowed(prompt);
    if (!baseUrl) throw new Error('没有配置生图服务的地址');
    if (!apiKey) throw new Error('没有配置生图服务的 API key');
    const url = `${String(baseUrl).replace(/\/+$/, '')}/images/generations`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = { model, prompt: safe, n: 1, ...(size ? { [sizeField]: size } : {}), ...extra };
      const response = await this.fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        let detail = text.slice(0, 200);
        try { detail = JSON.parse(text)?.error?.message || detail; } catch { /* keep raw */ }
        throw new Error(`生图服务返回 ${response.status}：${detail}`);
      }
      let payload = {};
      try { payload = JSON.parse(text); } catch { throw new Error('生图服务返回的不是 JSON'); }
      const item = payload?.data?.[0] || payload?.images?.[0] || {};
      let buffer = null;
      if (item.b64_json) buffer = Buffer.from(item.b64_json, 'base64');
      else if (item.url) {
        const imageResponse = await this.fetch(item.url, { signal: controller.signal, redirect: 'follow' });
        if (!imageResponse.ok) throw new Error(`下载生成的图片失败 ${imageResponse.status}`);
        buffer = Buffer.from(await imageResponse.arrayBuffer());
      }
      if (!buffer || buffer.byteLength < 1024) throw new Error('生图服务没返回图片内容');
      this.logger(`生图完成 ${buffer.byteLength} bytes (${model})`);
      return { buffer, url, prompt: safe, contentType: 'image/png' };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('生图超时了，等会儿再试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
