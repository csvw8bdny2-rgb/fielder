(function() {
  window.escapeHtml = function(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  window.formatMobilePhoneInput = function(el) {
    if (!el) return '';
    const digits = String(el.value || '').replace(/\D/g, '').slice(0, 11);
    let formatted = digits;
    if (digits.length > 7) {
      formatted = `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    } else if (digits.length > 3) {
      formatted = `${digits.slice(0, 3)}-${digits.slice(3)}`;
    }
    el.value = formatted;
    return formatted;
  };

  window.isValidMobile010 = function(val) {
    if (!val) return true;
    return /^010-\d{4}-\d{4}$/.test(String(val).trim());
  };

  // 1. KFIRST 커스텀 콤보박스 스타일 주입 (OS 기본 회색 팝업 대체)
  const style = document.createElement('style');
  style.textContent = `
    .kf-select-native-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
      pointer-events: none !important;
    }
    .kf-select-btn {
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      background-color: #FFFFFF;
      border: 1px solid #D5D3CF;
      border-radius: 0.5rem;
      padding: 0 10px;
      min-height: 36px;
      font-size: 13px;
      font-weight: 600;
      color: #111827;
      cursor: pointer;
      transition: border-color 0.15s, box-shadow 0.15s;
      text-align: left;
    }
    .kf-select-btn:hover {
      border-color: #0084B4;
    }
    .kf-select-btn.kf-open {
      border-color: #13B5EA;
      box-shadow: 0 0 0 2px rgba(19, 181, 234, 0.2);
    }
    .kf-select-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .kf-select-menu {
      position: fixed;
      z-index: 99999;
      background: #FFFFFF;
      border: 1px solid #CBD5E1;
      border-radius: 0.75rem;
      box-shadow: 0 12px 30px -6px rgba(0, 43, 65, 0.18), 0 4px 10px -2px rgba(0, 43, 65, 0.08);
      padding: 6px;
      max-height: 260px;
      overflow-y: auto;
      font-family: inherit;
    }
    .kf-select-option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 0.5rem;
      font-size: 13px;
      font-weight: 600;
      color: #1E1F21;
      cursor: pointer;
      transition: background-color 0.12s, color 0.12s;
      white-space: normal;
      word-break: keep-all;
    }
    .kf-select-option:hover {
      background-color: #F0F8FC;
      color: #007EA8;
    }
    .kf-select-option.kf-selected {
      background-color: #EBF7FD;
      color: #007EA8;
      font-weight: 700;
    }
    .kf-select-option.kf-disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    @media print {
      header, nav, .no-print { display: none !important; }
      body { background: #FFFFFF !important; }
    }
  `;
  document.head.appendChild(style);

  let activeMenu = null;
  let activeSelect = null;
  let activeBtn = null;

  function closeMenu() {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
    if (activeBtn) {
      activeBtn.classList.remove('kf-open');
      activeBtn = null;
    }
    activeSelect = null;
  }

  function syncButtonText(selectEl) {
    const btn = selectEl._kfBtn;
    if (!btn) return;
    const labelEl = btn.querySelector('.kf-select-label');
    const selectedOpt = selectEl.options[selectEl.selectedIndex];
    labelEl.textContent = selectedOpt ? selectedOpt.text : (selectEl.getAttribute('placeholder') || '선택');
    if (selectEl.disabled) {
      btn.style.opacity = '0.55';
      btn.style.pointerEvents = 'none';
    } else {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }
  }

  function openMenuForSelect(selectEl, btn) {
    if (activeSelect === selectEl) {
      closeMenu();
      return;
    }
    closeMenu();

    activeSelect = selectEl;
    activeBtn = btn;
    btn.classList.add('kf-open');

    const menu = document.createElement('div');
    menu.className = 'kf-select-menu';

    Array.from(selectEl.options).forEach((opt, idx) => {
      const item = document.createElement('div');
      const isSelected = idx === selectEl.selectedIndex;
      item.className = 'kf-select-option' + (isSelected ? ' kf-selected' : '') + (opt.disabled ? ' kf-disabled' : '');
      const labelSpan = document.createElement('span');
      labelSpan.style.overflow = 'hidden';
      labelSpan.style.textOverflow = 'ellipsis';
      labelSpan.textContent = opt.text;
      item.appendChild(labelSpan);
      if (isSelected) {
        const checkSpan = document.createElement('span');
        checkSpan.style.color = '#13B5EA';
        checkSpan.style.fontWeight = '900';
        checkSpan.textContent = '✓';
        item.appendChild(checkSpan);
      }
      if (!opt.disabled) {
        item.addEventListener('click', function(e) {
          e.stopPropagation();
          selectEl.selectedIndex = idx;
          syncButtonText(selectEl);
          closeMenu();
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    activeMenu = menu;

    const rect = btn.getBoundingClientRect();
    const maxAllowedWidth = Math.max(200, window.innerWidth - 16);
    menu.style.minWidth = Math.min(Math.max(rect.width, 160), maxAllowedWidth) + 'px';
    menu.style.maxWidth = maxAllowedWidth + 'px';
    const actualWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = (spaceBelow < menuHeight + 12 && rect.top > menuHeight + 12)
      ? (rect.top - menuHeight - 4)
      : (rect.bottom + 4);
    let left = rect.left;
    if (left + actualWidth > window.innerWidth - 12) {
      left = Math.max(8, rect.right - actualWidth);
    }
    if (left + actualWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - actualWidth - 8);
    }
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.left = left + 'px';
  }

  function enhanceSelect(selectEl) {
    if (!selectEl || selectEl._kfEnhanced || selectEl.dataset.native === 'true' || selectEl.multiple) return;
    selectEl._kfEnhanced = true;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kf-select-btn';
    // 원본 select의 높이/너비 스타일 힌트 반영
    if (selectEl.classList.contains('h-11')) btn.style.minHeight = '44px';
    else if (selectEl.classList.contains('h-10')) btn.style.minHeight = '40px';
    else if (selectEl.classList.contains('h-8')) btn.style.minHeight = '32px';

    btn.innerHTML = `
      <span class="kf-select-label"></span>
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" style="flex-shrink:0;color:#64748B;">
        <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    selectEl._kfBtn = btn;
    selectEl.classList.add('kf-select-native-hidden');
    selectEl.parentNode.insertBefore(btn, selectEl.nextSibling);
    syncButtonText(selectEl);

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      openMenuForSelect(selectEl, btn);
    });

    selectEl.addEventListener('change', function() {
      syncButtonText(selectEl);
    });

    const optObserver = new MutationObserver(() => syncButtonText(selectEl));
    optObserver.observe(selectEl, { childList: true, subtree: true, attributes: true });
  }

  // .value 프로퍼티 프로그래밍 변경도 자동 동기화
  const valDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (valDesc && valDesc.set) {
    Object.defineProperty(HTMLSelectElement.prototype, 'value', {
      get: function() { return valDesc.get.call(this); },
      set: function(v) {
        valDesc.set.call(this, v);
        if (this._kfEnhanced) syncButtonText(this);
      },
      configurable: true
    });
  }

  function scanSelects(root) {
    (root || document).querySelectorAll('select').forEach(enhanceSelect);
  }

  document.addEventListener('click', function(e) {
    if (activeMenu && !activeMenu.contains(e.target) && (!activeBtn || !activeBtn.contains(e.target))) {
      closeMenu();
    }
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', function(e) {
    if (activeMenu && e.target !== activeMenu) closeMenu();
  }, true);

  document.addEventListener('DOMContentLoaded', function() {
    scanSelects(document);
    const domObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            if (node.tagName === 'SELECT') enhanceSelect(node);
            else if (node.querySelectorAll) scanSelects(node);
          }
        });
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  });

  window.syncCustomSelect = syncButtonText;

  // 2. 클라이언트 이미지 자동 리사이징 & 압축 (최대 1280px, WebP/JPEG 변환)
  window.compressImageFile = function(file, options) {
    const opts = Object.assign({ maxWidth: 1280, maxHeight: 1280, quality: 0.78 }, options || {});
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        return reject(new Error('이미지 파일이 아닙니다.'));
      }
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function() {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;
        if (width > opts.maxWidth || height > opts.maxHeight) {
          const ratio = Math.min(opts.maxWidth / width, opts.maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        let dataUrl = canvas.toDataURL('image/webp', opts.quality);
        if (!dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/jpeg', opts.quality);
        }
        const compressedBytes = Math.round((dataUrl.length * 3) / 4);
        resolve({
          dataUrl,
          width,
          height,
          originalKB: Math.max(1, Math.round(file.size / 1024)),
          compressedKB: Math.max(1, Math.round(compressedBytes / 1024))
        });
      };
      img.onerror = function() {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('이미지를 불러올 수 없습니다.'));
      };
      img.src = objectUrl;
    });
  };
})();
