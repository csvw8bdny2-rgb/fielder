const crypto = require('crypto');

function getSmsConfig() {
  const provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  const apiKey = String(process.env.SMS_API_KEY || '').trim();
  const apiSecret = String(process.env.SMS_API_SECRET || '').trim();
  const userId = String(process.env.SMS_USER_ID || '').trim();
  const sender = String(process.env.SMS_SENDER || '').trim();
  return { provider, apiKey, apiSecret, userId, sender };
}

function isLiveSmsConfigured() {
  const cfg = getSmsConfig();
  if (cfg.provider === 'aligo') {
    return Boolean(cfg.apiKey && (cfg.userId || cfg.apiSecret) && cfg.sender);
  }
  if (cfg.provider === 'solapi') {
    return Boolean(cfg.apiKey && cfg.apiSecret && cfg.sender);
  }
  return false;
}

async function sendSmsOtpMessage(phone, otpCode) {
  const cfg = getSmsConfig();
  const text = `[Fielder] 본인확인 인증번호는 [${otpCode}]입니다. (5분 내 입력)`;
  const cleanReceiver = String(phone || '').replace(/\D/g, '');
  const cleanSender = cfg.sender.replace(/\D/g, '');

  if (cfg.provider === 'aligo' && isLiveSmsConfigured()) {
    const form = new URLSearchParams({
      key: cfg.apiKey,
      user_id: cfg.userId || cfg.apiSecret,
      sender: cleanSender,
      receiver: cleanReceiver,
      msg: text,
    });
    const res = await fetch('https://apis.aligo.in/send/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || Number(data.result_code) < 1) {
      throw new Error(data.message || '알리고 문자 발송에 실패했습니다.');
    }
    return { ok: true, provider: 'aligo', raw: data };
  }

  if (cfg.provider === 'solapi' && isLiveSmsConfigured()) {
    const date = new Date().toISOString();
    const salt = crypto.randomBytes(16).toString('hex');
    const signature = crypto
      .createHmac('sha256', cfg.apiSecret)
      .update(date + salt)
      .digest('hex');

    const res = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `HMAC-SHA256 apiKey=${cfg.apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify({
        message: {
          to: cleanReceiver,
          from: cleanSender,
          text,
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.errorMessage || data.message || '솔라피 문자 발송에 실패했습니다.');
    }
    return { ok: true, provider: 'solapi', raw: data };
  }

  // 개발용 테스트 모드 폴백
  return { ok: true, provider: 'mock' };
}

module.exports = {
  isLiveSmsConfigured,
  sendSmsOtpMessage,
};
