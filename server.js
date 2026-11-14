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

// IDs dos formulários para controle de KM diário
const INITIAL_KM_FORM_IDS = new Set([15810, 15813, 16552]); // Checklists de Saída (Inicial)
const FINAL_KM_FORM_ID = 16607;                              // Checklist de Encerramento (Final)

let cachedDashboardData = null;

// --- SISTEMA DE CACHE PERSISTENTE DE USUÁRIOS E TELEFONES ---
const USERS_CACHE_FILE = path.join(__dirname, 'users-cache.json');
const USERS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora para revalidar lista geral de usuários

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

// Inicializa a cache a partir do disco na inicialização do servidor
loadUserCacheFromFile();

// Função para formatar o telefone: remove +55 e deixa (XX) 9XXXX-XXXX
function formatPhoneNumber(phone) {
  if (!phone || phone === 'Sem número') return phone;
  
  // Remove tudo o que não for número
  let digits = phone.replace(/\D/g, '');
  
  // Remove o DDI (55) se o número tiver mais de 11 dígitos e começar por 55
  if (digits.startsWith('55') && digits.length > 11) {
    digits = digits.substring(2);
  }
  
  // Formata para (XX) XXXXX-XXXX se tiver 11 dígitos
  if (digits.length === 11) {
    return `(${digits.substring(0, 2)}) ${digits.substring(2, 7)}-${digits.substring(7)}`;
  } 
  // Formata para (XX) XXXX-XXXX se tiver 10 dígitos (telefones fixos antigos)
  else if (digits.length === 10) {
    return `(${digits.substring(0, 2)}) ${digits.substring(2, 6)}-${digits.substring(6)}`;
  }
  
  // Se não bater com o tamanho padrão, devolve o original para não cortar dados erradamente
  return phone;
}

async function updateDashboardCache() {
  try {
    const now = new Date();
    // Garante data no fuso de Brasília (America/Sao_Paulo)
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
    const startDateToday = `${todayStr}T00:00Z`;
    const endDateToday = `${todayStr}T23:59Z`;

    // Histórico dos últimos 30 dias para os funcionários pendentes
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const startDate30Days = `${thirtyDaysAgo}T00:00Z`;

    const headers = { 'x-prolog-api-token': PROLOG_API_TOKEN };

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] 🔄 [ROTINA] Buscando frotas, veículos e checklists...`);

    // Busca usuários na API apenas se o cache expirou (1h) ou estiver vazio
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

    const [branchRes, usersRes, checklistsRes, vehiclesRes] = await Promise.all([
      axios.get(`${BASE_URL}/api/v3/branch-offices/${BRANCH_OFFICE_ID}`, { headers }).catch(err => { console.error('[ERRO Filial]', err.response?.status || err.message); return { data: null }; }),
      usersPromise,
      axios.get(`${BASE_URL}/api/v3/checklists`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, startDate: startDate30Days, endDate: endDateToday, includeAnswers: true, pageSize: 100, pageNumber: 0 } }).catch(err => { console.error('[ERRO Checklists]', err.response?.status || err.message); return { data: null }; }),
      axios.get(`${BASE_URL}/api/v3/vehicles`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, active: true, pageSize: 100, pageNumber: 0 } }).catch(err => { console.error('[ERRO Veículos]', err.response?.status || err.message); return { data: null }; })
    ]);

    // Se as requisições falharem (ex: rate limit 429), preserva a cache anterior
    if (!checklistsRes.data && !vehiclesRes.data && cachedDashboardData) {
      console.warn(`[${new Date().toLocaleTimeString('pt-BR')}] ⚠️ API indisponível ou limite atingido. Mantendo cache anterior.`);
      return;
    }

    const branchName = branchRes.data?.name || 'Filial Matriz';
    const allUsers = usersRes.data?.content || cachedUsersList || [];
    const operationalUsers = allUsers.filter(u => !(u.roleName || '').toLowerCase().includes('gestor'));
    
    const allChecklists = checklistsRes.data?.content || [];
    // Ordena do mais antigo para o mais recente para capturar primeiro e último checklist do dia
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

    // --- LÓGICA DE TELEFONES SEQUENCIAL COM CACHE PERSISTENTE ---
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
          // Formata o número recebido da API antes de o guardar na cache
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
    // Mapeia saída (15810, 15813, 16552) e retorno (16607)
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

      // Primeiro checklist de saída do dia com odômetro preenchido
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

      // Último checklist de retorno do dia com odômetro preenchido
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

    let totalKmRodado = 0;
    let veiculosEmRota = 0;
    let veiculosFinalizados = 0;
    const kmControleList = [];

    veiculosKmMap.forEach((vKm, placa) => {
      const kmInicial = vKm.initialChecklist ? vKm.initialChecklist.odometer : null;
      const kmFinal = vKm.finalChecklist ? vKm.finalChecklist.odometer : null;
      let kmRodada = null;
      let statusKm = 'sem_saida';

      if (kmInicial !== null && kmFinal !== null) {
        kmRodada = kmFinal - kmInicial;
        if (kmRodada >= 0) {
          statusKm = 'finalizado';
          totalKmRodado += kmRodada;
          veiculosFinalizados++;
        } else {
          statusKm = 'inconsistente';
        }
      } else if (kmInicial !== null) {
        statusKm = 'em_rota';
        veiculosEmRota++;
      } else if (kmFinal !== null) {
        statusKm = 'sem_inicial';
      }

      const motorista = vKm.finalChecklist?.submittedBy || vKm.initialChecklist?.submittedBy || 'Motorista';
      const userId = vKm.finalChecklist?.userId || vKm.initialChecklist?.userId;
      const telefone = userId ? (userPhoneCache.get(userId) || '') : '';

      kmControleList.push({
        placa,
        modelo: vKm.modelo,
        motorista,
        telefone,
        kmInicial,
        horaInicial: vKm.initialChecklist?.submittedAt ? new Date(vKm.initialChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null,
        kmFinal,
        horaFinal: vKm.finalChecklist?.submittedAt ? new Date(vKm.finalChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null,
        kmRodada,
        statusKm
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

    // --- 1. POPULA O MAPA COM OS VEÍCULOS DA FROTA ---
    const veiculosMap = new Map();
    const rawVehicles = vehiclesRes.data;
    const vehiclesList = Array.isArray(rawVehicles) ? rawVehicles : (rawVehicles?.content || rawVehicles?.items || []);

    vehiclesList.forEach(v => {
      const placa = (v.licensePlate || v.plate || v.placa || '').trim();
      if (placa) {
        const kmData = veiculosKmMap.get(placa);
        veiculosMap.set(placa, {
          placa: placa,
          modelo: v.model?.name || v.modelName || '',
          tipo: v.type?.name || v.vehicleTypeName || 'car',
          alta: 0,
          media: 0,
          baixa: 0,
          fezHoje: placasComChecklistHoje.has(placa),
          kmInicial: kmData?.initialChecklist?.odometer ?? null,
          kmFinal: kmData?.finalChecklist?.odometer ?? null,
          kmRodada: (kmData?.initialChecklist?.odometer != null && kmData?.finalChecklist?.odometer != null) ? (kmData.finalChecklist.odometer - kmData.initialChecklist.odometer) : null,
          statusKm: kmData ? (
            (kmData.initialChecklist && kmData.finalChecklist) 
              ? (kmData.finalChecklist.odometer >= kmData.initialChecklist.odometer ? 'finalizado' : 'inconsistente')
              : (kmData.initialChecklist ? 'em_rota' : (kmData.finalChecklist ? 'sem_inicial' : 'sem_saida'))
          ) : 'sem_saida',
          horaInicial: kmData?.initialChecklist?.submittedAt ? new Date(kmData.initialChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null,
          horaFinal: kmData?.finalChecklist?.submittedAt ? new Date(kmData.finalChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null
        });
      }
    });

    // --- 2. SOMA AS ANOMALIAS DOS CHECKLISTS AOS VEÍCULOS (SOMENTE HOJE) ---
    checklistsHoje.forEach(c => {
      const placa = (c.vehicle?.licensePlate || '').trim();
      if (!placa) return;

      const altaIssues = (c.totalIssuesCriticalPriority || 0) + (c.totalIssuesHighPriority || 0);
      const mediaIssues = c.totalNokAlternativesHighPriority || 0;
      const baixaIssues = c.totalIssuesLowPriority || 0;

      const kmData = veiculosKmMap.get(placa);
      const kmInicial = kmData?.initialChecklist?.odometer ?? null;
      const kmFinal = kmData?.finalChecklist?.odometer ?? null;
      const kmRodada = (kmInicial !== null && kmFinal !== null) ? (kmFinal - kmInicial) : null;
      const statusKm = kmData ? (
        (kmData.initialChecklist && kmData.finalChecklist)
          ? (kmFinal >= kmInicial ? 'finalizado' : 'inconsistente')
          : (kmData.initialChecklist ? 'em_rota' : (kmData.finalChecklist ? 'sem_inicial' : 'sem_saida'))
      ) : 'sem_saida';

      if (!veiculosMap.has(placa)) {
        veiculosMap.set(placa, { 
          placa, 
          modelo: c.vehicle?.modelName || '', 
          tipo: c.vehicle?.vehicleTypeName || 'car', 
          alta: altaIssues, 
          media: mediaIssues, 
          baixa: baixaIssues, 
          fezHoje: placasComChecklistHoje.has(placa),
          kmInicial,
          kmFinal,
          kmRodada,
          statusKm,
          horaInicial: kmData?.initialChecklist?.submittedAt ? new Date(kmData.initialChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null,
          horaFinal: kmData?.finalChecklist?.submittedAt ? new Date(kmData.finalChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null
        });
      } else {
        const v = veiculosMap.get(placa);
        v.alta += altaIssues; 
        v.media += mediaIssues; 
        v.baixa += baixaIssues;
        if (!v.modelo && c.vehicle?.modelName) v.modelo = c.vehicle.modelName;
        if (placasComChecklistHoje.has(placa)) v.fezHoje = true;
        if (kmData) {
          v.kmInicial = kmInicial;
          v.kmFinal = kmFinal;
          v.kmRodada = kmRodada;
          v.statusKm = statusKm;
          v.horaInicial = kmData.initialChecklist?.submittedAt ? new Date(kmData.initialChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
          v.horaFinal = kmData.finalChecklist?.submittedAt ? new Date(kmData.finalChecklist.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
        }
      }
    });

    let totalAlta = 0; let totalMedia = 0; let totalBaixa = 0;
    Array.from(veiculosMap.values()).forEach(v => {
      totalAlta += v.alta; totalMedia += v.media; totalBaixa += v.baixa;
    });

    const totalActiveUsers = operationalUsers.length;
    const realizaramCount = usuariosComChecklistHojeSet.size;
    const semChecklistCount = Math.max(0, totalActiveUsers - realizaramCount);
    const conformidadePct = totalActiveUsers > 0 ? Math.min(100, Math.round((realizaramCount / totalActiveUsers) * 100)) : (checklistsHoje.length > 0 ? 100 : 0);

    cachedDashboardData = {
      branchName,
      kpis: { 
        checklistsHoje: checklistsHoje.length, 
        semChecklist: semChecklistCount, 
        conformidade: conformidadePct, 
        osAlta: totalAlta, 
        totalOs: (totalAlta + totalMedia + totalBaixa),
        totalKmRodado,
        veiculosEmRota,
        veiculosFinalizados
      },
      kmControle: kmControleList.sort((a, b) => {
        const prioridade = { em_rota: 1, finalizado: 2, inconsistente: 3, sem_inicial: 4, sem_saida: 5 };
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

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ✅ Cache atualizada. Total de veículos no painel: ${veiculosMap.size}`);
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

// Endpoint para forçar a atualização imediata do cache de usuários
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
