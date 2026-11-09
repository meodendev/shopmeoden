const crypto = require('crypto');

// Khóa AES-256 lấy từ ENV (64 ký tự hex)
function getKey() {
  const k = Buffer.from(process.env.ACCOUNT_ENCRYPTION_KEY || '', 'hex');
  if (k.length !== 32) throw new Error('ACCOUNT_ENCRYPTION_KEY phải là 64 ký tự hex (32 byte)');
  return k;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}

function decrypt(payload) {
  const [iv, tag, enc] = payload.split(':').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, getKey };
