require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initSchema } = require('./db');
const { encrypt, decrypt, getKey } = require('./crypto');

// ---- Kiểm tra biến môi trường bắt buộc khi khởi động ----
for (const k of ['DATABASE_URL', 'JWT_SECRET', 'ACCOUNT_ENCRYPTION_KEY']) {
  if (!process.env[k]) { console.error(`Thiếu biến môi trường: ${k}`); process.exit(1); }
}
getKey();

const RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythical'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const toInt = (v) => (Number.isInteger(Number(v)) && v !== '' && v !== null ? Number(v) : NaN);

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
const origins = (process.env.CLIENT_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins }));
app.use(express.json({ limit: '20kb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

// ---- Auth middleware: luôn đọc lại user từ DB để biết bị khóa hay chưa ----
const auth = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Chưa đăng nhập');
  let payload;
  try { payload = jwt.verify(h.slice(7), process.env.JWT_SECRET); }
  catch { throw new HttpError(401, 'Phiên đăng nhập hết hạn'); }
  const { rows } = await pool.query('SELECT id, username, role, coins, locked FROM users WHERE id=$1', [payload.id]);
  if (!rows[0]) throw new HttpError(401, 'Tài khoản không tồn tại');
  if (rows[0].locked) throw new HttpError(403, 'Tài khoản đã bị khóa');
  req.user = rows[0];
  next();
});
const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : next(new HttpError(403, 'Không có quyền admin'));

const signToken = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// ================= USER =================
app.post('/api/register', authLimiter, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Username 3-20 ký tự: chữ, số, dấu _');
  if (password.length < 6 || password.length > 72) throw new HttpError(400, 'Mật khẩu 6-72 ký tự');
  const hash = await bcrypt.hash(password, 10);
  const coins = Math.max(0, parseInt(process.env.INITIAL_USER_COINS || '0', 10) || 0);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users(username, password_hash, coins) VALUES ($1,$2,$3) RETURNING id, username, role, coins',
      [username, hash, coins]);
    const u = rows[0];
    if (coins > 0) await pool.query("INSERT INTO transactions(user_id,type,amount,balance_after,note) VALUES ($1,'bonus',$2,$2,'Coin khởi tạo')", [u.id, coins]);
    res.status(201).json({ token: signToken(u), user: u });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Username đã tồn tại');
    throw e;
  }
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username)=lower($1)', [username]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash)))
    throw new HttpError(401, 'Sai username hoặc mật khẩu');
  if (u.locked) throw new HttpError(403, 'Tài khoản đã bị khóa');
  res.json({ token: signToken(u), user: { id: u.id, username: u.username, role: u.role, coins: u.coins } });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// Danh sách túi (công khai) - chỉ trả số lượng, không lộ thông tin acc
app.get('/api/boxes', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT b.id, b.name, b.description, b.price, b.active,
      COUNT(a.id) FILTER (WHERE a.status='available')::int AS stock,
      MIN(a.price) FILTER (WHERE a.status='available') AS min_price
    FROM boxes b LEFT JOIN accounts a ON a.box_id=b.id
    GROUP BY b.id ORDER BY b.price, b.id`);
  res.json({ boxes: rows });
}));

// Danh sách acc của 1 nhóm (công khai): chỉ hiện tên hiển thị, mô tả, giá. KHÔNG lộ username/mật khẩu.
app.get('/api/boxes/:id/accounts', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const { rows } = await pool.query(
    "SELECT id, title, info, rarity, price FROM accounts WHERE box_id=$1 AND status='available' ORDER BY price, id", [id]);
  res.json({ accounts: rows });
}));

// Mua 1 acc đã chọn: trừ coin + giao acc trong 1 transaction.
app.post('/api/accounts/:id/buy', auth, wrap(async (req, res) => {
  const accId = toInt(req.params.id);
  if (!(accId > 0)) throw new HttpError(400, 'Acc không hợp lệ');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Khóa user trước (tránh trừ coin trùng khi gửi nhiều request cùng lúc)
    const u = (await client.query('SELECT id, coins, locked FROM users WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
    if (u.locked) throw new HttpError(403, 'Tài khoản đã bị khóa');
    // Khóa acc: nếu 2 người mua cùng lúc, người sau sẽ thấy acc đã bán
    const acc = (await client.query(
      `SELECT a.id, a.title, a.username, a.enc_password, a.info, a.rarity, a.price, b.active
       FROM accounts a JOIN boxes b ON b.id=a.box_id WHERE a.id=$1 AND a.status='available' FOR UPDATE OF a`, [accId])).rows[0];
    if (!acc || !acc.active) throw new HttpError(409, 'Acc đã được bán hoặc không còn');
    if (u.coins < acc.price) throw new HttpError(400, 'Không đủ coin');
    const balance = u.coins - acc.price;
    await client.query("UPDATE accounts SET status='sold', owner_id=$1, pulled_at=now() WHERE id=$2", [u.id, acc.id]);
    await client.query('UPDATE users SET coins=$1 WHERE id=$2', [balance, u.id]);
    await client.query("INSERT INTO transactions(user_id,type,amount,balance_after,note) VALUES ($1,'buy',$2,$3,$4)",
      [u.id, -acc.price, balance, `Mua ${acc.title || acc.username}`]);
    await client.query('COMMIT');
    res.json({
      coins: balance,
      account: { id: acc.id, title: acc.title, username: acc.username, password: decrypt(acc.enc_password), info: acc.info, rarity: acc.rarity },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}));

app.get('/api/collection', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.username, a.enc_password, a.info, a.rarity, a.pulled_at, b.name AS box_name
     FROM accounts a JOIN boxes b ON b.id=a.box_id WHERE a.owner_id=$1 ORDER BY a.pulled_at DESC`, [req.user.id]);
  res.json({ items: rows.map(({ enc_password, ...r }) => ({ ...r, password: decrypt(enc_password) })) });
}));

app.get('/api/transactions', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, type, amount, balance_after, note, created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json({ items: rows });
}));

// ================= ADMIN =================
const admin = express.Router();
admin.use(auth, requireAdmin);

admin.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await pool.query(
    'SELECT id, username, role, coins, locked, created_at FROM users WHERE username ILIKE $1 ORDER BY id DESC LIMIT 200', [`%${q}%`]);
  res.json({ users: rows });
}));

// Admin cộng coin cho user (ghi lịch sử giao dịch)
admin.post('/users/:id/coins', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const amount = toInt(req.body.amount);
  if (!(id > 0) || !(amount >= 1 && amount <= 100000000)) throw new HttpError(400, 'Số coin phải là số nguyên dương');
  const note = String(req.body.note || 'Admin cộng coin').slice(0, 200);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id, username, coins FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!u) throw new HttpError(404, 'Không tìm thấy user');
    const balance = u.coins + amount;
    await client.query('UPDATE users SET coins=$1 WHERE id=$2', [balance, id]);
    await client.query("INSERT INTO transactions(user_id,type,amount,balance_after,note,created_by) VALUES ($1,'admin_add',$2,$3,$4,$5)",
      [id, amount, balance, note, req.user.id]);
    await client.query('COMMIT');
    res.json({ username: u.username, coins: balance });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}));

admin.patch('/users/:id/lock', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Không thể tự khóa chính mình');
  const { rowCount } = await pool.query('UPDATE users SET locked=$1 WHERE id=$2', [!!req.body.locked, id]);
  if (!rowCount) throw new HttpError(404, 'Không tìm thấy user');
  res.json({ ok: true });
}));

admin.post('/boxes', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const price = toInt(req.body.price);
  if (!name || !(price >= 1)) throw new HttpError(400, 'Cần tên túi và giá (số nguyên dương)');
  const { rows } = await pool.query('INSERT INTO boxes(name, description, price) VALUES ($1,$2,$3) RETURNING *',
    [name, String(req.body.description || '').slice(0, 300), price]);
  res.status(201).json({ box: rows[0] });
}));

admin.patch('/boxes/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE boxes SET active=$1 WHERE id=$2', [!!req.body.active, toInt(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Không tìm thấy túi');
  res.json({ ok: true });
}));

// Thêm acc vào kho (mật khẩu được mã hóa AES-256-GCM, không bao giờ lưu plaintext)
admin.post('/accounts', wrap(async (req, res) => {
  const boxId = toInt(req.body.box_id);
  const title = String(req.body.title || '').trim().slice(0, 60);
  const username = String(req.body.username || '').trim().slice(0, 100);
  const password = String(req.body.password || '').slice(0, 200);
  const rarity = String(req.body.rarity || '');
  if (!(boxId > 0) || !username || !password) throw new HttpError(400, 'Thiếu túi, username hoặc mật khẩu acc');
  if (!RARITIES.includes(rarity)) throw new HttpError(400, `Độ hiếm phải là: ${RARITIES.join(', ')}`);
  const box = (await pool.query('SELECT id, price FROM boxes WHERE id=$1', [boxId])).rows[0];
  if (!box) throw new HttpError(404, 'Không tìm thấy nhóm');
  // Giá riêng của acc; bỏ trống thì lấy giá mặc định của nhóm
  const price = req.body.price === undefined || req.body.price === '' || req.body.price === null ? box.price : toInt(req.body.price);
  if (!(price >= 1)) throw new HttpError(400, 'Giá phải là số nguyên dương');
  const { rows } = await pool.query(
    'INSERT INTO accounts(box_id, title, username, enc_password, info, rarity, price) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [boxId, title || username, username, encrypt(password), String(req.body.info || '').slice(0, 300), rarity, price]);
  res.status(201).json({ id: rows[0].id });
}));

// Danh sách kho: KHÔNG trả mật khẩu
admin.get('/accounts', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.price, a.username, a.info, a.rarity, a.status, a.box_id, b.name AS box_name, u.username AS owner
     FROM accounts a JOIN boxes b ON b.id=a.box_id LEFT JOIN users u ON u.id=a.owner_id
     ORDER BY a.id DESC LIMIT 300`);
  res.json({ accounts: rows });
}));

// Chỉ xóa được acc chưa phát
admin.delete('/accounts/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM accounts WHERE id=$1 AND status='available'", [toInt(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Không tìm thấy acc hoặc acc đã được phát');
  res.json({ ok: true });
}));

app.use('/api/admin', admin);

app.get('/health', (req, res) => res.json({ ok: true }));
app.use((req, res) => res.status(404).json({ error: 'Không tìm thấy' }));
// Xử lý lỗi tập trung, không lộ stack trace
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Lỗi máy chủ' });
});

async function ensureAdmin() {
  const { ADMIN_USERNAME: u, ADMIN_PASSWORD: p } = process.env;
  if (!u || !p) return;
  const hash = await bcrypt.hash(p, 10);
  await pool.query("INSERT INTO users(username, password_hash, role) VALUES ($1,$2,'admin') ON CONFLICT (username) DO NOTHING", [u, hash]);
}

(async () => {
  await initSchema();
  await ensureAdmin();
  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`Server chạy tại cổng ${port}`));
})().catch((e) => { console.error('Khởi động thất bại:', e.message); process.exit(1); });
