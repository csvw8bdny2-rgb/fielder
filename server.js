const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { db, initDatabase, hashPassword, verifyPassword } = require('./db.js');

initDatabase();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ==========================================
// ⭐️ 쿠키 및 세션 관리 헬퍼 (인터넷 다고객 보안 체계)
// ==========================================
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const key = parts.shift().trim();
      const val = decodeURIComponent(parts.join('='));
      if (key) list[key] = val;
    });
  }
  return list;
}

function isMobileClientRequest(req, body = null) {
  if (!req) return false;
  const headerType = (req.headers['x-client-type'] || '').toLowerCase();
  if (headerType === 'mobile') return true;
  if (body && body.client === 'mobile') return true;
  try {
    const u = url.parse(req.url || '', true);
    if (u.query && u.query.client === 'mobile') return true;
  } catch (e) {}
  return false;
}

function getSession(req, forceClientType = null) {
  if (!req) return null;
  const cookies = parseCookies(req);
  const isMobile = forceClientType ? forceClientType === 'mobile' : isMobileClientRequest(req);
  let sessionId = isMobile ? cookies['fielder_mobile_session'] : cookies['fielder_session'];
  if (!sessionId && req.headers['authorization']) {
    const m = req.headers['authorization'].match(/^Bearer\s+(.+)$/i);
    if (m) sessionId = m[1];
  }
  if (!sessionId) return null;

  try {
    const sess = db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')").get(sessionId);
    if (!sess) return null;

    let user = null;
    if (sess.role === 'SUPER_ADMIN') {
      user = {
        id: 'super_admin',
        role: 'SUPER_ADMIN',
        name: '슈퍼관리자',
        email: process.env.SUPER_ADMIN_EMAIL || 'admin@fielder.kr',
        role_title: '슈퍼관리자'
      };
    } else {
      user = db.prepare(`
        SELECT u.id, u.company_id, u.role, u.name, u.phone, u.email, u.is_active, u.must_change_password, u.custom_role_id, r.name as role_name
        FROM users u
        LEFT JOIN custom_roles r ON u.custom_role_id = r.id
        WHERE u.id = ?
      `).get(sess.user_id);
    }
    if (!user || user.is_active === 0) {
      try { db.prepare("DELETE FROM sessions WHERE id = ?").run(sess.id); } catch (e) {}
      return null;
    }

    let company = null;
    if (sess.company_id) {
      company = db.prepare("SELECT * FROM companies WHERE id = ?").get(sess.company_id);
      if (!company || company.status === 'DELETED' || company.status === 'SUSPENDED' || company.status === 'CLOSED') {
        try { db.prepare("DELETE FROM sessions WHERE id = ?").run(sess.id); } catch (e) {}
        return null;
      }
    }

    return { sessionId: sess.id, user, role: sess.role, companyId: sess.company_id, company, clientType: isMobile ? 'mobile' : 'console' };
  } catch (err) {
    console.error('Session retrieval error:', err);
    return null;
  }
}

function createSession(userId, role, companyId) {
  const sessionId = 'sess_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, role, company_id, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    sessionId, userId, role, companyId || null, expiresAt
  );
  return { sessionId, expiresAt };
}

function deleteSession(reqOrSessionId, forceClientType = null) {
  if (!reqOrSessionId) return;
  let sessionId = null;
  if (typeof reqOrSessionId === 'string') {
    sessionId = reqOrSessionId;
  } else {
    const cookies = parseCookies(reqOrSessionId);
    const isMobile = forceClientType ? forceClientType === 'mobile' : isMobileClientRequest(reqOrSessionId);
    sessionId = isMobile ? cookies['fielder_mobile_session'] : cookies['fielder_session'];
  }
  if (sessionId) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
}

// ==========================================
// ⭐️ 실시간 Server-Sent Events (SSE) 브로드캐스트 풀 (테넌트 엄격 격리)
// ==========================================
const sseClients = new Set();

function broadcastSSE(type, payload = {}, targetCompanyId = null) {
  const effectiveCompanyId = targetCompanyId || (payload && payload.company_id) || null;
  if (!effectiveCompanyId) return;
  const message = `event: ${type}\ndata: ${JSON.stringify({ type, ...payload, timestamp: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    if (client.companyId !== effectiveCompanyId) {
      continue;
    }
    try {
      client.write(message);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// ==========================================
// ⭐️ 문자 / 카카오 알림톡 발송량 계량 및 Mock 어댑터 (실제 발송 연동 전 구조)
// ==========================================
function maskPhone(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)}-****-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-***-${digits.slice(6)}`;
  if (digits.length >= 4) return `***-****-${digits.slice(-4)}`;
  return '***';
}

function getMonthPrefix(yearMonth) {
  if (yearMonth && /^\d{4}-\d{2}$/.test(yearMonth)) return yearMonth;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getChannelCostUnits(channel) {
  const ch = String(channel || 'SMS').toUpperCase();
  if (ch === 'LMS') return 3;
  if (ch === 'MMS') return 6;
  return 1; // SMS, ALIMTALK
}

function getMonthlyMessageStats(companyId, yearMonth = null) {
  const prefix = getMonthPrefix(yearMonth);
  const comp = db.prepare('SELECT message_monthly_limit, message_extra_credit, message_enabled FROM companies WHERE id = ?').get(companyId) || {};
  const baseLimit = comp.message_monthly_limit !== null && comp.message_monthly_limit !== undefined ? Number(comp.message_monthly_limit) : 50;
  const extraCredit = Number(comp.message_extra_credit || 0);
  const enabled = comp.message_enabled !== undefined && comp.message_enabled !== null ? Number(comp.message_enabled) === 1 : true;
  const totalLimit = baseLimit + extraCredit;

  const rows = db.prepare(`
    SELECT channel, purpose, status, cost_units
    FROM message_logs
    WHERE company_id = ? AND substr(created_at, 1, 7) = ?
  `).all(companyId, prefix);

  let usedCount = 0;
  let totalUnits = 0;
  let smsCount = 0;
  let lmsCount = 0;
  let mmsCount = 0;
  let alimtalkCount = 0;
  let otpCount = 0;
  let failedCount = 0;

  for (const r of rows) {
    if (r.status === 'FAILED') {
      failedCount++;
      continue;
    }
    if (r.purpose === 'OTP') {
      otpCount++;
      continue;
    }
    usedCount++;
    totalUnits += Number(r.cost_units || 1);
    const ch = String(r.channel || '').toUpperCase();
    if (ch === 'SMS') smsCount++;
    else if (ch === 'LMS') lmsCount++;
    else if (ch === 'MMS') mmsCount++;
    else if (ch === 'ALIMTALK') alimtalkCount++;
  }

  const pct = totalLimit > 0 ? Math.round((usedCount / totalLimit) * 100) : (usedCount > 0 ? 100 : 0);
  const estimatedCostKrw = alimtalkCount * 8 + smsCount * 12 + lmsCount * 35 + mmsCount * 80;

  return {
    month: prefix,
    enabled,
    base_limit: baseLimit,
    extra_credit: extraCredit,
    total_limit: totalLimit,
    used_count: usedCount,
    total_units: totalUnits,
    usage_pct: pct,
    warning_80: enabled && totalLimit > 0 && pct >= 80 && pct < 100,
    warning_100: enabled && totalLimit > 0 && usedCount >= totalLimit,
    sms_count: smsCount,
    lms_count: lmsCount,
    mms_count: mmsCount,
    alimtalk_count: alimtalkCount,
    otp_count: otpCount,
    failed_count: failedCount,
    estimated_cost_krw: estimatedCostKrw
  };
}

function sendMessage(companyId, opts = {}) {
  const provider = (process.env.MESSAGE_PROVIDER || 'mock').toLowerCase();
  const channel = String(opts.channel || 'SMS').toUpperCase();
  const purpose = String(opts.purpose || 'GENERAL').toUpperCase();
  const recipientPhone = String(opts.recipient_phone || '').trim();
  const templateCode = opts.template_code || null;
  const contentPreview = String(opts.content_preview || '').slice(0, 120);
  const costUnits = getChannelCostUnits(channel);
  const nowIso = new Date().toISOString();

  if (!companyId || !recipientPhone) {
    return { ok: false, status: 'FAILED', fail_reason: 'MISSING_PARAMS' };
  }

  db.exec('BEGIN');
  try {
    const stats = getMonthlyMessageStats(companyId);
    if (!stats.enabled && purpose !== 'OTP') {
      db.prepare(`
        INSERT INTO message_logs (company_id, channel, purpose, recipient_phone, template_code, content_preview, provider, provider_msg_id, status, fail_reason, cost_units, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', 'MESSAGE_DISABLED', ?, ?)
      `).run(companyId, channel, purpose, recipientPhone, templateCode, contentPreview, provider, null, costUnits, nowIso);
      db.exec('COMMIT');
      return { ok: false, status: 'FAILED', fail_reason: 'MESSAGE_DISABLED' };
    }

    if (purpose !== 'OTP' && stats.total_limit > 0 && stats.used_count >= stats.total_limit) {
      db.prepare(`
        INSERT INTO message_logs (company_id, channel, purpose, recipient_phone, template_code, content_preview, provider, provider_msg_id, status, fail_reason, cost_units, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', 'MONTHLY_LIMIT_EXCEEDED', ?, ?)
      `).run(companyId, channel, purpose, recipientPhone, templateCode, contentPreview, provider, null, costUnits, nowIso);
      db.exec('COMMIT');
      return { ok: false, status: 'FAILED', fail_reason: 'MONTHLY_LIMIT_EXCEEDED' };
    }

    // Provider adapter: currently mock-only unless explicit external integration is enabled via env
    const providerMsgId = `${provider}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const finalStatus = 'SENT';
    db.prepare(`
      INSERT INTO message_logs (company_id, channel, purpose, recipient_phone, template_code, content_preview, provider, provider_msg_id, status, fail_reason, cost_units, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(companyId, channel, purpose, recipientPhone, templateCode, contentPreview, provider, providerMsgId, finalStatus, costUnits, nowIso);
    db.exec('COMMIT');
    return { ok: true, status: finalStatus, provider, provider_msg_id: providerMsgId, cost_units: costUnits };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    console.error('[sendMessage error]', err.message);
    return { ok: false, status: 'FAILED', fail_reason: 'INTERNAL_ERROR' };
  }
}

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
  if (cfIp) return String(cfIp).split(',')[0].trim();
  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim();
  const xff = req.headers['x-forwarded-for'];
  const trustProxy = Boolean(process.env.RENDER) || process.env.TRUST_PROXY === 'true';
  if (xff && trustProxy) {
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[0];
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ⭐️ 입력값 검증 및 로그인 시도 제한 헬퍼
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPhone(phone) {
  if (!phone) return true;
  return /^(01[016789]|02|0[3-9][0-9])-?\d{3,4}-?\d{4}$/.test(phone.trim());
}

function generateTempPassword(len = 10) {
  return crypto.randomBytes(8).toString('base64url').slice(0, len);
}

const loginAttemptMap = new Map();
function checkLoginRateLimit(key) {
  const now = Date.now();
  const rec = loginAttemptMap.get(key);
  if (!rec) return { blocked: false };
  if (now - rec.firstAttempt > 5 * 60 * 1000) {
    loginAttemptMap.delete(key);
    return { blocked: false };
  }
  if (rec.count >= 5) {
    const remainSec = Math.ceil((5 * 60 * 1000 - (now - rec.firstAttempt)) / 1000);
    return { blocked: true, message: `로그인 시도가 너무 많습니다. ${remainSec}초 후 다시 시도해주세요.` };
  }
  return { blocked: false };
}

function recordLoginFailure(key) {
  const now = Date.now();
  const rec = loginAttemptMap.get(key);
  if (!rec || now - rec.firstAttempt > 5 * 60 * 1000) {
    loginAttemptMap.set(key, { count: 1, firstAttempt: now });
  } else {
    rec.count += 1;
  }
}

function clearLoginFailures(key) {
  loginAttemptMap.delete(key);
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

function sendJSON(res, status, data, cookieHeader = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  if (cookieHeader) {
    headers['Set-Cookie'] = cookieHeader;
  }
  res.writeHead(status, headers);
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

// ⭐️ 테넌트 식별 및 데이터 격리 (대체값 central 누수 완전 제거)
function resolveCompanyId(parsedUrl, body, req) {
  if (req) {
    const auth = getSession(req);
    if (auth && auth.role !== 'SUPER_ADMIN' && auth.companyId) {
      return auth.companyId;
    }
  }
  let tenant = (parsedUrl && parsedUrl.query && parsedUrl.query.tenant) || (body && (body.tenant || body.company_id)) || '';
  if (!tenant && parsedUrl && parsedUrl.pathname) {
    const tMatch = parsedUrl.pathname.match(/^\/t\/([a-zA-Z0-9_-]+)/);
    if (tMatch) tenant = tMatch[1];
  }
  if (tenant && tenant !== 'null' && tenant !== 'undefined') {
    const cleanTenant = String(tenant).trim().toLowerCase();
    const row = db.prepare("SELECT id FROM companies WHERE (LOWER(subdomain) = ? OR id = ?) AND status != 'DELETED'").get(cleanTenant, String(tenant).trim());
    if (row && row.id) return row.id;
  }
  return null;
}

function getMonthlyTicketCount(companyId) {
  if (!companyId) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM tickets
    WHERE company_id = ?
      AND status != 'CANCELLED'
      AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(companyId);
  return row ? row.cnt : 0;
}

function checkTicketLimit(companyId) {
  const comp = db.prepare('SELECT monthly_ticket_limit, plan FROM companies WHERE id = ?').get(companyId);
  const used = getMonthlyTicketCount(companyId);
  if (comp && comp.plan === 'FREE' && used >= comp.monthly_ticket_limit) {
    return {
      allowed: false,
      message: `이번 달 무료 지시 한도(${comp.monthly_ticket_limit}건)를 모두 소진했습니다. 유료 플랜으로 업그레이드하세요.`
    };
  }
  return { allowed: true };
}

function consumeTicketLimit(companyId) {
  const used = getMonthlyTicketCount(companyId);
  db.prepare('UPDATE companies SET monthly_used_count = ? WHERE id = ?').run(used, companyId);
}

// ⭐️ 사이트 자동 생성 및 독립 프로비저닝 (센트럴타워 의존성 완전 제거)
function seedDefaultTenantData(companyId) {
  const roles = [
    { id: `role_maint_${companyId}`, name: '영선/시설보수팀', category: 'FACILITY' },
    { id: `role_clean_${companyId}`, name: '환경/미화청결팀', category: 'CLEANING' },
    { id: `role_sec_${companyId}`, name: '보안/방재안전팀', category: 'SECURITY' },
    { id: `role_elec_${companyId}`, name: '전기/기계설비팀', category: 'ELECTRICAL' }
  ];
  const insertRole = db.prepare('INSERT OR IGNORE INTO custom_roles (id, company_id, name, category, is_system) VALUES (?, ?, ?, ?, 1)');
  for (const r of roles) {
    insertRole.run(r.id, companyId, r.name, r.category);
  }

  // 신규 테넌트는 구역 빈 상태로 시작 (온보딩에서 직접 등록)

  const defaultTemplates = [
    {
      title: '화장실 정기 위생 점검표',
      role_name: '환경/미화청결팀',
      building: '본관',
      freq: 'DAILY',
      items: JSON.stringify([
        { id: 'item_1', type: 'CHECK', label: '바닥 물기 및 쓰레기 청소 완료', required: true },
        { id: 'item_2', type: 'YES_NO', label: '세면대 수전 및 변기 정상 작동 여부', required: true },
        { id: 'item_3', type: 'CHECKBOX', label: '보충 완료 소모품', options: ['휴지', '핸드타월', '물비누'], required: false }
      ]),
      desc: '화장실 정기 청결 상태 점검'
    },
    {
      title: '기계실 및 전기설비 일일 안전점검표',
      role_name: '전기/기계설비팀',
      building: '본관',
      freq: 'DAILY',
      items: JSON.stringify([
        { id: 'item_1', type: 'CHECK', label: '주 수배전반 전압/전류 지침 확인', required: true },
        { id: 'item_2', type: 'TEXT', label: '변압기 권선 온도(°C)', required: true },
        { id: 'item_3', type: 'RADIO', label: '이상 소음 및 진동 유무', options: ['양호(정상)', '주의(점검필요)', '불량(즉시조치)'], required: true }
      ]),
      desc: '전기실 수배전반 및 기계설비 상태 점검'
    },
    {
      title: '소방 방재 및 피난통로 점검표',
      role_name: '보안/방재안전팀',
      building: '본관',
      freq: 'DAILY',
      items: JSON.stringify([
        { id: 'item_1', type: 'CHECK', label: '소화전 앞 적치물 없음 및 호스 정상', required: true },
        { id: 'item_2', type: 'YES_NO', label: '비상구 방화문 자동 도어클로저 닫힘 상태', required: true },
        { id: 'item_3', type: 'RADIO', label: '유도등 점등 상태', options: ['정상 점등', '램프 교체 필요', '점멸 불량'], required: true }
      ]),
      desc: '소방 설비 및 비상 대피 통로 상태 점검'
    }
  ];

  const insertTmpl = db.prepare(`
    INSERT OR IGNORE INTO inspection_templates (id, company_id, title, target_role_id, target_role_name, building, frequency, items, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  defaultTemplates.forEach((t, idx) => {
    const matchedRole = roles.find(r => r.name === t.role_name) || roles[0];
    insertTmpl.run(`tmpl_${companyId}_${idx + 1}`, companyId, t.title, matchedRole.id, matchedRole.name, t.building, t.freq, t.items, t.desc);
  });
}

// ⭐️ 원스톱 프로비저닝 (회사 + 관리자 계정 + 기본 설정 일괄 생성)
function provisionTenant({ name, company_name, subdomain, adminName, admin_name, adminEmail, admin_email, adminPhone, admin_phone, password, password_hash, plan, monthlyTicketLimit, monthly_ticket_limit, enabledFeatures, enabled_features }) {
  const companyName = name || company_name;
  const adminN = adminName || admin_name || '관리자';
  const adminE = adminEmail || admin_email || '';
  const adminP = adminPhone || admin_phone || '';
  const slug = (subdomain || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const id = 'comp_' + slug;
  const features = enabledFeatures || enabled_features;
  const featStr = typeof features === 'object' ? JSON.stringify(features) : '{"checklists":true,"realtime_sse":true,"public_qr":true,"outsource":true}';
  const limit = parseInt(monthlyTicketLimit || monthly_ticket_limit, 10) || 100;

  const defaultBuildings = JSON.stringify(['본관']);
  const defaultFloors = JSON.stringify(['1F']);
  const defaultBuildingsConfig = JSON.stringify({
    '본관': { basement: 'NONE', ground: 1, hasRooftop: false, floors: ['1F'] }
  });

  db.prepare(`
    INSERT INTO companies (
      id, name, subdomain, logo_url, plan, status,
      monthly_ticket_limit, monthly_used_count,
      storage_limit_mb, storage_used_mb, enabled_features,
      admin_name, admin_email, admin_phone,
      buildings, floors, buildings_config
    ) VALUES (?, ?, ?, 'Fielder', ?, 'ACTIVE', ?, 0, 500, 5, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, companyName, slug, plan || 'FREE', limit, featStr,
    adminN, adminE || `admin@${slug}.fielder.kr`, adminP,
    defaultBuildings, defaultFloors, defaultBuildingsConfig
  );

  const userId = 'user_admin_' + slug;
  const pwdHash = password_hash || hashPassword(password || '1234');
  const mustChangePw = password_hash ? 0 : 1;
  db.prepare(`
    INSERT OR REPLACE INTO users (id, company_id, role, name, phone, email, password, is_active, must_change_password)
    VALUES (?, ?, 'ADMIN', ?, ?, ?, ?, 1, ?)
  `).run(userId, id, adminN, adminP || '010-0000-0000', adminE || `admin@${slug}.fielder.kr`, pwdHash, mustChangePw);

  seedDefaultTenantData(id);

  return {
    id,
    name: companyName,
    subdomain: slug,
    admin_name: adminN,
    admin_email: adminE,
    admin_user_id: userId,
    plan: plan || 'FREE',
    monthly_ticket_limit: limit
  };
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
    // ⭐️ 전역 API 인증 미들웨어 (모든 /api/* 보호, 공개 엔드포인트 제외)
    // ==========================================
    const publicApiPaths = [
      '/api/login',
      '/api/logout',
      '/api/signup',
      '/api/me',
      '/api/public/company',
      '/api/public/locations',
      '/api/auth/sms/send',
      '/api/auth/sms/verify',
      '/api/tickets/qr'
    ];
    if (pathname.startsWith('/api/') && !publicApiPaths.includes(pathname)) {
      const reqSession = getSession(req);
      if (!reqSession) {
        return sendJSON(res, 401, { error: '로그인이 필요합니다.' });
      }
      if (pathname.startsWith('/api/super-admin') && reqSession.role !== 'SUPER_ADMIN') {
        return sendJSON(res, 403, { error: '슈퍼 관리자 권한이 필요합니다.' });
      }
      const isManagerOrSuper = reqSession.role === 'SITE_MANAGER' || reqSession.role === 'ADMIN' || reqSession.role === 'SUPER_ADMIN';
      const isTicketAdminEndpoint =
        pathname === '/api/tickets/direct-dispatch' ||
        (pathname.match(/^\/api\/tickets\/[^/]+$/) && (method === 'PUT' || method === 'DELETE')) ||
        (pathname.match(/^\/api\/tickets\/[^/]+\/(close-direct|assign|approve|reject|cancel)$/) && method === 'POST');
      const isAdminOnlyEndpoint =
        isTicketAdminEndpoint ||
        pathname.startsWith('/api/users') ||
        pathname.startsWith('/api/roles') ||
        pathname.startsWith('/api/blocked-users') ||
        pathname === '/api/analytics' ||
        pathname === '/api/inspections/stats' ||
        pathname === '/api/inspections/statistics' ||
        (pathname.startsWith('/api/settings/') && method !== 'GET') ||
        (pathname.startsWith('/api/locations') && method !== 'GET') ||
        (pathname.startsWith('/api/inspections/templates') && method !== 'GET');
      if (isAdminOnlyEndpoint && !isManagerOrSuper) {
        return sendJSON(res, 403, { error: '회사 관리자 권한이 필요합니다.' });
      }
      // 슈퍼관리자 대리 접속(Impersonation) 쓰기 작업 감사 로그 기록
      if (reqSession.role === 'SUPER_ADMIN' && method !== 'GET' && !pathname.startsWith('/api/super-admin')) {
        try {
          const targetCid = resolveCompanyId(parsedUrl, null, req);
          db.prepare('INSERT INTO audit_logs (company_id, actor_id, actor_role, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(targetCid || null, reqSession.user.id, 'SUPER_ADMIN', 'IMPERSONATION_WRITE', 'API', pathname, `${method} ${pathname}`, new Date().toISOString());
        } catch (e) {}
      }
    }

    // ⭐️ 공개 회사 기본 정보 (로그인/QR 신고 화면용 최소 정보)
    if (pathname === '/api/public/company' && method === 'GET') {
      const tenant = (parsedUrl.query?.tenant || '').trim().toLowerCase();
      if (!tenant) return sendJSON(res, 400, { error: '테넌트 파라미터가 필요합니다.' });
      const comp = db.prepare("SELECT name, subdomain, logo_url FROM companies WHERE (LOWER(subdomain) = ? OR id = ?) AND status != 'DELETED'").get(tenant, tenant);
      if (!comp) return sendJSON(res, 404, { error: '존재하지 않는 회사입니다.' });
      return sendJSON(res, 200, comp);
    }

    // ⭐️ 공개 구역 단건/목록 조회 (비로그인 시 locId 지정 단건만 허용해 전체 구역 열거 차단)
    if (pathname === '/api/public/locations' && method === 'GET') {
      const tenant = (parsedUrl.query?.tenant || '').trim().toLowerCase();
      const locId = (parsedUrl.query?.locId || parsedUrl.query?.location || '').trim();
      if (!tenant) return sendJSON(res, 400, { error: '테넌트 파라미터가 필요합니다.' });
      const comp = db.prepare("SELECT id FROM companies WHERE (LOWER(subdomain) = ? OR id = ?) AND status != 'DELETED'").get(tenant, tenant);
      if (!comp) return sendJSON(res, 404, { error: '존재하지 않는 회사입니다.' });
      if (locId) {
        const locs = db.prepare('SELECT id, building, floor, name, category FROM locations WHERE company_id = ? AND id = ?').all(comp.id, locId);
        return sendJSON(res, 200, locs);
      }
      const reqSession = getSession(req);
      if (!reqSession || (reqSession.role !== 'SUPER_ADMIN' && reqSession.companyId !== comp.id)) {
        return sendJSON(res, 200, []);
      }
      const locs = db.prepare('SELECT id, building, floor, name, category FROM locations WHERE company_id = ? ORDER BY building ASC, floor ASC, name ASC').all(comp.id);
      return sendJSON(res, 200, locs);
    }

    // ⭐️ [P0-추가 B] 서버 자체 QR SVG/PNG 생성 API (외부 qrserver 의존 제거 + URL 통일)
    if (pathname.match(/^\/api\/locations\/([^/]+)\/qr\.(svg|png)$/) && method === 'GET') {
      const locId = pathname.split('/')[3];
      const ext = pathname.endsWith('.png') ? 'png' : 'svg';
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const loc = db.prepare('SELECT id, company_id, name, building, floor FROM locations WHERE id = ? AND company_id = ?').get(locId, companyId);
      if (!loc) return sendJSON(res, 404, { error: '해당 회사의 구역을 찾을 수 없습니다.' });

      const comp = db.prepare('SELECT subdomain FROM companies WHERE id = ?').get(companyId);
      const slug = (comp && comp.subdomain) || 'central';
      const baseOrigin = (process.env.PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || ('localhost:' + PORT)}`).replace(/\/$/, '');
      const targetUrl = `${baseOrigin}/report?locId=${encodeURIComponent(loc.id)}&tenant=${encodeURIComponent(slug)}`;
      const size = Math.min(800, Math.max(120, parseInt(parsedUrl.query?.size || '300', 10) || 300));

      if (ext === 'png') {
        const buf = await QRCode.toBuffer(targetUrl, { width: size, margin: 1 });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="qr-${loc.id}.png"`
        });
        return res.end(buf);
      } else {
        const svg = await QRCode.toString(targetUrl, { type: 'svg', width: size, margin: 1 });
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(svg);
      }
    }

    // ==========================================
    // ⭐️ 0. 실시간 이벤트 스트림 (Server-Sent Events - 회사별 엄격 격리)
    // ==========================================
    if (pathname === '/api/events' && method === 'GET') {
      const sseSession = getSession(req);
      if (!sseSession) {
        return sendJSON(res, 401, { error: '로그인이 필요합니다.' });
      }
      const sseCompanyId = sseSession.role === 'SUPER_ADMIN' ? resolveCompanyId(parsedUrl, null, req) : sseSession.companyId;
      if (!sseCompanyId) {
        return sendJSON(res, 400, { error: '테넌트 정보가 필요합니다.' });
      }
      res.companyId = sseCompanyId;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`event: CONNECTED\ndata: ${JSON.stringify({ message: '실시간 관제 스트림 연결 성공', company_id: sseCompanyId, timestamp: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      const keepAliveTimer = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepAliveTimer); sseClients.delete(res); }
      }, 20000);
      req.on('close', () => {
        clearInterval(keepAliveTimer);
        sseClients.delete(res);
      });
      return;
    }

    // ==========================================
    // 1. 기본 설정 (회사명/로고)
    // ==========================================
    if (pathname === '/api/settings/company' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 404, { error: '회사를 찾을 수 없습니다.' });
      const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
      if (!company) return sendJSON(res, 404, { error: '회사를 찾을 수 없습니다.' });
      let buildings = ['본관'];
      let floors = ['1F'];
      let buildingsConfig = {
        '본관': { basement: 'NONE', ground: 1, hasRooftop: false, floors: ['1F'] }
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

      // ⭐️ users 테이블의 관리자 최신 이름을 항상 우선 반영하여 헤더와 완벽 동기화
      const adminUser = db.prepare("SELECT name, email FROM users WHERE company_id = ? AND role = 'ADMIN' ORDER BY (id = 'user_admin') DESC, created_at ASC LIMIT 1").get(company.id);
      const effectiveAdminName = adminUser?.name || company.admin_name || '관리자';
      const effectiveAdminEmail = adminUser?.email || company.admin_email;

      return sendJSON(res, 200, {
        ...company,
        monthly_used_count: getMonthlyTicketCount(company.id),
        message_stats: getMonthlyMessageStats(company.id),
        admin_name: effectiveAdminName,
        admin_email: effectiveAdminEmail,
        buildings: Object.keys(buildingsConfig),
        floors,
        buildings_config: buildingsConfig
      });
    }
    if (pathname === '/api/settings/company' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트 정보를 확인할 수 없습니다.' });
      const { name, logo_url, buildings_config, buildings, floors, address, contact_phone } = body;
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
            buildings_config = COALESCE(?, buildings_config),
            address = COALESCE(?, address),
            contact_phone = COALESCE(?, contact_phone)
        WHERE id = ?
      `).run(
        name || null,
        logo_url || null,
        bStr || null,
        fStr || null,
        bcStr || null,
        address !== undefined ? String(address).trim() : null,
        contact_phone !== undefined ? String(contact_phone).trim() : null,
        companyId
      );
      broadcastSSE('COMPANY_UPDATED', { company_id: companyId, name, logo_url, buildings_config }, companyId);
      return sendJSON(res, 200, { success: true, message: '기본 설정이 저장되었습니다.' });
    }

    // ==========================================
    // 2. 구역 및 층수(Floor) / 건물동(Building) 위치 관리 API
    // ==========================================
    if (pathname === '/api/locations' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
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
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const { building, floor, name, code, description } = body;
      if (!name || !name.trim() || !floor) return sendJSON(res, 400, { error: '층수와 구역명을 입력하세요.' });
      const cleanName = name.trim();
      const id = 'loc_' + Date.now();
      const locCode = code || `LOC-${floor}-${Math.floor(10 + Math.random() * 90)}`;
      db.prepare(`
        INSERT INTO locations (id, company_id, building, floor, code, name, category, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'MAIN_TOWER', ?, ?)
      `).run(id, companyId, building || '본관', floor, locCode, cleanName, description || '', new Date().toISOString());
      broadcastSSE('LOCATION_UPDATED', { action: 'CREATE', id, company_id: companyId }, companyId);
      return sendJSON(res, 201, { success: true, id, message: '새 위치/구역이 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/locations\/([^/]+)$/) && method === 'DELETE') {
      const locId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const locRow = db.prepare('SELECT id FROM locations WHERE id = ? AND company_id = ?').get(locId, companyId);
      if (!locRow) return sendJSON(res, 404, { error: '구역을 찾을 수 없습니다.' });

      const ticketRef = db.prepare('SELECT COUNT(*) as cnt FROM tickets WHERE location_id = ? AND company_id = ?').get(locId, companyId).cnt;
      if (ticketRef > 0) {
        return sendJSON(res, 409, { error: '작업지시 또는 이력에서 사용 중인 구역은 삭제할 수 없습니다.' });
      }

      try {
        db.prepare('DELETE FROM locations WHERE id = ? AND company_id = ?').run(locId, companyId);
      } catch (delErr) {
        return sendJSON(res, 409, { error: '다른 데이터에서 참조 중인 구역은 삭제할 수 없습니다.' });
      }
      broadcastSSE('LOCATION_UPDATED', { action: 'DELETE', id: locId, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '위치가 삭제되었습니다.' });
    }
    if (pathname.match(/^\/api\/locations\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const locId = pathname.split('/')[3];
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const { building, floor, name, code, description } = body;
      db.prepare(`
        UPDATE locations
        SET building = ?, floor = ?, name = ?, code = ?, description = ?
        WHERE id = ? AND company_id = ?
      `).run(building || '본관', floor, (name || '').trim(), code || `LOC-${floor}-EDIT`, description || '', locId, companyId);
      broadcastSSE('LOCATION_UPDATED', { action: 'UPDATE', id: locId, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '구역 정보가 수정되었습니다.' });
    }

    // ==========================================
    // 3. 티켓 및 모니터링 API
    // ==========================================
    // [GET] /api/tickets (전체 티켓 및 그룹별 카운트 제공)
    if (pathname === '/api/tickets' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
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
        WHERE t.company_id = ? AND t.status != 'CANCELLED'
        ORDER BY t.created_at DESC
      `;
      const tickets = db.prepare(query).all(companyId);
      return sendJSON(res, 200, tickets);
    }

    // ⭐️ [POST] /api/tickets/direct-dispatch (관리자 직접 작업지시 등록 및 즉시 발송)
    if (pathname === '/api/tickets/direct-dispatch' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
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
        instruction_photo_url,
        due_date
      } = body;

      if (!title || !title.trim()) return sendJSON(res, 400, { error: '작업 지시 제목을 입력하세요.' });
      const cleanTitle = title.trim();

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
        finalLocId = firstLoc ? firstLoc.id : null;
      }

      if (!finalLocId) {
        return sendJSON(res, 400, { error: '등록된 구역이 없습니다. 설정에서 구역을 먼저 등록하거나 구역명을 입력해주세요.' });
      }

      // 서버 중복 생성 방지 (5초 이내 동일 제목/구역)
      const fiveSecAgo = new Date(Date.now() - 5000).toISOString();
      const dup = db.prepare('SELECT id FROM tickets WHERE company_id = ? AND title = ? AND location_id = ? AND created_at > ? AND status != \'CANCELLED\'').get(companyId, cleanTitle, finalLocId, fiveSecAgo);
      if (dup) {
        return sendJSON(res, 409, { error: '동일한 작업지시가 방금 등록되었습니다. 잠시 후 다시 시도하세요.' });
      }

      const reqSession = getSession(req);
      const actorName = (reqSession && reqSession.user && reqSession.user.name) || '관리자';
      const actorPhone = (reqSession && reqSession.user && reqSession.user.phone) || '';
      const nowIso = new Date().toISOString();

      const id = 't_' + Date.now();
      const ticketNo = 'T-DIR-' + Math.floor(1000 + Math.random() * 9000);

      db.prepare(`
        INSERT INTO tickets (
          id, ticket_no, company_id, location_id, category, title, description,
          reporter_type, reporter_name, reporter_phone, status,
          target_type, target_group_role_id, assignee_id,
          instruction_title, instruction_notes, instruction_photo_url, due_date,
          created_at, assigned_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          'ADMIN_DIRECT', ?, ?, 'IN_PROGRESS',
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?
        )
      `).run(
        id, ticketNo, companyId, finalLocId, category || 'FACILITY', cleanTitle, instruction_notes || '관리자 직접 현장 작업지시 발송 건',
        actorName, actorPhone,
        target_type || 'GROUP',
        target_group_role_id || null,
        target_type === 'INDIVIDUAL' ? assignee_id : null,
        cleanTitle,
        instruction_notes || '',
        instruction_photo_url || null,
        due_date || null,
        nowIso, nowIso
      );

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_CREATED', { ticket_id: id, title: cleanTitle, type: 'ADMIN_DIRECT', company_id: companyId }, companyId);
      return sendJSON(res, 201, { success: true, id, ticket_no: ticketNo, message: '관리자 직접 작업지시가 발송되었습니다.' });
    }

    // ⭐️ [PUT] /api/tickets/:id (작업지시 수정)
    if (pathname.match(/^\/api\/tickets\/([^/]+)$/) && method === 'PUT') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!existing) return sendJSON(res, 404, { error: '작업지시를 찾을 수 없습니다.' });

      const { title, instruction_notes, location_id, due_date, category, target_type, target_group_role_id, assignee_id } = body;
      const newTitle = (title && title.trim()) ? title.trim() : existing.title;

      const effTargetType = target_type || existing.target_type || 'GROUP';
      const effGroupId = effTargetType === 'GROUP'
        ? (target_group_role_id !== undefined ? (target_group_role_id || null) : existing.target_group_role_id)
        : null;
      const effAssigneeId = effTargetType === 'INDIVIDUAL'
        ? (assignee_id !== undefined ? (assignee_id || null) : existing.assignee_id)
        : null;

      db.prepare(`
        UPDATE tickets
        SET title = ?,
            instruction_title = ?,
            instruction_notes = ?,
            location_id = COALESCE(?, location_id),
            due_date = ?,
            category = COALESCE(?, category),
            target_type = ?,
            target_group_role_id = ?,
            assignee_id = ?
        WHERE id = ? AND company_id = ?
      `).run(
        newTitle,
        newTitle,
        instruction_notes !== undefined ? instruction_notes : existing.instruction_notes,
        location_id || null,
        due_date !== undefined ? (due_date || null) : existing.due_date,
        category || null,
        effTargetType,
        effGroupId,
        effAssigneeId,
        ticketId,
        companyId
      );

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '작업지시가 수정되었습니다.' });
    }

    // ⭐️ [DELETE] /api/tickets/:id (작업지시 취소 - Soft Delete)
    if (pathname.match(/^\/api\/tickets\/([^/]+)$/) && method === 'DELETE') {
      const ticketId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!existing) return sendJSON(res, 404, { error: '작업지시를 찾을 수 없습니다.' });

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE tickets
        SET status = 'CANCELLED', cancelled_at = ?, cancelled_reason = '관리자 취소'
        WHERE id = ? AND company_id = ?
      `).run(nowIso, ticketId, companyId);

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, status: 'CANCELLED', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '작업지시가 취소되었습니다.' });
    }

    // ⭐️ [GET] /api/tickets/:id/history (진행프로세스 상세 타임라인 히스토리)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/history$/) && method === 'GET') {
      const ticketId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
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
        WHERE t.id = ? AND t.company_id = ?
      `).get(ticketId, companyId);

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
          photo_url: t.photo_url || null
        },
        {
          step: 2,
          name: '관리자 작업 지시',
          status: t.assigned_at ? 'COMPLETED' : (t.status === 'PENDING' ? 'PENDING' : 'COMPLETED'),
          timestamp: t.assigned_at || t.created_at,
          actor: t.reporter_name || '관리자',
          target: t.target_type === 'INDIVIDUAL' ? `개인: ${t.assignee_name || '실무자'}` : `직무그룹: ${t.target_group_name || '전체 그룹'} (선착순)`,
          instruction_title: t.instruction_title || t.title,
          instruction_notes: t.instruction_notes || '',
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
          photo_url: t.completion_photo_url || t.unresolved_photo_url || null
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
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const ticketRow = db.prepare('SELECT id FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!ticketRow) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });
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
        WHERE id = ? AND company_id = ?
      `).run(closeComment, closeComment, ticketId, companyId);
      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, status: 'COMPLETED', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '마감 처리되었습니다.' });
    }

    // ⭐️ [POST] /api/tickets/:id/claim (실무자 현장 접수 - 선착순 할당 및 작업 착수)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/claim$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const reqSession = getSession(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const effWorkerId = (reqSession && reqSession.user && reqSession.user.id) || body.worker_id;
      const effWorkerName = (reqSession && reqSession.user && reqSession.user.name) || body.worker_name || '실무자';

      const existing = db.prepare('SELECT company_id, assignee_id, started_at, claimed_by_name FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!existing) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });
      if (existing.started_at && existing.assignee_id && existing.assignee_id !== effWorkerId) {
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
        WHERE id = ? AND company_id = ?
      `).run(effWorkerId, effWorkerName, effWorkerName, ticketId, companyId);

      broadcastSSE('TICKET_CLAIMED', { ticket_id: ticketId, worker_name: effWorkerName, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: `${effWorkerName}님이 작업을 정상 접수하였습니다. 현장 조치를 시작하세요.` });
    }

    // [POST] /api/tickets/:id/assign (작업 지시 발송)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/assign$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const { target_type, target_group_role_id, assignee_id, instruction_title, instruction_notes, instruction_photo_url } = body;
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const ticketRow = db.prepare('SELECT id FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!ticketRow) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });

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
        WHERE id = ? AND company_id = ?
      `).run(
        target_type || 'GROUP',
        target_group_role_id || null,
        target_type === 'INDIVIDUAL' ? assignee_id : null,
        instruction_title || '작업 지시',
        instruction_notes || '',
        instruction_photo_url || null,
        ticketId,
        companyId
      );

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_ASSIGNED', { ticket_id: ticketId, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '작업 지시가 발송되었습니다.' });
    }

    // [POST] /api/tickets/:id/unresolved (실무자 미해결 보고 ➔ 계속 대기)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/unresolved$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const reqSession = getSession(req);
      const { unresolved_reason, unresolved_photo_url } = body;
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const ticketRow = db.prepare('SELECT id FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!ticketRow) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });

      const effWorkerId = (reqSession && reqSession.user && reqSession.user.id) || body.worker_id || null;
      const effWorkerName = (reqSession && reqSession.user && reqSession.user.name) || body.worker_name || '실무자';

      db.prepare(`
        UPDATE tickets
        SET 
          status = 'IN_PROGRESS',
          resolution_type = 'UNRESOLVED',
          unresolved_reason = ?,
          unresolved_photo_url = ?,
          assignee_id = ?,
          completed_by_name = ?
        WHERE id = ? AND company_id = ?
      `).run(
        unresolved_reason || '현장 자재 부족으로 보류',
        unresolved_photo_url || '',
        effWorkerId,
        effWorkerName,
        ticketId,
        companyId
      );

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, resolution_type: 'UNRESOLVED', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '미해결 사유가 등록되어 계속 대기 상태로 유지됩니다.' });
    }

    // ⭐️ [POST] /api/tickets/:id/outsource (실무자 외주/아웃소싱 의뢰 처리)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/outsource$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const reqSession = getSession(req);
      const { partner_name, outsource_reason, estimated_date, photo_url } = body;
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const ticketRow = db.prepare('SELECT id FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!ticketRow) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });

      const effWorkerName = (reqSession && reqSession.user && reqSession.user.name) || body.worker_name || '실무자';
      const fullReason = `[외주의뢰: ${partner_name || '협력업체'}] ${outsource_reason || '전문 외주 출동 요청'}${estimated_date ? ` (예상일: ${estimated_date})` : ''}`;

      db.prepare(`
        UPDATE tickets
        SET 
          status = 'IN_PROGRESS',
          resolution_type = 'OUTSOURCING',
          unresolved_reason = ?,
          unresolved_photo_url = ?,
          completed_by_name = ?
        WHERE id = ? AND company_id = ?
      `).run(
        fullReason,
        photo_url || '',
        effWorkerName,
        ticketId,
        companyId
      );

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, resolution_type: 'OUTSOURCING', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '외주 및 아웃소싱 의뢰가 접수되었습니다.' });
    }

    // [POST] /api/tickets/:id/complete (실무자 조치 완료 보고 - 코멘트 필수, 사진 선택)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/complete$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const reqSession = getSession(req);
      const { completion_notes, completion_photo_url } = body;
      const cleanNotes = (completion_notes || '').trim();
      if (!cleanNotes) {
        return sendJSON(res, 400, { error: '조치 완료 보고 내용을 입력해주세요.' });
      }
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const ticketRow = db.prepare('SELECT id FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!ticketRow) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });

      const effWorkerId = (reqSession && reqSession.user && reqSession.user.id) || body.worker_id || null;
      const effWorkerName = (reqSession && reqSession.user && reqSession.user.name) || body.worker_name || '실무자';

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
        WHERE id = ? AND company_id = ?
      `).run(
        effWorkerName,
        effWorkerId,
        cleanNotes,
        completion_photo_url || '',
        ticketId,
        companyId
      );

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, status: 'WAITING_APPROVAL', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '조치 완료 보고가 등록되었습니다.' });
    }

    // ⭐️ [POST] /api/tickets/:id/approve (관리자 최종 종결 마감 승인 & 코멘트 기록)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/approve$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const ticketRow = db.prepare('SELECT id FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!ticketRow) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });
      const adminComment = (body.admin_notes || '').trim() || '관리자 현장 조치 상태 확인 완료. 정상 승인 종결함.';

      db.prepare(`
        UPDATE tickets
        SET 
          status = 'COMPLETED',
          admin_notes = ?,
          approved_at = datetime('now')
        WHERE id = ? AND company_id = ?
      `).run(adminComment, ticketId, companyId);

      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, status: 'COMPLETED', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '작업이 최종 마감 승인되었습니다.' });
    }

    // [POST] /api/tickets/:id/reject (반려)
    if (pathname.match(/^\/api\/tickets\/([^/]+)\/reject$/) && method === 'POST') {
      const ticketId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const ticketRow = db.prepare('SELECT id FROM tickets WHERE id = ? AND company_id = ?').get(ticketId, companyId);
      if (!ticketRow) return sendJSON(res, 404, { error: '해당 회사의 작업지시를 찾을 수 없습니다.' });
      db.prepare('DELETE FROM tickets WHERE id = ? AND company_id = ?').run(ticketId, companyId);
      broadcastSSE('TICKET_UPDATED', { ticket_id: ticketId, action: 'DELETE', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '신고가 반려되었습니다.' });
    }

    // [POST] /api/tickets/staff-report (현장 실무자 이상 신고 즉시 접수 -> 관제실 신규접수 반영)
    if (pathname === '/api/tickets/staff-report' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const { location_id, building, floor, location_name, category, title, description, reporter_name, reporter_phone, photo_url } = body;
      const cleanTitle = (title || '').trim();
      const cleanDesc = (description || '').trim();
      if (!cleanTitle && !cleanDesc) {
        return sendJSON(res, 400, { error: '이상 신고 내용 또는 제목을 입력해주세요.' });
      }

      const limitCheck = checkTicketLimit(companyId);
      if (!limitCheck.allowed) {
        return sendJSON(res, 403, { error: 'LIMIT_EXCEEDED', message: limitCheck.message });
      }

      let finalLocId = location_id || null;
      if (!finalLocId && (building || floor || location_name)) {
        const matched = db.prepare('SELECT id FROM locations WHERE company_id = ? AND name = ? LIMIT 1').get(companyId, location_name || '');
        if (matched) finalLocId = matched.id;
      }
      if (!finalLocId) {
        const firstLoc = db.prepare('SELECT id FROM locations WHERE company_id = ? LIMIT 1').get(companyId);
        if (firstLoc) {
          finalLocId = firstLoc.id;
        } else {
          const defaultLocId = 'loc_' + Date.now();
          db.prepare(`
            INSERT INTO locations (id, company_id, code, name, building, floor)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(defaultLocId, companyId, 'LOC-' + Date.now().toString().slice(-6), location_name || '현장 공용 구역', building || '본관', floor || '1F');
          finalLocId = defaultLocId;
        }
      }

      const id = 't_' + Date.now();
      const ticketNo = 'S-' + Math.floor(1000 + Math.random() * 9000);
      const locPrefix = [building, floor, location_name].filter(Boolean).join(' ');
      const finalTitle = cleanTitle || `${locPrefix ? `[${locPrefix}] ` : ''}현장 이상 신고`;
      const finalDesc = locPrefix && cleanDesc ? `[위치: ${locPrefix}] ${cleanDesc}` : (cleanDesc || finalTitle);

      db.prepare(`
        INSERT INTO tickets (
          id, ticket_no, company_id, location_id, category, title, description,
          reporter_type, reporter_name, reporter_phone, photo_url, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'STAFF_APP', ?, ?, ?, 'PENDING', datetime('now'))
      `).run(
        id,
        ticketNo,
        companyId,
        finalLocId,
        category || 'FACILITY',
        finalTitle,
        finalDesc,
        reporter_name || '현장 실무자',
        reporter_phone || '',
        photo_url || null
      );

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_CREATED', { ticket_id: id, title: finalTitle, type: 'STAFF_APP', company_id: companyId }, companyId);
      return sendJSON(res, 201, { success: true, id, ticket_no: ticketNo, message: '이상 신고가 관제실에 즉시 접수되었습니다.' });
    }

    // [POST] /api/tickets/qr (QR 간편 신고 접수 - 서버 인증토큰 및 구역 소속 검증 필수)
    if (pathname === '/api/tickets/qr' && method === 'POST') {
      const body = await parseBody(req);
      const { location_id, category, title, description, phone, reporter_name, photo_url, qr_verify_token } = body;
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) {
        return sendJSON(res, 400, { error: 'TENANT_REQUIRED', message: '회사(테넌트) 정보를 확인할 수 없습니다.' });
      }

      const cleanPhone = String(phone || '').trim();
      if (!cleanPhone || !isValidPhone(cleanPhone)) {
        return sendJSON(res, 400, { error: 'INVALID_PHONE', message: '올바른 휴대폰 번호를 입력해주세요.' });
      }

      // S1: 서버 발급 단발성 휴대폰 인증 토큰 검증
      const tokenVal = String(qr_verify_token || body.verification_token || '').trim();
      if (!tokenVal) {
        return sendJSON(res, 401, { error: 'PHONE_VERIFICATION_REQUIRED', message: '휴대폰 본인 인증이 필요합니다.' });
      }
      const tokenRow = db.prepare(`
        SELECT token, company_id, phone FROM qr_verify_tokens
        WHERE token = ? AND company_id = ? AND phone = ? AND used_at IS NULL AND expires_at > datetime('now')
      `).get(tokenVal, companyId, cleanPhone);
      if (!tokenRow) {
        return sendJSON(res, 401, { error: 'INVALID_VERIFICATION_TOKEN', message: '휴대폰 인증이 만료되었거나 유효하지 않습니다. 다시 인증해주세요.' });
      }

      const isBlocked = db.prepare('SELECT reason FROM blocked_users WHERE phone = ? AND company_id = ?').get(cleanPhone, companyId);
      if (isBlocked) {
        return sendJSON(res, 403, { error: 'BLOCKED_USER', message: `신고가 제한된 연락처입니다: ${isBlocked.reason}` });
      }

      const limitCheck = checkTicketLimit(companyId);
      if (!limitCheck.allowed) {
        return sendJSON(res, 403, { error: 'LIMIT_EXCEEDED', message: limitCheck.message });
      }

      // S4 & S5: 구역 소속 검증 (타사 구역 ID 차단 + 구역 없음 500 방지)
      let finalLocId = location_id ? String(location_id).trim() : '';
      if (finalLocId) {
        const validLoc = db.prepare('SELECT id FROM locations WHERE id = ? AND company_id = ?').get(finalLocId, companyId);
        if (!validLoc) {
          return sendJSON(res, 400, { error: 'INVALID_LOCATION', message: '해당 회사의 유효한 구역이 아닙니다.' });
        }
      } else {
        const firstLoc = db.prepare('SELECT id FROM locations WHERE company_id = ? LIMIT 1').get(companyId);
        if (!firstLoc) {
          return sendJSON(res, 400, { error: 'NO_LOCATIONS', message: '등록된 시설 구역이 없어 신고를 접수할 수 없습니다. 관리자에게 문의하세요.' });
        }
        finalLocId = firstLoc.id;
      }

      const cleanTitle = String(title || '').trim() || 'QR 현장 불편 신고';
      const id = 't_' + Date.now();
      const ticketNo = 'T-' + Math.floor(1000 + Math.random() * 9000);

      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE qr_verify_tokens SET used_at = datetime('now') WHERE token = ?`).run(tokenVal);
        db.prepare(`
          INSERT INTO tickets (
            id, ticket_no, company_id, location_id, category, title, description, 
            reporter_type, reporter_name, reporter_phone, photo_url, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PUBLIC_QR', ?, ?, ?, 'PENDING', datetime('now'))
        `).run(id, ticketNo, companyId, finalLocId, category || 'FACILITY', cleanTitle, description || '', reporter_name || '방문객', cleanPhone, photo_url || null);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (e) {}
        throw err;
      }

      consumeTicketLimit(companyId);
      broadcastSSE('TICKET_CREATED', { ticket_id: id, title: cleanTitle, type: 'PUBLIC_QR', company_id: companyId }, companyId);
      return sendJSON(res, 201, { success: true, ticket_no: ticketNo, message: '신고가 접수되었습니다.' });
    }

    // ==========================================
    // 4. 사용자 & 역할 관리 API
    // ==========================================
    if (pathname === '/api/users' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const users = db.prepare(`
        SELECT u.id, u.company_id, u.role, u.name, u.phone, u.email, u.custom_role_id, u.is_active, u.must_change_password, u.created_at, u.last_login_at, r.name as role_name 
        FROM users u 
        LEFT JOIN custom_roles r ON u.custom_role_id = r.id 
        WHERE u.company_id = ?
        ORDER BY (u.role = 'ADMIN') DESC, u.created_at DESC
      `).all(companyId);
      return sendJSON(res, 200, users);
    }
    if (pathname === '/api/users' && method === 'POST') {
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const { name, email, password, phone, role, custom_role_id } = body;
      if (!name || !name.trim()) return sendJSON(res, 400, { error: '이름을 입력하세요.' });
      if (!email || !isValidEmail(email)) return sendJSON(res, 400, { error: '유효한 이메일 주소(로그인 ID)를 입력하세요.' });
      if (phone && !isValidPhone(phone)) return sendJSON(res, 400, { error: '올바른 휴대폰 번호 형식을 입력하세요. (예: 010-1234-5678)' });
      if ((role || 'WORKER') === 'WORKER' && !custom_role_id) {
        return sendJSON(res, 400, { error: '현장 실무자는 소속 직무 그룹을 반드시 선택해야 합니다.' });
      }
      
      const cleanName = name.trim();
      const cleanPhone = (phone || '').trim();
      const cleanEmail = email.trim().toLowerCase();

      // 중복 이메일 및 중복 이름 명시적 오류 반환 (덮어쓰기 방지)
      const dupEmail = db.prepare('SELECT id FROM users WHERE company_id = ? AND LOWER(email) = ?').get(companyId, cleanEmail);
      if (dupEmail) {
        return sendJSON(res, 409, { error: `이미 등록된 이메일 [${cleanEmail}] 입니다.` });
      }
      const dupName = db.prepare('SELECT id FROM users WHERE company_id = ? AND LOWER(TRIM(name)) = ?').get(companyId, cleanName.toLowerCase());
      if (dupName) {
        return sendJSON(res, 409, { error: `이미 동일한 이름 [${cleanName}]의 사용자가 존재합니다. 구분할 수 있는 이름을 입력하세요.` });
      }

      let rawPw = (password && password.trim()) ? password.trim() : '';
      let isTemp = 0;
      if (rawPw) {
        if (rawPw.length < 8) {
          return sendJSON(res, 400, { error: '비밀번호는 최소 8자 이상이어야 합니다.' });
        }
      } else {
        rawPw = generateTempPassword(10);
        isTemp = 1;
      }

      const pwdVal = hashPassword(rawPw);
      const id = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const nowIso = new Date().toISOString();

      let validRoleId = null;
      if (custom_role_id && String(custom_role_id).trim()) {
        const roleRow = db.prepare('SELECT id FROM custom_roles WHERE id = ? AND company_id = ?').get(String(custom_role_id).trim(), companyId);
        if (!roleRow) {
          return sendJSON(res, 400, { error: '유효하지 않은 직무 그룹입니다.' });
        }
        validRoleId = roleRow.id;
      }

      try {
        db.prepare(`
          INSERT INTO users (id, company_id, role, name, email, password, phone, custom_role_id, is_active, must_change_password, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(id, companyId, role || 'WORKER', cleanName, cleanEmail, pwdVal, cleanPhone, validRoleId, isTemp, nowIso);
      } catch (insertErr) {
        console.error('User insert error:', insertErr);
        if (String(insertErr.message || '').includes('UNIQUE')) {
          return sendJSON(res, 409, { error: `이미 등록된 이메일 [${cleanEmail}] 입니다.` });
        }
        return sendJSON(res, 400, { error: '사용자 등록에 실패했습니다. 입력값을 확인해주세요.' });
      }

      if (role === 'ADMIN') {
        db.prepare("UPDATE companies SET admin_name = ? WHERE id = ? AND (admin_name IS NULL OR admin_name = '')").run(cleanName, companyId);
      }

      broadcastSSE('USER_UPDATED', { action: 'CREATE', id, company_id: companyId }, companyId);
      return sendJSON(res, 201, {
        success: true,
        id,
        temp_password: isTemp ? rawPw : undefined,
        message: isTemp
          ? '사용자가 등록되었습니다. 안내된 임시 비밀번호를 전달하세요. (첫 로그인 시 변경 필수)'
          : '사용자가 등록되었습니다.'
      });
    }
    if (pathname.match(/^\/api\/users\/([^/]+)$/) && method === 'DELETE') {
      const userId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const targetUser = db.prepare('SELECT id, role FROM users WHERE id = ? AND company_id = ?').get(userId, companyId);
      if (!targetUser) return sendJSON(res, 404, { error: '사용자를 찾을 수 없습니다.' });

      if (targetUser.role === 'ADMIN') {
        const adminCnt = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE company_id = ? AND role = 'ADMIN' AND is_active = 1").get(companyId).cnt;
        if (adminCnt <= 1) {
          return sendJSON(res, 409, { error: '최소 1명의 활성 관리자가 필요하므로 삭제할 수 없습니다.' });
        }
      }

      const ticketRef = db.prepare('SELECT COUNT(*) as cnt FROM tickets WHERE assignee_id = ?').get(userId).cnt;
      const patrolRef = db.prepare('SELECT COUNT(*) as cnt FROM patrol_logs WHERE user_id = ?').get(userId).cnt;
      if (ticketRef > 0 || patrolRef > 0) {
        return sendJSON(res, 409, { error: '작업지시 또는 순찰 이력이 있는 사용자는 삭제할 수 없습니다. 비활성화(퇴사/중지) 기능을 이용해주세요.' });
      }

      try {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ? AND company_id = ?').run(userId, companyId);
      } catch (delErr) {
        return sendJSON(res, 409, { error: '다른 데이터에서 참조 중인 사용자는 삭제할 수 없습니다. 비활성화 기능을 이용해주세요.' });
      }
      broadcastSSE('USER_UPDATED', { action: 'DELETE', id: userId, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '사용자가 삭제되었습니다.' });
    }
    if (pathname.match(/^\/api\/users\/([^/]+)\/toggle-active$/) && method === 'PUT') {
      const userId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const targetUser = db.prepare('SELECT id, is_active, role FROM users WHERE id = ? AND company_id = ?').get(userId, companyId);
      if (!targetUser) return sendJSON(res, 404, { error: '사용자를 찾을 수 없습니다.' });
      const nextActive = targetUser.is_active ? 0 : 1;
      db.prepare('UPDATE users SET is_active = ? WHERE id = ? AND company_id = ?').run(nextActive, userId, companyId);
      broadcastSSE('USER_UPDATED', { action: 'TOGGLE_ACTIVE', id: userId, is_active: nextActive, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, is_active: nextActive, message: nextActive ? '계정이 활성화되었습니다.' : '계정이 비활성화되었습니다.' });
    }
    if (pathname.match(/^\/api\/users\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const userId = pathname.split('/')[3];
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const { name, email, password, phone, role, custom_role_id } = body;
      
      const targetUser = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(userId, companyId);
      if (!targetUser) return sendJSON(res, 404, { error: '사용자를 찾을 수 없습니다.' });

      const newName = (name && name.trim()) ? name.trim() : targetUser.name;
      const newEmail = (email && email.trim()) ? email.trim().toLowerCase() : targetUser.email;
      const newPhone = phone !== undefined ? phone.trim() : (targetUser.phone || '');
      const newRole = role || targetUser.role || 'WORKER';
      const newRoleId = custom_role_id !== undefined ? (custom_role_id || null) : targetUser.custom_role_id;

      if (!isValidEmail(newEmail)) return sendJSON(res, 400, { error: '유효한 이메일 형식을 입력하세요.' });
      if (newPhone && !isValidPhone(newPhone)) return sendJSON(res, 400, { error: '올바른 휴대폰 번호 형식을 입력하세요.' });
      if (newRole === 'WORKER' && !newRoleId) {
        return sendJSON(res, 400, { error: '현장 실무자는 소속 직무 그룹을 반드시 선택해야 합니다.' });
      }

      const dupEmail = db.prepare('SELECT id FROM users WHERE company_id = ? AND LOWER(email) = ? AND id != ?').get(companyId, newEmail, userId);
      if (dupEmail) return sendJSON(res, 409, { error: `이미 다른 사용자가 사용 중인 이메일 [${newEmail}] 입니다.` });

      let pwdVal = '';
      if (password && password.trim()) {
        if (password.trim().length < 8) return sendJSON(res, 400, { error: '비밀번호는 최소 8자 이상이어야 합니다.' });
        pwdVal = hashPassword(password.trim());
      }

      db.prepare(`
        UPDATE users
        SET name = ?, email = ?, password = CASE WHEN ? != '' THEN ? ELSE password END, phone = ?, role = ?, custom_role_id = ?
        WHERE id = ? AND company_id = ?
      `).run(newName, newEmail, pwdVal, pwdVal, newPhone, newRole, newRoleId, userId, companyId);

      // ⭐️ 관리자(ADMIN)이거나 user_admin인 경우 companies 테이블의 admin_name 및 admin_email 도 즉시 동기화!
      if (targetUser.role === 'ADMIN' || userId === 'user_admin' || newRole === 'ADMIN') {
        db.prepare(`
          UPDATE companies
          SET admin_name = COALESCE(?, admin_name),
              admin_email = COALESCE(?, admin_email)
          WHERE id = ?
        `).run(newName, newEmail, companyId);
      }

      broadcastSSE('USER_UPDATED', { action: 'UPDATE', id: userId, name: newName, email: newEmail, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '사용자 정보가 수정되었습니다.' });
    }
    if (pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/) && method === 'POST') {
      const userId = pathname.split('/')[3];
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const targetUser = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(userId, companyId);
      if (!targetUser) return sendJSON(res, 404, { error: '사용자를 찾을 수 없습니다.' });

      const rawPw = (body.newPassword && body.newPassword.trim()) ? body.newPassword.trim() : generateTempPassword(10);
      if (rawPw.length < 8) {
        return sendJSON(res, 400, { error: '새 비밀번호는 최소 8자 이상이어야 합니다.' });
      }

      db.prepare('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ? AND company_id = ?').run(hashPassword(rawPw), userId, companyId);
      broadcastSSE('USER_UPDATED', { action: 'PASSWORD_RESET', id: userId, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, temp_password: rawPw, message: '임시 비밀번호가 재설정되었습니다. (첫 로그인 시 변경 필수)' });
    }

    // ==========================================
    // ⭐️ 4-1. 모바일 현장순찰 일지 API
    // ==========================================
    if (pathname === '/api/patrol' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
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
      const reqSession = getSession(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const { building, floor, location_name, check_items, notes, photo_url } = body;
      const sessionUserId = (reqSession && reqSession.user && reqSession.user.id) || 'user_worker';
      const sessionWorkerName = (reqSession && reqSession.user && reqSession.user.name) || '현장 실무자';

      let parsedItems = {};
      if (typeof check_items === 'string') {
        try { parsedItems = JSON.parse(check_items); } catch (e) { parsedItems = {}; }
      } else if (check_items && typeof check_items === 'object') {
        parsedItems = check_items;
      }
      const entries = Object.entries(parsedItems);
      if (entries.length === 0) {
        return sendJSON(res, 400, { error: '최소 1개 이상의 순찰 점검 항목에 응답해주세요.' });
      }
      const hasBad = entries.some(([, v]) => String(v).includes('불량') || String(v).toUpperCase() === 'BAD' || v === false);
      const cleanNotes = String(notes || '').trim();
      if (hasBad && !cleanNotes && !photo_url) {
        return sendJSON(res, 400, { error: '불량 항목이 있는 경우 특이사항 메모 또는 현장 사진 첨부가 필수입니다.' });
      }

      const id = 'pt_' + Date.now();
      db.prepare(`
        INSERT INTO patrol_logs (id, company_id, user_id, worker_name, building, floor, location_name, check_items, notes, photo_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        companyId,
        sessionUserId,
        sessionWorkerName,
        building || '',
        floor || '',
        location_name || '순찰 구역',
        JSON.stringify(parsedItems),
        cleanNotes,
        photo_url || ''
      );
      broadcastSSE('PATROL_SUBMITTED', { id, worker_name: sessionWorkerName, location_name, company_id: companyId }, companyId);
      return sendJSON(res, 201, { success: true, id, message: '현장 순찰 점검 일지가 등록되었습니다.' });
    }

    if (pathname === '/api/roles' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
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
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const cleanName = (body.name || '').trim();
      const category = body.category || 'FACILITY';
      if (!cleanName) return sendJSON(res, 400, { error: '직무 그룹명을 입력하세요.' });
      if (cleanName.length > 30) return sendJSON(res, 400, { error: '직무 그룹명은 최대 30자까지 입력할 수 있습니다.' });

      const dup = db.prepare('SELECT id FROM custom_roles WHERE company_id = ? AND LOWER(TRIM(name)) = ?').get(companyId, cleanName.toLowerCase());
      if (dup) return sendJSON(res, 409, { error: `이미 존재하는 직무 그룹명 [${cleanName}] 입니다.` });

      const id = 'role_' + Date.now();
      db.prepare('INSERT INTO custom_roles (id, company_id, name, category, is_system) VALUES (?, ?, ?, ?, 0)').run(
        id, companyId, cleanName, category
      );
      return sendJSON(res, 201, { success: true, id, name: cleanName, message: '직무 그룹이 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/roles\/([^/]+)$/) && method === 'DELETE') {
      const roleId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const roleRow = db.prepare('SELECT id, is_system FROM custom_roles WHERE id = ? AND company_id = ?').get(roleId, companyId);
      if (!roleRow) return sendJSON(res, 404, { error: '직무 그룹을 찾을 수 없습니다.' });
      if (roleRow.is_system) return sendJSON(res, 409, { error: '기본 시스템 직무 그룹은 삭제할 수 없습니다.' });

      const userRef = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE custom_role_id = ? AND company_id = ?').get(roleId, companyId).cnt;
      const ticketRef = db.prepare('SELECT COUNT(*) as cnt FROM tickets WHERE target_group_role_id = ? AND company_id = ?').get(roleId, companyId).cnt;
      const tmplRef = db.prepare('SELECT COUNT(*) as cnt FROM inspection_templates WHERE target_role_id = ? AND company_id = ?').get(roleId, companyId).cnt;

      if (userRef > 0 || ticketRef > 0 || tmplRef > 0) {
        return sendJSON(res, 409, { error: '작업지시, 점검표 또는 소속 사용자에서 사용 중인 직무 그룹은 삭제할 수 없습니다.' });
      }

      try {
        db.prepare('DELETE FROM custom_roles WHERE id = ? AND company_id = ?').run(roleId, companyId);
      } catch (delErr) {
        return sendJSON(res, 409, { error: '다른 데이터에서 참조 중인 직무 그룹은 삭제할 수 없습니다.' });
      }
      return sendJSON(res, 200, { success: true, message: '직무 그룹이 삭제되었습니다.' });
    }
    if (pathname.match(/^\/api\/roles\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const roleId = pathname.split('/')[3];
      const body = await parseBody(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const cleanName = (body.name || '').trim();
      const category = body.category || 'FACILITY';
      if (!cleanName) return sendJSON(res, 400, { error: '직무 그룹명을 입력하세요.' });
      if (cleanName.length > 30) return sendJSON(res, 400, { error: '직무 그룹명은 최대 30자까지 입력할 수 있습니다.' });

      const dup = db.prepare('SELECT id FROM custom_roles WHERE company_id = ? AND LOWER(TRIM(name)) = ? AND id != ?').get(companyId, cleanName.toLowerCase(), roleId);
      if (dup) return sendJSON(res, 409, { error: `이미 존재하는 직무 그룹명 [${cleanName}] 입니다.` });

      db.prepare(`
        UPDATE custom_roles
        SET name = ?, category = ?
        WHERE id = ? AND company_id = ?
      `).run(cleanName, category, roleId, companyId);
      return sendJSON(res, 200, { success: true, message: '직무 그룹이 수정되었습니다.' });
    }

    // ==========================================
    // ⭐️ 4-2. 현장 점검표 템플릿 및 점검 수행 이력 API
    // ==========================================
    if (pathname === '/api/inspections/templates' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
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
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
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
      broadcastSSE('INSPECTION_TEMPLATE_UPDATED', { action: 'CREATE', id, title, company_id: companyId }, companyId);
      return sendJSON(res, 201, { success: true, id, message: '점검표 양식이 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/templates\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const tmplId = pathname.split('/')[4];
      const { title, target_role_id, target_role_name, building, frequency, items, description } = await parseBody(req);
      const tmplRow = db.prepare('SELECT company_id FROM inspection_templates WHERE id = ?').get(tmplId);
      const companyId = (tmplRow && tmplRow.company_id) || resolveCompanyId(parsedUrl, null, req);
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
      broadcastSSE('INSPECTION_TEMPLATE_UPDATED', { action: 'UPDATE', id: tmplId, title, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '점검표 양식이 수정되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/templates\/([^/]+)$/) && method === 'DELETE') {
      const tmplId = pathname.split('/')[4];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      try {
        db.prepare('DELETE FROM inspection_templates WHERE id = ? AND company_id = ?').run(tmplId, companyId);
      } catch (delErr) {
        return sendJSON(res, 409, { error: '점검 이력에서 참조 중인 점검표 양식은 삭제할 수 없습니다.' });
      }
      broadcastSSE('INSPECTION_TEMPLATE_UPDATED', { action: 'DELETE', id: tmplId, company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '점검표 양식이 삭제되었습니다.' });
    }

    // ⭐️ 점검 일정(주기별 완료/누락 현황) API
    if (pathname === '/api/inspections/schedule' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const kstTodayStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const dateStr = (parsedUrl.query?.date || kstTodayStr).slice(0, 10);
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
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const todayStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
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
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const logs = db.prepare(`
        SELECT * FROM inspection_logs
        WHERE company_id = ?
        ORDER BY completed_at DESC
      `).all(companyId);
      return sendJSON(res, 200, logs);
    }
    if (pathname === '/api/inspections/logs' && method === 'POST') {
      const body = await parseBody(req);
      const reqSession = getSession(req);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const limitCheck = checkTicketLimit(companyId);
      if (!limitCheck.allowed) {
        return sendJSON(res, 403, { error: 'LIMIT_EXCEEDED', message: limitCheck.message });
      }
      const { template_id, template_title, role_name, building, floor, location_name, results, notes, photo_url } = body;
      const sessionWorkerId = (reqSession && reqSession.user && reqSession.user.id) || null;
      const sessionWorkerName = (reqSession && reqSession.user && reqSession.user.name) || '현장 실무자';

      let parsedResults = {};
      if (typeof results === 'string') {
        try { parsedResults = JSON.parse(results); } catch (e) { parsedResults = {}; }
      } else if (results && typeof results === 'object') {
        parsedResults = results;
      }

      const resultValues = Object.values(parsedResults);
      if (resultValues.length === 0) {
        return sendJSON(res, 400, { error: '모든 필수 점검 항목에 응답해주세요.' });
      }
      if (template_id) {
        const tmpl = db.prepare('SELECT items FROM inspection_templates WHERE id = ? AND company_id = ?').get(template_id, companyId);
        if (tmpl && tmpl.items) {
          try {
            const tmplItems = JSON.parse(tmpl.items);
            if (Array.isArray(tmplItems) && tmplItems.length > 0 && resultValues.length < tmplItems.length) {
              return sendJSON(res, 400, { error: `점검표 항목(${tmplItems.length}개)을 모두 입력해주세요.` });
            }
          } catch (e) {}
        }
      }

      // S9: 서버에서 결과 기반 status 강제 계산 (하드코딩 '양호' 제거)
      const isBad = resultValues.some(v => {
        const s = String(v || '').trim();
        return s === '불량' || s === '이상' || s === '아니오' || s.toUpperCase() === 'BAD' || s.toUpperCase() === 'FAIL' || v === false;
      });
      const isWarn = !isBad && resultValues.some(v => String(v || '').trim() === '주의');
      const computedStatus = isBad ? '불량' : (isWarn ? '주의' : '양호');
      const cleanNotes = String(notes || '').trim();
      if (isBad && !cleanNotes && !photo_url) {
        return sendJSON(res, 400, { error: '불량 항목이 포함된 경우 메모 또는 현장 사진 첨부가 필수입니다.' });
      }

      const id = 'ins_log_' + Date.now();
      const resultsStr = JSON.stringify(parsedResults);
      db.prepare(`
        INSERT INTO inspection_logs (id, company_id, template_id, template_title, worker_id, worker_name, role_name, building, floor, location_name, results, status, notes, photo_url, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        companyId,
        template_id || null,
        template_title || '현장 점검표',
        sessionWorkerId,
        sessionWorkerName,
        role_name || '직무 미지정',
        building || '',
        floor || '',
        location_name || '현장 구역',
        resultsStr,
        computedStatus,
        cleanNotes,
        photo_url || ''
      );
      consumeTicketLimit(companyId);
      broadcastSSE('INSPECTION_LOG_SUBMITTED', { id, worker_name: sessionWorkerName, template_title, location_name, status: computedStatus, company_id: companyId }, companyId);
      return sendJSON(res, 201, { success: true, id, status: computedStatus, message: '현장 점검 결과가 성공적으로 등록되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/logs\/([^/]+)$/) && method === 'GET') {
      const logId = pathname.split('/')[4];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const log = db.prepare('SELECT * FROM inspection_logs WHERE id = ? AND company_id = ?').get(logId, companyId);
      if (!log) return sendJSON(res, 404, { error: '기록을 찾을 수 없습니다.' });
      return sendJSON(res, 200, log);
    }
    if (pathname.match(/^\/api\/inspections\/logs\/([^/]+)\/confirm$/) && method === 'POST') {
      const logId = pathname.split('/')[4];
      const reqSession = getSession(req);
      const isManager = reqSession && (reqSession.role === 'SITE_MANAGER' || reqSession.role === 'ADMIN' || reqSession.role === 'SUPER_ADMIN');
      if (!isManager) return sendJSON(res, 403, { error: '관리자 권한이 필요합니다.' });
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const log = db.prepare('SELECT company_id, is_confirmed, worker_name FROM inspection_logs WHERE id = ? AND company_id = ?').get(logId, companyId);
      if (!log) return sendJSON(res, 404, { error: '기록을 찾을 수 없습니다.' });
      const nextStatus = log.is_confirmed ? 0 : 1;
      const confirmerName = (reqSession.user && reqSession.user.name) || '관리자';
      db.prepare(`
        UPDATE inspection_logs
        SET is_confirmed = ?,
            confirmed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
            confirmed_by = CASE WHEN ? = 1 THEN ? ELSE NULL END
        WHERE id = ? AND company_id = ?
      `).run(nextStatus, nextStatus, nextStatus, confirmerName, logId, companyId);
      broadcastSSE('INSPECTION_LOG_SUBMITTED', { id: logId, is_confirmed: nextStatus, action: 'CONFIRM', company_id: log.company_id }, log.company_id);
      return sendJSON(res, 200, { success: true, is_confirmed: nextStatus, message: nextStatus ? '확인 완료되었습니다.' : '확인이 취소되었습니다.' });
    }
    if (pathname.match(/^\/api\/inspections\/logs\/([^/]+)$/) && (method === 'PUT' || method === 'POST')) {
      const logId = pathname.split('/')[4];
      const reqSession = getSession(req);
      const isManager = reqSession && (reqSession.role === 'SITE_MANAGER' || reqSession.role === 'ADMIN' || reqSession.role === 'SUPER_ADMIN');
      if (!isManager) return sendJSON(res, 403, { error: '관리자 권한이 필요합니다.' });
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });

      const logRow = db.prepare('SELECT company_id, results, status FROM inspection_logs WHERE id = ? AND company_id = ?').get(logId, companyId);
      if (!logRow) return sendJSON(res, 404, { error: '기록을 찾을 수 없습니다.' });

      const { building, floor, location_name, notes, results, is_confirmed } = await parseBody(req);
      let resultsStr = null;
      let nextComputedStatus = null;
      if (results !== undefined) {
        let parsedRes = {};
        if (typeof results === 'string') {
          try { parsedRes = JSON.parse(results); } catch (e) { parsedRes = {}; }
        } else if (results && typeof results === 'object') {
          parsedRes = results;
        }
        resultsStr = JSON.stringify(parsedRes);
        const vals = Object.values(parsedRes);
        const isBad = vals.some(v => {
          const s = String(v || '').trim();
          return s === '불량' || s === '이상' || s === '아니오' || s.toUpperCase() === 'BAD' || s.toUpperCase() === 'FAIL' || v === false;
        });
        const isWarn = !isBad && vals.some(v => String(v || '').trim() === '주의');
        nextComputedStatus = isBad ? '불량' : (isWarn ? '주의' : '양호');
      }

      db.prepare(`
        UPDATE inspection_logs
        SET building = COALESCE(?, building),
            floor = COALESCE(?, floor),
            location_name = COALESCE(?, location_name),
            status = COALESCE(?, status),
            notes = COALESCE(?, notes),
            results = COALESCE(?, results),
            is_confirmed = COALESCE(?, is_confirmed)
        WHERE id = ? AND company_id = ?
      `).run(building || null, floor || null, location_name || null, nextComputedStatus, notes || null, resultsStr, is_confirmed !== undefined ? is_confirmed : null, logId, companyId);
      broadcastSSE('INSPECTION_LOG_SUBMITTED', { id: logId, action: 'UPDATE', company_id: companyId }, companyId);
      return sendJSON(res, 200, { success: true, message: '점검 결과가 수정되었습니다.' });
    }

    // ==========================================
    // 5. SMS & 블랙리스트 & 분석 API
    // ==========================================
    // S7: OTP 발송 횟수 제한 (번호/IP별) + 로그 마스킹
    if (!global._otpRateMap) global._otpRateMap = new Map();
    if (pathname === '/api/auth/sms/send' && method === 'POST') {
      const body = await parseBody(req);
      const { phone } = body;
      const cleanPhone = String(phone || '').trim();
      if (!cleanPhone || !isValidPhone(cleanPhone)) return sendJSON(res, 400, { error: '올바른 휴대폰 번호를 입력하세요.' });

      const clientIp = getClientIp(req);
      const nowMs = Date.now();
      const prune = (arr, winMs) => arr.filter(t => nowMs - t < winMs);
      const phoneKey = `p:${cleanPhone}`;
      const ipKey = `ip:${clientIp}`;
      const pHits = prune(global._otpRateMap.get(phoneKey) || [], 24 * 3600 * 1000);
      const pMinHits = pHits.filter(t => nowMs - t < 60 * 1000);
      const ipMinHits = prune(global._otpRateMap.get(ipKey) || [], 60 * 1000);
      if (pMinHits.length >= 3 || pHits.length >= 10 || ipMinHits.length >= 10) {
        return sendJSON(res, 429, { error: 'RATE_LIMITED', message: '인증번호 요청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.' });
      }
      pHits.push(nowMs);
      ipMinHits.push(nowMs);
      global._otpRateMap.set(phoneKey, pHits);
      global._otpRateMap.set(ipKey, ipMinHits);

      const blocked = db.prepare('SELECT reason FROM blocked_users WHERE phone = ?').get(cleanPhone);
      if (blocked) {
        return sendJSON(res, 403, { error: 'BLOCKED', message: `신고 제한 연락처입니다: ${blocked.reason}` });
      }
      const otpCode = crypto.randomInt(100000, 999999).toString();
      db.prepare(`
        INSERT OR REPLACE INTO sms_otps (phone, otp_code, expires_at)
        VALUES (?, ?, datetime('now', '+5 minutes'))
      `).run(cleanPhone, otpCode);
      const companyId = resolveCompanyId(parsedUrl, body, req);
      if (companyId) {
        sendMessage(companyId, {
          channel: 'SMS',
          purpose: 'OTP',
          recipient_phone: cleanPhone,
          content_preview: '[Fielder] 본인확인 인증번호 6자리 발송'
        });
      }
      console.log(`[SMS OTP] phone=${maskPhone(cleanPhone)} issued=true`);
      return sendJSON(res, 200, { success: true, message: '인증번호 6자리가 발송되었습니다. (5분 내 입력)' });
    }
    if (pathname === '/api/auth/sms/verify' && method === 'POST') {
      const body = await parseBody(req);
      const { phone, otp, code, tenant } = body;
      const cleanPhone = String(phone || '').trim();
      const otpVal = String(otp || code || '').trim();
      if (!cleanPhone || !isValidPhone(cleanPhone)) {
        return sendJSON(res, 400, { error: 'INVALID_PHONE', message: '올바른 휴대폰 번호를 입력해주세요.' });
      }
      // S2 & Item 4: QA 우회는 env가 명시적으로 'true'이고 DB 상의 회사 subdomain이 qa/test일 때만 허용
      const companyId = resolveCompanyId(parsedUrl, body, req);
      const dbComp = companyId ? db.prepare("SELECT id, subdomain FROM companies WHERE id = ? AND status != 'DELETED'").get(companyId) : null;
      const dbSlug = (dbComp && dbComp.subdomain ? dbComp.subdomain : '').toLowerCase();
      const qaBypassEnabled = process.env.ENABLE_QA_OTP_BYPASS === 'true';
      const isQaContext = qaBypassEnabled && dbSlug && (dbSlug.includes('qa') || dbSlug.includes('test'));

      const issueVerifyToken = () => {
        const token = 'qrt_' + crypto.randomBytes(24).toString('hex');
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO qr_verify_tokens (token, company_id, phone, expires_at, created_at)
          VALUES (?, ?, ?, datetime('now', '+10 minutes'), ?)
        `).run(token, companyId || 'unknown', cleanPhone, nowIso);
        return token;
      };

      if (isQaContext && otpVal === '000000') {
        const token = issueVerifyToken();
        return sendJSON(res, 200, { success: true, qa_bypass: true, verification_token: token, message: 'QA 테스트 인증이 완료되었습니다.' });
      }
      const record = db.prepare("SELECT * FROM sms_otps WHERE phone = ? AND expires_at > datetime('now')").get(cleanPhone);
      if (record && record.otp_code === otpVal) {
        db.prepare('DELETE FROM sms_otps WHERE phone = ?').run(cleanPhone);
        const token = issueVerifyToken();
        return sendJSON(res, 200, { success: true, verification_token: token, message: '인증이 완료되었습니다.' });
      }
      return sendJSON(res, 400, { error: 'INVALID_OTP', message: '인증번호가 일치하지 않거나 만료되었습니다.' });
    }

    if (pathname === '/api/blocked-users' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      const blocked = db.prepare('SELECT * FROM blocked_users WHERE company_id = ?').all(companyId);
      return sendJSON(res, 200, blocked);
    }
    if (pathname.match(/^\/api\/blocked-users\/([^/]+)$/) && method === 'DELETE') {
      const blockId = pathname.split('/')[3];
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) return sendJSON(res, 400, { error: '테넌트를 식별할 수 없습니다.' });
      db.prepare('DELETE FROM blocked_users WHERE id = ? AND company_id = ?').run(blockId, companyId);
      return sendJSON(res, 200, { success: true });
    }

    // ⭐️ [ANALYTICS] 실시간 테넌트 통계 및 보고서 API (DB 실시간 연동)
    if (pathname === '/api/analytics' && method === 'GET') {
      const companyId = resolveCompanyId(parsedUrl, null, req);
      if (!companyId) {
        return sendJSON(res, 404, { error: '고객사 테넌트를 찾을 수 없습니다.' });
      }

      const total = db.prepare("SELECT count(*) as count FROM tickets WHERE company_id = ? AND status != 'CANCELLED'").get(companyId).count;
      const completed = db.prepare("SELECT count(*) as count FROM tickets WHERE company_id = ? AND status = 'COMPLETED'").get(companyId).count;
      const inProgress = db.prepare("SELECT count(*) as count FROM tickets WHERE company_id = ? AND status = 'IN_PROGRESS'").get(companyId).count;
      const pending = db.prepare("SELECT count(*) as count FROM tickets WHERE company_id = ? AND status = 'PENDING'").get(companyId).count;

      const completionRate = total > 0 ? Math.round((completed / total) * 1000) / 10 : 0;

      // S8: 단계별 실제 소요시간(분) 계산 (SQLite julianday 기반 실측)
      const formatMinutesKor = (mins) => {
        if (mins === null || mins === undefined || isNaN(mins)) return '-';
        const m = Math.max(0, Math.round(mins));
        if (m >= 60) {
          const h = Math.floor(m / 60);
          const r = m % 60;
          return r > 0 ? `${h}시간 ${r}분` : `${h}시간`;
        }
        return `${m}분`;
      };

      const stepAgg = db.prepare(`
        SELECT
          AVG(CASE WHEN assigned_at IS NOT NULL AND created_at IS NOT NULL AND julianday(assigned_at) > julianday(created_at)
                   THEN (julianday(assigned_at) - julianday(created_at)) * 1440.0 END) as s1_min,
          COUNT(CASE WHEN assigned_at IS NOT NULL AND created_at IS NOT NULL AND julianday(assigned_at) > julianday(created_at) THEN 1 END) as s1_n,
          AVG(CASE WHEN started_at IS NOT NULL AND assigned_at IS NOT NULL AND julianday(started_at) > julianday(assigned_at)
                   THEN (julianday(started_at) - julianday(assigned_at)) * 1440.0 END) as s2_min,
          COUNT(CASE WHEN started_at IS NOT NULL AND assigned_at IS NOT NULL AND julianday(started_at) > julianday(assigned_at) THEN 1 END) as s2_n,
          AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL AND julianday(completed_at) > julianday(started_at)
                   THEN (julianday(completed_at) - julianday(started_at)) * 1440.0 END) as s3_min,
          COUNT(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL AND julianday(completed_at) > julianday(started_at) THEN 1 END) as s3_n,
          AVG(CASE WHEN approved_at IS NOT NULL AND completed_at IS NOT NULL AND julianday(approved_at) > julianday(completed_at)
                   THEN (julianday(approved_at) - julianday(completed_at)) * 1440.0 END) as s4_min,
          COUNT(CASE WHEN approved_at IS NOT NULL AND completed_at IS NOT NULL AND julianday(approved_at) > julianday(completed_at) THEN 1 END) as s4_n,
          AVG(CASE WHEN status = 'COMPLETED' AND completed_at IS NOT NULL AND created_at IS NOT NULL AND julianday(completed_at) >= julianday(created_at)
                   THEN (julianday(completed_at) - julianday(created_at)) * 1440.0 END) as overall_min,
          COUNT(CASE WHEN status = 'COMPLETED' AND completed_at IS NOT NULL THEN 1 END) as overall_n
        FROM tickets
        WHERE company_id = ? AND status != 'CANCELLED'
      `).get(companyId) || {};

      const avgMinutes = stepAgg.overall_n > 0 && stepAgg.overall_min !== null ? Math.round(stepAgg.overall_min) : 0;
      const avgHours = stepAgg.overall_n > 0 ? (avgMinutes / 60).toFixed(1) : '0.0';

      // 취약/다발 구역 분석 (Hotspots)
      const hotspotsRaw = db.prepare(`
        SELECT l.name as loc_name, l.floor, count(t.id) as count
        FROM tickets t
        LEFT JOIN locations l ON t.location_id = l.id
        WHERE t.company_id = ? AND t.status != 'CANCELLED'
        GROUP BY t.location_id
        ORDER BY count DESC
        LIMIT 5
      `).all(companyId);

      const hotspots = hotspotsRaw.map(h => ({
        location: `${h.loc_name || '기본 구역'} (${h.floor || '1F'})`,
        count: h.count,
        details: `민원/작업 ${h.count}건 발생`
      }));

      // 직무 그룹별 처리 현황 (target_group_role_id 기준 실측 집계)
      const roles = db.prepare('SELECT id, name, category FROM custom_roles WHERE company_id = ?').all(companyId);
      const groupPerformance = roles.map(r => {
        const tStats = db.prepare(`
          SELECT count(*) as total,
                 SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as comp,
                 AVG(CASE WHEN status = 'COMPLETED' AND completed_at IS NOT NULL AND created_at IS NOT NULL AND julianday(completed_at) >= julianday(created_at)
                          THEN (julianday(completed_at) - julianday(created_at)) * 1440.0 END) as avg_min
          FROM tickets
          WHERE company_id = ? AND target_group_role_id = ? AND status != 'CANCELLED'
        `).get(companyId, r.id);

        const gTotal = tStats.total || 0;
        const gComp = tStats.comp || 0;
        const gRate = gTotal > 0 ? Math.round((gComp / gTotal) * 100) + '%' : '-';
        const gAvg = gComp > 0 && tStats.avg_min !== null ? formatMinutesKor(tStats.avg_min) : '-';
        return {
          group: r.name,
          total: gTotal,
          completed: gComp,
          avg_time: gAvg,
          rate: gRate
        };
      });

      // 실무자 개인별 조치 성과 (실측 리드타임)
      const workers = db.prepare("SELECT id, name, role FROM users WHERE company_id = ? AND role != 'ADMIN'").all(companyId);
      const workerPerformance = workers.map(w => {
        const wStats = db.prepare(`
          SELECT count(*) as total,
                 SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as comp,
                 AVG(CASE WHEN status = 'COMPLETED' AND completed_at IS NOT NULL AND created_at IS NOT NULL AND julianday(completed_at) >= julianday(created_at)
                          THEN (julianday(completed_at) - julianday(created_at)) * 1440.0 END) as avg_min
          FROM tickets
          WHERE company_id = ? AND status != 'CANCELLED' AND (assignee_id = ? OR claimed_by_name = ? OR completed_by_name = ?)
        `).get(companyId, w.id, w.name, w.name);

        const wTotal = wStats.total || 0;
        const wComp = wStats.comp || 0;
        const wRate = wTotal > 0 ? Math.round((wComp / wTotal) * 100) + '%' : '-';
        const wAvg = wComp > 0 && wStats.avg_min !== null ? formatMinutesKor(wStats.avg_min) : '-';

        return {
          name: w.name,
          role: w.role || '현장 실무자',
          total: wTotal,
          completed_count: wComp,
          assigned_count: wTotal,
          completion_rate: wRate,
          rate: wRate,
          avg_lead_time: wAvg,
          avg_time: wAvg
        };
      });

      // 외주 및 자체 조치 분석 (Outsourcing summary)
      const outsourceTickets = db.prepare(`
        SELECT count(*) as total,
               SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as comp,
               SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) as prog
        FROM tickets
        WHERE company_id = ? AND status != 'CANCELLED' AND (target_type = 'OUTSOURCE' OR resolution_type = 'OUTSOURCING' OR category = 'ELEVATOR')
      `).get(companyId);

      const outTotal = outsourceTickets.total || 0;
      const outComp = outsourceTickets.comp || 0;
      const outProg = outsourceTickets.prog || 0;
      const internalCount = Math.max(0, total - outTotal);
      const outRatio = total > 0 ? Math.round((outTotal / total) * 1000) / 10 : 0;
      const internalRatio = total > 0 ? Math.round((internalCount / total) * 1000) / 10 : null;

      // 단계별 실측 breakdown (완료 건 및 유효 단계 표본이 있을 때만 생성)
      const rawSteps = [
        { key: '1. 접수 -> 관리자 지시', min: Math.round(stepAgg.s1_min || 0), n: stepAgg.s1_n || 0 },
        { key: '2. 지시 -> 실무자 착수', min: Math.round(stepAgg.s2_min || 0), n: stepAgg.s2_n || 0 },
        { key: '3. 현장 조치 작업', min: Math.round(stepAgg.s3_min || 0), n: stepAgg.s3_n || 0 },
        { key: '4. 완료 보고 -> 최종 승인', min: Math.round(stepAgg.s4_min || 0), n: stepAgg.s4_n || 0 }
      ];
      const totalStepMin = rawSteps.reduce((acc, s) => acc + s.min, 0);
      let leadTimeBreakdown = [];
      let bottleneckStep = null;
      if (completed > 0 && totalStepMin > 0) {
        let maxIdx = 0;
        rawSteps.forEach((s, idx) => {
          if (s.min > rawSteps[maxIdx].min) maxIdx = idx;
        });
        bottleneckStep = rawSteps[maxIdx].key.replace(/^\d+\.\s*/, '');
        leadTimeBreakdown = rawSteps.map((s, idx) => ({
          step: idx === maxIdx ? `${s.key} (최대 병목)` : s.key,
          minutes: s.min,
          sample_count: s.n,
          percentage: Math.round((s.min / totalStepMin) * 100)
        }));
      }

      return sendJSON(res, 200, {
        total_tickets: total,
        completed_tickets: completed,
        avg_lead_time_hours: completed > 0 ? parseFloat(avgHours) : null,
        completion_rate: completionRate,
        bottleneck_step: bottleneckStep,
        lead_time_breakdown: leadTimeBreakdown,
        hotspots,
        group_performance: groupPerformance,
        worker_performance: workerPerformance,
        outsourcing_summary: {
          total_outsourced: outTotal,
          in_progress: outProg,
          completed: outComp,
          internal_count: internalCount,
          internal_ratio: internalRatio,
          outsource_ratio: outRatio,
          partners: outTotal > 0 ? [
            { partner: '승강기/외주 협력사', count: outTotal, category: '외주/특수', status: '정상가동' }
          ] : []
        }
      });
    }

    // ==========================================
    // ⭐️ [SUPER ADMIN GUARD] 슈퍼 관리자 API 접근 통제
    // ==========================================
    if (pathname.startsWith('/api/super-admin/')) {
      const session = getSession(req);
      if (!session || session.role !== 'SUPER_ADMIN') {
        return sendJSON(res, 403, { error: '슈퍼 관리자 권한이 필요합니다.' });
      }
    }

    // ⭐️ [SUPER ADMIN] 1. 플랫폼 총괄 대시보드 통계 API
    if (pathname === '/api/super-admin/overview' && method === 'GET') {
      const companies = db.prepare('SELECT * FROM companies').all();
      const totalTickets = db.prepare('SELECT count(*) as count FROM tickets').get().count;
      const totalUsers = db.prepare('SELECT count(*) as count FROM users').get().count;
      let pendingApps = 0;
      try {
        pendingApps = db.prepare("SELECT count(*) as count FROM company_applications WHERE status = 'PENDING_REVIEW'").get().count;
      } catch (e) {}
      
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
        pending_applications: pendingApps,
        total_storage_used_mb: totalStorageUsed,
        plan_breakdown: { FREE: freeCount, PRO: proCount, ENTERPRISE: enterpriseCount },
        companies
      });
    }

    // ⭐️ [SUPER ADMIN] 2. 전체 고객사 목록 및 제어 현황 (소프트 삭제 제외)
    if (pathname === '/api/super-admin/companies' && method === 'GET') {
      const companies = db.prepare("SELECT * FROM companies WHERE status != 'DELETED' ORDER BY created_at DESC").all();
      return sendJSON(res, 200, companies.map(c => {
        let features = { checklists: true, realtime_sse: true, public_qr: true, outsource: true };
        try { if (c.enabled_features) features = typeof c.enabled_features === 'string' ? JSON.parse(c.enabled_features) : c.enabled_features; } catch(e){}
        const monthlyUsed = getMonthlyTicketCount(c.id);
        const messageStats = getMonthlyMessageStats(c.id);
        return {
          ...c,
          monthly_used_count: monthlyUsed,
          message_stats: messageStats,
          enabled_features: features,
          usage_pct: Math.min(100, Math.round((monthlyUsed / (c.monthly_ticket_limit || 100)) * 100)),
          storage_pct: Math.min(100, Math.round(((c.storage_used_mb || 0) / (c.storage_limit_mb || 500)) * 100))
        };
      }));
    }

    // ⭐️ [SUPER ADMIN] 3. 신규 회사 등록 (모달 생성 + 즉시 프로비저닝 + 랜덤 임시 비밀번호)
    if (pathname === '/api/super-admin/companies' && method === 'POST') {
      const body = await parseBody(req);
      const { name, subdomain, logo_url, plan, admin_name, admin_email, admin_phone, password, monthly_ticket_limit, enabled_features } = body;
      
      const slug = (subdomain || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!name || !slug) {
        return sendJSON(res, 400, { error: '회사명과 서브도메인(영문 슬러그)은 필수입니다.' });
      }

      const existing = db.prepare('SELECT id FROM companies WHERE subdomain = ?').get(slug);
      if (existing) {
        return sendJSON(res, 400, { error: `서브도메인 [${slug}]은(는) 이미 사용 중입니다.` });
      }

      const tempPassword = (password && String(password).trim()) ? String(password).trim() : generateTempPassword(10);
      if (tempPassword.length < 8) {
        return sendJSON(res, 400, { error: '초기 비밀번호는 최소 8자 이상이어야 합니다.' });
      }

      const company = provisionTenant({
        name,
        subdomain: slug,
        logo_url,
        plan: plan || 'FREE',
        admin_name,
        admin_email,
        admin_phone,
        password: tempPassword,
        monthly_ticket_limit,
        enabled_features
      });

      const baseOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || ('localhost:' + PORT)}`;

      return sendJSON(res, 201, {
        success: true,
        temp_password: tempPassword,
        message: `[${name}] 회사가 성공적으로 등록 및 개설되었습니다.`,
        company: {
          ...company,
          web_url: `${baseOrigin}/?tenant=${slug}`,
          mobile_url: `${baseOrigin}/mobile?tenant=${slug}`
        }
      });
    }

    // ⭐️ [SUPER ADMIN] 3-1. 가입 신청서 목록 조회
    if (pathname === '/api/super-admin/applications' && method === 'GET') {
      const applications = db.prepare('SELECT * FROM company_applications ORDER BY created_at DESC').all();
      return sendJSON(res, 200, applications);
    }

    // ⭐️ [SUPER ADMIN] 3-2. 가입 신청 승인 (프로비저닝 실행)
    if (pathname.match(/^\/api\/super-admin\/applications\/([^/]+)\/approve$/) && method === 'POST') {
      const appId = pathname.split('/')[4];
      const app = db.prepare('SELECT * FROM company_applications WHERE id = ?').get(appId);
      if (!app) return sendJSON(res, 404, { error: '신청서를 찾을 수 없습니다.' });
      if (app.status === 'APPROVED') return sendJSON(res, 400, { error: '이미 승인된 신청서입니다.' });

      const slug = app.requested_slug;
      const existing = db.prepare('SELECT id FROM companies WHERE subdomain = ?').get(slug);
      if (existing) return sendJSON(res, 400, { error: `이미 해당 서브도메인 [${slug}]을 사용하는 회사가 존재합니다.` });

      const session = getSession(req);
      const company = provisionTenant({
        name: app.company_name,
        subdomain: slug,
        admin_name: app.admin_name,
        admin_email: app.admin_email,
        admin_phone: app.admin_phone,
        password_hash: app.password_hash
      });

      db.prepare(`
        UPDATE company_applications
        SET status = 'APPROVED', reviewer_id = ?, company_id = ?, reviewed_at = datetime('now')
        WHERE id = ?
      `).run(session ? session.user.id : 'super_admin', company.id, appId);

      const baseOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || ('localhost:' + PORT)}`;
      return sendJSON(res, 200, {
        success: true,
        message: `[${app.company_name}] 가입 신청이 성공적으로 승인되어 사이트가 개설되었습니다.`,
        company: {
          ...company,
          web_url: `${baseOrigin}/?tenant=${slug}`,
          mobile_url: `${baseOrigin}/mobile?tenant=${slug}`
        }
      });
    }

    // ⭐️ [SUPER ADMIN] 3-3. 가입 신청 반려
    if (pathname.match(/^\/api\/super-admin\/applications\/([^/]+)\/reject$/) && method === 'POST') {
      const appId = pathname.split('/')[4];
      const { reason } = await parseBody(req);
      const app = db.prepare('SELECT * FROM company_applications WHERE id = ?').get(appId);
      if (!app) return sendJSON(res, 404, { error: '신청서를 찾을 수 없습니다.' });

      const session = getSession(req);
      db.prepare(`
        UPDATE company_applications
        SET status = 'REJECTED', review_note = ?, reviewer_id = ?, reviewed_at = datetime('now')
        WHERE id = ?
      `).run(reason || '승인 요건 미충족', session ? session.user.id : 'super_admin', appId);

      return sendJSON(res, 200, { success: true, message: `[${app.company_name}] 가입 신청이 반려 처리되었습니다.` });
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

    // ⭐️ [SUPER ADMIN] 5. 원클릭 +100건 리포트 충전 API (회사 존재 검증 + 감사 로그)
    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)\/charge-100$/) && method === 'POST') {
      const companyId = pathname.split('/')[4];
      const session = getSession(req);
      const comp = db.prepare("SELECT id, name, monthly_ticket_limit FROM companies WHERE id = ? AND status != 'DELETED'").get(companyId);
      if (!comp) return sendJSON(res, 404, { error: '고객사를 찾을 수 없습니다.' });

      db.exec('BEGIN');
      try {
        db.prepare('UPDATE companies SET monthly_ticket_limit = monthly_ticket_limit + 100 WHERE id = ?').run(companyId);
        db.prepare('INSERT INTO audit_logs (company_id, actor_id, actor_role, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(companyId, session ? session.user.id : 'super_admin', 'SUPER_ADMIN', 'CHARGE_REPORT_100', 'COMPANY', companyId, '+100 리포트 한도 충전', new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (e) {}
        throw err;
      }

      const updated = db.prepare('SELECT monthly_ticket_limit, monthly_used_count FROM companies WHERE id = ?').get(companyId);
      return sendJSON(res, 200, {
        success: true,
        message: `[${comp.name}] +100건이 즉시 충전되었습니다. (총 한도: ${updated.monthly_ticket_limit}건)`,
        monthly_ticket_limit: updated.monthly_ticket_limit
      });
    }

    // ⭐️ [SUPER ADMIN] 5-1. 문자/알림톡 발송 크레딧 충전 & 활성화 토글
    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)\/charge-messages$/) && method === 'POST') {
      const companyId = pathname.split('/')[4];
      const body = await parseBody(req);
      const session = getSession(req);
      const comp = db.prepare("SELECT id, name, message_monthly_limit, message_extra_credit, message_enabled FROM companies WHERE id = ? AND status != 'DELETED'").get(companyId);
      if (!comp) return sendJSON(res, 404, { error: '고객사를 찾을 수 없습니다.' });

      if (body.message_enabled !== undefined) {
        const nextEnabled = body.message_enabled ? 1 : 0;
        db.prepare('UPDATE companies SET message_enabled = ? WHERE id = ?').run(nextEnabled, companyId);
        return sendJSON(res, 200, { success: true, message: `문자/알림톡 발송 기능이 ${nextEnabled ? '활성화' : '비활성화'}되었습니다.` });
      }

      const delta = parseInt(body.delta, 10);
      if (!Number.isFinite(delta) || delta < 1 || delta > 10000) {
        return sendJSON(res, 400, { error: '충전 건수는 1~10,000 사이의 정수만 허용됩니다.' });
      }

      const reason = (body.reason || '').trim() || `슈퍼관리자 추가 크레딧 ${delta > 0 ? '+' : ''}${delta}건`;
      const nowIso = new Date().toISOString();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE companies SET message_extra_credit = COALESCE(message_extra_credit, 0) + ? WHERE id = ?').run(delta, companyId);
        db.prepare('INSERT INTO message_credit_logs (company_id, delta, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
          companyId, delta, reason, session ? session.user.email : 'super_admin', nowIso
        );
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (e) {}
        throw err;
      }

      const stats = getMonthlyMessageStats(companyId);
      return sendJSON(res, 200, {
        success: true,
        message: `[${comp.name}] 문자/알림톡 크레딧 ${delta > 0 ? '+' : ''}${delta}건이 반영되었습니다. (월 총 한도: ${stats.total_limit}건)`,
        message_stats: stats
      });
    }

    // ⭐️ [SUPER ADMIN] 5-2. 고객사별 월간 문자/알림톡 발송 이력 조회 (전화번호 마스킹)
    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)\/messages$/) && method === 'GET') {
      const companyId = pathname.split('/')[4];
      const month = getMonthPrefix(parsedUrl.query && parsedUrl.query.month);
      const comp = db.prepare('SELECT id, name, subdomain FROM companies WHERE id = ?').get(companyId);
      if (!comp) return sendJSON(res, 404, { error: '고객사를 찾을 수 없습니다.' });

      const stats = getMonthlyMessageStats(companyId, month);
      const rawLogs = db.prepare(`
        SELECT id, company_id, channel, purpose, recipient_phone, template_code, content_preview, provider, provider_msg_id, status, fail_reason, cost_units, created_at
        FROM message_logs
        WHERE company_id = ? AND substr(created_at, 1, 7) = ?
        ORDER BY created_at DESC
        LIMIT 200
      `).all(companyId, month);

      const creditLogs = db.prepare(`
        SELECT id, delta, reason, created_by, created_at
        FROM message_credit_logs
        WHERE company_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `).all(companyId);

      return sendJSON(res, 200, {
        company: comp,
        month,
        stats,
        logs: rawLogs.map(l => ({ ...l, recipient_phone: maskPhone(l.recipient_phone) })),
        credit_logs: creditLogs
      });
    }

    // ⭐️ [PUBLIC SIGNUP] 6. 홈페이지 자가 회원가입 및 신청 접수 API
    if (pathname === '/api/signup' && method === 'POST') {
      const body = await parseBody(req);
      const { company_name, subdomain, admin_name, admin_email, admin_phone, password } = body;

      const slug = (subdomain || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!company_name || !slug || !admin_name || !admin_email) {
        return sendJSON(res, 400, { error: '필수 가입 정보를 모두 입력해주세요.' });
      }
      if (!isValidEmail(admin_email)) {
        return sendJSON(res, 400, { error: '유효한 이메일 주소를 입력해주세요.' });
      }
      if (admin_phone && !isValidPhone(admin_phone)) {
        return sendJSON(res, 400, { error: '올바른 휴대폰 번호 형식을 입력해주세요. (예: 010-1234-5678)' });
      }
      if (!password || String(password).trim().length < 8) {
        return sendJSON(res, 400, { error: '비밀번호는 최소 8자 이상으로 설정해주세요.' });
      }

      const reservedSlugs = ['www', 'admin', 'super', 'superadmin', 'api', 'login', 'signup', 'app', 'system', 'root'];
      if (reservedSlugs.includes(slug)) {
        return sendJSON(res, 400, { error: `[${slug}]은(는) 시스템 예약어로 사용할 수 없습니다. 다른 서브도메인을 입력해주세요.` });
      }

      const existing = db.prepare('SELECT id FROM companies WHERE subdomain = ?').get(slug);
      if (existing) {
        return sendJSON(res, 400, { error: `입력하신 서브도메인 [${slug}]은(는) 이미 다른 고객사가 사용 중입니다. 다른 이름을 입력해주세요.` });
      }

      const pendingApp = db.prepare("SELECT id FROM company_applications WHERE requested_slug = ? AND status = 'PENDING_REVIEW'").get(slug);
      if (pendingApp) {
        return sendJSON(res, 400, { error: `서브도메인 [${slug}]에 대한 가입 신청이 이미 접수되어 심사 중입니다.` });
      }

      const autoApprove = process.env.AUTO_APPROVE_SIGNUP !== 'false';

      if (autoApprove) {
        const company = provisionTenant({
          name: company_name,
          subdomain: slug,
          admin_name,
          admin_email,
          admin_phone,
          password: password || '1234'
        });

        // 신청 내역에도 승인 완료로 보존 (슈퍼관리자 감사 로그)
        try {
          const appId = 'app_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
          const pwdHash = hashPassword(password || '1234');
          db.prepare(`
            INSERT INTO company_applications (
              id, company_name, requested_slug, admin_name, admin_email, admin_phone,
              password_hash, status, created_at, reviewed_at, review_note
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', datetime('now'), datetime('now'), '자가 가입 즉시 자동 승인')
          `).run(appId, company_name, slug, admin_name, admin_email, admin_phone || '', pwdHash);
        } catch(e) {}

        // 회원가입 직후 해당 관리자로 즉시 로그인 세션 발급
        const adminUser = db.prepare("SELECT id FROM users WHERE company_id = ? AND role = 'ADMIN'").get(company.id);
        let cookieHeader = '';
        if (adminUser) {
          const session = createSession(adminUser.id, 'SITE_MANAGER', company.id);
          cookieHeader = `fielder_session=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
        }

        const baseOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || ('localhost:' + PORT)}`;
        return sendJSON(res, 201, {
          success: true,
          pending: false,
          message: '회원가입이 완료되었습니다! 100개 무료 리포트/티켓이 즉시 부여되었습니다.',
          company: {
            ...company,
            free_limit: 100,
            web_url: `${baseOrigin}/?tenant=${slug}`,
            mobile_url: `${baseOrigin}/mobile?tenant=${slug}`
          }
        }, cookieHeader);
      } else {
        const appId = 'app_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const pwdHash = hashPassword(password || '1234');
        db.prepare(`
          INSERT INTO company_applications (
            id, company_name, requested_slug, admin_name, admin_email, admin_phone,
            password_hash, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', datetime('now'))
        `).run(appId, company_name, slug, admin_name, admin_email, admin_phone || '', pwdHash);

        return sendJSON(res, 201, {
          success: true,
          pending: true,
          message: '가입 신청이 성공적으로 접수되었습니다. 관리자 승인 후 사이트가 개설됩니다.',
          application: {
            id: appId,
            company_name,
            subdomain: slug,
            admin_name,
            admin_email
          }
        });
      }
    }

    // ⭐️ [AUTH] 7. 통합 로그인 API (HTTP-only 세션 쿠키 + 해시 검증 + 시도 제한 + 첫 로그인 비번변경 플래그)
    if (pathname === '/api/login' && method === 'POST') {
      const body = await parseBody(req);
      const rawIdentifier = (body.email || body.identifier || '').trim();
      const email = rawIdentifier.toLowerCase();
      const password = (body.password || '').trim();
      const tenant = (body.tenant || (parsedUrl.query && parsedUrl.query.tenant) || '').trim().toLowerCase();
      const clientIp = getClientIp(req);
      const rateKey = `${clientIp}:${email}`;

      const rl = checkLoginRateLimit(rateKey);
      if (rl.blocked) {
        return sendJSON(res, 429, { error: rl.message });
      }

      if (!rawIdentifier || !isValidEmail(rawIdentifier)) {
        return sendJSON(res, 400, { error: '유효한 이메일 주소를 입력해주세요.' });
      }
      if (!password) {
        return sendJSON(res, 400, { error: '비밀번호를 입력해주세요.' });
      }

      // 1) 슈퍼 관리자 계정 체크 (환경변수 필수 - 기본 비밀번호 미사용)
      const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@fielder.kr').toLowerCase();
      if (email === superAdminEmail) {
        const superAdminPw = process.env.SUPER_ADMIN_PASSWORD;
        if (!superAdminPw) {
          return sendJSON(res, 503, { error: '슈퍼 관리자 비밀번호 환경변수(SUPER_ADMIN_PASSWORD)가 설정되지 않아 로그인할 수 없습니다.' });
        }
        if (password !== superAdminPw) {
          recordLoginFailure(rateKey);
          return sendJSON(res, 401, { error: '이메일 또는 비밀번호가 일치하지 않습니다.' });
        }
        clearLoginFailures(rateKey);
        const session = createSession('super_admin', 'SUPER_ADMIN', null);
        const cookieHeader = `fielder_session=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
        return sendJSON(res, 200, {
          success: true,
          role: 'SUPER_ADMIN',
          user: {
            name: '슈퍼관리자',
            email: superAdminEmail,
            role_title: '슈퍼관리자'
          },
          redirect_url: '/super-admin'
        }, cookieHeader);
      }

      // 특정 회사(tenant)가 지정된 경우 해당 회사 ID 확인
      let tenantComp = null;
      if (tenant && tenant !== 'null' && tenant !== 'undefined') {
        tenantComp = db.prepare('SELECT id, name, subdomain FROM companies WHERE subdomain = ? OR id = ?').get(tenant, tenant);
      }

      // 2) 회사 관리자 / 실무자 통합 조회 (이메일 기준 — 테넌트 지정 시 타사 폴백 금지)
      let user = null;
      if (tenantComp) {
        user = db.prepare(`
          SELECT u.*, c.name as company_name, c.subdomain, c.status as company_status
          FROM users u
          LEFT JOIN companies c ON u.company_id = c.id
          WHERE u.company_id = ? AND LOWER(u.email) = ?
        `).get(tenantComp.id, email);
      } else if (!tenant || tenant === 'null' || tenant === 'undefined') {
        user = db.prepare(`
          SELECT u.*, c.name as company_name, c.subdomain, c.status as company_status
          FROM users u
          LEFT JOIN companies c ON u.company_id = c.id
          WHERE LOWER(u.email) = ?
        `).get(email);
      }

      if (!user) {
        recordLoginFailure(rateKey);
        return sendJSON(res, 401, { error: '이메일 또는 비밀번호가 일치하지 않습니다.' });
      }

      if (user.is_active === 0) {
        return sendJSON(res, 403, { error: '비활성화된 계정입니다. 회사 관리자에게 문의하세요.' });
      }

      // 고객사 정지/삭제 상태 확인
      if (user.company_status === 'SUSPENDED' || user.company_status === 'CLOSED' || user.company_status === 'DELETED') {
        return sendJSON(res, 403, { error: '해당 고객사 계정은 현재 이용이 정지되었습니다. 관리자에게 문의하세요.' });
      }

      // 비밀번호 검증 (해시 검증)
      const isValid = verifyPassword(password, user.password);
      if (!isValid) {
        recordLoginFailure(rateKey);
        return sendJSON(res, 401, { error: '이메일 또는 비밀번호가 일치하지 않습니다.' });
      }

      clearLoginFailures(rateKey);

      const nowIso = new Date().toISOString();
      if (!user.password || !user.password.includes(':')) {
        try {
          db.prepare("UPDATE users SET password = ?, last_login_at = ? WHERE id = ?").run(hashPassword(password), nowIso, user.id);
        } catch(e) {}
      } else {
        try {
          db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso, user.id);
        } catch(e) {}
      }

      const isAdmin = user.role === 'ADMIN';
      const isMobileClient = isMobileClientRequest(req, body);
      const roleName = isAdmin ? 'SITE_MANAGER' : 'WORKER';
      const session = createSession(user.id, roleName, user.company_id);
      const cookieName = isMobileClient ? 'fielder_mobile_session' : 'fielder_session';
      const cookieHeader = `${cookieName}=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;

      const targetSlug = user.subdomain && user.subdomain !== 'null' && user.subdomain !== 'undefined' ? user.subdomain : '';
      const redirectUrl = (isMobileClient || !isAdmin) ? `/mobile?tenant=${targetSlug}` : `/?tenant=${targetSlug}`;

      return sendJSON(res, 200, {
        success: true,
        role: isAdmin ? 'COMPANY_ADMIN' : 'WORKER',
        must_change_password: !!user.must_change_password,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          company_id: user.company_id,
          company_name: user.company_name,
          subdomain: targetSlug,
          must_change_password: !!user.must_change_password,
          role_title: isAdmin ? (user.company_name + ' 총괄 관리자') : (user.role || '현장 점검원')
        },
        redirect_url: redirectUrl
      }, cookieHeader);
    }

    // ⭐️ [AUTH] 7-0. 본인 비밀번호 변경 API (첫 로그인 강제 변경 포함)
    if (pathname === '/api/change-password' && method === 'POST') {
      const session = getSession(req);
      if (!session || session.role === 'SUPER_ADMIN') {
        return sendJSON(res, 401, { error: '로그인이 필요합니다.' });
      }
      const { newPassword } = await parseBody(req);
      if (!newPassword || newPassword.trim().length < 8) {
        return sendJSON(res, 400, { error: '새 비밀번호는 최소 8자 이상이어야 합니다.' });
      }
      db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword.trim()), session.user.id);
      return sendJSON(res, 200, { success: true, message: '비밀번호가 안전하게 변경되었습니다.' });
    }

    // ⭐️ [AUTH] 7-1. 현재 로그인 사용자 세션 조회 API
    if (pathname === '/api/me' && method === 'GET') {
      const session = getSession(req);
      if (!session) {
        return sendJSON(res, 401, { logged_in: false, error: '로그인 세션이 없습니다.' });
      }

      let companyInfo = null;
      if (session.companyId) {
        companyInfo = db.prepare('SELECT id, name, subdomain, plan, status FROM companies WHERE id = ?').get(session.companyId);
      }

      let impersonating = false;
      let targetCompany = null;
      if (session.role === 'SUPER_ADMIN') {
        const targetCid = resolveCompanyId(parsedUrl, null, req);
        if (targetCid) {
          const tc = db.prepare("SELECT id, name, subdomain FROM companies WHERE id = ? AND status != 'DELETED'").get(targetCid);
          if (tc) {
            impersonating = true;
            targetCompany = tc;
          }
        }
      }

      return sendJSON(res, 200, {
        logged_in: true,
        impersonating,
        target_company: targetCompany,
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          phone: session.user.phone || '',
          role: session.role,
          must_change_password: !!session.user.must_change_password,
          custom_role_id: session.user.custom_role_id || null,
          role_name: session.user.role_name || '',
          company_id: session.companyId,
          company_name: targetCompany ? targetCompany.name : (companyInfo ? companyInfo.name : '플랫폼 본부'),
          subdomain: targetCompany ? targetCompany.subdomain : (companyInfo ? (companyInfo.subdomain || 'central') : 'central'),
          role_title: session.role === 'SUPER_ADMIN' ? '슈퍼관리자' : (session.user.role_title || '')
        }
      });
    }

    // ⭐️ [AUTH] 7-2. 로그아웃 API (세션 삭제 및 쿠키 만료)
    if (pathname === '/api/logout' && method === 'POST') {
      const body = await parseBody(req);
      const isMobile = isMobileClientRequest(req, body);
      deleteSession(req, isMobile ? 'mobile' : 'console');
      const cookieName = isMobile ? 'fielder_mobile_session' : 'fielder_session';
      const cookieClear = `${cookieName}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`;
      return sendJSON(res, 200, { success: true, message: '로그아웃되었습니다.' }, cookieClear);
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

      const rawPwd = (new_password && new_password.trim()) ? new_password.trim() : generateTempPassword(10);
      if (rawPwd.length < 8) {
        return sendJSON(res, 400, { error: '비밀번호는 최소 8자 이상이어야 합니다.' });
      }
      db.prepare("UPDATE users SET password = ?, must_change_password = 1 WHERE company_id = ? AND (role = 'ADMIN' OR email = ?)").run(hashPassword(rawPwd), companyId, comp.admin_email);
      return sendJSON(res, 200, { success: true, temp_password: rawPwd, message: `[${comp.name}] 마스터 관리자 임시 비밀번호가 발급되었습니다.` });
    }

    // S6: 회사 삭제 시 confirm_name(회사명 일치) 필수 검증 + 소프트 삭제 + 감사 로그
    if (pathname.match(/^\/api\/super-admin\/companies\/([^/]+)$/) && method === 'DELETE') {
      const companyId = pathname.split('/')[4];
      const body = await parseBody(req);
      const session = getSession(req);
      const comp = db.prepare("SELECT id, name, subdomain, status FROM companies WHERE id = ? AND status != 'DELETED'").get(companyId);
      if (!comp) return sendJSON(res, 404, { error: '회사를 찾을 수 없습니다.' });
      if (comp.id === 'comp_central_tower' || comp.subdomain === 'central') {
        return sendJSON(res, 403, { error: '기본 데모 테넌트(central)는 삭제할 수 없습니다.' });
      }

      const confirmName = String(body.confirm_name || '').trim();
      if (!confirmName || confirmName !== comp.name) {
        return sendJSON(res, 400, { error: `삭제 확인을 위해 회사명 [${comp.name}]을 정확히 입력해주세요.` });
      }

      const nowIso = new Date().toISOString();
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE companies SET status = 'DELETED', deleted_at = ?, subdomain = ? WHERE id = ?")
          .run(nowIso, `${comp.subdomain}__deleted_${Date.now()}`, companyId);
        db.prepare("UPDATE users SET is_active = 0 WHERE company_id = ?").run(companyId);
        db.prepare('INSERT INTO audit_logs (company_id, actor_id, actor_role, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(companyId, session ? session.user.id : 'super_admin', 'SUPER_ADMIN', 'COMPANY_SOFT_DELETE', 'COMPANY', companyId, `소프트 삭제 확인: ${comp.name}`, nowIso);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (e) {}
        throw err;
      }

      return sendJSON(res, 200, { success: true, message: `[${comp.name}] 회사가 안전하게 삭제(보관 전환)되었습니다.` });
    }

    // ==========================================
    // 6. 정적 웹 페이지 서빙
    // ==========================================
    if (pathname === '/' || pathname === '/admin') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    // ⭐️ [TENANT PATH ROUTING] 개별 프로젝트 전용 URL 지원 (/t/:slug/)
    if (pathname.match(/^\/t\/([a-zA-Z0-9_-]+)\/?$/)) {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname.match(/^\/t\/([a-zA-Z0-9_-]+)\/mobile\/?$/)) {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'mobile.html'));
    }
    if (pathname.match(/^\/t\/([a-zA-Z0-9_-]+)\/(report|qr)\/?$/)) {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'report.html'));
    }
    if (pathname === '/super-admin' || pathname === '/super-admin/') {
      const session = getSession(req);
      if (!session || session.role !== 'SUPER_ADMIN') {
        res.writeHead(302, { Location: '/login?redirect=/super-admin' });
        return res.end();
      }
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
    sendJSON(res, 500, { error: '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 엔터프라이즈 FMS 서버 정상 가동 중 (PORT: ${PORT})`);
});
