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
// IP thật của người dùng (phía trước server có proxy của Render/Cloudflare)
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.ip || '').slice(0, 64);
const isBanned = async (ip) => (await pool.query('SELECT 1 FROM banned_ips WHERE ip=$1', [ip])).rowCount > 0;
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
  if (rows[0].role !== 'admin' && await isBanned(clientIp(req))) throw new HttpError(403, 'Địa chỉ mạng của bạn đã bị chặn do nghi ngờ gian lận');
  req.user = rows[0];
  next();
});
const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : next(new HttpError(403, 'Không có quyền admin'));

const signToken = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// ================= USER =================
app.post('/api/register', authLimiter, wrap(async (req, res) => {
  if (await isBanned(clientIp(req))) throw new HttpError(403, 'Địa chỉ mạng của bạn đã bị chặn');
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Username 3-20 ký tự: chữ, số, dấu _');
  if (password.length < 6 || password.length > 72) throw new HttpError(400, 'Mật khẩu 6-72 ký tự');
  const hash = await bcrypt.hash(password, 10);
  const coins = Math.max(0, parseInt(process.env.INITIAL_USER_COINS || '0', 10) || 0);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users(username, password_hash, coins, register_ip, last_ip) VALUES ($1,$2,$3,$4,$4) RETURNING id, username, role, coins',
      [username, hash, coins, clientIp(req)]);
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
  if (u.role !== 'admin' && await isBanned(clientIp(req))) throw new HttpError(403, 'Địa chỉ mạng của bạn đã bị chặn');
  await pool.query('UPDATE users SET last_ip=$1 WHERE id=$2', [clientIp(req), u.id]);
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

// ================= NHIỆM VỤ VƯỢT LINK (Link4m) =================
// Luồng: server tạo mã bí mật -> rút gọn link đích chứa mã -> user vượt link -> tới trang kích hoạt -> server kiểm tra -> cộng coin.
// Mã bí mật chỉ nằm trong link đích (server không bao giờ trả link đích cho client).
// Lớp chống bypass: mã 1 lần + đúng user + thời gian tối thiểu + giới hạn theo tài khoản + giới hạn theo IP + ghi IP/thiết bị/referrer để admin xem.
const nodeCrypto = require('crypto');
const TASK_REWARD = () => parseInt(process.env.TASK_REWARD || '500', 10);
const TASK_DAILY = () => parseInt(process.env.TASK_DAILY_LIMIT || '2', 10);        // lượt / tài khoản / ngày
const TASK_IP_DAILY = () => parseInt(process.env.TASK_IP_DAILY_LIMIT || '3', 10);  // lượt / IP / ngày (chống tạo nhiều acc)
const TASK_MIN_SEC = () => parseInt(process.env.TASK_MIN_SECONDS || '120', 10);   // tối thiểu 2 phút
const BAN_STRIKES = () => parseInt(process.env.TASK_BAN_STRIKES || '3', 10);       // số lần nghi bypass trong 24h thì chặn IP
const REQUIRE_REF = () => process.env.TASK_REQUIRE_REFERRER === 'true';            // bắt buộc phải đi qua trang link4m
const TASK_TTL_SEC = 60 * 60;
const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
// "Ngày" tính theo giờ Việt Nam
const DAY_VN = "(completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
const DONE_TODAY = `SELECT COUNT(*)::int AS n FROM tasks WHERE user_id=$1 AND status='done' AND ${DAY_VN}`;
const DONE_TODAY_IP = `SELECT COUNT(*)::int AS n FROM tasks WHERE done_ip=$1 AND status='done' AND ${DAY_VN}`;

// Ghi 1 lần vi phạm cho IP; đủ BAN_STRIKES lần trong 24h thì tự chặn IP
async function addStrike(ip, reason, taskId, userId) {
  // mỗi nhiệm vụ chỉ bị tính 1 lần (bấm "Thử lại" nhiều lần không bị cộng dồn)
  const m = await pool.query('UPDATE tasks SET struck=true WHERE id=$1 AND struck=false RETURNING id', [taskId]);
  if (!m.rowCount) return;
  await pool.query('INSERT INTO ip_strikes(ip, user_id, reason) VALUES ($1,$2,$3)', [ip, userId, reason]);
  const n = (await pool.query("SELECT COUNT(*)::int AS n FROM ip_strikes WHERE ip=$1 AND created_at > now() - interval '24 hours'", [ip])).rows[0].n;
  if (n >= BAN_STRIKES()) {
    await pool.query('INSERT INTO banned_ips(ip, reason) VALUES ($1,$2) ON CONFLICT (ip) DO NOTHING', [ip, `Tự động: ${n} lần nghi bypass trong 24h`]);
  }
}

app.get('/api/tasks/info', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(DONE_TODAY, [req.user.id]);
  res.json({ reward: TASK_REWARD(), dailyLimit: TASK_DAILY(), doneToday: rows[0].n, minSeconds: TASK_MIN_SEC() });
}));

app.post('/api/tasks', auth, wrap(async (req, res) => {
  if (!process.env.LINK4M_API || !process.env.SITE_URL) throw new HttpError(503, 'Nhiệm vụ chưa được cấu hình');
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  if ((await pool.query(DONE_TODAY, [req.user.id])).rows[0].n >= TASK_DAILY()) throw new HttpError(400, 'Bạn đã hết lượt nhiệm vụ hôm nay');
  if ((await pool.query(DONE_TODAY_IP, [ip])).rows[0].n >= TASK_IP_DAILY()) throw new HttpError(400, 'Địa chỉ mạng này đã hết lượt nhiệm vụ hôm nay');
  // Mỗi user chỉ giữ 1 nhiệm vụ đang chờ: nhiệm vụ cũ chưa xong sẽ bị hủy
  await pool.query("UPDATE tasks SET status='expired' WHERE user_id=$1 AND status='pending'", [req.user.id]);
  const token = nodeCrypto.randomBytes(24).toString('hex');
  const ins = await pool.query('INSERT INTO tasks(user_id, token_hash, reward, create_ip, create_ua) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [req.user.id, sha256(token), TASK_REWARD(), ip, ua]);
  const id = ins.rows[0].id;
  const dest = `${process.env.SITE_URL.replace(/\/$/, '')}/?activate=${id}&t=${token}`;
  let shortUrl;
  try {
    const r = await fetch(`https://link4m.co/api-shorten/v2?api=${encodeURIComponent(process.env.LINK4M_API)}&url=${encodeURIComponent(dest)}`,
      { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.status !== 'success' || !j.shortenedUrl) throw new Error(j.message || 'Link4m trả lỗi');
    shortUrl = j.shortenedUrl;
  } catch (e) {
    await pool.query("UPDATE tasks SET status='expired' WHERE id=$1", [id]);
    console.error('Link4m lỗi:', e.message);
    throw new HttpError(502, 'Không tạo được link, hãy thử lại sau');
  }
  await pool.query('UPDATE tasks SET short_url=$1 WHERE id=$2', [shortUrl, id]);
  res.json({ taskId: id, shortUrl, reward: TASK_REWARD() });
}));

// Trang kích hoạt gọi API này: kiểm tra đúng user, đúng mã, đủ thời gian, giới hạn ngày/IP -> cộng coin (1 transaction)
app.post('/api/tasks/:id/activate', auth, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const token = String(req.body.token || '');
  if (!(id > 0) || token.length < 10) throw new HttpError(400, 'Link nhiệm vụ không hợp lệ');
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  const referrer = String(req.body.referrer || '').slice(0, 300);
  const viaLink4m = /link4m/i.test(referrer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id, coins FROM users WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
    const t = (await client.query('SELECT * FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, u.id])).rows[0];
    if (!t) throw new HttpError(404, 'Nhiệm vụ không tồn tại (hãy đăng nhập đúng tài khoản đã nhận nhiệm vụ)');
    if (t.status === 'done') throw new HttpError(409, 'Nhiệm vụ này đã nhận thưởng rồi');
    if (t.status !== 'pending') throw new HttpError(400, 'Nhiệm vụ đã hết hạn, hãy nhận nhiệm vụ mới');
    const a = Buffer.from(sha256(token), 'hex'), b = Buffer.from(t.token_hash, 'hex');
    if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) {
      const err = new HttpError(400, 'Mã nhiệm vụ không hợp lệ');
      err.strike = { taskId: t.id, reason: 'sai_ma' };
      throw err;
    }
    const age = (Date.now() - new Date(t.created_at).getTime()) / 1000;
    if (age > TASK_TTL_SEC) throw new HttpError(400, 'Nhiệm vụ đã hết hạn, hãy nhận nhiệm vụ mới');
    if (age < TASK_MIN_SEC()) {
      const wait = Math.ceil(TASK_MIN_SEC() - age);
      const err = new HttpError(400, `Hệ thống chưa ghi nhận lượt xem. Hãy chờ thêm khoảng ${wait} giây rồi bấm Thử lại`);
      // Dưới nửa thời gian tối thiểu: người thật không thể xong, gần như chắc chắn dùng công cụ bypass -> tính 1 lần vi phạm
      if (age < TASK_MIN_SEC() / 2) err.strike = { taskId: t.id, reason: 'qua_nhanh' };
      throw err;
    }
    if (REQUIRE_REF() && !viaLink4m) throw new HttpError(400, 'Không phát hiện bạn đã đi qua trang vượt link');
    if ((await client.query(DONE_TODAY, [u.id])).rows[0].n >= TASK_DAILY()) throw new HttpError(400, 'Bạn đã hết lượt nhiệm vụ hôm nay');
    if ((await client.query(DONE_TODAY_IP, [ip])).rows[0].n >= TASK_IP_DAILY()) throw new HttpError(400, 'Địa chỉ mạng này đã hết lượt nhiệm vụ hôm nay');
    // Cờ nghi vấn: không chặn, chỉ ghi để admin xem
    const flags = [];
    if (t.create_ip && t.create_ip !== ip) flags.push('khac_ip');
    if (t.create_ua && t.create_ua !== ua) flags.push('khac_thiet_bi');
    if (!viaLink4m) flags.push('khong_qua_link4m');
    if (age < TASK_MIN_SEC() * 1.5) flags.push('qua_nhanh');
    const balance = u.coins + t.reward;
    await client.query("UPDATE tasks SET status='done', completed_at=now(), done_ip=$2, done_ua=$3, referrer=$4, flags=$5 WHERE id=$1",
      [t.id, ip, ua, referrer, flags.join(',')]);
    await client.query('UPDATE users SET coins=$1 WHERE id=$2', [balance, u.id]);
    await client.query("INSERT INTO transactions(user_id,type,amount,balance_after,note) VALUES ($1,'task',$2,$3,$4)",
      [u.id, t.reward, balance, `Nhiệm vụ vượt link #${t.id}`]);
    await client.query('COMMIT');
    res.json({ coins: balance, reward: t.reward });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.strike) await addStrike(ip, e.strike.reason, e.strike.taskId, req.user.id).catch((x) => console.error(x.message));
    throw e;
  } finally { client.release(); }
}));

// ================= ADMIN =================
const admin = express.Router();
admin.use(auth, requireAdmin);

admin.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await pool.query(
    'SELECT id, username, role, coins, locked, created_at, register_ip, last_ip FROM users WHERE username ILIKE $1 ORDER BY id DESC LIMIT 200', [`%${q}%`]);
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

// Admin xem nhiệm vụ vượt link kèm IP và cờ nghi vấn
admin.get('/tasks', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, u.username, t.status, t.reward, t.create_ip, t.done_ip, t.referrer, t.flags, t.created_at, t.completed_at
     FROM tasks t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 200`);
  res.json({ tasks: rows });
}));

admin.get('/banned-ips', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT ip, reason, created_at FROM banned_ips ORDER BY created_at DESC LIMIT 300');
  res.json({ ips: rows });
}));
admin.post('/banned-ips', wrap(async (req, res) => {
  const ip = String(req.body.ip || '').trim().slice(0, 64);
  if (ip.length < 3) throw new HttpError(400, 'IP không hợp lệ');
  await pool.query('INSERT INTO banned_ips(ip, reason) VALUES ($1,$2) ON CONFLICT (ip) DO NOTHING', [ip, 'Admin chặn thủ công']);
  res.json({ ok: true });
}));
// Bỏ chặn cũng xóa lịch sử vi phạm của IP đó để không bị chặn lại ngay
admin.post('/banned-ips/unban', wrap(async (req, res) => {
  const ip = String(req.body.ip || '').trim();
  await pool.query('DELETE FROM banned_ips WHERE ip=$1', [ip]);
  await pool.query('DELETE FROM ip_strikes WHERE ip=$1', [ip]);
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
