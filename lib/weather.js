const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const WMO = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

export function describeCode(code) {
  return WMO[Number(code)] || `天气码 ${code}`;
}

/** Human-friendly one-liner used in QQ messages. */
export function formatWeather(data) {
  if (!data) return '';
  const today = data.daily || {};
  const parts = [
    `${data.city}：${data.condition}，${round(data.temp)}°C`,
    `体感 ${round(data.feelsLike)}°C`,
  ];
  if (today.min != null && today.max != null) parts.push(`今天 ${round(today.min)}~${round(today.max)}°C`);
  if (today.precipProbability != null) parts.push(`降水概率 ${Math.round(today.precipProbability)}%`);
  if (data.windSpeed != null) parts.push(`风 ${round(data.windSpeed)} km/h`);
  const advice = weatherAdvice(data);
  return `${parts.join(' · ')}${advice ? `\n${advice}` : ''}`;
}

/** Small, non-nagging suggestions (cold / rain / wind). */
export function weatherAdvice(data) {
  if (!data) return '';
  const notes = [];
  const temp = Number(data.temp);
  const today = data.daily || {};
  if (Number.isFinite(temp) && temp <= 0) notes.push('外面很冷，别逞强，厚外套穿上。');
  else if (Number.isFinite(temp) && temp <= 8) notes.push('有点冷，出门记得加一件。');
  if (Number.isFinite(Number(today.precipProbability)) && Number(today.precipProbability) >= 50) notes.push('可能会下雨/雪，带把伞。');
  if (Number.isFinite(Number(data.windSpeed)) && Number(data.windSpeed) >= 30) notes.push('风不小，注意别被吹透。');
  return notes.join(' ');
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : '?';
}

/**
 * Weather lookups for QQ.
 *
 * Design: the command path takes a **city name**, so it never reads anyone's
 * private location — no permission prompt needed. The owner's own city comes
 * from config and is only used for the autonomous path (checking his weather).
 */
export class WeatherService {
  constructor({ defaultCity = '', cacheMinutes = 10, fetchImpl = fetch, timeoutMs = 8000, logger }) {
    this.defaultCity = String(defaultCity || '').trim();
    this.cacheMinutes = Math.max(1, Number(cacheMinutes) || 10);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 8000);
    this.logger = logger || (() => {});
    this.cache = new Map();
    this.coords = new Map();
  }

  async _json(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'dsh-qq/1.0 (weather)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveCity(city) {
    const name = String(city || '').trim() || this.defaultCity;
    if (!name) throw new Error('没有指定城市');
    const key = name.toLowerCase();
    if (this.coords.has(key)) return this.coords.get(key);
    const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
    const data = await this._json(url);
    const hit = data?.results?.[0];
    if (!hit) throw new Error(`找不到城市「${name}」`);
    const place = {
      name: String(hit.name || name),
      admin: String(hit.admin1 || ''),
      country: String(hit.country || ''),
      latitude: hit.latitude,
      longitude: hit.longitude,
      timezone: hit.timezone || 'auto',
    };
    this.coords.set(key, place);
    return place;
  }

  async get(city, { fresh = false } = {}) {
    const place = await this.resolveCity(city);
    const cacheKey = `${place.latitude},${place.longitude}`;
    const cached = this.cache.get(cacheKey);
    if (!fresh && cached && Date.now() - cached.at < this.cacheMinutes * 60000) {
      return { ...cached.value, cached: true };
    }
    const url = `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}`
      + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max'
      + '&timezone=auto&forecast_days=1';
    const data = await this._json(url);
    const current = data?.current || {};
    const daily = data?.daily || {};
    const value = {
      city: place.admin && place.admin !== place.name ? `${place.admin}·${place.name}` : place.name,
      temp: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      condition: describeCode(current.weather_code),
      windSpeed: current.wind_speed_10m,
      observedAt: current.time || '',
      daily: {
        min: daily.temperature_2m_min?.[0],
        max: daily.temperature_2m_max?.[0],
        precipProbability: daily.precipitation_probability_max?.[0],
        condition: describeCode(daily.weather_code?.[0]),
      },
    };
    this.cache.set(cacheKey, { at: Date.now(), value });
    return { ...value, cached: false };
  }

  /** Convenience: owner's configured city + ready-to-send text. */
  async ownerWeather() {
    const data = await this.get(this.defaultCity);
    return { data, text: formatWeather(data) };
  }

  /** One-liner for QQ messages. */
  format(data) {
    return formatWeather(data);
  }
}
