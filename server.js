const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));


// Configurações da API Prolog
const BASE_URL = 'https://prologapp.com/prolog';
const BRANCH_OFFICE_ID = ''; // Insira o ID da filial desejada aqui
const PROLOG_API_TOKEN = ''; // Insira o seu token válido aqui

let cachedDashboardData = null;

// Memória global para guardar os telefones e evitar sobrecarga na API
const userPhoneCache = new Map();

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
    const todayStr = now.toISOString().split('T')[0];
    const startDateToday = `${todayStr}T00:00Z`;
    const endDateToday = `${todayStr}T23:59Z`;

    // Histórico dos últimos 30 dias para os funcionários pendentes
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const startDate30Days = `${thirtyDaysAgo}T00:00Z`;

    const headers = { 'x-prolog-api-token': PROLOG_API_TOKEN };

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] 🔄 [ROTINA] Buscando frotas, veículos e checklists...`);

    const [branchRes, usersRes, checklistsRes, vehiclesRes] = await Promise.all([
      axios.get(`${BASE_URL}/api/v3/branch-offices/${BRANCH_OFFICE_ID}`, { headers }).catch(() => ({ data: null })),
      axios.get(`${BASE_URL}/api/v3/users`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, active: true, pageSize: 100, pageNumber: 0 } }).catch(() => ({ data: null })),
      axios.get(`${BASE_URL}/api/v3/checklists`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, startDate: startDate30Days, endDate: endDateToday, includeAnswers: true, pageSize: 100, pageNumber: 0 } }).catch(() => ({ data: null })),
      axios.get(`${BASE_URL}/api/v3/vehicles`, { headers, params: { branchOfficesId: BRANCH_OFFICE_ID, active: true, pageSize: 100, pageNumber: 0 } }).catch(() => ({ data: null }))
    ]);

    const branchName = branchRes.data?.name || 'Filial Matriz';
    const allUsers = usersRes.data?.content || [];
    const operationalUsers = allUsers.filter(u => !(u.roleName || '').toLowerCase().includes('gestor'));
    
    const allChecklists = checklistsRes.data?.content || [];
    const checklistsHoje = allChecklists.filter(c => c.submittedAt && c.submittedAt >= startDateToday);
    
    const usuariosComChecklistHojeSet = new Set();
    const placasComChecklistHoje = new Set();
    
    checklistsHoje.forEach(c => {
      if (c.submittedBy?.id) usuariosComChecklistHojeSet.add(c.submittedBy.id);
      if (c.vehicle?.licensePlate) placasComChecklistHoje.add(c.vehicle.licensePlate);
    });

    // --- LÓGICA DE TELEFONES SEQUENCIAL COM FORMATAÇÃO ---
    const neededUserIds = new Set();
    operationalUsers.forEach(u => neededUserIds.add(u.id));
    checklistsHoje.forEach(c => {
      if (c.submittedBy?.id) neededUserIds.add(c.submittedBy.id);
    });

    const missingIds = Array.from(neededUserIds).filter(id => !userPhoneCache.has(id));

    if (missingIds.length > 0) {
      console.log(`[ROTINA] Obtendo telefones para ${missingIds.length} funcionários...`);
      
      for (const id of missingIds) {
        try {
          const userRes = await axios.get(`${BASE_URL}/api/v3/users/${id}`, { headers });
          // Formata o número recebido da API antes de o guardar na cache
          const rawPhone = userRes.data?.phone || 'Sem número';
          userPhoneCache.set(id, formatPhoneNumber(rawPhone));
        } catch (err) {
          console.error(`[ERRO] A API recusou o telefone do utilizador ${id}. Será tentado de novo.`);
        }
        await new Promise(res => setTimeout(res, 250));
      }
    }

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
      const placa = v.licensePlate || v.plate || v.placa;
      if (placa) {
        veiculosMap.set(placa, {
          placa: placa,
          modelo: v.model?.name || v.modelName || '',
          tipo: v.type?.name || v.vehicleTypeName || 'car',
          alta: 0,
          media: 0,
          baixa: 0,
          fezHoje: placasComChecklistHoje.has(placa)
        });
      }
    });

    // --- 2. SOMA AS ANOMALIAS DOS CHECKLISTS AOS VEÍCULOS (SOMENTE HOJE) ---
    checklistsHoje.forEach(c => {
      const placa = c.vehicle?.licensePlate;
      if (!placa) return;

      const altaIssues = (c.totalIssuesCriticalPriority || 0) + (c.totalIssuesHighPriority || 0);
      const mediaIssues = c.totalNokAlternativesHighPriority || 0;
      const baixaIssues = c.totalIssuesLowPriority || 0;

      if (!veiculosMap.has(placa)) {
        veiculosMap.set(placa, { 
          placa, 
          modelo: c.vehicle?.modelName || '', 
          tipo: c.vehicle?.vehicleTypeName || 'car', 
          alta: altaIssues, 
          media: mediaIssues, 
          baixa: baixaIssues, 
          fezHoje: placasComChecklistHoje.has(placa) 
        });
      } else {
        const v = veiculosMap.get(placa);
        v.alta += altaIssues; 
        v.media += mediaIssues; 
        v.baixa += baixaIssues;
        if (!v.modelo && c.vehicle?.modelName) v.modelo = c.vehicle.modelName;
        if (placasComChecklistHoje.has(placa)) v.fezHoje = true;
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
        totalOs: (totalAlta + totalMedia + totalBaixa) 
      },
      realizaram: checklistsHoje.map(c => ({
        nome: c.submittedBy?.name || 'Motorista',
        telefone: (c.submittedBy?.id ? userPhoneCache.get(c.submittedBy.id) : '') || '',
        placa: c.vehicle?.licensePlate || 'N/A',
        hora: c.submittedAt ? new Date(c.submittedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--'
      })),
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

const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));