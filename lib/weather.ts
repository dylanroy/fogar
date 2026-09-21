/** Open-Meteo: no key, no account, CORS enabled. The one third party a widget talks to, and only if the user adds it. */
export interface Place { name: string; region: string; country: string; lat: number; lon: number }
export interface Forecast {
  current: { temp: number; code: number; wind: number };
  daily: Array<{ date: string; hi: number; lo: number; code: number }>;
  unit: 'c' | 'f';
  fetchedAt: number;
}

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

export async function geocode(query: string, endpoint = GEOCODE): Promise<Place[]> {
  const res = await fetch(`${endpoint}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`);
  if (!res.ok) throw new Error(`Geocoding returned ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).map((r: any) => ({ name: r.name, region: r.admin1 ?? '', country: r.country ?? '', lat: r.latitude, lon: r.longitude }));
}

export async function fetchForecast(lat: number, lon: number, unit: 'c' | 'f', endpoint = FORECAST): Promise<Forecast> {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'auto', forecast_days: '4',
    current: 'temperature_2m,weather_code,wind_speed_10m', daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    temperature_unit: unit === 'f' ? 'fahrenheit' : 'celsius', wind_speed_unit: unit === 'f' ? 'mph' : 'kmh',
  });
  const res = await fetch(`${endpoint}?${q}`);
  if (!res.ok) throw new Error(`Forecast returned ${res.status}`);
  const d = await res.json();
  return {
    current: { temp: Math.round(d.current.temperature_2m), code: d.current.weather_code, wind: Math.round(d.current.wind_speed_10m) },
    daily: (d.daily.time as string[]).map((date, i) => ({ date, hi: Math.round(d.daily.temperature_2m_max[i]), lo: Math.round(d.daily.temperature_2m_min[i]), code: d.daily.weather_code[i] })),
    unit, fetchedAt: Date.now(),
  };
}

/** WMO weather interpretation codes, the way Open-Meteo reports them. */
export function describeWeather(code: number): { label: string; icon: string } {
  if (code === 0) return { label: 'Clear', icon: '☀️' };
  if (code <= 2) return { label: 'Partly cloudy', icon: '⛅' };
  if (code === 3) return { label: 'Overcast', icon: '☁️' };
  if (code <= 48) return { label: 'Fog', icon: '🌫️' };
  if (code <= 57) return { label: 'Drizzle', icon: '🌦️' };
  if (code <= 67) return { label: 'Rain', icon: '🌧️' };
  if (code <= 77) return { label: 'Snow', icon: '🌨️' };
  if (code <= 82) return { label: 'Showers', icon: '🌧️' };
  if (code <= 86) return { label: 'Snow showers', icon: '🌨️' };
  return { label: 'Thunderstorm', icon: '⛈️' };
}

export const defaultUnit = (): 'c' | 'f' => (/-(US|LR|MM)$/i.test(navigator.language) ? 'f' : 'c');
