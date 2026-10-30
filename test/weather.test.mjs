import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherService, describeCode, formatWeather, weatherAdvice } from '../lib/weather.js';

function stubFetch(routes) {
  return async (url) => {
    for (const [pattern, body] of routes) {
      if (String(url).includes(pattern)) {
        return { ok: true, json: async () => body };
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('weather codes and formatting stay readable', () => {
  assert.equal(describeCode(0), '晴');
  assert.equal(describeCode(61), '小雨');
  assert.equal(describeCode(999), '天气码 999');

  const text = formatWeather({
    city: '示例省·示例市',
    condition: '阴',
    temp: 4.6,
    feelsLike: 0.1,
    windSpeed: 11,
    daily: { min: 1.6, max: 8.6, precipProbability: 5 },
  });
  assert.ok(text.includes('示例市'));
  assert.ok(text.includes('阴'));
  assert.ok(text.includes('5°C'));
  assert.ok(text.includes('2~9°C'));
  assert.ok(text.includes('加一件'));
  assert.equal(weatherAdvice({ temp: 20 }), '');
});

test('service geocodes once, predicts, and caches', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).includes('geocoding')) {
      return {
        ok: true,
        json: async () => ({ results: [{ name: '示例市', admin1: '示例省', country: '中国', latitude: 45.75, longitude: 126.65, timezone: 'Asia/Shanghai' }] }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        current: { temperature_2m: -3, apparent_temperature: -8, weather_code: 71, wind_speed_10m: 20, time: '2026-10-20T18:30' },
        daily: { weather_code: [71], temperature_2m_min: [-9], temperature_2m_max: [-1], precipitation_probability_max: [70] },
      }),
    };
  };
  const weather = new WeatherService({ defaultCity: '示例市', fetchImpl });
  const first = await weather.get();
  assert.equal(first.temp, -3);
  assert.equal(first.condition, '小雪');
  assert.equal(first.cached, false);
  const second = await weather.get();
  assert.equal(second.cached, true);
  assert.equal(calls, 2, '地理编码与预报各一次，第二次命中缓存');
});

test('unknown city raises a clear error', async () => {
  const weather = new WeatherService({
    defaultCity: '不存在市',
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }),
  });
  await assert.rejects(() => weather.get('不存在市'), /找不到城市/);
});
