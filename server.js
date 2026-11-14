const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const { db, initDatabase } = require('./db.js');

initDatabase();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ==========================================
// ⭐️ 실시간 Server-Sent Events (SSE) 브로드캐스트 풀
// ==========================================
const sseClients = new Set();

function broadcastSSE(type, payload = {}) {
  const message = `event: ${type}\ndata: ${JSON.stringify({ type, ...payload, timestamp: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStaticFile(res, filePath, contentType) {
  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = contentType || MIME_TYPES[ext] || 'text/html';
    res.writeHead(200, { 'Content-Type': mime + (mime.startsWith('text/') || mime.includes('javascript') || mime.includes('json') ? '; charset=utf-8' : '') });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

function getFloorRank(floorStr) {
  if (!floorStr) return 0;
  const s = String(floorStr).trim().toUpperCase();
  const bMatch = s.match(/B(\d+)/);
  if (bMatch) return -parseInt(bMatch[1], 10);
  if (s.includes('RF') || s.includes('ROOF') || s.includes('옥상')) return 900;
  if (s.includes('PH')) return 901;
  if (s.includes('ETC') || s.includes('기타')) return 999;
  const fMatch = s.match(/(\d+)/);
  if (fMatch) return parseInt(fMatch[1], 10);
  return 0;
}

function resolveCompanyId(parsedUrl, body) {
  const tenant = (parsedUrl && parsedUrl.query && parsedUrl.query.tenant) || (body && (body.tenant || body.company_id)) || '';
  if (tenant) {
    const row = db.prepare('SELECT id FROM companies WHERE subdomain = ? OR id = ?').get(tenant, tenant);
    if (row) return row.id;
  }
  return 'comp_central_tower';
}

function checkTicketLimit(companyId) {
  const comp = db.prepare('SELECT monthly_ticket_limit, monthly_used_count, plan FROM companies WHERE id = ?').get(companyId);
  if (comp && comp.plan === 'FREE' && comp.monthly_used_count >= comp.monthly_ticket_limit) {
    return {
      allowed: false,
      message: `이번 달 무료 지시 한도(${comp.monthly_ticket_limit}건)를 모두 소진했습니다. 유료 플랜으로 업그레이드하세요.`
    };
  }
  return { allowed: true };
}

function consumeTicketLimit(companyId) {
  db.prepare('UPDATE companies SET monthly_used_count = monthly_used_count + 1 WHERE id = ?').run(companyId);
}

function seedDefaultTenantData(companyId) {
  const roles = [
    { id: `role_maint_${companyId}`, name: '영선/시설보수팀', category: 'FACILITY' },
    { id: `role_clean_${companyId}`, name: '환경/미화청결팀', category: 'CLEANING' },
    { id: `role_sec_${companyId}`, name: '보안/주차안내팀', category: 'SECURITY' },
    { id: `role_elec_${companyId}`, name: '전기/기계설비팀', category: 'ELECTRICAL' }
  ];
  const insertRole = db.prepare('INSERT OR IGNORE INTO custom_roles (id, company_id, name, category, is_system) VALUES (?, ?, ?, ?, 1)');
  for (const r of roles) {
    insertRole.run(r.id, companyId, r.name, r.category);
  }

  const shortSlug = companyId.replace(/^comp_/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'TENANT';
  const locs = [
    { id: `loc_1f_lobby_${companyId}`, building: '본관', floor: '1F', code: `${shortSlug}-1F-01`, name: '1층 메인 로비', category: 'FACILITY', desc: '주 출입구 및 안내 데스크' },
    { id: `loc_1f_restroom_${companyId}`, building: '본관', floor: '1F', code: `${shortSlug}-1F-02`, name: '1층 공용 화장실', category: 'CLEANING', desc: '1층 남녀 공용 화장실' },
    { id: `loc_b1_elec_${companyId}`, building: '본관', floor: 'B1', code: `${shortSlug}-B1-01`, name: '지하 1층 전기실', category: 'ELECTRICAL', desc: '수배전반 및 비상발전기' }
  ];
  const insertLoc = db.prepare('INSERT OR IGNORE INTO locations (id, company_id, building, floor, code, name, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))');
  for (const l of locs) {
    insertLoc.run(l.id, companyId, l.building, l.floor, l.code, l.name, l.category, l.desc);
  }

  const baseTemplates = db.prepare("SELECT title, target_role_name, building, frequency, items, description FROM inspection_templates WHERE company_id = 'comp_central_tower'").all();
  const insertTmpl = db.prepare(`
    INSERT OR IGNORE INTO inspection_templates (id, company_id, title, target_role_id, target_role_name, building, frequency, items, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  if (baseTemplates.length > 0) {
    baseTemplates.forEach((t, idx) => {
      const matchedRole = roles.find(r => r.name === t.target_role_name) || roles[0];
      insertTmpl.run(`tmpl_${companyId}_${idx + 1}`, companyId, t.title, matchedRole.id, t.target_role_name || matchedRole.name, t.building || '전체', t.frequency || 'DAILY', t.items, t.description || '');
    });
  } else {
    insertTmpl.run(
      `tmpl_${companyId}_1`,
      companyId,
      '일일 시설 안전 점검표',
      roles[0].id,
      roles[0].name,
      '본관',
      'DAILY',
      JSON.stringify([{ id: 'chk_1', type: 'CHECK', label: '시설 이상 유무 확인', required: true }]),
      '기본 시설 안전 점검'
    );
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const parsedUrl = { pathname: u.pathname, query: Object.fromEntries(u.searchParams.entries()) };
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    // ==========================================
    // ⭐️ 0. 실시간 이벤트 스트림 (Server-Sent Events)
    // ==========================================
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`event: CONNECTED\ndata: ${JSON.stringify({ message: '실시간 관제 스트림 연결 성공', timestamp: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // ==========================================
    // 1. 기본 설정 (회사명/로고)
    // ==========================================
    if (pathname === '/api/settings/company' && method === 'GET') {
      const tenant = parsedUrl.query?.tenant;
      let company;
      if (tenant) {
        company = db.prepare('SELECT * FROM companies WHERE subdomain = ? OR id = ?').get(tenant, tenant);
      }
      if (!company) {
        company = db.prepare('SELECT * FROM companies WHERE id = ?').get('comp_central_tower');
      }
      let buildings = ['본관', '별관'];
      let floors = ['B2', 'B1', '1F', '2F', '3F', '4F', '5F', '6F', '7F', '8F'];
      let buildingsConfig = {
        '본관': { basement: 'B2', ground: 8, hasRooftop: true, floors: ['B2', 'B1', '1F', '2F', '3F', '4F', '5F', '6F', '7F', '8F', 'RF'] },
        '별관': { basement: 'NONE', ground: 3, hasRooftop: false, floors: ['1F', '2F', '3F'] }
      };

      try {
        if (company && company.buildings_config) buildingsConfig = JSON.parse(company.buildings_config);
      } catch (e) {}
      try {
        if (company && company.buildings) buildings = JSON.parse(company.buildings);
      } catch (e) {}
      try {
        if (company && company.floors) floors = JSON.parse(company.floors);
      } catch (e) {}

      return sendJSON(res, 200, {
        ...company,
        buildings: Object.keys(buildingsConfig),
        floors,
        buildings_config: buildingsConfig
      });
    }
    if (pathname === '/api/settings/company' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const { name, logo_url, buildings_config, buildings, floors } = body;
      let bcStr = undefined;
      let bStr = undefined;
      let fStr = undefined;

      if (buildings_config && typeof buildings_config === 'object') {
        bcStr = JSON.stringify(buildings_config);
        const bList = Object.keys(buildings_config);
        bStr = JSON.stringify(bList);
        const allFloors = [];
        bList.forEach(b => {
          if (buildings_config[b] && Array.isArray(buildings_config[b].floors)) {
            buildings_config[b].floors.forEach(f => {
              if (!allFloors.includes(f)) allFloors.push(f);
            });
          }
        });
        fStr = JSON.stringify(allFloors);
      } else {
        if (Array.isArray(buildings)) bStr = JSON.stringify(buildings);
        if (Array.isArray(floors)) fStr = JSON.stringify(floors);
      }

      db.prepare(`
        UPDATE companies 
        SET name = COALESCE(?, name), 
            logo_url = COALESCE(?, logo_url),
            buildings = COALESCE(?, buildings),
            floors = COALESCE(?, floors),
            buildings_config = COALESCE(?, buildings_config)
        WHERE id = ?
      `).run(
        name || null,
        logo_url || null,
        bStr || null,
        fStr || null,
        bcStr || null,
        companyId
      );
      broadcastSSE('COMPANY_UPDATED', { company_id: companyId, name, logo_url, buildings_config });
      return sendJSON(res, 200, { success: true, message: '기본 설정이 저장되었습니다.' });
    }

    // ==========================================
    // 2. 구역 및 층수(Floor) / 건물동(Building) 위치 관리 API
    // ==========================================
    if (pathname === '/api/locations' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const locs = db.prepare('SELECT * FROM locations WHERE company_id = ?').all(companyId);
      locs.sort((a, b) => {
        const bldgA = a.building || '본관';
        const bldgB = b.building || '본관';
        if (bldgA !== bldgB) return bldgA.localeCompare(bldgB, 'ko');
        const rankA = getFloorRank(a.floor);
        const rankB = getFloorRank(b.floor);
        if (rankA !== rankB) return rankA - rankB;
        return (a.name || '').localeCompare(b.name || '', 'ko');
      });
      return sendJSON(res, 200, locs);
    }
    if (pathname === '/api/locations' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const { building, floor, name, code, description } = body;
      if (!name || !floor) return sendJSON(res, 400, { error: '층수와 구역명을 입력하세요.' });
      const id = 'loc_' + Date.now();
      const locCode = code || `LOC-${floor}-${Math.floor(10 + Math.random() * 90)}`;
      db.prepare(`
        INSERT INTO locations (id, company_id, building, floor, code, name, category, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'MAIN_TOWER', ?, datetime('now'))
      `).run(id, companyId, building || '본관', floor, locCode, name, description || '');
      broadcastSSE('LOCATION_UPDATED', { action: 'CREATE', id });
      return sendJSON(res, 201, { success: true, id, message: '새 위치/구역이 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/locations\/([^/]+)$/) && method === 'DELETE') {
      const locId = pathname.split('/')[3];
      db.prepare('DELETE FROM locations WHERE id = ?').run(locId);
      broadcastSSE('LOCATION_UPDATED', { action: 'DELETE', id: locId });
      return sendJSON(res, 200, { success: true, message: '위치가 삭제되었습니다.' });
    }
    if (pathname.match(/^\/api\/locations\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const locId = pathname.split('/')[3];
      const { building, floor, name, code, description } = await parseBody(req);
      db.prepare(`
        UPDATE locations
        SET building = ?, floor = ?, name = ?, code = ?, description = ?
        WHERE id = ?
      `).run(building || '본관', floor, name, code || `LOC-${floor}-EDIT`, description || '', locId);
      broadcastSSE('LOCATION_UPDATED', { action: 'UPDATE', id: locId });
      return sendJSON(res, 200, { success: true, message: '구역 정보가 수정되었습니다.' });
    }

    // ==========================================
    // 3. 티켓 및 모니터링 API
    // ==========================================
    // [GET] /api/tickets (전체 티켓 및 그룹별 카운트 제공)
    if (pathname === '/api/tickets' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const query = `
        SELECT 
          t.*, 
          l.name as location_name, 
          l.floor as location_floor,
          l.building as location_building,
          gr.name as target_group_name,
          u.name as assignee_name,
          ur.name as assignee_role_name
        FROM tickets t
        LEFT JOIN locations l ON t.location_id = l.id
        LEFT JOIN custom_roles gr ON t.target_group_role_id = gr.id
        LEFT JOIN users u ON t.assignee_id = u.id
        LEFT JOIN custom_roles ur ON u.custom_role_id = ur.id
        WHERE t.company_id = ?
        ORDER BY t.created_at DESC
      `;
      const tickets = db.prepare(query).all(companyId);
      return sendJSON(res, 200, tickets);
    }

    // ⭐️ [POST] /api/tickets/direct-dispatch (관리자 직접 작업지시 등록 및 즉시 발송)
    if (pathname === '/api/tickets/direct-dispatch' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const limitCheck = checkTicketLimit(companyId);
      if (!limitCheck.allowed) {
        return sendJSON(res, 403, { error: 'LIMIT_EXCEEDED', message: limitCheck.message });
      }
      const {
        title,
        category,
        building,
        floor,
        location_id,
        location_custom_name,
        target_type,
        target_group_role_id,
        assignee_id,
        instruction_notes,
        instruction_photo_url
      } = body;

      if (!title) return sendJSON(res, 400, { error: '작업 지시 제목을 입력하세요.' });

      let finalLocId = location_id;
      if (!finalLocId && (floor || location_custom_name)) {
        finalLocId = 'loc_' + Date.now();
        const locName = location_custom_name || `${building || '본관'} ${floor || '1F'} 지정 작업 구역`;
        db.prepare(`
          INSERT INTO locations (id, company_id, building, floor, code, name, category, description)
          VALUES (?, ?, ?, ?, ?, ?, 'FACILITY', '관리자 직접 작업지시 지정 구역')
        `).run(finalLocId, companyId, building || '본관', floor || '1F', `LOC-AUTO-${Date.now().toString().slice(-4)}`, locName);
      } else if (!finalLocId) {
        const firstLoc = db.prepare('SELECT id FROM locations WHERE company_id = ? LIMIT 1').get(companyId);
        finalLocId = firstLoc ? firstLoc.id : 'loc_1f_lobby';
      }

      const id = 't_' + Date.now();
      const ticketNo = 'T-DIR-' + Math.floor(1000 + Math.random() * 9000);

      db.prepare(`
        INSERT INTO tickets (
          id, ticket_no, company_id, location_id, category, title, description,
          reporter_type, reporter_name, reporter_phone, status,
          target_type, target_group_role_id, assignee_id,
          instruction_title, instruction_notes, instruction_photo_url,
          created_at, assigned_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          'ADMIN_DIRECT', '운영관리자', '02-1234-5678', 'IN_PROGRESS',
          ?, ?, ?,
          ?, ?, ?,
          datetime('now'), datetime('now')
        )
      `).run(
        id, ticketNo, companyId, finalLocId, category || 'FACILITY', title, instruction_notes || '관리자 직접 현장 작업지시 발송 건',
        target_type || 'GROUP',
        target_group_role_id || null,
        target_type === 'INDIVIDUAL' ? assignee_id : null,
        title,
        instruction_notes || '',
        instruction_photo_url || null
      );

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_CREATED', { ticket_id: id, title, type: 'ADMIN_DIRECT' });
      return sendJSON(res, 201, { success: true, id, ticket_no: ticketNo, message: '관리자 직접 작업지시가 발송되었습니다.' });
    }

    // ⭐️ [GET] /api/tickets/:id/history (진행프로세스 상세 타임라인 히스토리)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/history$/) && method === 'GET') {
      const ticketId = pathname.split('/')[3];
      const t = db.prepare(`
        SELECT 
          t.*, 
          l.name as location_name, 
          l.floor as location_floor,
          l.building as location_building,
          gr.name as target_group_name,
          u.name as assignee_name
        FROM tickets t
        LEFT JOIN locations l ON t.location_id = l.id
        LEFT JOIN custom_roles gr ON t.target_group_role_id = gr.id
        LEFT JOIN users u ON t.assignee_id = u.id
        WHERE t.id = ?
      `).get(ticketId);

      if (!t) return sendJSON(res, 404, { error: 'NOT_FOUND', message: '티켓 정보를 찾을 수 없습니다.' });

      const timeline = [
        {
          step: 1,
          name: '최초 접수',
          status: 'COMPLETED',
          timestamp: t.created_at,
          actor: t.reporter_name ? `${t.reporter_name} (${t.reporter_type === 'PUBLIC_QR' ? '모바일 QR' : t.reporter_type === 'ADMIN_DIRECT' ? '관리자 직접지시' : '현장직원 순찰'})` : '신고자',
          phone: t.reporter_phone,
          title: t.title,
          description: t.description,
          photo_url: t.photo_url || (t.reporter_type === 'PUBLIC_QR' ? 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=600&q=80' : null)
        },
        {
          step: 2,
          name: '관리자 작업 지시',
          status: t.assigned_at ? 'COMPLETED' : (t.status === 'PENDING' ? 'PENDING' : 'COMPLETED'),
          timestamp: t.assigned_at || t.created_at,
          actor: '운영관리소',
          target: t.target_type === 'INDIVIDUAL' ? `개인: ${t.assignee_name || '실무자'}` : `직무그룹: ${t.target_group_name || '전체 그룹'} (선착순)`,
          instruction_title: t.instruction_title || t.title,
          instruction_notes: t.instruction_notes || '현장 점검 및 조치 바람',
          instruction_photo_url: t.instruction_photo_url
        },
        {
          step: 3,
          name: '실무자 현장 접수 (착수)',
          status: t.started_at ? 'COMPLETED' : (t.status === 'IN_PROGRESS' && !t.started_at ? 'WAITING' : (t.status === 'PENDING' ? 'WAITING' : 'COMPLETED')),
          timestamp: t.started_at,
          actor: t.claimed_by_name || t.completed_by_name || t.assignee_name || '접수 대기',
          note: t.started_at ? '선착순 현장 접수 완료 후 작업 착수' : '실무자 접수 대기 중'
        },
        {
          step: 4,
          name: '현장 조치 보고',
          status: (t.status === 'WAITING_APPROVAL' || t.status === 'COMPLETED' || t.resolution_type === 'UNRESOLVED' || t.resolution_type === 'OUTSOURCING') ? 'COMPLETED' : 'WAITING',
          timestamp: t.completed_at || (t.resolution_type ? t.started_at : null),
          actor: t.completed_by_name || t.claimed_by_name || '담당 실무자',
          resolution_type: t.resolution_type || (t.status === 'COMPLETED' ? 'RESOLVED' : null),
          notes: t.completion_notes || t.unresolved_reason || '',
          photo_url: t.completion_photo_url || t.unresolved_photo_url || (t.status === 'COMPLETED' ? 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=600&q=80' : null)
        },
        {
          step: 5,
          name: '최종 관리자 마감 승인',
          status: t.status === 'COMPLETED' ? 'COMPLETED' : (t.status === 'WAITING_APPROVAL' ? 'WAITING_APPROVAL' : 'WAITING'),
          timestamp: t.approved_at,
          actor: '관리소장',
          admin_notes: t.admin_notes || (t.status === 'COMPLETED' ? '현장 조치 확인 후 종결 승인함.' : null)
        }
      ];

      return sendJSON(res, 200, { ticket: t, timeline });
    }

    // ⭐️ [POST] /api/tickets/:id/close-direct (단순 민원 즉시 마감 - 코멘트 필수/선택 기록)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/close-direct$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const closeComment = (body.comment || '').trim() || '관리자 현장 확인 후 직접 마감 종결 처리됨';

      db.prepare(`
        UPDATE tickets 
        SET 
          status = 'COMPLETED',
          completed_by_name = '관리자 직접 마감',
          completion_notes = ?,
          admin_notes = ?,
          approved_at = datetime('now'),
          completed_at = datetime('now')
        WHERE id = ?
      `).run(closeComment, closeComment, ticketId);
      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, status: 'COMPLETED' });
      return sendJSON(res, 200, { success: true, message: '마감 처리되었습니다.' });
    }

    // ⭐️ [POST] /api/tickets/:id/claim (실무자 현장 접수 - 선착순 할당 및 작업 착수)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/claim$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const { worker_id, worker_name } = body;

      const existing = db.prepare('SELECT assignee_id, started_at, claimed_by_name FROM tickets WHERE id = ?').get(ticketId);
      if (existing && existing.started_at && existing.assignee_id && existing.assignee_id !== worker_id) {
        return sendJSON(res, 400, {
          error: 'ALREADY_CLAIMED',
          message: `이미 다른 실무자(${existing.claimed_by_name || '동료 실무자'})가 접수한 작업입니다.`
        });
      }

      db.prepare(`
        UPDATE tickets 
        SET 
          status = 'IN_PROGRESS',
          assignee_id = ?,
          claimed_by_name = ?,
          completed_by_name = ?,
          started_at = datetime('now')
        WHERE id = ?
      `).run(worker_id, worker_name, worker_name, ticketId);

      broadcastSSE('TICKET_CLAIMED', { ticket_id: ticketId, worker_name });
      return sendJSON(res, 200, { success: true, message: `${worker_name}님이 작업을 정상 접수하였습니다. 현장 조치를 시작하세요.` });
    }

    // [POST] /api/tickets/:id/assign (작업 지시 발송)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/assign$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const { target_type, target_group_role_id, assignee_id, instruction_title, instruction_notes, instruction_photo_url } = body;
      const ticketRow = db.prepare('SELECT company_id FROM tickets WHERE id = ?').get(ticketId);
      const companyId = (ticketRow && ticketRow.company_id) || resolveCompanyId(parsedUrl, body);

      const limitCheck = checkTicketLimit(companyId);
      if (!limitCheck.allowed) {
        return sendJSON(res, 403, { error: 'LIMIT_EXCEEDED', message: limitCheck.message });
      }

      db.prepare(`
        UPDATE tickets 
        SET 
          status = 'IN_PROGRESS',
          target_type = ?,
          target_group_role_id = ?,
          assignee_id = ?,
          instruction_title = ?,
          instruction_notes = ?,
          instruction_photo_url = ?,
          assigned_at = datetime('now')
        WHERE id = ?
      `).run(
        target_type || 'GROUP',
        target_group_role_id || null,
        target_type === 'INDIVIDUAL' ? assignee_id : null,
        instruction_title || '작업 지시',
        instruction_notes || '',
        instruction_photo_url || null,
        ticketId
      );

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_ASSIGNED', { ticket_id: ticketId });
      return sendJSON(res, 200, { success: true, message: '작업 지시가 발송되었습니다.' });
    }

    // [POST] /api/tickets/:id/unresolved (실무자 미해결 보고 ➔ 계속 대기)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/unresolved$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const { worker_id, worker_name, unresolved_reason, unresolved_photo_url } = body;

      db.prepare(`
        UPDATE tickets
        SET 
          status = 'IN_PROGRESS',
          resolution_type = 'UNRESOLVED',
          unresolved_reason = ?,
          unresolved_photo_url = ?,
          assignee_id = ?,
          completed_by_name = ?
        WHERE id = ?
      `).run(
        unresolved_reason || '현장 자재 부족으로 보류',
        unresolved_photo_url || '',
        worker_id || null,
        worker_name || '실무자',
        ticketId
      );

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, resolution_type: 'UNRESOLVED' });
      return sendJSON(res, 200, { success: true, message: '미해결 사유가 등록되어 계속 대기 상태로 유지됩니다.' });
    }

    // ⭐️ [POST] /api/tickets/:id/outsource (실무자 외주/아웃소싱 의뢰 처리)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/outsource$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const { worker_id, worker_name, partner_name, outsource_reason, estimated_date, photo_url } = body;
      const fullReason = `[외주의뢰: ${partner_name || '협력업체'}] ${outsource_reason || '전문 외주 출동 요청'}${estimated_date ? ` (예상일: ${estimated_date})` : ''}`;

      db.prepare(`
        UPDATE tickets
        SET 
          status = 'IN_PROGRESS',
          resolution_type = 'OUTSOURCING',
          unresolved_reason = ?,
          unresolved_photo_url = ?,
          completed_by_name = ?
        WHERE id = ?
      `).run(
        fullReason,
        photo_url || '',
        worker_name || '실무자',
        ticketId
      );

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, resolution_type: 'OUTSOURCING' });
      return sendJSON(res, 200, { success: true, message: '외주 및 아웃소싱 의뢰가 접수되었습니다.' });
    }

    // [POST] /api/tickets/:id/complete (실무자 조치 완료 보고)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/complete$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const { completion_notes, completion_photo_url, worker_id, worker_name } = body;

      db.prepare(`
        UPDATE tickets
        SET 
          status = 'WAITING_APPROVAL',
          resolution_type = 'RESOLVED',
          completed_by_name = ?,
          assignee_id = ?,
          completion_notes = ?,
          completion_photo_url = ?,
          completed_at = datetime('now')
        WHERE id = ?
      `).run(
        worker_name || '실무자',
        worker_id || null,
        completion_notes || '',
        completion_photo_url || '',
        ticketId
      );

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, status: 'WAITING_APPROVAL' });
      return sendJSON(res, 200, { success: true, message: '조치 완료 보고가 등록되었습니다.' });
    }

    // ⭐️ [POST] /api/tickets/:id/approve (관리자 최종 종결 마감 승인 & 코멘트 기록)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/approve$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const adminComment = (body.admin_notes || '').trim() || '관리자 현장 조치 상태 확인 완료. 정상 승인 종결함.';

      db.prepare(`
        UPDATE tickets
        SET 
          status = 'COMPLETED',
          admin_notes = ?,
          approved_at = datetime('now')
        WHERE id = ?
      `).run(adminComment, ticketId);

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, status: 'COMPLETED' });
      return sendJSON(res, 200, { success: true, message: '작업이 최종 마감 승인되었습니다.' });
    }

    // [POST] /api/tickets/:id/reject (반려)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/reject$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, action: 'DELETE' });
      return sendJSON(res, 200, { success: true, message: '신고가 반려되었습니다.' });
    }

    // [POST] /api/tickets/qr (QR 간편 신고 접수)
    if (pathname === '/api/tickets/qr' && method === 'POST') {
      const body = await parseBody(req);
      const { location_id, category, title, description, phone, reporter_name, photo_url } = body;
      const companyId = resolveCompanyId(parsedUrl, body);

      const isBlocked = db.prepare('SELECT reason FROM blocked_users WHERE phone = ? AND company_id = ?').get(phone, companyId);
      if (isBlocked) {
        return sendJSON(res, 403, { error: 'BLOCKED_USER', message: `신고가 제한된 연락처입니다: ${isBlocked.reason}` });
      }

      const limitCheck = checkTicketLimit(companyId);
      if (!limitCheck.allowed) {
        return sendJSON(res, 403, { error: 'LIMIT_EXCEEDED', message: limitCheck.message });
      }

      let finalLocId = location_id;
      if (!finalLocId) {
        const firstLoc = db.prepare('SELECT id FROM locations WHERE company_id = ? LIMIT 1').get(companyId);
        finalLocId = firstLoc ? firstLoc.id : null;
      }

      const id = 't_' + Date.now();
      const ticketNo = 'T-' + Math.floor(1000 + Math.random() * 9000);

      db.prepare(`
        INSERT INTO tickets (
          id, ticket_no, company_id, location_id, category, title, description, 
          reporter_type, reporter_name, reporter_phone, photo_url, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PUBLIC_QR', ?, ?, ?, 'PENDING', datetime('now'))
      `).run(id, ticketNo, companyId, finalLocId, category || 'FACILITY', title, description || '', reporter_name || '방문객', phone, photo_url || null);

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_CREATED', { ticket_id: id, title, type: 'PUBLIC_QR', company_id: companyId });
      return sendJSON(res, 201, { success: true, ticket_no: ticketNo, message: '신고가 접수되었습니다.' });
    }

    // ==========================================
    // 4. 사용자 & 역할 관리 API
    // ==========================================
    if (pathname === '/api/users' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const users = db.prepare(`
        SELECT u.*, r.name as role_name 
        FROM users u 
        LEFT JOIN custom_roles r ON u.custom_role_id = r.id 
        WHERE u.company_id = ?
        ORDER BY u.created_at DESC
      `).all(companyId);
      return sendJSON(res, 200, users);
    }
    if (pathname === '/api/users' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const { name, email, password, phone, role, custom_role_id } = body;
      if (!name) return sendJSON(res, 400, { error: '이름을 입력하세요.' });
      if (!email) return sendJSON(res, 400, { error: '로그인 아이디(이메일)를 입력하세요.' });
      const id = 'user_' + Date.now();
      db.prepare(`
        INSERT INTO users (id, company_id, role, name, email, password, phone, custom_role_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(id, companyId, role || 'WORKER', name, email, password || '1234', phone || '', custom_role_id || null);
      broadcastSSE('USER_UPDATED', { action: 'CREATE', id });
      return sendJSON(res, 201, { success: true, id, message: '사용자가 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/users\/([^/]+)$/) && method === 'DELETE') {
      const userId = pathname.split('/')[3];
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      broadcastSSE('USER_UPDATED', { action: 'DELETE', id: userId });
      return sendJSON(res, 200, { success: true, message: '사용자가 삭제되었습니다.' });
    }
    if (pathname.match(/^\/api\/users\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const userId = pathname.split('/')[3];
      const { name, email, password, phone, role, custom_role_id } = await parseBody(req);
      db.prepare(`
        UPDATE users
        SET name = ?, email = COALESCE(?, email), password = CASE WHEN ? != '' THEN ? ELSE password END, phone = ?, role = ?, custom_role_id = ?
        WHERE id = ?
      `).run(name, email || null, password || '', password || '', phone || '', role || 'WORKER', custom_role_id || null, userId);
      broadcastSSE('USER_UPDATED', { action: 'UPDATE', id: userId });
      return sendJSON(res, 200, { success: true, message: '사용자 정보가 수정되었습니다.' });
    }
    if (pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/) && method === 'POST') {
      const userId = pathname.split('/')[3];
      const { newPassword } = await parseBody(req);
      const targetPw = (newPassword && newPassword.trim()) ? newPassword.trim() : '1234';
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(targetPw, userId);
      broadcastSSE('USER_UPDATED', { action: 'PASSWORD_RESET', id: userId });
      return sendJSON(res, 200, { success: true, message: `비밀번호가 [${targetPw}]로 재설정되었습니다.` });
    }

    // ==========================================
    // ⭐️ 4-1. 모바일 현장순찰 일지 API
    // ==========================================
    if (pathname === '/api/patrol' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const logs = db.prepare(`
        SELECT p.*, u.role as user_role 
        FROM patrol_logs p 
        LEFT JOIN users u ON p.user_id = u.id 
        WHERE p.company_id = ?
        ORDER BY p.created_at DESC 
        LIMIT 50
      `).all(companyId);
      return sendJSON(res, 200, logs);
    }
    if (pathname === '/api/patrol' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const { user_id, worker_name, building, floor, location_name, check_items, notes, photo_url } = body;
      const id = 'pt_' + Date.now();
      db.prepare(`
        INSERT INTO patrol_logs (id, company_id, user_id, worker_name, building, floor, location_name, check_items, notes, photo_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        companyId,
        user_id || 'user_worker_choi',
        worker_name || '현장 실무자',
        building || '본관',
        floor || '1F',
        location_name || '순찰 구역',
        typeof check_items === 'object' ? JSON.stringify(check_items) : (check_items || '{}'),
        notes || '',
        photo_url || ''
      );
      broadcastSSE('PATROL_SUBMITTED', { id, worker_name, location_name });
      return sendJSON(res, 201, { success: true, id, message: '현장 순찰 점검 일지가 등록되었습니다.' });
    }

    if (pathname === '/api/roles' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const roles = db.prepare(`
        SELECT r.*, count(u.id) as worker_count 
        FROM custom_roles r 
        LEFT JOIN users u ON u.custom_role_id = r.id 
        WHERE r.company_id = ? 
        GROUP BY r.id
      `).all(companyId);
      return sendJSON(res, 200, roles);
    }
    if (pathname === '/api/roles' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const { name, category } = body;
      if (!name) return sendJSON(res, 400, { error: '직무명을 입력하세요.' });
      const id = 'role_' + Date.now();
      db.prepare('INSERT INTO custom_roles (id, company_id, name, category, is_system) VALUES (?, ?, ?, ?, 0)').run(
        id, companyId, name, category || 'FACILITY'
      );
      return sendJSON(res, 201, { success: true, id, name });
    }
    if (pathname.match(/^\/api\/roles\/([^/]+)$/) && method === 'DELETE') {
      const roleId = pathname.split('/')[3];
      db.prepare('DELETE FROM custom_roles WHERE id = ? AND is_system = 0').run(roleId);
      return sendJSON(res, 200, { success: true });
    }
    if (pathname.match(/^\/api\/roles\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const roleId = pathname.split('/')[3];
      const { name, category } = await parseBody(req);
      db.prepare(`
        UPDATE custom_roles
        SET name = ?, category = ?
        WHERE id = ?
      `).run(name, category || 'FACILITY', roleId);
      return sendJSON(res, 200, { success: true, message: '직무 그룹이 수정되었습니다.' });
    }

    // ==========================================
    // ⭐️ 4-2. 현장 점검표 템플릿 및 점검 수행 이력 API
    // ==========================================
    if (pathname === '/api/inspections/templates' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const templates = db.prepare(`
        SELECT t.*, r.name as role_display_name
        FROM inspection_templates t
        LEFT JOIN custom_roles r ON t.target_role_id = r.id
        WHERE t.company_id = ?
        ORDER BY t.created_at DESC
      `).all(companyId);
      return sendJSON(res, 200, templates);
    }
    if (pathname === '/api/inspections/templates' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const { title, target_role_id, target_role_name, building, frequency, items, description } = body;
      if (!title) return sendJSON(res, 400, { error: '점검표 명칭을 입력하세요.' });
      const id = 'tmpl_' + Date.now();
      const itemsStr = typeof items === 'object' ? JSON.stringify(items) : (items || '[]');
      db.prepare(`
        INSERT INTO inspection_templates (id, company_id, title, target_role_id, target_role_name, building, frequency, items, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        companyId,
        title,
        target_role_id || null,
        target_role_name || '전체 직무',
        building || '전체',
        frequency || 'DAILY',
        itemsStr,
        description || ''
      );
      broadcastSSE('INSPECTION_TEMPLATE_UPDATED', { action: 'CREATE', id, title });
      return sendJSON(res, 201, { success: true, id, message: '점검표 양식이 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/templates\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const tmplId = pathname.split('/')[4];
      const { title, target_role_id, target_role_name, building, frequency, items, description } = await parseBody(req);
      const itemsStr = typeof items === 'object' ? JSON.stringify(items) : (items || '[]');
      db.prepare(`
        UPDATE inspection_templates
        SET title = ?, target_role_id = ?, target_role_name = ?, building = ?, frequency = ?, items = ?, description = ?
        WHERE id = ?
      `).run(
        title,
        target_role_id || null,
        target_role_name || '전체 직무',
        building || '전체',
        frequency || 'DAILY',
        itemsStr,
        description || '',
        tmplId
      );
      broadcastSSE('INSPECTION_TEMPLATE_UPDATED', { action: 'UPDATE', id: tmplId, title });
      return sendJSON(res, 200, { success: true, message: '점검표 양식이 수정되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/templates\/([^/]+)$/) && method === 'DELETE') {
      const tmplId = pathname.split('/')[4];
      db.prepare('DELETE FROM inspection_templates WHERE id = ?').run(tmplId);
      broadcastSSE('INSPECTION_TEMPLATE_UPDATED', { action: 'DELETE', id: tmplId });
      return sendJSON(res, 200, { success: true, message: '점검표 양식이 삭제되었습니다.' });
    }

    // ⭐️ 점검 일정(주기별 완료/누락 현황) API
    if (pathname === '/api/inspections/schedule' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const dateStr = (parsedUrl.query?.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
      const baseDate = new Date(dateStr + 'T00:00:00Z');
      const dayOfWeek = baseDate.getUTCDay(); // 0=Sun..6=Sat
      const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monDate = new Date(baseDate.getTime() + diffToMon * 86400000);
      const sunDate = new Date(monDate.getTime() + 6 * 86400000);
      const weekStart = monDate.toISOString().slice(0, 10);
      const weekEnd = sunDate.toISOString().slice(0, 10);
      const monthPrefix = dateStr.slice(0, 7);

      const templates = db.prepare('SELECT * FROM inspection_templates WHERE company_id = ? ORDER BY created_at DESC').all(companyId);
      const logs = db.prepare('SELECT * FROM inspection_logs WHERE company_id = ? ORDER BY completed_at DESC').all(companyId);

      const items = templates.map(t => {
        const freq = (t.frequency || 'DAILY').toUpperCase();
        const matchingLogs = logs.filter(l => {
          if (l.template_id !== t.id && l.template_title !== t.title) return false;
          const d = (l.completed_at || '').slice(0, 10);
          if (!d) return false;
          if (freq === 'WEEKLY') return d >= weekStart && d <= weekEnd;
          if (freq === 'MONTHLY') return d.slice(0, 7) === monthPrefix;
          return d === dateStr;
        });
        const latest = matchingLogs[0] || null;
        return {
          id: t.id,
          title: t.title,
          target_role_name: t.target_role_name || '전체 직무',
          building: t.building || '전체',
          frequency: freq,
          target_count: 1,
          completed_count: matchingLogs.length,
          is_done: matchingLogs.length >= 1,
          last_completed_at: latest ? latest.completed_at : null,
          last_worker_name: latest ? latest.worker_name : null,
          last_status: latest ? latest.status : null
        };
      });

      const doneCount = items.filter(i => i.is_done).length;
      return sendJSON(res, 200, {
        date: dateStr,
        week_range: `${weekStart} ~ ${weekEnd}`,
        month: monthPrefix,
        total_count: items.length,
        done_count: doneCount,
        pending_count: items.length - doneCount,
        items
      });
    }

    // ⭐️ 점검표별 기간 통계 API
    if (pathname === '/api/inspections/statistics' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const todayStr = new Date().toISOString().slice(0, 10);
      const endDate = (parsedUrl.query?.endDate || todayStr).slice(0, 10);
      const startDefault = new Date(new Date(endDate + 'T00:00:00Z').getTime() - 6 * 86400000).toISOString().slice(0, 10);
      const startDate = (parsedUrl.query?.startDate || startDefault).slice(0, 10);
      const templateId = parsedUrl.query?.templateId || 'ALL';

      const templates = db.prepare('SELECT * FROM inspection_templates WHERE company_id = ?').all(companyId);
      const allLogs = db.prepare(`
        SELECT * FROM inspection_logs
        WHERE company_id = ? AND substr(completed_at, 1, 10) >= ? AND substr(completed_at, 1, 10) <= ?
        ORDER BY completed_at DESC
      `).all(companyId, startDate, endDate);

      const targetTmpl = templateId !== 'ALL' ? templates.find(t => t.id === templateId) : null;
      const filteredLogs = targetTmpl
        ? allLogs.filter(l => l.template_id === targetTmpl.id || l.template_title === targetTmpl.title)
        : allLogs;

      const sTime = new Date(startDate + 'T00:00:00Z').getTime();
      const eTime = new Date(endDate + 'T00:00:00Z').getTime();
      const days = Math.max(1, Math.round((eTime - sTime) / 86400000) + 1);

      const dailyMap = {};
      for (let i = 0; i < days && i < 60; i++) {
        const d = new Date(sTime + i * 86400000).toISOString().slice(0, 10);
        dailyMap[d] = { date: d, total: 0, good: 0, warn: 0, bad: 0 };
      }

      let goodCount = 0;
      let warnCount = 0;
      let badCount = 0;
      filteredLogs.forEach(l => {
        const d = (l.completed_at || '').slice(0, 10);
        const st = l.status || '양호';
        if (st === '불량') badCount++;
        else if (st === '주의') warnCount++;
        else goodCount++;

        if (dailyMap[d]) {
          dailyMap[d].total++;
          if (st === '불량') dailyMap[d].bad++;
          else if (st === '주의') dailyMap[d].warn++;
          else dailyMap[d].good++;
        }
      });

      const calcExpected = (t) => {
        const f = (t.frequency || 'DAILY').toUpperCase();
        if (f === 'WEEKLY') return Math.max(1, Math.ceil(days / 7));
        if (f === 'MONTHLY') return Math.max(1, Math.ceil(days / 30));
        return days;
      };
      const expectedCount = targetTmpl
        ? calcExpected(targetTmpl)
        : templates.reduce((acc, t) => acc + calcExpected(t), 0);

      const totalLogs = filteredLogs.length;
      const completionRate = expectedCount > 0 ? Math.min(100, Math.round((totalLogs / expectedCount) * 100)) : 0;

      return sendJSON(res, 200, {
        startDate,
        endDate,
        days,
        templateId,
        templateTitle: targetTmpl ? targetTmpl.title : '전체 점검표',
        total_logs: totalLogs,
        expected_count: expectedCount,
        completion_rate: completionRate,
        good_count: goodCount,
        warn_count: warnCount,
        bad_count: badCount,
        daily_series: Object.values(dailyMap),
        logs: filteredLogs
      });
    }

    // ⭐️ 점검 결과 이력 API
    if (pathname === '/api/inspections/logs' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const logs = db.prepare(`
        SELECT * FROM inspection_logs
        WHERE company_id = ?
        ORDER BY completed_at DESC
      `).all(companyId);
      return sendJSON(res, 200, logs);
    }
    if (pathname === '/api/inspections/logs' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body);
      const limitCheck = checkTicketLimit(companyId);
      if (!limitCheck.allowed) {
        return sendJSON(res, 403, { error: 'LIMIT_EXCEEDED', message: limitCheck.message });
      }
      const { template_id, template_title, worker_id, worker_name, role_name, building, floor, location_name, results, status, notes, photo_url } = body;
      const id = 'ins_log_' + Date.now();
      const resultsStr = typeof results === 'object' ? JSON.stringify(results) : (results || '{}');
      db.prepare(`
        INSERT INTO inspection_logs (id, company_id, template_id, template_title, worker_id, worker_name, role_name, building, floor, location_name, results, status, notes, photo_url, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        companyId,
        template_id || null,
        template_title || '현장 점검표',
        worker_id || null,
        worker_name || '현장 실무자',
        role_name || '직무 미지정',
        building || '본관',
        floor || '1F',
        location_name || '현장 구역',
        resultsStr,
        status || '양호',
        notes || '',
        photo_url || ''
      );
      consumeTicketLimit(companyId);
      broadcastSSE('INSPECTION_LOG_SUBMITTED', { id, worker_name, template_title, location_name, status });
      return sendJSON(res, 201, { success: true, id, message: '현장 점검 결과가 성공적으로 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/logs\/([^/]+)$/) && method === 'GET') {
      const logId = pathname.split('/')[4];
      const log = db.prepare('SELECT * FROM inspection_logs WHERE id = ?').get(logId);
      if (!log) return sendJSON(res, 404, { error: '기록을 찾을 수 없습니다.' });
      return sendJSON(res, 200, log);
    }
    if (pathname.match(/^\/api\/inspections\/logs\/([^/]+)\/confirm$/) && method === 'POST') {
      const logId = pathname.split('/')[4];
      const log = db.prepare('SELECT is_confirmed, worker_name FROM inspection_logs WHERE id = ?').get(logId);
      if (!log) return sendJSON(res, 404, { error: '기록을 찾을 수 없습니다.' });
      const nextStatus = log.is_confirmed ? 0 : 1;
      db.prepare(`
        UPDATE inspection_logs
        SET is_confirmed = ?,
            confirmed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
            confirmed_by = CASE WHEN ? = 1 THEN '김관리 소장' ELSE NULL END
        WHERE id = ?
      `).run(nextStatus, nextStatus, nextStatus, logId);
      broadcastSSE('INSPECTION_LOG_SUBMITTED', { id: logId, is_confirmed: nextStatus, action: 'CONFIRM' });
      return sendJSON(res, 200, { success: true, is_confirmed: nextStatus, message: nextStatus ? '확인 완료되었습니다.' : '확인이 취소되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/logs\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const logId = pathname.split('/')[4];
      const { building, floor, location_name, status, notes, results, is_confirmed } = await parseBody(req);
      const resultsStr = results !== undefined ? (typeof results === 'object' ? JSON.stringify(results) : results) : null;
      db.prepare(`
        UPDATE inspection_logs
        SET building = COALESCE(?, building),
            floor = COALESCE(?, floor),
            location_name = COALESCE(?, location_name),
            status = COALESCE(?, status),
            notes = COALESCE(?, notes),
            results = COALESCE(?, results),
            is_confirmed = COALESCE(?, is_confirmed)
        WHERE id = ?
      `).run(building || null, floor || null, location_name || null, status || null, notes || null, resultsStr, is_confirmed !== undefined ? is_confirmed : null, logId);
      broadcastSSE('INSPECTION_LOG_SUBMITTED', { id: logId, action: 'UPDATE' });
      return sendJSON(res, 200, { success: true, message: '점검 결과가 수정되었습니다.' });
    }

    // ==========================================
    // 5. SMS & 블랙리스트 & 분석 API
    // ==========================================
    if (pathname === '/api/auth/sms/send' && method === 'POST') {
      const { phone } = await parseBody(req);
      if (!phone) return sendJSON(res, 400, { error: '전화번호를 입력하세요.' });
      const blocked = db.prepare('SELECT reason FROM blocked_users WHERE phone = ?').get(phone);
      if (blocked) {
        return sendJSON(res, 403, { error: 'BLOCKED', message: `신고 제한 연락처입니다: ${blocked.reason}` });
      }
      db.prepare(`
        INSERT OR REPLACE INTO sms_otps (phone, otp_code, expires_at)
        VALUES (?, '123456', datetime('now', '+10 minutes'))
      `).run(phone);
      return sendJSON(res, 200, { success: true, message: '인증번호(123456)가 발송되었습니다.' });
    }
    if (pathname === '/api/auth/sms/verify' && method === 'POST') {
      const { phone, otp } = await parseBody(req);
      const record = db.prepare('SELECT * FROM sms_otps WHERE phone = ?').get(phone);
      if (record && record.otp_code === otp) {
        return sendJSON(res, 200, { success: true, message: '인증이 완료되었습니다.' });
      }
      return sendJSON(res, 400, { error: 'INVALID_OTP', message: '인증번호가 일치하지 않습니다.' });
    }

    if (pathname === '/api/blocked-users' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl);
      const blocked = db.prepare('SELECT * FROM blocked_users WHERE company_id = ?').all(companyId);
      return sendJSON(res, 200, blocked);
    }
    if (pathname.match(/^\/api\/blocked-users\/([^/]+)$/) && method === 'DELETE') {
      const blockId = pathname.split('/')[3];
      db.prepare('DELETE FROM blocked_users WHERE id = ?').run(blockId);
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/analytics' && method === 'GET') {
      return sendJSON(res, 200, {
        total_tickets: 142,
        avg_lead_time_hours: 4.2,
        completion_rate: 92.4,
        bottleneck_step: '현장 조치 작업',
        lead_time_breakdown: [
          { step: '1. 접수 -> 관리자 지시', minutes: 35, percentage: 14 },
          { step: '2. 지시 -> 실무자 착수', minutes: 45, percentage: 18 },
          { step: '3. 현장 조치 작업 (최대 병목)', minutes: 126, percentage: 50 },
          { step: '4. 완료 보고 -> 최종 승인', minutes: 42, percentage: 18 }
        ],
        hotspots: [
          { location: '3층 남성화장실 (3F)', count: 7, details: '수전 불량 4건, 소변기 3건' },
          { location: '지하 2층 주차장 (B2)', count: 5, details: '배관 누수 3건, 조명 2건' },
          { location: '1층 로비 출입구 (1F)', count: 3, details: '회전문 센서 감도 3건' }
        ],
        group_performance: [
          { group: '환경/미화청결팀', total: 65, avg_time: '40분', rate: '98%' },
          { group: '영선/시설보수팀', total: 42, avg_time: '2.8시간', rate: '88%' },
          { group: '보안/방재안전팀', total: 20, avg_time: '25분', rate: '100%' },
          { group: '전기/기계설비팀', total: 15, avg_time: '2.1시간', rate: '93%' }
        ],
        worker_performance: [
          { name: '최영선 반장', role: '영선/시설보수팀', total: 38, rate: '94%', avg_time: '1.8시간' },
          { name: '이영선 기사', role: '영선/시설보수팀', total: 29, rate: '90%', avg_time: '2.4시간' },
          { name: '정미화 조장', role: '환경/미화청결팀', total: 45, rate: '100%', avg_time: '35분' },
          { name: '박청결 사원', role: '환경/미화청결팀', total: 32, rate: '97%', avg_time: '42분' },
          { name: '강전기 기사', role: '전기/기계설비팀', total: 21, rate: '91%', avg_time: '2.1시간' },
          { name: '박보안 대원', role: '보안/방재안전팀', total: 18, rate: '100%', avg_time: '20분' }
        ],
        outsourcing_summary: {
          total_outsourced: 18,
          in_progress: 5,
          completed: 13,
          internal_ratio: 87.3,
          outsource_ratio: 12.7,
          partners: [
            { partner: '삼원엘리베이터', count: 6, category: '승강기/특수', status: '정상진행' },
            { partner: '한양위생배관공사', count: 5, category: '시설보수/배관', status: '조치완료' },
            { partner: '대한소방방재엔지니어링', count: 4, category: '보안/소방설비', status: '조치완료' },
            { partner: '세기특수유리샷시', count: 3, category: '영선/도어', status: '부품대기' }
          ]
        }
      });
    }

    // ==========================================
    // ⭐️ [SUPER ADMIN] 1. 플랫폼 총괄 대시보드 통계 API
    // ==========================================
    if (pathname === '/api/super-admin/overview' && method === 'GET') {
      const companies = db.prepare('SELECT * FROM companies').all();
      const totalTickets = db.prepare('SELECT count(*) as count FROM tickets').get().count;
      const totalUsers = db.prepare('SELECT count(*) as count FROM users').get().count;
      
      let totalStorageUsed = 0;
      let freeCount = 0;
      let proCount = 0;
      let enterpriseCount = 0;

      companies.forEach(c => {
        totalStorageUsed += (c.storage_used_mb || 0);
        if (c.plan === 'FREE') freeCount++;
        else if (c.plan === 'PRO') proCount++;
        else enterpriseCount++;
      });

      return sendJSON(res, 200, {
        total_companies: companies.length,
        total_tickets: totalTickets,
        total_users: totalUsers,
        total_storage_used_mb: totalStorageUsed,
        plan_breakdown: { FREE: freeCount, PRO: proCount, ENTERPRISE: enterpriseCount },
        companies
      });
    }

    // ⭐️ [SUPER ADMIN] 2. 전체 고객사 목록 및 제어 현황
    if (pathname === '/api/super-admin/companies' && method === 'GET') {
      const companies = db.prepare('SELECT * FROM companies ORDER BY created_at DESC').all();
      return sendJSON(res, 200, companies.map(c => {
        let features = { checklists: true, realtime_sse: true, public_qr: true, outsource: true };
        try { if (c.enabled_features) features = typeof c.enabled_features === 'string' ? JSON.parse(c.enabled_features) : c.enabled_features; } catch(e){}
        return {
          ...c,
          enabled_features: features,
          usage_pct: Math.min(100, Math.round(((c.monthly_used_count || 0) / (c.monthly_ticket_limit || 100)) * 100)),
          storage_pct: Math.min(100, Math.round(((c.storage_used_mb || 0) / (c.storage_limit_mb || 500)) * 100))
        };
      }));
    }

    // ⭐️ [SUPER ADMIN] 3. 신규 회사 등록 (+100건 기본 부여)
    if (pathname === '/api/super-admin/companies' && method === 'POST') {
      const body = await parseBody(req);
      const { name, subdomain, logo_url, plan, admin_name, admin_email, admin_phone, monthly_ticket_limit, enabled_features } = body;
      
      const slug = (subdomain || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!name || !slug) {
        return sendJSON(res, 400, { error: '회사명과 서브도메인(영문 슬러그)은 필수입니다.' });
      }

      const existing = db.prepare('SELECT id FROM companies WHERE subdomain = ?').get(slug);
      if (existing) {
        return sendJSON(res, 400, { error: `서브도메인 [${slug}]은(는) 이미 사용 중입니다.` });
      }

      const id = 'comp_' + slug;
      const featStr = typeof enabled_features === 'object' ? JSON.stringify(enabled_features) : '{"checklists":true,"realtime_sse":true,"public_qr":true,"outsource":true}';
      const limit = parseInt(monthly_ticket_limit, 10) || 100;

      db.prepare(`
        INSERT INTO companies (
          id, name, subdomain, logo_url, plan, status,
          monthly_ticket_limit, monthly_used_count,
          storage_limit_mb, storage_used_mb, enabled_features,
          admin_name, admin_email, admin_phone
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, 0, 500, 5, ?, ?, ?, ?)
      `).run(
        id, name, slug, logo_url || 'FMS', plan || 'FREE',
        limit, featStr, admin_name || '관리자', admin_email || '', admin_phone || ''
      );

      // 기본 관리자 계정 생성
      const userId = 'user_admin_' + slug;
      db.prepare(`
        INSERT OR IGNORE INTO users (id, company_id, role, name, phone, email, password)
        VALUES (?, ?, 'ADMIN', ?, ?, ?, '1234')
      `).run(userId, id, admin_name || '관리자', admin_phone || '010-0000-0000', admin_email || `admin@${slug}.smartfms.kr`);

      seedDefaultTenantData(id);
      const baseOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || ('localhost:' + PORT)}`;

      return sendJSON(res, 201, {
        success: true,
        message: `[${name}] 회사가 성공적으로 등록되었습니다. 100건 무료 리포트가 부여되었습니다.`,
        subdomain: slug,
        web_url: `${baseOrigin}/?tenant=${slug}`,
        mobile_url: `${baseOrigin}/mobile?tenant=${slug}`
      });
    }

    // ⭐️ [SUPER ADMIN] 4. 기능 On/Off 토글 및 한도/플랜 수정
    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)$/) && method === 'PUT') {
      const companyId = pathname.split('/')[4];
      const body = await parseBody(req);
      const { plan, monthly_ticket_limit, status, storage_limit_mb, enabled_features } = body;

      const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
      if (!company) return sendJSON(res, 404, { error: '고객사를 찾을 수 없습니다.' });

      const featStr = enabled_features ? JSON.stringify(enabled_features) : company.enabled_features;
      const newLimit = monthly_ticket_limit !== undefined ? parseInt(monthly_ticket_limit, 10) : company.monthly_ticket_limit;
      const newPlan = plan || company.plan;
      const newStatus = status || company.status;
      const newStorage = storage_limit_mb !== undefined ? parseInt(storage_limit_mb, 10) : company.storage_limit_mb;

      db.prepare(`
        UPDATE companies 
        SET 
          plan = ?, 
          monthly_ticket_limit = ?, 
          status = ?, 
          storage_limit_mb = ?,
          enabled_features = ?
        WHERE id = ?
      `).run(newPlan, newLimit, newStatus, newStorage, featStr, companyId);

      return sendJSON(res, 200, { success: true, message: '고객사 설정 및 권한이 업데이트되었습니다.' });
    }

    // ⭐️ [SUPER ADMIN] 5. 원클릭 +100건 리포트 충전 API
    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)\/charge-100$/) && method === 'POST') {
      const companyId = pathname.split('/')[4];
      db.prepare('UPDATE companies SET monthly_ticket_limit = monthly_ticket_limit + 100 WHERE id = ?').run(companyId);
      const updated = db.prepare('SELECT monthly_ticket_limit, monthly_used_count FROM companies WHERE id = ?').get(companyId);
      return sendJSON(res, 200, {
        success: true,
        message: `+100건이 즉시 충전되었습니다. (총 한도: ${updated.monthly_ticket_limit}건)`,
        monthly_ticket_limit: updated.monthly_ticket_limit
      });
    }

    // ⭐️ [PUBLIC SIGNUP] 6. 홈페이지 자가 회원가입 및 즉시 온보딩 API
    if (pathname === '/api/signup' && method === 'POST') {
      const body = await parseBody(req);
      const { company_name, subdomain, admin_name, admin_email, admin_phone, password } = body;

      const slug = (subdomain || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!company_name || !slug || !admin_name || !admin_email) {
        return sendJSON(res, 400, { error: '필수 가입 정보를 모두 입력해주세요.' });
      }

      const existing = db.prepare('SELECT id FROM companies WHERE subdomain = ?').get(slug);
      if (existing) {
        return sendJSON(res, 400, { error: `입력하신 서브도메인 [${slug}]은(는) 이미 다른 고객사가 사용 중입니다. 다른 이름을 입력해주세요.` });
      }

      const companyId = 'comp_' + slug;
      // 100건 기본 발급
      db.prepare(`
        INSERT INTO companies (
          id, name, subdomain, logo_url, plan, status,
          monthly_ticket_limit, monthly_used_count,
          storage_limit_mb, storage_used_mb, enabled_features,
          admin_name, admin_email, admin_phone
        ) VALUES (?, ?, ?, 'FMS', 'FREE', 'ACTIVE', 100, 0, 500, 5, '{"checklists":true,"realtime_sse":true,"public_qr":true,"outsource":true}', ?, ?, ?)
      `).run(companyId, company_name, slug, admin_name, admin_email, admin_phone || '');

      // 관리자 계정 생성
      const userId = 'user_admin_' + slug;
      db.prepare(`
        INSERT INTO users (id, company_id, role, name, phone, email, password)
        VALUES (?, ?, 'ADMIN', ?, ?, ?, ?)
      `).run(userId, companyId, admin_name, admin_phone || '010-0000-0000', admin_email, password || '1234');

      seedDefaultTenantData(companyId);
      const baseOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || ('localhost:' + PORT)}`;

      return sendJSON(res, 201, {
        success: true,
        message: '회원가입이 완료되었습니다! 100개 무료 리포트/티켓이 즉시 부여되었습니다.',
        company: {
          id: companyId,
          name: company_name,
          subdomain: slug,
          free_limit: 100,
          web_url: `${baseOrigin}/?tenant=${slug}`,
          mobile_url: `${baseOrigin}/mobile?tenant=${slug}`
        }
      });
    }

    
    // ⭐️ [AUTH] 7. 통합 로그인 API
    if (pathname === '/api/login' && method === 'POST') {
      const body = await parseBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = (body.password || '').trim();

      if (!email) {
        return sendJSON(res, 400, { error: '이메일을 입력해주세요.' });
      }
      if (!password) {
        return sendJSON(res, 400, { error: '비밀번호를 입력해주세요.' });
      }

      // 1) 슈퍼 관리자 계정 체크
      if (email === 'admin@smartfms.kr' || email === 'superadmin@smartfms.kr' || email === 'admin') {
        if (password !== '1234' && password !== 'admin1234') {
          return sendJSON(res, 401, { error: '비밀번호가 일치하지 않습니다.' });
        }
        return sendJSON(res, 200, {
          success: true,
          role: 'SUPER_ADMIN',
          user: {
            name: '최고 총괄 관리자',
            email: 'admin@smartfms.kr',
            role_title: '통합 슈퍼 관리자'
          },
          redirect_url: '/super-admin'
        });
      }

      // 2) 회사 마스터 관리자 (companies 테이블 admin_email)
      let companyAdmin = db.prepare('SELECT * FROM companies WHERE LOWER(admin_email) = ?').get(email);
      if (!companyAdmin && (email === 'admin@central.kr' || email === 'admin@fms.kr')) {
        companyAdmin = db.prepare('SELECT * FROM companies WHERE subdomain = ?').get('central');
      }
      if (companyAdmin) {
        const adminUser = db.prepare("SELECT password FROM users WHERE company_id = ? AND (LOWER(email) = ? OR role = 'ADMIN') LIMIT 1").get(companyAdmin.id, email);
        const expectedPw = (adminUser && adminUser.password) ? adminUser.password : '1234';
        if (password !== expectedPw) {
          return sendJSON(res, 401, { error: '비밀번호가 일치하지 않습니다.' });
        }
        return sendJSON(res, 200, {
          success: true,
          role: 'COMPANY_ADMIN',
          user: {
            name: companyAdmin.admin_name || '마스터 관리자',
            email: companyAdmin.admin_email,
            company_id: companyAdmin.id,
            company_name: companyAdmin.name,
            subdomain: companyAdmin.subdomain,
            role_title: companyAdmin.name + ' 총괄 마스터'
          },
          redirect_url: '/?tenant=' + companyAdmin.subdomain
        });
      }

      // 3) 현장 작업자 및 일반 사용자 (users 테이블)
      const user = db.prepare('SELECT u.*, c.name as company_name, c.subdomain FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE LOWER(u.email) = ?').get(email);
      if (user) {
        const expectedPw = user.password || '1234';
        if (password !== expectedPw) {
          return sendJSON(res, 401, { error: '비밀번호가 일치하지 않습니다.' });
        }
        const isAdmin = user.role === 'ADMIN';
        return sendJSON(res, 200, {
          success: true,
          role: isAdmin ? 'COMPANY_ADMIN' : 'WORKER',
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            company_id: user.company_id,
            company_name: user.company_name,
            subdomain: user.subdomain,
            role_title: isAdmin ? '시설 관리자' : (user.role || '현장 점검원')
          },
          redirect_url: isAdmin ? '/?tenant=' + user.subdomain : '/mobile?tenant=' + user.subdomain + '&user_id=' + user.id
        });
      }

      return sendJSON(res, 401, { error: '등록되지 않은 계정입니다. 가입 정보를 확인해주세요.' });
    }

    // ⭐️ [SUPER ADMIN] 8. 회사 이름 / 도메인 / 비밀번호 개별 변경 & 삭제 API (JANDI 스타일)
    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)\/name$/) && method === 'PUT') {
      const companyId = pathname.split('/')[4];
      const { name } = await parseBody(req);
      if (!name) return sendJSON(res, 400, { error: '회사명을 입력해주세요.' });
      db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name.trim(), companyId);
      return sendJSON(res, 200, { success: true, message: '팀(회사) 이름이 변경되었습니다.' });
    }

    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)\/subdomain$/) && method === 'PUT') {
      const companyId = pathname.split('/')[4];
      const { subdomain } = await parseBody(req);
      const slug = (subdomain || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!slug) return sendJSON(res, 400, { error: '유효한 서브도메인을 입력해주세요.' });

      const dup = db.prepare('SELECT id FROM companies WHERE subdomain = ? AND id != ?').get(slug, companyId);
      if (dup) return sendJSON(res, 400, { error: '이미 사용 중인 서브도메인입니다.' });

      db.prepare('UPDATE companies SET subdomain = ? WHERE id = ?').run(slug, companyId);
      return sendJSON(res, 200, { success: true, message: '팀 도메인이 변경되었습니다.', subdomain: slug });
    }

    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)\/reset-password$/) && method === 'POST') {
      const companyId = pathname.split('/')[4];
      const { new_password } = await parseBody(req);
      const comp = db.prepare('SELECT admin_email, name FROM companies WHERE id = ?').get(companyId);
      if (!comp) return sendJSON(res, 404, { error: '회사를 찾을 수 없습니다.' });

      const pwd = new_password || '1234';
      db.prepare('UPDATE users SET password = ? WHERE company_id = ? AND (role = "ADMIN" OR email = ?)').run(pwd, companyId, comp.admin_email);
      return sendJSON(res, 200, { success: true, message: '[' + comp.name + '] 마스터 관리자 비밀번호가 성공적으로 초기화되었습니다.' });
    }

    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)$/) && method === 'DELETE') {
      const companyId = pathname.split('/')[4];
      const comp = db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId);
      if (!comp) return sendJSON(res, 404, { error: '회사를 찾을 수 없습니다.' });

      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM inspection_logs WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM inspection_templates WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM patrol_logs WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM blocked_users WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM tickets WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM locations WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM custom_roles WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM users WHERE company_id = ?').run(companyId);
        db.prepare('DELETE FROM companies WHERE id = ?').run(companyId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return sendJSON(res, 200, { success: true, message: '[' + comp.name + '] 회사와 관련된 모든 데이터가 안전하게 삭제되었습니다.' });
    }

    // ==========================================
    // 6. 정적 웹 페이지 서빙
    // ==========================================
    if (pathname === '/' || pathname === '/admin') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === '/super-admin' || pathname === '/super-admin/') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'super_admin.html'));
    }
    if (pathname === '/login' || pathname === '/login/') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'login.html'));
    }
    if (pathname === '/signup' || pathname === '/signup/') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'signup.html'));
    }
    if (pathname === '/mobile' || pathname === '/mobile/') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'mobile.html'));
    }
    if (pathname === '/report' || pathname === '/report/' || pathname === '/qr' || pathname === '/qr/') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'report.html'));
    }

    const resolvedStatic = path.resolve(PUBLIC_DIR, '.' + pathname);
    if (resolvedStatic.startsWith(PUBLIC_DIR) && fs.existsSync(resolvedStatic) && fs.statSync(resolvedStatic).isFile()) {
      return serveStaticFile(res, resolvedStatic);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');

  } catch (err) {
    console.error('Server Error:', err);
    sendJSON(res, 500, { error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 엔터프라이즈 FMS 서버 정상 가동 중 (PORT: ${PORT})`);
});
