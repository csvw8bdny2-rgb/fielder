const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ALLOWED_IMAGE_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

let s3Client = null;

function isR2Configured() {
  return Boolean(
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_URL
  );
}

function getS3Client() {
  if (!s3Client && isR2Configured()) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

/**
 * 이미지 Data URL(또는 기존 URL)을 검증하고, R2가 설정된 경우 Cloudflare R2에 업로드해 공개 URL을 반환합니다.
 * 미설정 로컬 환경에서는 MIME/용량(5MB) 검증 후 원본 Data URL을 그대로 반환합니다.
 */
async function processAndUploadImage(input, folder = 'tickets') {
  const val = String(input || '').trim();
  if (!val) return '';
  if (/^https?:\/\//i.test(val)) return val;

  const match = val.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) {
    const err = new Error('지원하지 않는 이미지 형식입니다. (JPEG, PNG, WEBP만 허용)');
    err.statusCode = 400;
    throw err;
  }

  const mime = match[1].toLowerCase();
  const ext = ALLOWED_IMAGE_MIME[mime];
  if (!ext) {
    const err = new Error('허용되지 않는 이미지 MIME 타입입니다. (image/jpeg, image/png, image/webp만 허용)');
    err.statusCode = 400;
    throw err;
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    const err = new Error('이미지 파일 크기는 최대 5MB까지만 업로드할 수 있습니다.');
    err.statusCode = 400;
    throw err;
  }

  if (!isR2Configured()) {
    return val;
  }

  const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `${folder}/${datePrefix}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const client = getS3Client();
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mime,
    CacheControl: 'public, max-age=31536000',
  }));

  const base = String(process.env.R2_PUBLIC_URL).replace(/\/+$/, '');
  return `${base}/${key}`;
}

module.exports = {
  isR2Configured,
  processAndUploadImage,
  MAX_IMAGE_BYTES,
};
