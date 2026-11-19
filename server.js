require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Configurações da API Prolog (-3 UTC / America/Sao_Paulo)
const BASE_URL = process.env.PROLOG_BASE_URL || 'https://prologapp.com/prolog';
const BRANCH_OFFICE_ID = process.env.BRANCH_OFFICE_ID;
const PROLOG_API_TOKEN = process.env.PROLOG_API_TOKEN;

// Configurações da API SmartGPS (0 UTC)
const SMARTGPS_BASE_URL = process.env.SMARTGPS_BASE_URL || 'https://web.smartgps.com.br';
const SMARTGPS_API_HASH = process.env.SMARTGPS_API_HASH || '';
let currentGpsHash = SMARTGPS_API_HASH;
const SMARTGPS_EMAIL = process.env.SMARTGPS_EMAIL || '';
const SMARTGPS_PASSWORD = process.env.SMARTGPS_PASSWORD || '';

// Tolerância mínima em KM para auditoria entre Odômetro (Prolog) e Histórico GPS (SmartGPS)
const AUDITORIA_TOLERANCIA_KM = Number(process.env.AUDITORIA_TOLERANCIA_KM || 5);

// Controles de Rate Limit para /api/get_history
const HISTORY_DELAY_MS = 1600;       // 1,6s entre cada chamada para evitar erro 429
const MAX_HISTORY_CALLS_PER_RUN = 6; // Máximo de consultas de histórico por ciclo
let rateLimitCooldownUntil = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePlate(plate) {
  if (!plate) return '';
  return String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ─── CONVERSÕES DE FUSO HORÁRIO (SMARTGPS = 0 UTC | PAINEL/PROLOG = -3 UTC) ───

function parseSmartGpsUtcToMs(rawInput) {
  if (rawInput === null || rawInput === undefined || rawInput === '-') return null;

  if (typeof rawInput === 'number' || (!isNaN(Number(rawInput)) && String(rawInput).trim() !== '')) {
    const ts = Number(rawInput);
    return ts < 1e12 ? ts * 1000 : ts;
  }

  const str = String(rawInput).trim();
  if (!str) return null;

  if (str.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  const brMatch = str.match(/^(\d{2})[-/](\d{2})[-/](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (brMatch) {
    const [, dd, mm, yyyy, hh, min, ss = '00'] = brMatch;
    const dUtc = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`);
    return isNaN(dUtc.getTime()) ? null : dUtc.getTime();
  }

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (isoMatch) {
    const [, yyyy, mm, dd, hh, min, ss = '00'] = isoMatch;
    const dUtc = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`);
    return isNaN(dUtc.getTime()) ? null : dUtc.getTime();
  }

  const fallback = new Date(str.replace(' ', 'T') + 'Z');
  return isNaN(fallback.getTime()) ? null : fallback.getTime();
}

function parsePrologTimeToMs(isoInput) {
  if (!isoInput) return null;
  const str = String(isoInput).trim();
  if (str.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const dBrt = new Date(`${str}-03:00`);
  return isNaN(dBrt.getTime()) ? null : dBrt.getTime();
}

function formatEpochToZeroUtc(epochMs) {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${min}`
  };
}

function formatHoraPainelMinus3(isoInput) {
  const ms = parsePrologTimeToMs(isoInput);
  if (ms === null) return null;
  return new Date(ms).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ─── CÁLCULOS GEOGRÁFICOS DE ALTA PRECISÃO (100% SATÉLITE / SEM ODÔMETRO FÍSICO) ───

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function angleDifferenceDeg(course1, course2) {
  if (course1 === null || course2 === null || isNaN(course1) || isNaN(course2)) return 0;
  const diff = Math.abs(course1 - course2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function parseSmartGpsPointTime(pt) {
  if (pt.timestamp !== undefined && pt.timestamp !== null && !isNaN(Number(pt.timestamp))) {
    return parseSmartGpsUtcToMs(Number(pt.timestamp));
  }
  const raw = pt.raw_time || pt.time || pt.dt_tracker || pt.created_at;
  return parseSmartGpsUtcToMs(raw);
}

function extractGpsPointsFromHistory(payload) {
  const points = [];

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      const lat = node.lat !== undefined ? Number(node.lat) : Number(node.latitude);
      const lng = node.lng !== undefined ? Number(node.lng) : Number(node.longitude ?? node.lon);

      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0 && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        let ignition = null;
        if (node.ignition !== undefined) ignition = Boolean(Number(node.ignition));
        else if (node.acc !== undefined) ignition = Boolean(Number(node.acc));

        points.push({
          lat,
          lng,
          timeMs: parseSmartGpsPointTime(node),
          speed: node.speed !== undefined && node.speed !== '-' ? Number(node.speed) : null,
          course: node.course !== undefined && node.course !== '-' ? Number(node.course) : null,
          ignition
        });
      }

      if (Array.isArray(node.items)) walk(node.items);
      if (Array.isArray(node.data)) walk(node.data);
      if (Array.isArray(node.positions)) walk(node.positions);
      if (Array.isArray(node.route)) walk(node.route);
    }
  }

  walk(payload);
  return points;
}

function computePreciseDistanceFromPoints(points, startMs, endMs, marginMs) {
  const hasTimestamps = points.some(p => p.timeMs !== null);
  let filtered = points;

  if (hasTimestamps) {
    filtered = points
      .filter(p => p.timeMs !== null && p.timeMs >= (startMs - marginMs) && p.timeMs <= (endMs + marginMs))
      .sort((a, b) => a.timeMs - b.timeMs);
  }

  let totalKm = 0;

  for (let i = 1; i < filtered.length; i++) {
    const prev = filtered[i - 1];
    const curr = filtered[i];

    // 1. Elimina deriva de GPS parado (velocidade < 3 km/h ou ignição desligada)
    const bothStopped = (prev.speed !== null && curr.speed !== null && prev.speed < 3 && curr.speed < 3);
    const ignitionOff = (prev.ignition === false && curr.ignition === false);
    if (bothStopped || ignitionOff) continue;

    const segKm = haversineDistanceKm(prev.lat, prev.lng, curr.lat, curr.lng);

    // 2. Descarta micro-oscilações (< 20 metros)
    if (segKm < 0.02) continue;

    let hours = 0;
    if (prev.timeMs && curr.timeMs && curr.timeMs > prev.timeMs) {
      hours = (curr.timeMs - prev.timeMs) / 3600000;
      // Descarta saltos inválidos de antena (> 200 km/h)
      if (segKm / hours > 200) continue;
    }

    // 3. Compensação de curvas via variação de rumo (course) + velocidade Doppler
    const turnAngle = angleDifferenceDeg(prev.course, curr.course);
    let curveFactor = 1.0;
    if (turnAngle >= 60) {
      curveFactor = 1.09; // Curva fechada / serra
    } else if (turnAngle >= 25) {
      curveFactor = 1.05; // Curva moderada
    } else if (turnAngle >= 10) {
      curveFactor = 1.02; // Curva leve
    }

    let segmentEstimateKm = segKm * curveFactor;

    // Ponderação com integração trapezoidal da velocidade Doppler em curvas acentuadas com pacotes curtos (<= 2 min)
    if (turnAngle >= 20 && hours > 0 && hours <= (2 / 60) && prev.speed !== null && curr.speed !== null) {
      const avgSpeedKmh = (prev.speed + curr.speed) / 2;
      const speedDistKm = avgSpeedKmh * hours;
      if (speedDistKm >= segKm && speedDistKm <= segKm * 1.25) {
        segmentEstimateKm = (segmentEstimateKm * 0.5) + (speedDistKm * 0.5);
      }
    }

    totalKm += segmentEstimateKm;
  }

  return Number(totalKm.toFixed(1));
}

// --- CACHE PERSISTENTE DE HISTÓRICO & RASTREAMENTO CONTÍNUO DE KM ---
const GPS_CACHE_FILE = path.join(__dirname, 'gps-history-cache.json');
const gpsHistoryCache = new Map();
const liveTelemetryTracker = new Map();

const GPS_HISTORY_ROUTE_TTL_MS = 4 * 60 * 1000;      // 4 min para veículos em rota
const GPS_HISTORY_FINAL_TTL_MS = 12 * 60 * 60 * 1000; // 12h para rotas já encerradas

function loadGpsCacheFromFile() {
  try {
    if (fs.existsSync(GPS_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(GPS_CACHE_FILE, 'utf-8'));
      if (raw.history && typeof raw.history === 'object') {
        for (const [k, v] of Object.entries(raw.history)) {
          gpsHistoryCache.set(k, v);
        }
      }
      if (raw.live && typeof raw.live === 'object') {
        for (const [k, v] of Object.entries(raw.live)) {
          liveTelemetryTracker.set(k, v);
        }
      }
      console.log(`[CACHE GPS] Carregados ${gpsHistoryCache.size} históricos e ${liveTelemetryTracker.size} rastreamentos ativos.`);
    }
  } catch (err) {
    console.warn('[CACHE GPS] Aviso ao ler gps-history-cache.json:', err.message);
  }
}

function saveGpsCacheToFile() {
  try {
    const historyObj = {};
    const now = Date.now();
    for (const [k, v] of gpsHistoryCache.entries()) {
      if (now - (v.fetchedAt || 0) < 24 * 60 * 60 * 1000) {
        historyObj[k] = v;
      }
    }
    const liveObj = {};
    for (const [k, v] of liveTelemetryTracker.entries()) {
      liveObj[k] = v;
    }
    fs.writeFileSync(GPS_CACHE_FILE, JSON.stringify({ history: historyObj, live: liveObj }, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[CACHE GPS] Falha ao salvar gps-history-cache.json:', err.message);
  }
}

loadGpsCacheFromFile();

// Cache de dispositivos SmartGPS (/api/get_devices)
let lastSmartGpsMap = new Map();
let lastSmartGpsFetch = 0;
const SMARTGPS_CACHE_TTL_MS = 25 * 1000;

async function ensureSmartGpsAuth() {
  if (currentGpsHash) return currentGpsHash;
  if (SMARTGPS_EMAIL && SMARTGPS_PASSWORD) {
    try {
      const cleanUrl = `${SMARTGPS_BASE_URL.replace(/\/+$/, '')}/api/login`;
      const res = await axios.post(cleanUrl, {
        email: SMARTGPS_EMAIL,
        password: SMARTGPS_PASSWORD
      }, { timeout: 10000 });
      if (res.data?.status === 1 && res.data?.user_api_hash) {
        currentGpsHash = res.data.user_api_hash;
        console.log('[SmartGPS] 🔑 Login realizado com sucesso via API! Hash obtido.');
        return currentGpsHash;
      }
    } catch (err) {
      console.warn('[SmartGPS] Aviso ao autenticar via e-mail/senha:', err.response?.data?.message || err.message);
    }
  }
  return null;
}

async function getSmartGpsDevicesMap(todayStrMinus3) {
  const hash = await ensureSmartGpsAuth();
  if (!hash) {
    return lastSmartGpsMap;
  }
  if (Date.now() - lastSmartGpsFetch < SMARTGPS_CACHE_TTL_MS && lastSmartGpsMap.size > 0) {
    return lastSmartGpsMap;
  }
  try {
    const cleanUrl = `${SMARTGPS_BASE_URL.replace(/\/+$/, '')}/api/get_devices`;
    const res = await axios.get(cleanUrl, {
      params: {
        user_api_hash: hash,
        ungrouped: 1,
        per_page: 100
      },
      timeout: 10000
    });

    let items = [];
    if (Array.isArray(res.data?.items?.data)) {
      items = res.data.items.data;
    } else if (Array.isArray(res.data?.items)) {
      items = res.data.items;
    } else if (Array.isArray(res.data)) {
      if (res.data.length > 0 && Array.isArray(res.data[0]?.items)) {
        items = res.data.flatMap(g => g.items || []);
      } else {
        items = res.data;
      }
    }

    const newMap = new Map();
    let trackerUpdated = false;

    items.forEach(d => {
      const rawPlate = d.plate_number || d.plate || d.device_data?.plate_number || d.device_data?.plate || '';
      let normPlate = normalizePlate(rawPlate);

      if (!normPlate && d.name) {
        const match = d.name.toUpperCase().match(/[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}/);
        if (match) normPlate = normalizePlate(match[0]);
      }

      if (normPlate) {
        const rawLat = (d.lat !== '-' && d.lat !== undefined && d.lat !== null) ? d.lat : (d.position?.lat ?? d.device_data?.lat);
        const rawLng = (d.lng !== '-' && d.lng !== undefined && d.lng !== null) ? d.lng : (d.position?.lng ?? d.device_data?.lng);
        const rawSpeed = (d.speed !== '-' && d.speed !== undefined && d.speed !== null) ? d.speed : (d.position?.speed ?? d.device_data?.speed);
        const rawCourse = d.course ?? d.position?.course ?? d.device_data?.course ?? null;

        const lat = (rawLat !== null && rawLat !== undefined && rawLat !== '-' && !isNaN(Number(rawLat))) ? Number(rawLat) : null;
        const lng = (rawLng !== null && rawLng !== undefined && rawLng !== '-' && !isNaN(Number(rawLng))) ? Number(rawLng) : null;
        const speed = (rawSpeed !== null && rawSpeed !== undefined && rawSpeed !== '-' && !isNaN(Number(rawSpeed))) ? Math.round(Number(rawSpeed)) : 0;
        const course = (rawCourse !== null && rawCourse !== '-' && !isNaN(Number(rawCourse))) ? Number(rawCourse) : null;

        let isOnline = (d.online === 'online' || d.online === 1 || d.online === true || d.online === '1' || d.conn === 'online');
        const isOffline = (d.online === 'offline' || d.online === 0 || d.online === false || d.online === '0' || d.conn === 'offline');

        const rawTime = d.time || d.last_communication || d.last_update || d.position?.time;
        const lastUpdateMs = parseSmartGpsUtcToMs(rawTime);
        const lastUpdateIso = lastUpdateMs !== null ? new Date(lastUpdateMs).toISOString() : null;

        if (!isOnline && !isOffline && lastUpdateMs !== null) {
          const diffMin = Math.round((Date.now() - lastUpdateMs) / 60000);
          if (diffMin <= 20 || speed > 0) {
            isOnline = true;
          }
        }
        const status = isOnline ? 'online' : 'offline';

        // Rastreamento ao vivo incremental com filtro anti-deriva e compensação de curvas
        if (todayStrMinus3 && lat !== null && lng !== null) {
          const liveKey = `${todayStrMinus3}_${normPlate}`;
          const prev = liveTelemetryTracker.get(liveKey);
          if (!prev) {
            liveTelemetryTracker.set(liveKey, {
              lastLat: lat,
              lastLng: lng,
              lastCourse: course,
              accumulatedKm: 0
            });
            trackerUpdated = true;
          } else if (speed >= 3) {
            const delta = haversineDistanceKm(prev.lastLat, prev.lastLng, lat, lng);
            if (delta >= 0.02 && delta < 50) {
              const turnAngle = angleDifferenceDeg(prev.lastCourse, course);
              const curveFactor = turnAngle >= 60 ? 1.09 : (turnAngle >= 25 ? 1.05 : (turnAngle >= 10 ? 1.02 : 1.0));
              prev.accumulatedKm = Number((prev.accumulatedKm + delta * curveFactor).toFixed(2));
              prev.lastLat = lat;
              prev.lastLng = lng;
              prev.lastCourse = course;
              trackerUpdated = true;
            }
          }
        }

        newMap.set(normPlate, {
          id: d.id,
          imei: d.imei || d.device_data?.imei || '',
          name: d.name || '',
          online: status,
          speed,
          lat,
          lng,
          lastUpdate: lastUpdateIso,
          mapsUrl: (lat !== null && lng !== null) ? `https://www.google.com/maps?q=${lat},${lng}` : null,
          wazeUrl: (lat !== null && lng !== null) ? `https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes` : null
        });
      }
    });

    if (trackerUpdated) {
      saveGpsCacheToFile();
    }

    lastSmartGpsMap = newMap;
    lastSmartGpsFetch = Date.now();
    console.log(`[SmartGPS] 📡 Sincronizados ${newMap.size} dispositivos GPS (0 UTC -> -3 UTC).`);
    return newMap;
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn('[SmartGPS] ⚠️ Erro 401: Token/Hash inválido no SmartGPS.');
      if (SMARTGPS_EMAIL && SMARTGPS_PASSWORD) {
        currentGpsHash = '';
      }
    } else {
      console.warn('[SmartGPS] Falha ao consultar SmartGPS:', err.response?.status || err.message);
    }
    return lastSmartGpsMap;
  }
}

/**
 * Consulta /api/get_history enviando a janela exata em 0 UTC
 * e calcula o deslocamento compensado por curvas e velocidade Doppler.
 */
async function fetchSingleHistoryWithHaversine(deviceId, startIso, endIso, placaLog) {
  const hash = await ensureSmartGpsAuth();
  if (!hash) return { status: 'no_auth', distanceKm: null };

  const startMs = parsePrologTimeToMs(startIso);
  const endMs = endIso ? parsePrologTimeToMs(endIso) : Date.now();
  if (!startMs) return { status: 'invalid_time', distanceKm: null };

  const marginMs = 3 * 60 * 1000;
  const fromUtc = formatEpochToZeroUtc(startMs - marginMs);
  const toUtc = formatEpochToZeroUtc(endMs + marginMs);

  const cleanUrl = `${SMARTGPS_BASE_URL.replace(/\/+$/, '')}/api/get_history`;
  const res = await axios.get(cleanUrl, {
    params: {
      user_api_hash: hash,
      device_id: deviceId,
      from_date: fromUtc.date,
      from_time: fromUtc.time,
      to_date: toUtc.date,
      to_time: toUtc.time
    },
    timeout: 15000
  });

  const rawPoints = extractGpsPointsFromHistory(res.data);
  let distanceKm = null;

  if (rawPoints.length > 0) {
    distanceKm = computePreciseDistanceFromPoints(rawPoints, startMs, endMs, marginMs);
    console.log(`[SmartGPS Preciso] 🛰️ ${placaLog} (${fromUtc.date} ${fromUtc.time}Z -> ${toUtc.time}Z): ${rawPoints.length} pts -> ${distanceKm} km`);
  } else if (res.data?.distance_sum !== undefined && res.data?.distance_sum !== null) {
    const parsed = parseFloat(String(res.data.distance_sum).replace(',', '.').replace(/[^0-9.-]/g, ''));
    if (!isNaN(parsed)) {
      distanceKm = Number(parsed.toFixed(1));
    }
  }

  return { status: 'ok', distanceKm };
}

/**
 * Processa a fila de histórico SEQUENCIALMENTE (1 veículo por vez com pausa),
 * evitando erro 429 e aguardando 3 minutos após o encerramento para chegada do último pacote GPS.
 */
async function resolveGpsDistancesSafely(veiculosKmMap, smartGpsMap, todayStrMinus3) {
  const resultMap = new Map();
  const pendingQueue = [];

  veiculosKmMap.forEach((vKm, placa) => {
    const normPlate = normalizePlate(placa);
    const gpsDevice = smartGpsMap ? smartGpsMap.get(normPlate) : null;
    if (!gpsDevice?.id || !vKm.initialChecklist?.submittedAt) return;

    const startIso = vKm.initialChecklist.submittedAt;
    const endIso = vKm.finalChecklist?.submittedAt || null;
    const isClosed = Boolean(endIso);
    const cacheKey = `${gpsDevice.id}_${startIso}_${endIso || 'open'}`;
    const cached = gpsHistoryCache.get(cacheKey);

    // Aguarda 3 minutos após o checklist final para garantir a chegada do último pacote GPS
    // e congela o resultado por 12h, poupando o limite de requisições da SmartGPS.
    const endMs = endIso ? parsePrologTimeToMs(endIso) : null;
    const awaitingLastPacket = isClosed && endMs && (Date.now() - endMs < 3 * 60 * 1000);
    const ttl = (isClosed && !awaitingLastPacket)
      ? GPS_HISTORY_FINAL_TTL_MS
      : GPS_HISTORY_ROUTE_TTL_MS;

    if (cached && (Date.now() - cached.fetchedAt < ttl)) {
      resultMap.set(placa, cached.distanceKm);
      return;
    }

    if (cached && cached.distanceKm !== null) {
      resultMap.set(placa, cached.distanceKm);
    } else {
      const live = liveTelemetryTracker.get(`${todayStrMinus3}_${normPlate}`);
      if (live && live.accumulatedKm > 0) {
        resultMap.set(placa, Number(live.accumulatedKm.toFixed(1)));
      }
    }

    pendingQueue.push({
      placa,
      deviceId: gpsDevice.id,
      startIso,
      endIso,
      isClosed,
      cacheKey,
      priority: isClosed ? 1 : 2
    });
  });

  if (pendingQueue.length === 0) return resultMap;

  if (Date.now() < rateLimitCooldownUntil) {
    const secsLeft = Math.ceil((rateLimitCooldownUntil - Date.now()) / 1000);
    console.log(`[SmartGPS] ⏳ Em pausa preventiva anti-429 (${secsLeft}s restantes). Usando cache/telemetria ao vivo.`);
    return resultMap;
  }

  pendingQueue.sort((a, b) => a.priority - b.priority);
  const batch = pendingQueue.slice(0, MAX_HISTORY_CALLS_PER_RUN);
  let cacheChanged = false;

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    try {
      const res = await fetchSingleHistoryWithHaversine(item.deviceId, item.startIso, item.endIso, item.placa);
      if (res.status === 'ok' && res.distanceKm !== null) {
        gpsHistoryCache.set(item.cacheKey, {
          distanceKm: res.distanceKm,
          fetchedAt: Date.now(),
          closed: item.isClosed
        });
        resultMap.set(item.placa, res.distanceKm);
        cacheChanged = true;
      }
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn(`[SmartGPS] ⚠️ Limite 429 atingido na placa ${item.placa}. Pausando consultas de histórico por 2 minutos.`);
        rateLimitCooldownUntil = Date.now() + 2 * 60 * 1000;
        break;
      } else {
        console.warn(`[SmartGPS] Aviso ao consultar histórico (${item.placa}):`, err.response?.status || err.message);
      }
    }

    if (i < batch.length - 1) {
      await sleep(HISTORY_DELAY_MS);
    }
  }

  if (cacheChanged) {
    saveGpsCacheToFile();
  }

  return resultMap;
}

// IDs dos formulários para controle de KM diário
const INITIAL_KM_FORM_IDS = new Set([15810, 15813, 16552]); // Checklists de Saída (Inicial)
const FINAL_KM_FORM_ID = 16607;                              // Checklist de Encerramento (Final)

function calcularKmVeiculo(vKm, gpsDistanceKm = null) {
  if (!vKm) {
    return {
      kmInicial: null,
      kmAtualizado: null,
      kmFinal: null,
      kmRodada: null,
      gpsKmRodado: null,
      auditoriaStatus: 'sem_dados',
      auditoriaDiff: null,
      statusKm: 'sem_saida',
      horaInicial: null,
      horaFinal: null
    };
  }

  const kmInicial = vKm.initialChecklist?.odometer ?? null;
  const kmFinal = vKm.finalChecklist?.odometer ?? null;
  const gpsKm = (gpsDistanceKm !== null && !isNaN(gpsDistanceKm)) ? Number(gpsDistanceKm.toFixed(1)) : null;

  const kmAtualizado = (kmInicial !== null && gpsKm !== null)
    ? Number((kmInicial + gpsKm).toFixed(1))
    : kmInicial;

  let kmRodada = null;
  let statusKm = 'sem_saida';
  let auditoriaStatus = 'pendente';
  let auditoriaDiff = null;

  if (kmInicial !== null && kmFinal !== null) {
    kmRodada = Number((kmFinal - kmInicial).toFixed(1));
    statusKm = kmRodada >= 0 ? 'finalizado' : 'inconsistente';

    if (gpsKm !== null) {
      auditoriaDiff = Number((kmRodada - gpsKm).toFixed(1));
      // Tolerância dinâmica: usa o maior valor entre AUDITORIA_TOLERANCIA_KM (ex: 5 km) ou 4% do KM rodado
      const toleranciaDinamica = Math.max(AUDITORIA_TOLERANCIA_KM, Number((kmRodada * 0.04).toFixed(1)));
      auditoriaStatus = Math.abs(auditoriaDiff) <= toleranciaDinamica ? 'ok' : 'divergente';
    } else {
      auditoriaStatus = 'sem_gps';
    }
  } else if (kmInicial !== null) {
    statusKm = 'em_rota';
    auditoriaStatus = gpsKm !== null ? 'em_monitoramento' : 'sem_gps';
  } else if (kmFinal !== null) {
    statusKm = 'sem_inicial';
    auditoriaStatus = 'divergente';
  }

  return {
    kmInicial,
    kmAtualizado,
    kmFinal,
    kmRodada,
    gpsKmRodado: gpsKm,
    auditoriaStatus,
    auditoriaDiff,
    statusKm,
    horaInicial: formatHoraPainelMinus3(vKm.initialChecklist?.submittedAt),
    horaFinal: formatHoraPainelMinus3(vKm.finalChecklist?.submittedAt)
  };
}

let cachedDashboardData = null;

// --- SISTEMA DE CACHE PERSISTENTE DE USUÁRIOS E TELEFONES ---
const USERS_CACHE_FILE = path.join(__dirname, 'users-cache.json');
const USERS_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedUsersList = [];
let lastUsersFetch = 0;
const userPhoneCache = new Map();

function loadUserCacheFromFile() {
  try {
    if (fs.existsSync(USERS_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_CACHE_FILE, 'utf-8'));
      if (data.phones && typeof data.phones === 'object') {
        for (const [id, phone] of Object.entries(data.phones)) {
          userPhoneCache.set(Number(id), phone);
        }
      }
      if (Array.isArray(data.users) && data.users.length > 0) {
        cachedUsersList = data.users;
      }
      if (data.lastUsersFetch) {
        lastUsersFetch = data.lastUsersFetch;
      }
      console.log(`[CACHE LOCAL] Carregados ${userPhoneCache.size} telefones e ${cachedUsersList.length} usuários de users-cache.json.`);
    }
  } catch (err) {
    console.warn('[CACHE LOCAL] Aviso ao ler users-cache.json:', err.message);
  }
}

function saveUserCacheToFile() {
  try {
    const phonesObj = {};
    for (const [id, phone] of userPhoneCache.entries()) {
      phonesObj[id] = phone;
    }
    const payload = {
      lastUsersFetch,
      users: cachedUsersList,
      phones: phonesObj
    };
    fs.writeFileSync(USERS_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[CACHE LOCAL] Falha ao salvar users-cache.json:', err.message);
  }
}

loadUserCacheFromFile();

function formatPhoneNumber(phone) {
  if (!phone || phone === 'Sem número') return phone;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) {
    digits = digits.substring(2);
  }
  if (digits.length === 11) {
    return `(${digits.substring(0, 2)}) ${digits.substring(2, 7)}-${digits.substring(7)}`;
  } else if (digits.length === 10) {
    return `(${digits.substring(0, 2)}) ${digits.substring(2, 6)}-${digits.substring(6)}`;
  }
  return phone;
}

async function updateDashboardCache() {
  try {
    const now = new Date();
    const todayStrMinus3 = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
    const startOfDayMinus3Ms = new Date(`${todayStrMinus3}T00:00:00-03:00`).getTime();

    const endDateTodayUtc = new Date(startOfDayMinus3Ms + 24 * 60 * 60 * 1000 - 1000).toISOString();

    // Janela de 7 dias para identificar motoristas ativos na operação
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const startDate7Days = `${sevenDaysAgo}T00:00:00Z`;

    const headers = { 'x-prolog-api-token': PROLOG_API_TOKEN };

    console.log(`[${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] 🔄 [ROTINA] Sincronizando frotas, checklists (-3 UTC) e GPS (0 UTC)...`);

    const shouldFetchUsers = (Date.now() - lastUsersFetch > USERS_CACHE_TTL_MS) || cachedUsersList.length === 0;
    const usersPromise = shouldFetchUsers
      ? axios.get(`${BASE_URL}/api/v3/users`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, active: true, pageSize: 100, pageNumber: 0 } })
          .then(res => {
            if (res.data?.content) {
              cachedUsersList = res.data.content;
              lastUsersFetch = Date.now();
              saveUserCacheToFile();
              console.log(`[CACHE LOCAL] Lista de ${cachedUsersList.length} usuários atualizada da API Prolog.`);
            }
            return res;
          })
          .catch(err => {
            console.error('[ERRO Usuários]', err.response?.status || err.message);
            return { data: { content: cachedUsersList } };
          })
      : Promise.resolve({ data: { content: cachedUsersList } });

    const [branchRes, usersRes, checklistsRes, vehiclesRes, smartGpsMap] = await Promise.all([
      axios.get(`${BASE_URL}/api/v3/branch-offices/${BRANCH_OFFICE_ID}`, { headers }).catch(err => { console.error('[ERRO Filial]', err.response?.status || err.message); return { data: null }; }),
      usersPromise,
      axios.get(`${BASE_URL}/api/v3/checklists`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, startDate: startDate7Days, endDate: endDateTodayUtc, includeAnswers: true, pageSize: 100, pageNumber: 0 } }).catch(err => { console.error('[ERRO Checklists]', err.response?.status || err.message); return { data: null }; }),
      axios.get(`${BASE_URL}/api/v3/vehicles`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, active: true, pageSize: 100, pageNumber: 0 } }).catch(err => { console.error('[ERRO Veículos]', err.response?.status || err.message); return { data: null }; }),
      getSmartGpsDevicesMap(todayStrMinus3)
    ]);

    if (!checklistsRes.data && !vehiclesRes.data && cachedDashboardData) {
      console.warn(`[${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] ⚠️ API indisponível ou limite atingido. Mantendo cache anterior.`);
      return;
    }

    const branchName = branchRes.data?.name || 'Filial Matriz';
    const allUsers = usersRes.data?.content || cachedUsersList || [];
    const operationalUsers = allUsers.filter(u => !(u.roleName || '').toLowerCase().includes('gestor'));

    const allChecklists = checklistsRes.data?.content || [];
    const checklistsHoje = allChecklists
      .filter(c => {
        const subMs = parsePrologTimeToMs(c.submittedAt);
        return subMs !== null && subMs >= startOfDayMinus3Ms;
      })
      .sort((a, b) => (parsePrologTimeToMs(a.submittedAt) || 0) - (parsePrologTimeToMs(b.submittedAt) || 0));

    const usuariosComChecklistHojeSet = new Set();
    const placasComChecklistHoje = new Set();

    checklistsHoje.forEach(c => {
      if (c.submittedBy?.id) usuariosComChecklistHojeSet.add(c.submittedBy.id);
      const placaLimpa = (c.vehicle?.licensePlate || '').trim();
      if (placaLimpa) placasComChecklistHoje.add(placaLimpa);
    });

    // --- TELEFONES SEQUENCIAIS COM CACHE ---
    const neededUserIds = new Set();
    operationalUsers.forEach(u => neededUserIds.add(u.id));
    checklistsHoje.forEach(c => {
      if (c.submittedBy?.id) neededUserIds.add(c.submittedBy.id);
    });

    const missingIds = Array.from(neededUserIds).filter(id => !userPhoneCache.has(id));
    if (missingIds.length > 0) {
      console.log(`[ROTINA] Obtendo telefones para ${missingIds.length} funcionários ausentes na cache...`);
      let novosTelefonesSalvos = false;

      for (const id of missingIds) {
        try {
          const userRes = await axios.get(`${BASE_URL}/api/v3/users/${id}`, { headers });
          const rawPhone = userRes.data?.phone || 'Sem número';
          userPhoneCache.set(id, formatPhoneNumber(rawPhone));
          novosTelefonesSalvos = true;
        } catch (err) {
          if (err.response?.status === 429) {
            console.warn(`[AVISO] Rate limit (429) atingido na busca de telefones. Pausando busca temporariamente.`);
            break;
          } else {
            userPhoneCache.set(id, 'Sem número');
            novosTelefonesSalvos = true;
          }
        }
        await sleep(500);
      }

      if (novosTelefonesSalvos) {
        saveUserCacheToFile();
      }
    }

    // --- CONTROLE DE KM DIÁRIO ---
    const veiculosKmMap = new Map();

    checklistsHoje.forEach(c => {
      const placa = (c.vehicle?.licensePlate || '').trim();
      if (!placa) return;

      if (!veiculosKmMap.has(placa)) {
        veiculosKmMap.set(placa, {
          placa,
          modelo: c.vehicle?.modelName || '',
          initialChecklist: null,
          finalChecklist: null
        });
      }

      const vKm = veiculosKmMap.get(placa);
      if (!vKm.modelo && c.vehicle?.modelName) vKm.modelo = c.vehicle.modelName;

      const odom = (c.odometerReading !== null && c.odometerReading !== undefined && !isNaN(Number(c.odometerReading))) ? Number(c.odometerReading) : null;

      if (INITIAL_KM_FORM_IDS.has(c.checklistFormId) && odom !== null) {
        if (!vKm.initialChecklist) {
          vKm.initialChecklist = {
            odometer: odom,
            submittedAt: c.submittedAt,
            submittedBy: c.submittedBy?.name || '',
            userId: c.submittedBy?.id,
            formId: c.checklistFormId,
            formName: c.checklistFormName
          };
        }
      }

      if (c.checklistFormId === FINAL_KM_FORM_ID && odom !== null) {
        vKm.finalChecklist = {
          odometer: odom,
          submittedAt: c.submittedAt,
          submittedBy: c.submittedBy?.name || '',
          userId: c.submittedBy?.id,
          formId: c.checklistFormId,
          formName: c.checklistFormName
        };
      }
    });

    // --- CONSULTA HISTÓRICO DE COORDENADAS COM FILA ANTI-429 E JANELA 0 UTC ---
    const gpsDistanceByPlate = await resolveGpsDistancesSafely(veiculosKmMap, smartGpsMap, todayStrMinus3);

    // --- CACHE CENTRAL DE CÁLCULO DE KM & AUDITORIA POR PLACA ---
    const kmCalculadoCache = new Map();
    const getKm = (placa) => {
      if (!kmCalculadoCache.has(placa)) {
        const vKm = veiculosKmMap.get(placa);
        const gpsDist = gpsDistanceByPlate.has(placa) ? gpsDistanceByPlate.get(placa) : null;
        kmCalculadoCache.set(placa, calcularKmVeiculo(vKm, gpsDist));
      }
      return kmCalculadoCache.get(placa);
    };

    let totalKmRodado = 0;
    let totalKmGpsEmRota = 0;
    let veiculosEmRota = 0;
    let veiculosFinalizados = 0;
    let divergenciasAuditoria = 0;
    const kmControleList = [];

    veiculosKmMap.forEach((vKm, placa) => {
      const km = getKm(placa);

      if (km.statusKm === 'finalizado') {
        totalKmRodado += km.kmRodada;
        veiculosFinalizados++;
      } else if (km.statusKm === 'em_rota') {
        veiculosEmRota++;
        if (km.gpsKmRodado !== null) {
          totalKmGpsEmRota += km.gpsKmRodado;
        }
      }

      if (km.auditoriaStatus === 'divergente') {
        divergenciasAuditoria++;
      }

      const motorista = vKm.finalChecklist?.submittedBy || vKm.initialChecklist?.submittedBy || 'Motorista';
      const userId = vKm.finalChecklist?.userId || vKm.initialChecklist?.userId;
      const telefone = userId ? (userPhoneCache.get(userId) || '') : '';
      const gps = smartGpsMap ? smartGpsMap.get(normalizePlate(placa)) : null;

      kmControleList.push({
        placa,
        modelo: vKm.modelo,
        motorista,
        telefone,
        gps: gps || null,
        ...km
      });
    });

    const userLastChecklistMap = new Map();
    allChecklists.forEach(c => {
      const userId = c.submittedBy?.id;
      const subMs = parsePrologTimeToMs(c.submittedAt);
      if (userId && subMs !== null) {
        const currentLast = userLastChecklistMap.get(userId);
        if (!currentLast || subMs > currentLast) {
          userLastChecklistMap.set(userId, subMs);
        }
      }
    });

    const naoRealizaramList = operationalUsers
      .filter(u => !usuariosComChecklistHojeSet.has(u.id))
      .filter(u => userLastChecklistMap.has(u.id))
      .map(u => {
        const lastMs = userLastChecklistMap.get(u.id);
        let ultimoStr = '—';
        if (lastMs) {
          ultimoStr = new Date(lastMs).toLocaleDateString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit',
            month: '2-digit'
          });
        }
        return {
          nome: u.name || 'Funcionário',
          telefone: userPhoneCache.get(u.id) || '',
          ultimo: ultimoStr
        };
      });

    // --- POPULA O MAPA COM OS VEÍCULOS DA FROTA ---
    const veiculosMap = new Map();
    const rawVehicles = vehiclesRes.data;
    const vehiclesList = Array.isArray(rawVehicles) ? rawVehicles : (rawVehicles?.content || rawVehicles?.items || []);

    vehiclesList.forEach(v => {
      const placa = (v.licensePlate || v.plate || v.placa || '').trim();
      if (placa) {
        const gps = smartGpsMap ? smartGpsMap.get(normalizePlate(placa)) : null;
        veiculosMap.set(placa, {
          placa: placa,
          modelo: v.model?.name || v.modelName || '',
          tipo: v.type?.name || v.vehicleTypeName || 'car',
          alta: 0,
          fezHoje: placasComChecklistHoje.has(placa),
          gps: gps || null,
          ...getKm(placa)
        });
      }
    });

    // --- SOMA AS ANOMALIAS DE ALTA PRIORIDADE AOS VEÍCULOS ---
    checklistsHoje.forEach(c => {
      const placa = (c.vehicle?.licensePlate || '').trim();
      if (!placa) return;

      const altaIssues = (c.totalIssuesCriticalPriority || 0) + (c.totalIssuesHighPriority || 0);
      const km = getKm(placa);
      const gps = smartGpsMap ? smartGpsMap.get(normalizePlate(placa)) : null;

      if (!veiculosMap.has(placa)) {
        veiculosMap.set(placa, {
          placa,
          modelo: c.vehicle?.modelName || '',
          tipo: c.vehicle?.vehicleTypeName || 'car',
          alta: altaIssues,
          fezHoje: placasComChecklistHoje.has(placa),
          gps: gps || null,
          ...km
        });
      } else {
        const v = veiculosMap.get(placa);
        v.alta += altaIssues;
        if (!v.modelo && c.vehicle?.modelName) v.modelo = c.vehicle.modelName;
        if (placasComChecklistHoje.has(placa)) v.fezHoje = true;
        if (gps && !v.gps) v.gps = gps;
        Object.assign(v, km);
      }
    });

    let totalAlta = 0;
    Array.from(veiculosMap.values()).forEach(v => {
      totalAlta += v.alta;
    });

    // Alinha os KPIs ao mesmo recorte de 7 dias da lista naoRealizaramList
    const motoristasAtivos = operationalUsers.filter(
      u => usuariosComChecklistHojeSet.has(u.id) || userLastChecklistMap.has(u.id)
    );

    const totalActiveUsers = motoristasAtivos.length;
    const realizaramCount = usuariosComChecklistHojeSet.size;
    const semChecklistCount = Math.max(0, totalActiveUsers - realizaramCount);
    const conformidadePct = totalActiveUsers > 0
      ? Math.min(100, Math.round((realizaramCount / totalActiveUsers) * 100))
      : (checklistsHoje.length > 0 ? 100 : 0);

    const totalKmCombinado = Math.round(totalKmRodado + totalKmGpsEmRota);
    const veiculosComKmAtivo = veiculosFinalizados + kmControleList.filter(v => v.statusKm === 'em_rota' && (v.gpsKmRodado || 0) > 0).length;
    const mediaKmCalculada = veiculosComKmAtivo > 0
      ? Math.round((totalKmRodado + totalKmGpsEmRota) / veiculosComKmAtivo)
      : 0;

    cachedDashboardData = {
      branchName,
      smartGps: {
        configured: Boolean(currentGpsHash || SMARTGPS_API_HASH || (SMARTGPS_EMAIL && SMARTGPS_PASSWORD)),
        connected: smartGpsMap ? smartGpsMap.size > 0 : false,
        totalDevices: smartGpsMap ? smartGpsMap.size : 0,
        toleranciaAuditoriaKm: AUDITORIA_TOLERANCIA_KM
      },
      kpis: {
        checklistsHoje: checklistsHoje.length,
        semChecklist: semChecklistCount,
        conformidade: conformidadePct,
        osAlta: totalAlta,
        totalKmRodado: totalKmCombinado,
        totalKmConcluidos: Math.round(totalKmRodado),
        totalKmEmRotaGps: Math.round(totalKmGpsEmRota),
        veiculosEmRota,
        veiculosFinalizados,
        divergenciasAuditoria,
        veiculosSemChecklist: Math.max(0, vehiclesList.length - placasComChecklistHoje.size),
        mediaKmPorVeiculo: mediaKmCalculada,
        funcionariosAtivos: motoristasAtivos.length
      },
      kmControle: kmControleList.sort((a, b) => {
        const prioridade = { em_rota: 1, inconsistente: 2, sem_inicial: 3, finalizado: 4, sem_saida: 5 };
        return (prioridade[a.statusKm] || 99) - (prioridade[b.statusKm] || 99);
      }),
      realizaram: checklistsHoje.map(c => {
        const isInitial = INITIAL_KM_FORM_IDS.has(c.checklistFormId);
        const isFinal = c.checklistFormId === FINAL_KM_FORM_ID;
        let kmTipo = '';
        if (isInitial && c.odometerReading) kmTipo = `Saída (${Number(c.odometerReading).toLocaleString('pt-BR')} km)`;
        else if (isFinal && c.odometerReading) kmTipo = `Retorno (${Number(c.odometerReading).toLocaleString('pt-BR')} km)`;

        return {
          nome: c.submittedBy?.name || 'Motorista',
          telefone: (c.submittedBy?.id ? userPhoneCache.get(c.submittedBy.id) : '') || '',
          placa: (c.vehicle?.licensePlate || 'N/A').trim(),
          hora: formatHoraPainelMinus3(c.submittedAt) || '--:--',
          formName: c.checklistFormName || '',
          formId: c.checklistFormId,
          kmTipo
        };
      }),
      naoRealizaram: naoRealizaramList,
      veiculos: Array.from(veiculosMap.values()).sort((a, b) => (b.alta - a.alta) || (b.fezHoje - a.fezHoje))
    };

    console.log(`[${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] ✅ Cache atualizada. Veículos: ${veiculosMap.size} | KM Total (Final+GPS): ${totalKmCombinado} km`);
  } catch (error) {
    console.error('[ERRO AO ATUALIZAR CACHE]', error.message);
  }
}

updateDashboardCache();
setInterval(updateDashboardCache, 30 * 1000);

app.get('/api/dashboard-data', (req, res) => {
  if (!cachedDashboardData) return res.status(503).json({ error: 'Sincronizando dados, aguarde...' });
  res.json(cachedDashboardData);
});

app.get('/api/refresh-users', async (req, res) => {
  try {
    lastUsersFetch = 0;
    await updateDashboardCache();
    res.json({
      status: 'ok',
      mensagem: 'Cache de usuários revalidado com sucesso',
      totalUsuarios: cachedUsersList.length,
      totalTelefones: userPhoneCache.size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));