const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// ⭐️ Render Persistent Disk (/var/data) 또는 환경변수(DB_PATH) 우선 사용 (컨테이너 재배포 시 DB 초기화 방지)
const PERSISTENT_DIR = process.env.DB_DIR || (fs.existsSync('/var/data') ? '/var/data' : __dirname);
if (!fs.existsSync(PERSISTENT_DIR)) {
  try { fs.mkdirSync(PERSISTENT_DIR, { recursive: true }); } catch (e) {}
}
const DB_PATH = process.env.DB_PATH || path.join(PERSISTENT_DIR, 'fms.db');
console.log(`💾 SQLite DB 경로: ${DB_PATH} (Persistent Disk: ${PERSISTENT_DIR === '/var/data' || !!process.env.DB_PATH})`);
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

// ⭐️ 비밀번호 해시 생성 및 검증 (scrypt 기반 안전 암호화 + 기존 평문 투명 호환)
function hashPassword(password) {
  if (!password) password = '1234';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt:')) {
    // 기존 평문 비밀번호 호환
    return password === stored;
  }
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, salt, hash] = parts;
  try {
    const testBuf = crypto.scryptSync(password, salt, 64);
    const storedBuf = Buffer.from(hash, 'hex');
    if (testBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(testBuf, storedBuf);
  } catch (e) {
    return false;
  }
}

function initDatabase() {
  console.log('📦 데이터베이스 스키마 구성 중...');

  // ⭐️ 멀티테넌트 컬럼 동적 마이그레이션
  const compCols = db.prepare("PRAGMA table_info(companies)").all().map(c => c.name);
  if (!compCols.includes('subdomain')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN subdomain TEXT UNIQUE;"); } catch(e){}
  }
  if (!compCols.includes('status')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN status TEXT DEFAULT 'ACTIVE';"); } catch(e){}
  }
  if (!compCols.includes('storage_limit_mb')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN storage_limit_mb INTEGER DEFAULT 500;"); } catch(e){}
  }
  if (!compCols.includes('storage_used_mb')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN storage_used_mb INTEGER DEFAULT 15;"); } catch(e){}
  }
  if (!compCols.includes('enabled_features')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN enabled_features TEXT DEFAULT '{\"checklists\":true,\"realtime_sse\":true,\"public_qr\":true,\"outsource\":true}';"); } catch(e){}
  }
  if (!compCols.includes('admin_name')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN admin_name TEXT;"); } catch(e){}
  }
  if (!compCols.includes('admin_email')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN admin_email TEXT;"); } catch(e){}
  }
  if (!compCols.includes('admin_phone')) {
    try { db.exec("ALTER TABLE companies ADD COLUMN admin_phone TEXT;"); } catch(e){}
  }


  // 1. 고객사 및 기본 설정
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subdomain TEXT UNIQUE,
      logo_url TEXT,
      plan TEXT DEFAULT 'FREE',
      status TEXT DEFAULT 'ACTIVE',
      monthly_ticket_limit INTEGER DEFAULT 100,
      monthly_used_count INTEGER DEFAULT 0,
      storage_limit_mb INTEGER DEFAULT 500,
      storage_used_mb INTEGER DEFAULT 15,
      enabled_features TEXT DEFAULT '{"checklists":true,"realtime_sse":true,"public_qr":true,"outsource":true}',
      admin_name TEXT,
      admin_email TEXT,
      admin_phone TEXT,
      buildings TEXT DEFAULT '["본관"]',
      floors TEXT DEFAULT '["1F"]',
      buildings_config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. 직무 그룹
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_roles (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      is_system INTEGER DEFAULT 0,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
  `);

  // 3. 구역 및 층(Floor) 위치 관리
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      floor TEXT NOT NULL, -- 'B2', 'B1', '1F', '2F', '3F', '4F', '5F', '6F', '7F'
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'MAIN_TOWER',
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
  `);

  // 4. 사용자
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      custom_role_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (custom_role_id) REFERENCES custom_roles(id)
    );
  `);

  // 5. 티켓 및 작업지시 (민원/건의사항 구분 포함)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      ticket_no TEXT UNIQUE NOT NULL,
      company_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      reporter_type TEXT DEFAULT 'PUBLIC_QR', -- 'PUBLIC_QR'(일반사용자 모바일 민원/건의), 'STAFF_APP'(현장직원 순찰)
      reporter_name TEXT,
      reporter_phone TEXT,
      status TEXT DEFAULT 'PENDING', -- 'PENDING'(접수대기), 'IN_PROGRESS'(진행중), 'WAITING_APPROVAL'(승인대기), 'COMPLETED'(마감완료)
      
      target_type TEXT,
      target_group_role_id TEXT,
      assignee_id TEXT,
      
      instruction_title TEXT,
      instruction_notes TEXT,
      instruction_photo_url TEXT,
      
      resolution_type TEXT, -- 'RESOLVED', 'UNRESOLVED'
      unresolved_reason TEXT,
      unresolved_photo_url TEXT,
      
      completion_notes TEXT,
      completion_photo_url TEXT,
      completed_by_name TEXT,
      
      admin_notes TEXT,
      claimed_by_name TEXT,
      
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_at DATETIME,
      started_at DATETIME,
      completed_at DATETIME,
      approved_at DATETIME,

      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (target_group_role_id) REFERENCES custom_roles(id),
      FOREIGN KEY (assignee_id) REFERENCES users(id)
    );
  `);

  // 6. 불량 신고자 블랙리스트
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
  `);

  // 7. SMS OTP 인증
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_otps (
      phone TEXT PRIMARY KEY,
      otp_code TEXT NOT NULL,
      expires_at DATETIME NOT NULL
    );
  `);

  // 8. 모바일 실무자 현장순찰 일지 (Patrol Logs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS patrol_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      user_id TEXT,
      worker_name TEXT NOT NULL,
      building TEXT DEFAULT '본관',
      floor TEXT NOT NULL,
      location_name TEXT NOT NULL,
      check_items TEXT, -- JSON
      notes TEXT,
      photo_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
  `);

  // ⭐️ 9. 세션 테이블 (인터넷 다고객 보안 인증)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      company_id TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ⭐️ 10. 서비스 기업 가입 신청서 테이블 (승인/반려 워크플로)
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_applications (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      requested_slug TEXT NOT NULL,
      admin_name TEXT NOT NULL,
      admin_email TEXT NOT NULL,
      admin_phone TEXT,
      password_hash TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING_REVIEW', -- PENDING_REVIEW, APPROVED, REJECTED, CANCELLED
      reviewer_id TEXT,
      review_note TEXT,
      company_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME
    );
  `);

  // 안전 마이그레이션 (기존 컬럼 보충)
  try { db.exec("ALTER TABLE tickets ADD COLUMN admin_notes TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN claimed_by_name TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN photo_url TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN due_date TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN cancelled_at DATETIME;"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN cancelled_reason TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN email TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN password TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN last_login_at DATETIME;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN invite_token TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN invite_expires_at DATETIME;"); } catch (e) {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_company_email ON users(company_id, LOWER(email)) WHERE email IS NOT NULL AND email != '';"); } catch (e) {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_company_name ON custom_roles(company_id, LOWER(TRIM(name)));"); } catch (e) {}
  try { db.exec("ALTER TABLE locations ADD COLUMN building TEXT DEFAULT '본관';"); } catch (e) {}
  try { db.exec("ALTER TABLE companies ADD COLUMN buildings TEXT DEFAULT '[\"본관\", \"별관\"]';"); } catch (e) {}
  try { db.exec("ALTER TABLE companies ADD COLUMN floors TEXT DEFAULT '[\"B2\", \"B1\", \"1F\", \"2F\", \"3F\", \"4F\", \"5F\", \"6F\", \"7F\", \"8F\"]';"); } catch (e) {}
  try { db.exec("ALTER TABLE companies ADD COLUMN buildings_config TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE inspection_logs ADD COLUMN is_confirmed INTEGER DEFAULT 0;"); } catch (e) {}
  try { db.exec("ALTER TABLE inspection_logs ADD COLUMN confirmed_at DATETIME;"); } catch (e) {}
  try { db.exec("ALTER TABLE inspection_logs ADD COLUMN confirmed_by TEXT;"); } catch (e) {}

  // ⭐️ comp_central_tower 서브도메인 'central' 보장 (/?tenant=null 버그 원천 방지)
  try {
    db.exec("UPDATE companies SET subdomain = 'central' WHERE id = 'comp_central_tower' AND (subdomain IS NULL OR subdomain = '' OR subdomain = 'null');");
  } catch(e) {}

  // 기본 건물동 및 운영 층수 데이터 보장 (기본: 본관 1층만 존재)
  try {
    const defaultBc = JSON.stringify({
      '본관': { basement: 'NONE', ground: 1, hasRooftop: false, floors: ['1F'] }
    });
    db.prepare(`
      UPDATE companies 
      SET buildings_config = ? 
      WHERE (buildings_config IS NULL OR buildings_config = '')
    `).run(defaultBc);
  } catch (e) {}

  // 기본 건물동 및 운영 층수 데이터 보장 (기본: 본관 1층만 존재)
  try {
    db.exec(`
      UPDATE companies 
      SET buildings = '["본관"]' 
      WHERE (buildings IS NULL OR buildings = '');
      UPDATE companies 
      SET floors = '["1F"]' 
      WHERE (floors IS NULL OR floors = '');
    `);
  } catch (e) {}

  // 기존 사용자 계정 이메일/비밀번호 기본값 동기화
  const defaultUserCreds = [
    { id: 'user_admin', email: 'admin@fms.kr', pw: '1234' },
    { id: 'user_admin_sub', email: 'lee.op@fms.kr', pw: '1234' },
    { id: 'user_worker_choi', email: 'choi.maint@fms.kr', pw: '1234' },
    { id: 'user_worker_lee_m', email: 'lee.maint@fms.kr', pw: '1234' },
    { id: 'user_worker_jung_c', email: 'jung.clean@fms.kr', pw: '1234' },
    { id: 'user_worker_park_c', email: 'park.clean@fms.kr', pw: '1234' },
    { id: 'user_worker_kim_c', email: 'kim.clean@fms.kr', pw: '1234' },
    { id: 'user_worker_park_s', email: 'park.sec@fms.kr', pw: '1234' },
    { id: 'user_worker_kang_e', email: 'kang.elec@fms.kr', pw: '1234' },
    { id: 'user_worker_song_v', email: 'song.elev@fms.kr', pw: '1234' }
  ];
  for (const uc of defaultUserCreds) {
    db.prepare("UPDATE users SET email = ?, password = ? WHERE id = ? AND (email IS NULL OR email = '')").run(uc.email, uc.pw, uc.id);
  }

  // 관리자 계정 이름 및 이메일 동기화 (기존 데이터 보정)
  try {
    db.exec("UPDATE users SET name = 'Fielder 소장' WHERE id = 'user_admin' AND (name = '김관리 소장' OR name IS NULL);");
    db.exec("UPDATE companies SET admin_name = 'Fielder 소장' WHERE id = 'comp_central_tower' AND (admin_name = '김관리 소장' OR admin_name IS NULL);");
    const adminUser = db.prepare("SELECT name, email FROM users WHERE id = 'user_admin'").get();
    if (adminUser) {
      db.prepare("UPDATE companies SET admin_name = ?, admin_email = ? WHERE id = 'comp_central_tower'").run(adminUser.name, adminUser.email);
    }
  } catch (e) {}

  // ⭐️ 모든 회사의 기본 ADMIN 관리자 계정 누락 방지 및 자동 보강 동기화
  try {
    // 1) companies.id가 비어있는 불량 데이터(예: gabal 등) 보정
    const badComps = db.prepare("SELECT rowid, id, subdomain FROM companies WHERE id IS NULL OR id = ''").all();
    for (const bc of badComps) {
      const fixedId = 'comp_' + ((bc.subdomain || 'tenant').replace(/[^a-zA-Z0-9_-]/g, ''));
      db.prepare("UPDATE companies SET id = ? WHERE rowid = ?").run(fixedId, bc.rowid);
    }

    const allCompanies = db.prepare('SELECT id, subdomain, admin_name, admin_email, admin_phone FROM companies').all();
    for (const c of allCompanies) {
      if (!c.id) continue;
      const hasAdmin = db.prepare("SELECT id FROM users WHERE company_id = ? AND role = 'ADMIN'").get(c.id);
      if (!hasAdmin) {
        const slug = c.subdomain || c.id.replace('comp_', '');
        const adminId = 'user_admin_' + slug;
        const adminEmail = c.admin_email || `admin@${slug}.fielder.kr`;
        const adminName = c.admin_name || '총괄 관리자';
        const adminPhone = c.admin_phone || '010-0000-0000';
        const randPw = crypto.randomBytes(6).toString('base64url').slice(0, 10);
        db.prepare(`
          INSERT OR REPLACE INTO users (id, company_id, role, name, phone, email, password, is_active, must_change_password)
          VALUES (?, ?, 'ADMIN', ?, ?, ?, ?, 1, 1)
        `).run(adminId, c.id, adminName, adminPhone, adminEmail, hashPassword(randPw));
      }
    }
  } catch (e) {
    console.error('Admin auto-provision sync error:', e);
  }

  // ⭐️ 평문 비밀번호 scrypt 일괄 해시 전환
  try {
    const plainUsers = db.prepare("SELECT id, password FROM users WHERE password IS NULL OR password = '' OR password NOT LIKE '%:%'").all();
    for (const pu of plainUsers) {
      const raw = (pu.password && pu.password.trim()) ? pu.password.trim() : crypto.randomBytes(6).toString('base64url').slice(0, 10);
      const mustChange = (pu.password && pu.password.trim()) ? 0 : 1;
      db.prepare("UPDATE users SET password = ?, must_change_password = COALESCE(must_change_password, ?) WHERE id = ?").run(hashPassword(raw), mustChange, pu.id);
    }
  } catch (e) {
    console.error('Password hash migration error:', e);
  }

  // ⭐️ QA 테스트 데이터 정리 (central QA 잔여 데이터 및 qatest/qatest2 테넌트 제거)
  try {
    db.prepare("DELETE FROM tickets WHERE company_id = 'comp_central_tower' AND (title LIKE '%[QA]%' OR title = '[QA] 테스트 작업지시')").run();
    db.prepare("DELETE FROM users WHERE company_id = 'comp_central_tower' AND (name = 'QA테스터' OR name LIKE '%QA테스터%')").run();
    db.prepare("DELETE FROM custom_roles WHERE company_id = 'comp_central_tower' AND (name = 'QA테스트팀' OR name LIKE '%QA테스트팀%')").run();
    const qaComps = db.prepare("SELECT id FROM companies WHERE subdomain IN ('qatest-20261116', 'qatest2-20261116') OR id IN ('comp_qatest-20261116', 'comp_qatest2-20261116')").all();
    for (const qc of qaComps) {
      db.prepare('DELETE FROM inspection_logs WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM inspection_templates WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM patrol_logs WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM blocked_users WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM tickets WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM locations WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM custom_roles WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM users WHERE company_id = ?').run(qc.id);
      db.prepare('DELETE FROM companies WHERE id = ?').run(qc.id);
    }
    // 이번 달 실제 티켓 수 재계산 반영
    db.prepare(`
      UPDATE companies
      SET monthly_used_count = (
        SELECT COUNT(*) FROM tickets
        WHERE tickets.company_id = companies.id
          AND status != 'CANCELLED'
          AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
      )
    `).run();
  } catch (e) {
    console.error('QA cleanup error:', e);
  }

  // 기존 구역에 건물(본관) 기본값 설정
  db.exec("UPDATE locations SET building = '본관' WHERE building IS NULL OR building = '';");

  // 본관 8층 및 별관 샘플 구역 없으면 보강 (센트럴타워 존재 시에만)
  const hasCentral = db.prepare("SELECT id FROM companies WHERE id = 'comp_central_tower'").get();
  if (hasCentral) {
    const has8F = db.prepare("SELECT count(*) as cnt FROM locations WHERE company_id = 'comp_central_tower' AND (floor = '8F' OR name LIKE '%8층%')").get().cnt;
    if (has8F === 0) {
      db.prepare(`
        INSERT INTO locations (id, company_id, floor, building, code, name, category, description)
        VALUES ('loc_8f_exec', 'comp_central_tower', '8F', '본관', 'LOC-8F-01', '본관 8층 임원실 및 대회의실', 'OFFICE', 'VIP 접견실 및 통신설비')
      `).run();
    }
    const hasAnnex = db.prepare("SELECT count(*) as cnt FROM locations WHERE company_id = 'comp_central_tower' AND building = '별관'").get().cnt;
    if (hasAnnex === 0) {
      db.prepare(`
        INSERT INTO locations (id, company_id, floor, building, code, name, category, description)
        VALUES ('loc_annex_3f', 'comp_central_tower', '3F', '별관', 'LOC-AN-01', '별관 3층 스마트오피스 지원실', 'OFFICE', '별관 사무공간')
      `).run();
    }

    // 순찰 샘플 데이터 초기화 (없는 경우)
    const patrolCount = db.prepare('SELECT count(*) as cnt FROM patrol_logs').get().cnt;
    if (patrolCount === 0) {
      db.prepare(`
        INSERT INTO patrol_logs (id, company_id, user_id, worker_name, building, floor, location_name, check_items, notes, created_at)
        VALUES 
        ('pt_01', 'comp_central_tower', 'user_worker_park_s', '박보안 대원', '본관', '8F', '본관 8층 임원실 및 대회의실', '{"fire_safety":true,"lighting":true,"leak":true,"emergency_exit":true}', '비상계단 조명 및 소화전 점검 완료. 이상 무.', datetime('now', '-2 hours')),
        ('pt_02', 'comp_central_tower', 'user_worker_choi', '최영선 반장', '본관', 'B2', '지하 2층 주차장 B-04', '{"fire_safety":true,"lighting":true,"leak":false,"emergency_exit":true}', '배관 주변 미세 누수 건 진행중 확인. 자재 입고 시 교체 예정.', datetime('now', '-5 hours'))
      `).run();
    }
  }

  // ⭐️ 9 & 10. 현장 점검표 템플릿 & 점검 수행 기록 테이블
  db.exec(`
    CREATE TABLE IF NOT EXISTS inspection_templates (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      title TEXT NOT NULL,
      target_role_id TEXT,
      target_role_name TEXT,
      building TEXT DEFAULT '전체',
      frequency TEXT DEFAULT 'DAILY',
      items TEXT NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inspection_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      template_id TEXT,
      template_title TEXT NOT NULL,
      worker_id TEXT,
      worker_name TEXT NOT NULL,
      role_name TEXT,
      building TEXT NOT NULL,
      floor TEXT NOT NULL,
      location_name TEXT NOT NULL,
      results TEXT NOT NULL,
      status TEXT DEFAULT '양호',
      notes TEXT,
      photo_url TEXT,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
  `);

  seedData();
  initInspectionSeeds();
  console.log('✅ 데이터베이스 스키마 및 층수/위치/순찰 포함 시드 구성 완료!');
}

function initInspectionSeeds() {
  const tmplCount = db.prepare('SELECT count(*) as cnt FROM inspection_templates').get().cnt;
  if (tmplCount === 0) {
    const defaultTemplates = [
      {
        id: 'tmpl_restroom',
        title: '화장실 정기 위생 점검표',
        target_role_id: 'role_clean',
        target_role_name: '환경/미화청결팀',
        building: '전체',
        frequency: 'DAILY',
        description: '일일 화장실 청결도, 수온, 소모품 보충 및 시설 위생 점검',
        items: JSON.stringify([
          { id: 'sec_1', type: 'SECTION', title: '1층 남자화장실 위생 구역', description: '세면대 · 변기 · 바닥 순서로 점검' },
          { id: 'chk_clean', type: 'CHECK', label: '청소 완료', description: '점검했는지 체크만 해요.', required: true },
          { id: 'yn_floor', type: 'YES_NO', label: '바닥이 깨끗한가요?', description: 'O/X로 답하는 점검에 좋아요.', required: true },
          { id: 'txt_temp', type: 'TEXT', label: '수온(℃)', placeholder: '수치나 내용을 직접 입력해요 (예: 27.5)', unit: '℃', required: false },
          { id: 'rad_status', type: 'RADIO', label: '상태', description: '옵션 중 하나만 골라요.', options: ['양호', '보통', '불량'], required: true },
          { id: 'cb_supplies', type: 'CHECKBOX', label: '보충한 소모품', description: '옵션 중 여러 개를 골라요.', options: ['휴지', '핸드타월', '비누', '방향제'], required: true }
        ])
      },
      {
        id: 'tmpl_elec',
        title: '전기실 수배전반 및 전력설비 일일 점검표',
        target_role_id: 'role_elec',
        target_role_name: '전기/기계설비팀',
        building: '본관',
        frequency: 'DAILY',
        description: '수배전반 전압, 변압기 온도, 이상 소음 및 누전 점검',
        items: JSON.stringify([
          { id: 'sec_2', type: 'SECTION', title: '지하 2층 주 수배전반 계측실', description: '고압반, 저압반, 변압기 순서로 점검' },
          { id: 'chk_panel', type: 'CHECK', label: '수배전반 외관 이상 유무 확인', description: '경보창 표시등 및 계기 이상 여부', required: true },
          { id: 'yn_noise', type: 'YES_NO', label: '이상 소음 및 과열 냄새가 없습니까?', description: '변압기 웅- 소음 및 탄 냄새 체크', required: true },
          { id: 'txt_volt', type: 'TEXT', label: '수전 전압(V)', placeholder: '예: 220.5 또는 380', unit: 'V', required: true },
          { id: 'rad_elec_status', type: 'RADIO', label: '설비 종합 상태', description: '운전 상태 평가', options: ['정상 가동', '주의 요망', '긴급 점검'], required: true },
          { id: 'cb_elec_equip', type: 'CHECKBOX', label: '점검 완료 계기류', description: '확인한 계측 장비 선택', options: ['전압계', '전류계', '역률계', '누전경보기', '온도표시장치'], required: true }
        ])
      },
      {
        id: 'tmpl_fire',
        title: '소방/방재 시설 및 피난통로 점검표',
        target_role_id: 'role_sec',
        target_role_name: '보안/방재안전팀',
        building: '전체',
        frequency: 'DAILY',
        description: '소화기 충압, 비상계단 피난통로 적치물, 유도등 점등 및 방화문 밀폐 점검',
        items: JSON.stringify([
          { id: 'sec_3', type: 'SECTION', title: '소방 시설물 및 비상계단 통로', description: '방화구획 및 소화설비 전수 점검' },
          { id: 'chk_fire_ext', type: 'CHECK', label: '소화기 충압 압력 게이지 녹색(정상)', description: '지정 구역 소화기 지침 압력 확인', required: true },
          { id: 'yn_exit_clear', type: 'YES_NO', label: '비상구 및 비상계단에 적치물이 없습니까?', description: '피난 대피 통로 장애물 확인', required: true },
          { id: 'txt_pressure', type: 'TEXT', label: '옥내소화전 방수압력(MPa)', placeholder: '측정 압력 수치 입력 (예: 0.25)', unit: 'MPa', required: false },
          { id: 'rad_fire_door', type: 'RADIO', label: '방화문 자동 폐쇄 상태', description: '도어클로저 정상 밀폐 확인', options: ['정상 밀폐', '도어체크 유격', '고임목 방치'], required: true },
          { id: 'cb_fire_items', type: 'CHECKBOX', label: '점검 통과 항목', description: '정상 확인된 시설', options: ['유도등 점등', '비상조명등', '자동화재탐지설비', '방화셔터 연동'], required: true }
        ])
      }
    ];

    for (const t of defaultTemplates) {
      db.prepare(`
        INSERT INTO inspection_templates (id, company_id, title, target_role_id, target_role_name, building, frequency, items, description, created_at)
        VALUES (?, 'comp_central_tower', ?, ?, ?, ?, ?, ?, ?, datetime('now', '-3 days'))
      `).run(t.id, t.title, t.target_role_id, t.target_role_name, t.building, t.frequency, t.items, t.description);
    }
  }

  const logCount = db.prepare('SELECT count(*) as cnt FROM inspection_logs').get().cnt;
  if (logCount === 0) {
    const sampleLogs = [
      {
        id: 'ins_log_01',
        template_id: 'tmpl_restroom',
        template_title: '화장실 정기 위생 점검표',
        worker_id: 'user_worker_jung_c',
        worker_name: '정미화 조장',
        role_name: '환경/미화청결팀',
        building: '본관',
        floor: '1F',
        location_name: '1층 로비 화장실',
        status: '양호',
        notes: '바닥 물기 제거 및 핸드타월/물비누 완충 완료.',
        results: JSON.stringify({
          chk_clean: true,
          yn_floor: '네',
          txt_temp: '27.5',
          rad_status: '양호',
          cb_supplies: ['휴지', '핸드타월', '비누']
        }),
        completed_at: "datetime('now', '-45 minutes')"
      },
      {
        id: 'ins_log_02',
        template_id: 'tmpl_elec',
        template_title: '전기실 수배전반 및 전력설비 일일 점검표',
        worker_id: 'user_worker_kang_e',
        worker_name: '강전기 기사',
        role_name: '전기/기계설비팀',
        building: '본관',
        floor: 'B2',
        location_name: '지하 2층 주 수배전반실',
        status: '양호',
        notes: '수전 380V/220V 정상, 역률 98% 양호.',
        results: JSON.stringify({
          chk_panel: true,
          yn_noise: '네',
          txt_volt: '220.4',
          rad_elec_status: '정상 가동',
          cb_elec_equip: ['전압계', '전류계', '역률계', '누전경보기']
        }),
        completed_at: "datetime('now', '-2 hours')"
      },
      {
        id: 'ins_log_03',
        template_id: 'tmpl_fire',
        template_title: '소방/방재 시설 및 피난통로 점검표',
        worker_id: 'user_worker_park_s',
        worker_name: '박보안 대원',
        role_name: '보안/방재안전팀',
        building: '별관',
        floor: '3F',
        location_name: '별관 3층 스마트오피스 지원실 비상계단',
        status: '주의',
        notes: '비상계단 3층 참 구역에 택배 박스 적치물 발견하여 즉시 이전 조치 완료.',
        results: JSON.stringify({
          chk_fire_ext: true,
          yn_exit_clear: '아니오',
          txt_pressure: '0.27',
          rad_fire_door: '정상 밀폐',
          cb_fire_items: ['유도등 점등', '비상조명등', '자동화재탐지설비']
        }),
        completed_at: "datetime('now', '-3 hours')"
      },
      {
        id: 'ins_log_04',
        template_id: 'tmpl_restroom',
        template_title: '화장실 정기 위생 점검표',
        worker_id: 'user_worker_park_c',
        worker_name: '박청결 사원',
        role_name: '환경/미화청결팀',
        building: '본관',
        floor: '3F',
        location_name: '3층 남성화장실',
        status: '양호',
        notes: '소변기 세정 밸브 및 세면대 배수 상태 정상.',
        results: JSON.stringify({
          chk_clean: true,
          yn_floor: '네',
          txt_temp: '26.8',
          rad_status: '양호',
          cb_supplies: ['휴지', '비누']
        }),
        completed_at: "datetime('now', '-5 hours')"
      }
    ];

    for (const l of sampleLogs) {
      db.prepare(`
        INSERT INTO inspection_logs (id, company_id, template_id, template_title, worker_id, worker_name, role_name, building, floor, location_name, status, notes, results, completed_at)
        VALUES (?, 'comp_central_tower', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${l.completed_at})
      `).run(l.id, l.template_id, l.template_title, l.worker_id, l.worker_name, l.role_name, l.building, l.floor, l.location_name, l.status, l.notes, l.results);
    }
  }
}

function seedData() {
  const compCount = db.prepare('SELECT count(*) as cnt FROM companies').get().cnt;
  if (compCount > 0) return;

  console.log('🌱 층수 구조 및 25개 데이터셋 생성 중...');

  // 기본 고객사
  db.prepare(`
    INSERT INTO companies (id, name, subdomain, logo_url, plan, monthly_ticket_limit, monthly_used_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('comp_central_tower', '센트럴타워 통합시설운영본부', 'central', 'FMS', 'FREE', 100, 48);

  // 직무 그룹
  const roles = [
    { id: 'role_maint', name: '영선/시설보수팀', category: 'FACILITY', is_system: 1 },
    { id: 'role_clean', name: '환경/미화청결팀', category: 'CLEANING', is_system: 1 },
    { id: 'role_sec', name: '보안/방재안전팀', category: 'SECURITY', is_system: 1 },
    { id: 'role_elec', name: '전기/기계설비팀', category: 'ELECTRIC', is_system: 0 },
    { id: 'role_elev', name: '승강기/특수팀', category: 'ELEVATOR', is_system: 0 }
  ];
  for (const r of roles) {
    db.prepare('INSERT INTO custom_roles (id, company_id, name, category, is_system) VALUES (?, ?, ?, ?, ?)').run(
      r.id, 'comp_central_tower', r.name, r.category, r.is_system
    );
  }

  // ⭐️ 층수(Floor) 기반 구역 구조
  const locs = [
    { id: 'loc_b2_parking', floor: 'B2', code: 'LOC-B2-01', name: '지하 2층 주차장 B-04', category: 'PARKING', description: '기둥 B-04 배관 부근' },
    { id: 'loc_b1_parking', floor: 'B1', code: 'LOC-B1-01', name: '지하 1층 주차장 A구역', category: 'PARKING', description: '출차 게이트 부근' },
    { id: 'loc_1f_lobby', floor: '1F', code: 'LOC-1F-01', name: '1층 로비 출입구', category: 'LOBBY', description: '회전문 및 안내데스크' },
    { id: 'loc_2f_restroom', floor: '2F', code: 'LOC-2F-01', name: '2층 여자화장실', category: 'RESTROOM', description: '파우더룸 및 변기' },
    { id: 'loc_3f_toilet_m', floor: '3F', code: 'LOC-3F-01', name: '3층 남성화장실', category: 'RESTROOM', description: '세면대 및 소변기 구역' },
    { id: 'loc_4f_meeting', floor: '4F', code: 'LOC-4F-01', name: '4층 대회의실 복도', category: 'OFFICE', description: '공용 정수기 구역' },
    { id: 'loc_5f_office', floor: '5F', code: 'LOC-5F-01', name: '5층 공용 복도', category: 'OFFICE', description: '비상계단 입구' },
    { id: 'loc_6f_lounge', floor: '6F', code: 'LOC-6F-01', name: '6층 입주사 휴게라운지', category: 'OFFICE', description: '카페테리아 주변' },
    { id: 'loc_7f_terrace', floor: '7F', code: 'LOC-7F-01', name: '7층 옥상정원 (루프탑)', category: 'OUTDOOR', description: '휴게 벤치 구역' },
    { id: 'loc_el_01', floor: '1F', code: 'LOC-EL-01', name: '승강기 1호기 (고속)', category: 'ELEVATOR', description: '비상통화 및 조명' },
    { id: 'loc_el_02', floor: 'B1', code: 'LOC-EL-02', name: '승강기 2호기 (비상용)', category: 'ELEVATOR', description: '화물용 도어' }
  ];
  for (const l of locs) {
    db.prepare('INSERT INTO locations (id, company_id, floor, code, name, category, description) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      l.id, 'comp_central_tower', l.floor, l.code, l.name, l.category, l.description
    );
  }

  // 사용자들
  const demoPwHash = hashPassword(process.env.DEMO_USER_PASSWORD || 'fielder2026!');
  const users = [
    { id: 'user_admin', role: 'ADMIN', name: 'Fielder 소장', email: 'admin@fms.kr', phone: '010-1111-2222', custom_role_id: null },
    { id: 'user_admin_sub', role: 'ADMIN', name: '이운영 팀장', email: 'lee.op@fms.kr', phone: '010-1111-3333', custom_role_id: null },
    { id: 'user_worker_choi', role: 'WORKER', name: '최영선 반장', email: 'choi.maint@fms.kr', phone: '010-3333-4444', custom_role_id: 'role_maint' },
    { id: 'user_worker_lee_m', role: 'WORKER', name: '이영선 기사', email: 'lee.maint@fms.kr', phone: '010-3333-5555', custom_role_id: 'role_maint' },
    { id: 'user_worker_jung_c', role: 'WORKER', name: '정미화 조장', email: 'jung.clean@fms.kr', phone: '010-5555-6666', custom_role_id: 'role_clean' },
    { id: 'user_worker_park_c', role: 'WORKER', name: '박청결 사원', email: 'park.clean@fms.kr', phone: '010-5555-7777', custom_role_id: 'role_clean' },
    { id: 'user_worker_kim_c', role: 'WORKER', name: '김위생 사원', email: 'kim.clean@fms.kr', phone: '010-5555-8888', custom_role_id: 'role_clean' },
    { id: 'user_worker_park_s', role: 'WORKER', name: '박보안 대원', email: 'park.sec@fms.kr', phone: '010-7777-8888', custom_role_id: 'role_sec' },
    { id: 'user_worker_kang_e', role: 'WORKER', name: '강전기 기사', email: 'kang.elec@fms.kr', phone: '010-8888-9999', custom_role_id: 'role_elec' },
    { id: 'user_worker_song_v', role: 'WORKER', name: '송승강 엔지니어', email: 'song.elev@fms.kr', phone: '010-9999-1111', custom_role_id: 'role_elev' }
  ];
  for (const u of users) {
    db.prepare('INSERT INTO users (id, company_id, role, name, email, password, phone, custom_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
      u.id, 'comp_central_tower', u.role, u.name, u.email, demoPwHash, u.phone, u.custom_role_id
    );
  }

  // ⭐️ 25개 시드 데이터셋 (민원접수 PUBLIC_QR vs 신규접수 STAFF_APP)
  const sampleTickets = [
    // 1. 신규접수 (현장직원 순찰 접수 건)
    { id: 't_2003', no: 'T-2003', loc: 'loc_5f_office', cat: 'ELECTRIC', title: '5층 복도 4번 LED 매립등 깜빡임', desc: '조명이 지속적으로 깜빡거려 눈 피로 유발', type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'PENDING', time: '-45 minutes' },
    { id: 't_2005', no: 'T-2005', loc: 'loc_el_02', cat: 'ELEVATOR', title: '비상용 승강기 내부 비상통화 버튼 불량', desc: '비상벨 버튼을 눌러도 관제실 신호음 연결 안 됨', type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'PENDING', time: '-2 hours' },
    { id: 't_2019', no: 'T-2019', loc: 'loc_b1_parking', cat: 'SECURITY', title: '지하 1층 비상소화전 앞 적치물 방치', desc: '순찰 중 소화전 앞 물품 적치 확인되어 이동 조치 필요', type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'PENDING', time: '-1 hours' },

    // 2. 민원접수 (일반 사용자 모바일 QR에서 온 것 - 건의사항 포함)
    { id: 't_2001', no: 'T-2001', loc: 'loc_3f_toilet_m', cat: 'FACILITY', title: '세면대 2호 자동 수전 센서 미작동', desc: '손을 대도 물이 전혀 나오지 않습니다. 수리 부탁드립니다.', type: 'PUBLIC_QR', name: '이*수', phone: '010-1234-5678', status: 'PENDING', time: '-15 minutes' },
    { id: 't_2002', no: 'T-2002', loc: 'loc_1f_lobby', cat: 'CLEANING', title: '1층 로비 출입 회전문 앞 음료 쏟아짐', desc: '커피 음료가 쏟아져 바닥 끈적임 및 미끄럼 우려', type: 'PUBLIC_QR', name: '방문객A', phone: '010-2345-6789', status: 'PENDING', time: '-25 minutes' },
    { id: 't_2004', no: 'T-2004', loc: 'loc_2f_restroom', cat: 'FACILITY', title: '2층 여자화장실 3번 칸 문고리 잠금 불량', desc: '안쪽에서 잠금장치가 헛돌아서 문이 안 잠겨요', type: 'PUBLIC_QR', name: '입주사 직원', phone: '010-3456-7890', status: 'PENDING', time: '-1 hours' },
    { id: 't_2006', no: 'T-2006', loc: 'loc_7f_terrace', cat: 'CLEANING', title: '옥상정원 흡연구역 재떨이 담배꽁초 넘침', desc: '바람에 꽁초가 날려 지저분합니다. 청소 요청합니다.', type: 'PUBLIC_QR', name: '김*현', phone: '010-4567-8901', status: 'PENDING', time: '-3 hours' },
    { id: 't_2020', no: 'T-2020', loc: 'loc_4f_meeting', cat: 'FACILITY', title: '[민원/건의] 4층 회의실 복도 정수기 종이컵 디스펜서 추가 건의', desc: '오후 시간대에 컵이 자주 부족하니 디스펜서 추가 설치 건의드립니다.', type: 'PUBLIC_QR', name: '최*민', phone: '010-8888-2222', status: 'PENDING', time: '-4 hours' },
    { id: 't_2021', no: 'T-2021', loc: 'loc_6f_lounge', cat: 'CLEANING', title: '[민원/건의] 6층 휴게라운지 분리수거함 라벨 안내문 부착 요청', desc: '캔/플라스틱 구분이 잘 안 보여서 표지판이 더 컸으면 좋겠습니다.', type: 'PUBLIC_QR', name: '정*원', phone: '010-7777-3333', status: 'PENDING', time: '-5 hours' },

    // 3. 진행중 (정상 조치 진행 중 - 실무자 먼저 접수 테스트 지원)
    // ⭐️ 3-1. 조치 완료 ➔ 관리자 마감 승인 대기중 (WAITING_APPROVAL)
    { id: 't_2007', no: 'T-2007', loc: 'loc_1f_lobby', cat: 'CLEANING', title: '로비 출입문 유리창 지문 얼룩 정비', desc: '유리도어 정밀 클리닝', type: 'STAFF_APP', name: '안내데스크', phone: '010-9999-0000', status: 'WAITING_APPROVAL', time: '-30 minutes', target: 'GROUP', role: 'role_clean', title_wo: '로비 유리문 클리닝 지시', started: true, completed_by: '정미화 조장', notes: '로비 출입문 유리창 지문 및 얼룩 전용 세정제로 세척 완료했습니다.' },
    { id: 't_2010', no: 'T-2010', loc: 'loc_5f_office', cat: 'FACILITY', title: '5층 비상계단 방화문 도어클로저 덜컹거림', desc: '도어클로저 암 장력 조정', type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'WAITING_APPROVAL', time: '-2 hours', target: 'INDIVIDUAL', assignee: 'user_worker_choi', title_wo: '도어클로저 힌지 유격 및 속도 조정', started: true, completed_by: '최영선 반장', notes: '5층 방화문 도어클로저 힌지 유격 볼트 조임 및 속도 밸브 정상 조정 완료.' },

    // ⭐️ 3-2. 실무자 현장 접수 착수 대기 (started = false, 접수 버튼 눌러야 조치 가능)
    { id: 't_2009', no: 'T-2009', loc: 'loc_3f_toilet_m', cat: 'CLEANING', title: '3층 남성화장실 핸드타월 디스펜서 보충', desc: '핸드타월 및 비누 리필 필요', type: 'PUBLIC_QR', name: '이*수', phone: '010-1234-5678', status: 'IN_PROGRESS', time: '-1 hours', target: 'GROUP', role: 'role_clean', title_wo: '위생용품 긴급 보충 바람', started: false },
    { id: 't_2011', no: 'T-2011', loc: 'loc_b2_parking', cat: 'ELECTRIC', title: '지하 2층 B구역 센서 감지 조명 미점등', desc: '차량 진입 시 센서 불량으로 조명 안 켜짐', type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'IN_PROGRESS', time: '-4 hours', target: 'GROUP', role: 'role_elec', title_wo: '센서 모듈 교체 확인 요망', started: false },
    { id: 't_2013', no: 'T-2013', loc: 'loc_2f_restroom', cat: 'CLEANING', title: '2층 화장실 바닥 미끄럼 방지 매트 청소', desc: '우천 후 먼지 및 물기 세척 요청', type: 'STAFF_APP', name: '안내데스크', phone: '010-9999-0000', status: 'IN_PROGRESS', time: '-6 hours', target: 'GROUP', role: 'role_clean', title_wo: '미끄럼 매트 세척 및 건조', started: false },

    // ⭐️ 3-3. 이미 실무자가 접수하여 현장 작업 중 (started = true)
    { id: 't_2008', no: 'T-2008', loc: 'loc_b1_parking', cat: 'SECURITY', title: '지하 1층 주차장 장애인 구역 불법 적치물', desc: '택배 파렛트 적치물 이동 조치', type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'IN_PROGRESS', time: '-50 minutes', target: 'INDIVIDUAL', assignee: 'user_worker_park_s', title_wo: '적치물 즉시 이동 및 차도 확보', started: true, claimed_by: '박보안 대원' },
    { id: 't_2012', no: 'T-2012', loc: 'loc_el_01', cat: 'ELEVATOR', title: '승강기 1호기 내부 바닥 타일 들뜸', desc: '출입 발판 타일 끝부분 들뜸 현상', type: 'STAFF_APP', name: '이운영 팀장', phone: '010-1111-3333', status: 'IN_PROGRESS', time: '-5 hours', target: 'GROUP', role: 'role_elev', title_wo: '발판 고정 및 테이핑 조치', started: true, claimed_by: '송승강 엔지니어' },
    { id: 't_2014', no: 'T-2014', loc: 'loc_7f_terrace', cat: 'FACILITY', title: '옥상정원 배수구 낙엽 유입으로 배수 지연', desc: '트렌치 커버 분리 후 낙엽 수거 요망', type: 'STAFF_APP', name: '이운영 팀장', phone: '010-1111-3333', status: 'IN_PROGRESS', time: '-8 hours', target: 'INDIVIDUAL', assignee: 'user_worker_choi', title_wo: '옥상 배수구 트렌치 청소 및 통수 확인', started: true, claimed_by: '최영선 반장' },

    // 4. 현장미해결 (해결 불가 보고되어 계속 대기 중인 건)
    { 
      id: 't_1029', no: 'T-1029', loc: 'loc_b2_parking', cat: 'FACILITY', 
      title: '지하 2층 천장 메인 급수배관 미세 누수', desc: '배관 밸브 점검 및 누수 패킹 교체', 
      type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'IN_PROGRESS', time: '-51 hours',
      target: 'INDIVIDUAL', assignee: 'user_worker_choi', title_wo: '배관 패킹 즉시 교체 바람',
      res: 'UNRESOLVED', started: true,
      reason: '배관 노후화로 특수 규격 밸브(100A)가 마모됨. 현장 보유 부품 없음. 자재 발주 납품까지 3일 소요 예정으로 계속 대기 필요.',
      completed_by: '최영선 반장'
    },
    { 
      id: 't_2015', no: 'T-2015', loc: 'loc_el_01', cat: 'ELEVATOR', 
      title: '승강기 1호기 운행 중 14층 부근 소음 및 미세 진동', desc: '가이드 롤러 및 레일 마모 상태 점검 요망', 
      type: 'STAFF_APP', name: '이운영 팀장', phone: '010-1111-3333', status: 'IN_PROGRESS', time: '-26 hours',
      target: 'GROUP', role: 'role_elev', title_wo: '승강기 전문 점검반 긴급 출동',
      res: 'UNRESOLVED', started: true,
      reason: '자체 정비 불가. 현대엘리베이터 메인 컨트롤러 특수 진단 장비 및 부품 교체 외주 접수 완료. 외주팀 방문 대기 중.',
      completed_by: '송승강 엔지니어'
    },
    { 
      id: 't_2016', no: 'T-2016', loc: 'loc_1f_lobby', cat: 'FACILITY', 
      title: '1층 로비 메인 자동문 센서 모듈 고장으로 간헐적 닫힘 불가', desc: '적외선 안전 센서 컨트롤러 에러', 
      type: 'STAFF_APP', name: '안내데스크', phone: '010-9999-0000', status: 'IN_PROGRESS', time: '-30 hours',
      target: 'INDIVIDUAL', assignee: 'user_worker_choi', title_wo: '자동문 센서 단자 재결선 바람',
      res: 'UNRESOLVED', started: true,
      reason: '센서 PCB 메인기판 침수로 부품 전소됨. 자동문 제조사(오토도어텍) 정품 기판 주문 필요. 현재 수동 개방 고정 조치 후 대기 중.',
      completed_by: '최영선 반장'
    },
    { 
      id: 't_2017', no: 'T-2017', loc: 'loc_b2_parking', cat: 'ELECTRIC', 
      title: '지하 2층 주차관제 게이트 차단기 바 모터 과열 정지', desc: '차량 진입 시 바가 안 올라감', 
      type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'IN_PROGRESS', time: '-18 hours',
      target: 'GROUP', role: 'role_elec', title_wo: '주차 차단기 감속기 모터 점검',
      res: 'UNRESOLVED', started: true,
      reason: '모터 감속기 내부 기어 파손 확인. 아마노코리아 정품 교체 필요 (견적 승인 후 수리 진행 요망). 게이트 수동 개방 상태로 대기.',
      completed_by: '강전기 기사'
    },

    // 5. 마감완료 (관리자 승인 코멘트 포함)
    { 
      id: 't_3001', no: 'T-3001', loc: 'loc_5f_office', cat: 'CLEANING', 
      title: '5층 탕비실 싱크대 배수구 음식물 악취 청소', desc: '배수 트랩 청소 및 소독약 투여', 
      type: 'STAFF_APP', name: '입주사총무', phone: '010-1111-4444', status: 'COMPLETED', time: '-1 days',
      target: 'GROUP', role: 'role_clean', assignee: 'user_worker_jung_c', completed_by: '정미화 조장',
      res: 'RESOLVED', notes: '배수트랩 거름망 청소 및 배수관 소독제 주입 완료.', admin_notes: '현장 확인 완료. 악취 제거 양호하여 종결 승인함.'
    },
    { 
      id: 't_3002', no: 'T-3002', loc: 'loc_b1_parking', cat: 'ELECTRIC', 
      title: '지하 1층 주차장 안내 표지판 조명 교체', desc: 'LED 모듈 교체', 
      type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'COMPLETED', time: '-2 days',
      target: 'GROUP', role: 'role_elec', assignee: 'user_worker_kang_e', completed_by: '강전기 기사',
      res: 'RESOLVED', notes: '안정기 및 30W LED 모듈 교체 완료.', admin_notes: '조명 조도 및 점등 상태 확인 후 종결 승인.'
    },
    { 
      id: 't_3003', no: 'T-3003', loc: 'loc_2f_restroom', cat: 'CLEANING', 
      title: '2층 여자화장실 세면대 배수관 머리카락 제거', desc: '배수 역류 방지 청소', 
      type: 'PUBLIC_QR', name: '입주사A', phone: '010-6789-0123', status: 'COMPLETED', time: '-3 days',
      target: 'GROUP', role: 'role_clean', assignee: 'user_worker_park_c', completed_by: '박청결 사원',
      res: 'RESOLVED', notes: '배수관 관통기 작업으로 이물질 완전 제거 완료.', admin_notes: '통수 시험 정상 확인, 최종 마감.'
    },
    { 
      id: 't_3004', no: 'T-3004', loc: 'loc_el_02', cat: 'FACILITY', 
      title: '승강기 2호기 승강장 버튼 커버 헐거움 고정', desc: '볼트 조임 작업', 
      type: 'STAFF_APP', name: '이운영 팀장', phone: '010-1111-3333', status: 'COMPLETED', time: '-4 days',
      target: 'INDIVIDUAL', assignee: 'user_worker_choi', completed_by: '최영선 반장',
      res: 'RESOLVED', notes: '커버 고정 브라켓 재조립 및 마감 나사 교체 완료.', admin_notes: '버튼 작동 및 마감 체결 상태 양호 확인.'
    },
    { 
      id: 't_3005', no: 'T-3005', loc: 'loc_1f_lobby', cat: 'SECURITY', 
      title: '1층 서측 비상출입문 열림 감지 센서 오작동 정비', desc: '도어 마그네틱 센서 정비', 
      type: 'STAFF_APP', name: '박보안 대원', phone: '010-7777-8888', status: 'COMPLETED', time: '-5 days',
      target: 'GROUP', role: 'role_sec', assignee: 'user_worker_park_s', completed_by: '박보안 대원',
      res: 'RESOLVED', notes: '마그네틱 센서 접점 불량 세척 및 재결선으로 정상 작동 복구.', admin_notes: '방재실 신호 연동 및 센서 정상 복구 확인 승인.'
    }
  ];

  for (const t of sampleTickets) {
    const isAssigned = t.status !== 'PENDING';
    const isStarted = t.started === true;
    const isCompleted = t.status === 'COMPLETED';

    db.prepare(`
      INSERT INTO tickets (
        id, ticket_no, company_id, location_id, category, title, description,
        reporter_type, reporter_name, reporter_phone, status,
        target_type, target_group_role_id, assignee_id,
        instruction_title, resolution_type, unresolved_reason,
        completion_notes, completed_by_name, admin_notes, claimed_by_name,
        created_at, assigned_at, started_at, completed_at, approved_at
      ) VALUES (
        ?, ?, 'comp_central_tower', ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        datetime('now', '${t.time}'),
        ${isAssigned ? `datetime('now', '${t.time}')` : 'NULL'},
        ${isStarted ? `datetime('now', '${t.time}')` : 'NULL'},
        ${t.status === 'WAITING_APPROVAL' || isCompleted ? `datetime('now', '${t.time}')` : 'NULL'},
        ${isCompleted ? `datetime('now', '${t.time}')` : 'NULL'}
      )
    `).run(
      t.id, t.no, t.loc, t.cat, t.title, t.desc,
      t.type, t.name, t.phone, t.status,
      t.target || null, t.role || null, t.assignee || null,
      t.title_wo || null, t.res || null, t.reason || null,
      t.notes || null, t.completed_by || null,
      t.admin_notes || null, t.claimed_by || null
    );
  }

  // 블랙리스트
  db.prepare(`
    INSERT INTO blocked_users (id, company_id, phone, reason, created_at)
    VALUES (?, ?, ?, ?, datetime('now', '-3 days'))
  `).run('block_01', 'comp_central_tower', '010-8888-1294', '허위 사진 반복 신고 (3회 누적)');
}

module.exports = {
  db,
  initDatabase,
  hashPassword,
  verifyPassword
};
