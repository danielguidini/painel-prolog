require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Configurações da API Prolog
const BASE_URL = process.env.PROLOG_BASE_URL || 'https://prologapp.com/prolog';
const BRANCH_OFFICE_ID = process.env.BRANCH_OFFICE_ID;
const PROLOG_API_TOKEN = process.env.PROLOG_API_TOKEN;

// Configurações da API SmartGPS
const SMARTGPS_BASE_URL = process.env.SMARTGPS_BASE_URL || 'https://web.smartgps.com.br';
const SMARTGPS_API_HASH = process.env.SMARTGPS_API_HASH || '';
let currentGpsHash = SMARTGPS_API_HASH;
const SMARTGPS_EMAIL = process.env.SMARTGPS_EMAIL || '';
const SMARTGPS_PASSWORD = process.env.SMARTGPS_PASSWORD || '';

// Tolerância em KM para auditoria entre Odômetro (Prolog) e Histórico GPS (SmartGPS)
const AUDITORIA_TOLERANCIA_KM = Number(process.env.AUDITORIA_TOLERANCIA_KM || 5);

// Função auxiliar para normalizar placa (remove traços, espaços e caracteres especiais)
function normalizePlate(plate) {
  if (!plate) return '';
  return String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Formata ISO timestamp para data (YYYY-MM-DD) e hora (HH:mm) no fuso de Brasília
function formatDateTimeForGps(isoString) {
  const dateObj = isoString ? new Date(isoString) : new Date();
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj);

  const timeStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(dateObj);

  return { date: dateStr, time: timeStr };
}

// Cache de dados de telemetria SmartGPS (/api/get_devices)
let lastSmartGpsMap = new Map();
let lastSmartGpsFetch = 0;
const SMARTGPS_CACHE_TTL_MS = 25 * 1000; // 25s

// Cache de histórico de deslocamento SmartGPS (/api/get_history)
const gpsHistoryCache = new Map();
const GPS_HISTORY_ROUTE_TTL_MS = 2 * 60 * 1000; // 2 min para veículos em rota
const GPS_HISTORY_FINAL_TTL_MS = 30 * 60 * 1000; // 30 min para rotas já finalizadas

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

async function getSmartGpsDevicesMap() {
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

        const lat = (rawLat !== null && rawLat !== undefined && rawLat !== '-' && !isNaN(Number(rawLat))) ? Number(rawLat) : null;
        const lng = (rawLng !== null && rawLng !== undefined && rawLng !== '-' && !isNaN(Number(rawLng))) ? Number(rawLng) : null;
        const speed = (rawSpeed !== null && rawSpeed !== undefined && rawSpeed !== '-' && !isNaN(Number(rawSpeed))) ? Math.round(Number(rawSpeed)) : 0;

        let isOnline = (d.online === 'online' || d.online === 1 || d.online === true || d.online === '1' || d.conn === 'online');
        const isOffline = (d.online === 'offline' || d.online === 0 || d.online === false || d.online === '0' || d.conn === 'offline');

        const rawTime = d.time || d.last_communication || d.last_update || d.position?.time;
        if (!isOnline && !isOffline && rawTime && rawTime !== '-') {
          const dateUtc = new Date(String(rawTime).replace(' ', 'T') + 'Z');
          if (!isNaN(dateUtc.getTime())) {
            const diffMin = Math.round((Date.now() - dateUtc.getTime()) / 60000);
            if (diffMin <= 20 || speed > 0) {
              isOnline = true;
            }
          }
        }
        const status = isOnline ? 'online' : 'offline';

        newMap.set(normPlate, {
          id: d.id,
          imei: d.imei || d.device_data?.imei || '',
          name: d.name || '',
          online: status,
          speed,
          lat,
          lng,
          lastUpdate: rawTime && rawTime !== '-' ? rawTime : null,
          mapsUrl: (lat !== null && lng !== null) ? `https://www.google.com/maps?q=${lat},${lng}` : null,
          wazeUrl: (lat !== null && lng !== null) ? `https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes` : null
        });
      }
    });

    lastSmartGpsMap = newMap;
    lastSmartGpsFetch = Date.now();
    console.log(`[SmartGPS] 📡 Sincronizados ${newMap.size} dispositivos GPS.`);
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
 * Consulta o deslocamento (em KM) na API SmartGPS (/api/get_history)
 * desde o horário do checklist inicial até o checklist final (ou momento atual).
 */
async function getSmartGpsHistoryDistance(deviceId, startIso, endIso = null) {
  if (!deviceId || !startIso) return null;

  const hash = await ensureSmartGpsAuth();
  if (!hash) return null;

  const isClosed = Boolean(endIso);
  const cacheKey = `${deviceId}_${startIso}_${endIso || 'open'}`;
  const cached = gpsHistoryCache.get(cacheKey);
  const ttl = isClosed ? GPS_HISTORY_FINAL_TTL_MS : GPS_HISTORY_ROUTE_TTL_MS;

  if (cached && (Date.now() - cached.fetchedAt < ttl)) {
    return cached.distanceKm;
  }

  try {
    const startFmt = formatDateTimeForGps(startIso);
    const endFmt = formatDateTimeForGps(endIso || new Date().toISOString());

    const cleanUrl = `${SMARTGPS_BASE_URL.replace(/\/+$/, '')}/api/get_history`;
    const res = await axios.get(cleanUrl, {
      params: {
        user_api_hash: hash,
        device_id: deviceId,
        from_date: startFmt.date,
        from_time: startFmt.time,
        to_date: endFmt.date,
        to_time: endFmt.time
      },
      timeout: 12000
    });

    const data = res.data || {};
    let distanceKm = null;

    // 1. Tenta extrair diretamente de distance_sum (ex: "42.85 Km" ou 42.85)
    if (data.distance_sum !== undefined && data.distance_sum !== null) {
      const cleaned = String(data.distance_sum).replace(',', '.').replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) {
        distanceKm = Number(parsed.toFixed(1));
      }
    }

    // 2. Fallback: soma os trechos de deslocamento (status === 1) no array items
    if (distanceKm === null && Array.isArray(data.items)) {
      let total = 0;
      let hasSegment = false;
      data.items.forEach(seg => {
        if (seg.distance !== undefined && seg.distance !== null) {
          const segDist = parseFloat(String(seg.distance).replace(',', '.').replace(/[^0-9.-]/g, ''));
          if (!isNaN(segDist)) {
            total += segDist;
            hasSegment = true;
          }
        }
      });
      if (hasSegment) {
        distanceKm = Number(total.toFixed(1));
      }
    }

    if (distanceKm !== null) {
      gpsHistoryCache.set(cacheKey, { distanceKm, fetchedAt: Date.now() });
    }
    return distanceKm;
  } catch (err) {
    console.warn(`[SmartGPS] Falha ao obter histórico do device ${deviceId}:`, err.response?.status || err.message);
    return cached ? cached.distanceKm : null;
  }
}

// IDs dos formulários para controle de KM diário
const INITIAL_KM_FORM_IDS = new Set([15810, 15813, 16552]); // Checklists de Saída (Inicial)
const FINAL_KM_FORM_ID = 16607;                              // Checklist de Encerramento (Final)

/**
 * Calcula KM Inicial (intacto), KM Atualizado via GPS, KM Final e Auditoria de KM.
 */
function calcularKmVeiculo(vKm, gpsDistanceKm = null) {
  const formatHora = (iso) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;

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

  // KM Inicial permanece rigorosamente intacto conforme registrado no checklist de saída
  const kmInicial = vKm.initialChecklist?.odometer ?? null;
  const kmFinal = vKm.finalChecklist?.odometer ?? null;
  const gpsKm = (gpsDistanceKm !== null && !isNaN(gpsDistanceKm)) ? Number(gpsDistanceKm.toFixed(1)) : null;

  // KM Atualizado = KM Inicial + deslocamento medido pelo GPS desde o checklist inicial
  const kmAtualizado = (kmInicial !== null && gpsKm !== null)
    ? Number((kmInicial + gpsKm).toFixed(1))
    : kmInicial;

  let kmRodada = null;
  let statusKm = 'sem_saida';
  let auditoriaStatus = 'pendente'; // 'pendente' | 'ok' | 'divergente' | 'sem_gps' | 'sem_dados'
  let auditoriaDiff = null;

  if (kmInicial !== null && kmFinal !== null) {
    kmRodada = Number((kmFinal - kmInicial).toFixed(1));
    statusKm = kmRodada >= 0 ? 'finalizado' : 'inconsistente';

    // Rotina de Auditoria de KM (compara odômetro Prolog vs deslocamento SmartGPS)
    if (gpsKm !== null) {
      auditoriaDiff = Number((kmRodada - gpsKm).toFixed(1));
      auditoriaStatus = Math.abs(auditoriaDiff) <= AUDITORIA_TOLERANCIA_KM ? 'ok' : 'divergente';
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
    horaInicial: formatHora(vKm.initialChecklist?.submittedAt),
    horaFinal: formatHora(vKm.finalChecklist?.submittedAt)
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
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
    const startDateToday = `${todayStr}T00:00Z`;
    const endDateToday = `${todayStr}T23:59Z`;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const startDate30Days = `${thirtyDaysAgo}T00:00Z`;

    const headers = { 'x-prolog-api-token': PROLOG_API_TOKEN };

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] 🔄 [ROTINA] Buscando frotas, veículos, checklists e histórico GPS...`);

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
      axios.get(`${BASE_URL}/api/v3/checklists`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, startDate: startDate30Days, endDate: endDateToday, includeAnswers: true, pageSize: 100, pageNumber: 0 } }).catch(err => { console.error('[ERRO Checklists]', err.response?.status || err.message); return { data: null }; }),
      axios.get(`${BASE_URL}/api/v3/vehicles`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, active: true, pageSize: 100, pageNumber: 0 } }).catch(err => { console.error('[ERRO Veículos]', err.response?.status || err.message); return { data: null }; }),
      getSmartGpsDevicesMap()
    ]);

    if (!checklistsRes.data && !vehiclesRes.data && cachedDashboardData) {
      console.warn(`[${new Date().toLocaleTimeString('pt-BR')}] ⚠️ API indisponível ou limite atingido. Mantendo cache anterior.`);
      return;
    }

    const branchName = branchRes.data?.name || 'Filial Matriz';
    const allUsers = usersRes.data?.content || cachedUsersList || [];
    const operationalUsers = allUsers.filter(u => !(u.roleName || '').toLowerCase().includes('gestor'));

    const allChecklists = checklistsRes.data?.content || [];
    const checklistsHoje = allChecklists
      .filter(c => c.submittedAt && c.submittedAt >= startDateToday)
      .sort((a, b) => new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0));

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
        await new Promise(res => setTimeout(res, 500));
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

    // --- CONSULTA HISTÓRICO DE DESLOCAMENTO NA SMARTGPS (/api/get_history) ---
    const gpsDistanceByPlate = new Map();
    const historyPromises = [];

    veiculosKmMap.forEach((vKm, placa) => {
      const gpsDevice = smartGpsMap ? smartGpsMap.get(normalizePlate(placa)) : null;
      if (gpsDevice?.id && vKm.initialChecklist?.submittedAt) {
        const startIso = vKm.initialChecklist.submittedAt;
        const endIso = vKm.finalChecklist?.submittedAt || null;
        historyPromises.push(
          getSmartGpsHistoryDistance(gpsDevice.id, startIso, endIso).then(dist => {
            gpsDistanceByPlate.set(placa, dist);
          })
        );
      }
    });

    if (historyPromises.length > 0) {
      await Promise.all(historyPromises);
    }

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
      if (userId && c.submittedAt) {
        const currentLast = userLastChecklistMap.get(userId);
        if (!currentLast || new Date(c.submittedAt) > new Date(currentLast)) {
          userLastChecklistMap.set(userId, c.submittedAt);
        }
      }
    });

    const naoRealizaramList = operationalUsers
      .filter(u => !usuariosComChecklistHojeSet.has(u.id))
      .filter(u => userLastChecklistMap.has(u.id))
      .map(u => {
        const lastDateIso = userLastChecklistMap.get(u.id);
        let ultimoStr = '—';
        if (lastDateIso) {
          const d = new Date(lastDateIso);
          const day = String(d.getDate()).padStart(2, '0');
          const month = String(d.getMonth() + 1).padStart(2, '0');
          ultimoStr = `${day}/${month}`;
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

    const totalActiveUsers = operationalUsers.length;
    const realizaramCount = usuariosComChecklistHojeSet.size;
    const semChecklistCount = Math.max(0, totalActiveUsers - realizaramCount);
    const conformidadePct = totalActiveUsers > 0 ? Math.min(100, Math.round((realizaramCount / totalActiveUsers) * 100)) : (checklistsHoje.length > 0 ? 100 : 0);

    const totalKmCombinado = Math.round(totalKmRodado + totalKmGpsEmRota);

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
        mediaKmPorVeiculo: veiculosFinalizados > 0 ? Math.round(totalKmRodado / veiculosFinalizados) : 0,
        funcionariosAtivos: operationalUsers.length
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
          hora: c.submittedAt ? new Date(c.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--',
          formName: c.checklistFormName || '',
          formId: c.checklistFormId,
          kmTipo
        };
      }),
      naoRealizaram: naoRealizaramList,
      veiculos: Array.from(veiculosMap.values()).sort((a, b) => (b.alta - a.alta) || (b.fezHoje - a.fezHoje))
    };

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ✅ Cache atualizada. Veículos: ${veiculosMap.size} | KM Total (Final+GPS): ${totalKmCombinado} km`);
  } catch (error) {
    console.error('[ERRO AO ATUALIZAR CACHE]', error.message);
  }
}

updateDashboardCache();
setInterval(updateDashboardCache, 60 * 1000);

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