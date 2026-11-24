let isSmsVerified = false;
let qrVerifyToken = '';
let capturedQrPhotoData = '';
let hasReportPhoto = false;

function showQrToast(msg, isError = false) {
  let toast = document.getElementById('qr-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'qr-toast';
    toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] px-4 py-2.5 rounded-xl text-xs font-bold shadow-lg transition-opacity max-w-[90vw] text-center';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] px-4 py-2.5 rounded-xl text-xs font-bold shadow-lg transition-opacity max-w-[90vw] text-center ${isError ? 'bg-[#C53030] text-white' : 'bg-[#002B41] text-white'}`;
  toast.classList.remove('hidden');
  clearTimeout(window._qrToastTimer);
  window._qrToastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function resetSmsVerification() {
  if (isSmsVerified || qrVerifyToken) {
    isSmsVerified = false;
    qrVerifyToken = '';
    const badge = document.getElementById('sms-badge');
    if (badge) {
      badge.innerText = '인증 대기 (번호 변경됨)';
      badge.className = 'text-xs text-[#E5983B] font-semibold';
    }
  }
}

async function sendSmsOtp() {
  const phone = (document.getElementById('sms-phone')?.value || '').trim();
  if (!phone) { showQrToast('휴대폰 번호를 입력하세요.', true); return; }
  const tenant = new URLSearchParams(window.location.search).get('tenant') || '';
  const res = await fetch('/api/auth/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, tenant })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showQrToast(data.message || data.error || '인증번호 발송 실패', true); return; }
  document.getElementById('otp-group')?.classList.remove('hidden');
  showQrToast(data.message || '인증번호 6자리가 발송되었습니다.');
}

async function verifySmsOtp() {
  const phone = (document.getElementById('sms-phone')?.value || '').trim();
  const otp = (document.getElementById('sms-otp')?.value || '').trim();
  const tenant = new URLSearchParams(window.location.search).get('tenant') || '';
  const res = await fetch('/api/auth/sms/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, otp, tenant })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showQrToast(data.message || data.error || '인증번호 오류', true); return; }
  isSmsVerified = true;
  qrVerifyToken = data.verification_token || '';
  const badge = document.getElementById('sms-badge');
  if (badge) {
    badge.innerText = '인증 완료';
    badge.className = 'text-xs text-[#34A853] font-bold';
  }
  showQrToast('문자 인증이 완료되었습니다.');
}

async function handleQrPhotoFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    showQrToast('이미지 파일(JPG, PNG 등)만 첨부할 수 있습니다.', true);
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showQrToast('사진 파일은 10MB 이하만 첨부할 수 있습니다.', true);
    return;
  }
  let infoText = file.name;
  if (window.compressImageFile) {
    try {
      const res = await window.compressImageFile(file, { maxWidth: 1280, maxHeight: 1280, quality: 0.78 });
      capturedQrPhotoData = res.dataUrl;
      infoText = `${res.originalKB}KB -> ${res.compressedKB}KB`;
    } catch (e) {}
  } else {
    await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => { capturedQrPhotoData = ev.target.result || ''; resolve(); };
      reader.readAsDataURL(file);
    });
  }
  hasReportPhoto = true;
  document.getElementById('qr-photo-status').innerHTML = `<span class="text-[#34A853] font-bold">현장 사진 등록됨 (${infoText})</span>`;
  document.getElementById('btn-clear-qr-photo')?.classList.remove('hidden');
  showQrToast('현장 사진이 첨부되었습니다.');
}

function clearQrPhoto() {
  hasReportPhoto = false;
  capturedQrPhotoData = '';
  document.getElementById('qr-photo-status').innerText = '사진 촬영 / 추가 (클릭 또는 드래그)';
  document.getElementById('btn-clear-qr-photo')?.classList.add('hidden');
}

function simulateReportPhoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (file) await handleQrPhotoFile(file);
  };
  input.click();
}

async function submitQrTicket() {
  if (!isSmsVerified || !qrVerifyToken) { showQrToast('먼저 휴대폰 문자 인증을 완료해 주세요.', true); return; }
  const title = (document.getElementById('qr-title')?.value || '').trim();
  if (!title) { showQrToast('신고 제목을 입력하세요.', true); return; }
  const locId = document.getElementById('qr-target-location')?.value || '';
  const cat = document.getElementById('qr-category-select')?.value || 'FACILITY';
  const desc = (document.getElementById('qr-desc')?.value || '').trim();
  const phone = (document.getElementById('sms-phone')?.value || '').trim();
  const tenant = new URLSearchParams(window.location.search).get('tenant') || '';

  const btn = document.getElementById('btn-submit-qr-ticket');
  if (btn) { btn.disabled = true; btn.innerText = '접수 처리 중...'; }
  try {
    const res = await fetch('/api/tickets/qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant,
        location_id: locId,
        category: cat,
        title,
        description: desc,
        phone,
        photo_url: capturedQrPhotoData || '',
        qr_verify_token: qrVerifyToken
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showQrToast(data.message || data.error || '신고 접수 실패', true);
      return;
    }
    const resultBox = document.getElementById('qr-submit-result');
    if (resultBox) {
      const nowStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      resultBox.innerHTML = `<div class="font-bold">접수 완료 (접수번호: ${data.ticket_no || '-'} · ${nowStr})</div><div>시설관리 관제센터에 정상 등록되었습니다. 중복 접수하지 않으셔도 됩니다.</div>`;
      resultBox.classList.remove('hidden');
    }
    showQrToast(`접수 완료 (${data.ticket_no || ''})`);
    document.getElementById('qr-title').value = '';
    document.getElementById('qr-desc').value = '';
    clearQrPhoto();
    resetSmsVerification();
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = '정비 요청 접수하기'; }
  }
}

(async function initQrPage() {
  const sp = new URLSearchParams(window.location.search);
  const tenant = sp.get('tenant') || '';
  const locId = sp.get('locId') || '';

  if (tenant) {
    try {
      const cr = await fetch(`/api/public/company?tenant=${encodeURIComponent(tenant)}`);
      if (cr.ok) {
        const comp = await cr.json();
        const titleEl = document.getElementById('qr-company-title');
        if (titleEl && comp?.name) titleEl.textContent = comp.name;
      }
    } catch (e) {}
  }

  const select = document.getElementById('qr-target-location');
  if (select) {
    try {
      const res = await fetch(`/api/public/locations?tenant=${encodeURIComponent(tenant)}`);
      const locs = res.ok ? await res.json() : [];
      select.innerHTML = '';
      if (!Array.isArray(locs) || locs.length === 0) {
        select.innerHTML = '<option value="">등록된 구역이 없습니다</option>';
      } else {
        locs.forEach(l => {
          const opt = document.createElement('option');
          opt.value = l.id;
          opt.innerText = l.name;
          select.appendChild(opt);
        });
        if (locId && Array.from(select.options).some(o => o.value === locId)) {
          select.value = locId;
        }
      }
    } catch (e) {
      select.innerHTML = '<option value="">구역 정보를 불러오지 못했습니다</option>';
    }
  }

  const dz = document.getElementById('dropzone-qr-photo');
  if (dz) {
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.add('border-[#13B5EA]', 'bg-[#EBF7FD]');
    }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('border-[#13B5EA]', 'bg-[#EBF7FD]');
    }));
    dz.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) handleQrPhotoFile(files[0]);
    });
  }
})();
