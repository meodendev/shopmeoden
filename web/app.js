const API = (window.API_URL || '').replace(/\/$/, '') + '/api';
let token = localStorage.getItem('token'); // chỉ lưu token đăng nhập, KHÔNG lưu coin
let me = null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d).toLocaleString('vi-VN');

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) { token = null; me = null; localStorage.removeItem('token'); }
    throw new Error(d.error || 'Lỗi ' + r.status);
  }
  return d;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Đã sao chép'), () => toast('Không sao chép được'));
const closeModal = () => $('#modal').classList.add('hidden');
const openModal = (html) => { const m = $('#modal'); m.innerHTML = html; m.classList.remove('hidden'); };

function renderNav() {
  const cur = location.hash.replace('#', '') || '/';
  const items = me
    ? [['/', '🏠', 'Kho acc'], ['/tasks', '🎯', 'Nhiệm vụ'], ['/collection', '🗂️', 'Acc của tôi'], ['/history', '🧾', 'Lịch sử'],
       ...(me.role === 'admin' ? [['/admin', '⚙️', 'Admin']] : []), ['/account', '👤', 'Tôi']]
    : [['/', '🏠', 'Kho acc'], ['/login', '🔑', 'Đăng nhập'], ['/register', '✨', 'Đăng ký']];
  $('#nav').innerHTML = items.map(([p, i, l]) =>
    `<a href="#${p}" class="${cur === p || (p === '/' && cur.startsWith('/box/')) ? 'active' : ''}"><span>${i}</span><small>${l}</small></a>`).join('');
  $('#coinbar').innerHTML = me ? `<span class="pill">🪙 ${me.coins}</span>` : '';
}

// ---------- Pages ----------
const pages = {};

pages['/'] = async (el) => {
  const { boxes } = await api('/boxes');
  el.innerHTML = `<h1>Kho acc Blox Fruits</h1>
  <div class="grid">${boxes.filter((b) => b.active).map((b) => `
    <div class="card"><div class="emoji">🎁</div><h3>${esc(b.name)}</h3>
    <p class="mut">${esc(b.description)}</p>
    <p>${b.stock ? `<span class="price">Từ 🪙 ${b.min_price}</span> · Còn ${b.stock} acc` : 'Hết hàng'}</p>
    <a href="#/box/${b.id}"><button class="btn" ${b.stock < 1 ? 'disabled' : ''}>Xem acc</button></a></div>`).join('') || '<p class="mut">Chưa có nhóm nào.</p>'}</div>`;
};

async function boxPage(el, id) {
  const { accounts } = await api(`/boxes/${id}/accounts`);
  el.innerHTML = `<p><a href="#/" style="color:var(--mut)">← Quay lại</a></p><h1>Chọn acc</h1>
  <div class="grid">${accounts.map((a) => `
    <div class="card"><span class="tag ${esc(a.rarity)}">${esc(a.rarity)}</span>
    <h3>${esc(a.title)}</h3><p class="mut">${esc(a.info) || 'Không có mô tả'}</p>
    <p class="price">🪙 ${a.price}</p><button class="btn" data-buy="${a.id}">Mua</button></div>`).join('') || '<p class="mut">Hết acc.</p>'}</div>`;
  el.querySelectorAll('[data-buy]').forEach((btn) => (btn.onclick = () => {
    if (!me) { location.hash = '#/login'; return; }
    const a = accounts.find((x) => x.id == btn.dataset.buy);
    confirmBuy(a);
  }));
}

function confirmBuy(a) {
  openModal(`<div class="box"><h2>${esc(a.title)}</h2><p class="mut">${esc(a.info)}</p>
    <p>Giá: <b class="price">🪙 ${a.price}</b></p><p>Số dư: ${me.coins} → còn lại: ${me.coins - a.price}</p>
    <div class="row" style="justify-content:center"><button class="btn" id="go">Xác nhận mua</button><button class="btn red" id="no">Hủy</button></div></div>`);
  $('#no').onclick = closeModal;
  $('#go').onclick = guard(async () => {
    try {
      const res = await api(`/accounts/${a.id}/buy`, { method: 'POST' });
      me.coins = res.coins; renderNav();
      showResults([res.account]);
    } catch (e) { closeModal(); toast(e.message); route(); }
  });
}

function resultHtml(r, i = 0) {
  return `<div class="res reveal ${esc(r.rarity)}" style="animation-delay:${i * 0.25}s">
    <span class="tag ${esc(r.rarity)}">${esc(r.rarity)}</span>
    <p><b>${esc(r.title)}</b></p><p>User: <code>${esc(r.username)}</code></p><p>Pass: <code>${esc(r.password)}</code></p>
    ${r.info ? `<p class="mut">${esc(r.info)}</p>` : ''}
    <button class="btn sm" data-copy="${esc(r.username)}\n${esc(r.password)}">Sao chép</button></div>`;
}
function bindCopy(root) { root.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy))); }
function showResults(list) {
  openModal(`<div class="box"><h2>🎉 Mua thành công</h2>${list.map(resultHtml).join('')}<button class="btn" id="ok">Đóng</button></div>`);
  bindCopy($('#modal')); $('#ok').onclick = () => { closeModal(); route(); };
}

function authPage(kind) {
  return async (el) => {
    const login = kind === 'login';
    el.innerHTML = `<div class="card narrow"><h2>${login ? 'Đăng nhập' : 'Đăng ký'}</h2>
      <label>Username</label><input id="u" autocomplete="username"><label>Mật khẩu</label><input id="p" type="password" autocomplete="${login ? 'current-password' : 'new-password'}">
      <button class="btn" id="s">${login ? 'Đăng nhập' : 'Tạo tài khoản'}</button></div>`;
    $('#s').onclick = guard(async () => {
      const d = await api('/' + kind, { method: 'POST', body: { username: $('#u').value, password: $('#p').value } });
      token = d.token; localStorage.setItem('token', token); me = d.user; renderNav(); location.hash = sessionStorage.getItem('pending') ? '#/activate' : '#/';
    });
  };
}
pages['/login'] = authPage('login');
pages['/register'] = authPage('register');

pages['/collection'] = async (el) => {
  need();
  const { items } = await api('/collection');
  el.innerHTML = `<h1>Bộ sưu tập</h1>${items.length ? '' : '<p class="mut">Chưa có acc nào.</p>'}<div class="grid">${items.map((r) =>
    `<div>${resultHtml(r)}<span class="mut">${esc(r.box_name)} · ${fmtDate(r.pulled_at)}</span></div>`).join('')}</div>`;
  bindCopy(el);
};

pages['/history'] = async (el) => {
  need();
  const { items } = await api('/transactions');
  el.innerHTML = `<h1>Lịch sử coin</h1><div class="scroll"><table><tr><th>Thời gian</th><th>Nội dung</th><th>Coin</th><th>Số dư</th></tr>${items.map((t) =>
    `<tr><td>${fmtDate(t.created_at)}</td><td>${esc(t.note)}</td><td class="${t.amount > 0 ? 'coin' : ''}">${t.amount > 0 ? '+' : ''}${t.amount}</td><td>${t.balance_after}</td></tr>`).join('')}</table></div>`;
};

pages['/admin'] = async (el) => {
  need(); if (me.role !== 'admin') throw new Error('Không có quyền admin');
  const [{ users }, { boxes }, { accounts }, { tasks }, { ips }] = await Promise.all([api('/admin/users'), api('/boxes'), api('/admin/accounts'), api('/admin/tasks'), api('/admin/banned-ips')]);
  const boxOpts = boxes.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  el.innerHTML = `<h1>Admin</h1><div class="grid">
    <div class="card"><h3>➕ Thêm coin cho user</h3>
      <select id="cu">${users.map((u) => `<option value="${u.id}">${esc(u.username)} (🪙 ${u.coins})</option>`).join('')}</select>
      <input id="ca" type="number" min="1" placeholder="Số coin"><input id="cn" placeholder="Ghi chú (không bắt buộc)">
      <button class="btn" id="addcoin">Cộng coin</button></div>
    <div class="card"><h3>🎁 Tạo nhóm acc</h3><input id="bn" placeholder="Tên túi"><input id="bd" placeholder="Mô tả">
      <input id="bp" type="number" min="1" placeholder="Giá mặc định cho acc (coin)"><button class="btn" id="addbox">Tạo túi</button></div>
    <div class="card"><h3>🔑 Thêm acc</h3><select id="ab">${boxOpts}</select>
      <input id="at" placeholder="Tên hiển thị (vd: acc1)"><input id="au" placeholder="Username đăng nhập acc"><input id="ap" placeholder="Mật khẩu acc"><input id="ai" placeholder="Mô tả (level, trái, server...)"><input id="apr" type="number" min="1" placeholder="Giá coin (bỏ trống = giá nhóm)">
      <select id="ar">${['common', 'rare', 'epic', 'legendary', 'mythical'].map((r) => `<option>${r}</option>`).join('')}</select>
      <button class="btn" id="addacc">Thêm acc</button></div></div>
    <h2>IP bị chặn</h2><div class="scroll"><table><tr><th>IP</th><th>Lý do</th><th>Lúc</th><th></th></tr>${ips.length ? ips.map((i) =>
      `<tr><td>${esc(i.ip)}</td><td>${esc(i.reason)}</td><td>${fmtDate(i.created_at)}</td><td><button class="btn sm" data-unban="${esc(i.ip)}">Bỏ chặn</button></td></tr>`).join('') : '<tr><td colspan="4" class="mut">Chưa có IP nào bị chặn</td></tr>'}</table></div>
    <h2>Người dùng &amp; IP</h2><div class="scroll"><table><tr><th>User</th><th>Coin</th><th>IP đăng ký</th><th>IP gần nhất</th><th></th></tr>${users.map((u) =>
      `<tr><td>${esc(u.username)}${u.locked ? ' 🔒' : ''}</td><td>${u.coins}</td><td>${esc(u.register_ip || '-')}</td><td>${esc(u.last_ip || '-')}</td>
       <td>${u.role === 'admin' ? '' : `<button class="btn sm ${u.locked ? '' : 'red'}" data-lock="${u.id}" data-v="${!u.locked}">${u.locked ? 'Mở khóa' : 'Khóa'}</button>`}</td></tr>`).join('')}</table></div>
    <h2>Nhiệm vụ vượt link</h2><div class="scroll"><table><tr><th>#</th><th>User</th><th>Trạng thái</th><th>IP nhận → IP xong</th><th>Cờ nghi vấn</th><th>Lúc</th><th></th></tr>${tasks.map((t) =>
      `<tr><td>${t.id}</td><td>${esc(t.username)}</td><td>${esc(t.status)}</td><td>${esc(t.create_ip || '-')} → ${esc(t.done_ip || '-')}</td>
       <td style="color:${t.flags ? 'var(--danger)' : 'inherit'}">${esc(t.flags || '-')}</td><td>${fmtDate(t.completed_at || t.created_at)}</td><td><button class="btn sm red" data-ban="${esc(t.done_ip || t.create_ip || '')}">Chặn IP</button></td></tr>`).join('')}</table></div>
    <h2>Nhóm acc</h2><div class="scroll"><table><tr><th>Tên</th><th>Giá</th><th>Còn</th><th></th></tr>${boxes.map((b) =>
      `<tr><td>${esc(b.name)}</td><td>${b.price}</td><td>${b.stock}</td><td><button class="btn sm" data-tog="${b.id}" data-act="${!b.active}">${b.active ? 'Tắt' : 'Bật'}</button></td></tr>`).join('')}</table></div>
    <h2>Kho acc</h2><div class="scroll"><table><tr><th>Acc</th><th>Giá</th><th>Nhóm</th><th>Hiếm</th><th>Trạng thái</th><th></th></tr>${accounts.map((a) =>
      `<tr><td>${esc(a.title)}<br><span class="mut">${esc(a.username)}</span></td><td>${a.price}</td><td>${esc(a.box_name)}</td><td><span class="tag ${esc(a.rarity)}">${esc(a.rarity)}</span></td><td>${a.status === 'sold' ? 'Đã phát → ' + esc(a.owner) : 'Còn'}</td>
       <td>${a.status === 'available' ? `<button class="btn sm red" data-del="${a.id}">Xóa</button>` : ''}</td></tr>`).join('')}</table></div>`;
  const done = (m) => { toast(m); route(); };
  el.querySelectorAll('[data-ban]').forEach((b) => (b.onclick = guard(async () => {
    if (b.dataset.ban && confirm('Chặn IP ' + b.dataset.ban + '?')) { await api('/admin/banned-ips', { method: 'POST', body: { ip: b.dataset.ban } }); done('Đã chặn IP'); }
  })));
  el.querySelectorAll('[data-unban]').forEach((b) => (b.onclick = guard(async () => {
    await api('/admin/banned-ips/unban', { method: 'POST', body: { ip: b.dataset.unban } }); done('Đã bỏ chặn');
  })));
  el.querySelectorAll('[data-lock]').forEach((b) => (b.onclick = guard(async () => {
    await api('/admin/users/' + b.dataset.lock + '/lock', { method: 'PATCH', body: { locked: b.dataset.v === 'true' } }); done('Đã cập nhật');
  })));
  $('#addcoin').onclick = guard(async () => { const r = await api(`/admin/users/${$('#cu').value}/coins`, { method: 'POST', body: { amount: Number($('#ca').value), note: $('#cn').value } }); done(`${r.username}: 🪙 ${r.coins}`); });
  $('#addbox').onclick = guard(async () => { await api('/admin/boxes', { method: 'POST', body: { name: $('#bn').value, description: $('#bd').value, price: Number($('#bp').value) } }); done('Đã tạo túi'); });
  $('#addacc').onclick = guard(async () => { await api('/admin/accounts', { method: 'POST', body: { box_id: Number($('#ab').value), title: $('#at').value, price: $('#apr').value ? Number($('#apr').value) : undefined, username: $('#au').value, password: $('#ap').value, info: $('#ai').value, rarity: $('#ar').value } }); done('Đã thêm acc'); });
  el.querySelectorAll('[data-tog]').forEach((b) => (b.onclick = guard(async () => { await api('/admin/boxes/' + b.dataset.tog, { method: 'PATCH', body: { active: b.dataset.act === 'true' } }); done('Đã cập nhật'); })));
  el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = guard(async () => { if (confirm('Xóa acc này?')) { await api('/admin/accounts/' + b.dataset.del, { method: 'DELETE' }); done('Đã xóa'); } })));
};

pages['/account'] = async (el) => {
  need();
  el.innerHTML = `<div class="card narrow"><h2>👤 ${esc(me.username)}</h2><p>Số dư: <b class="price">🪙 ${me.coins}</b></p><button class="btn red" id="out">Đăng xuất</button></div>`;
  $('#out').onclick = () => { token = null; me = null; localStorage.removeItem('token'); location.hash = '#/login'; };
};

pages['/tasks'] = async (el) => {
  need();
  const info = await api('/tasks/info');
  el.innerHTML = `<h1>Nhiệm vụ vượt link</h1><div class="card narrow" style="margin:0 auto"><div class="emoji">🎯</div>
    <p style="text-align:center">Vượt 1 link nhận <b class="price">🪙 ${info.reward}</b></p>
    <p class="mut" style="text-align:center">Hôm nay: ${info.doneToday}/${info.dailyLimit} nhiệm vụ</p>
    <ol class="mut"><li>Bấm "Nhận link nhiệm vụ"</li><li>Mở link và vượt xong, web sẽ tự mở lại</li><li>Hệ thống xác nhận lượt xem rồi mới cộng coin</li><li>Phải mất ít nhất ${Math.round(info.minSeconds / 60)} phút. Dùng công cụ bypass nhiều lần sẽ bị chặn IP</li></ol>
    <button class="btn" id="mk" ${info.doneToday >= info.dailyLimit ? 'disabled' : ''}>Nhận link nhiệm vụ</button><div id="lk" style="margin-top:12px"></div></div>`;
  $('#mk').onclick = guard(async () => {
    const t = await api('/tasks', { method: 'POST' });
    $('#lk').innerHTML = `<a href="${esc(t.shortUrl)}" target="_blank" rel="noopener"><button class="btn">Mở link vượt (+${t.reward} coin)</button></a>
      <p class="mut">Vượt xong coin sẽ tự cộng. Nếu chưa thấy, quay lại trang này sau ít phút.</p>`;
  });
};

// Trang kích hoạt: người dùng được đưa về đây sau khi vượt link xong
pages['/activate'] = async (el) => {
  const raw = sessionStorage.getItem('pending');
  if (!raw) { location.hash = '#/'; return; }
  need(); // chưa đăng nhập thì chuyển sang trang đăng nhập, nhiệm vụ vẫn được giữ lại
  const { id, t, ref } = JSON.parse(raw);
  el.innerHTML = '<div class="card narrow" style="text-align:center"><h2>Đang xác nhận nhiệm vụ...</h2></div>';
  try {
    const r = await api(`/tasks/${id}/activate`, { method: 'POST', body: { token: t, referrer: ref || '' } });
    sessionStorage.removeItem('pending'); me.coins = r.coins; renderNav();
    el.innerHTML = `<div class="card narrow" style="text-align:center"><div class="emoji">✅</div><h2>Thành công!</h2><p class="price">+${r.reward} coin</p><a href="#/"><button class="btn">Về kho acc</button></a></div>`;
  } catch (e) {
    el.innerHTML = `<div class="card narrow" style="text-align:center"><div class="emoji">⚠️</div><p>${esc(e.message)}</p>
      <div class="row" style="justify-content:center"><button class="btn" id="rt">Thử lại</button><button class="btn red" id="sk">Bỏ qua</button></div></div>`;
    $('#rt').onclick = () => route();
    $('#sk').onclick = () => { sessionStorage.removeItem('pending'); location.hash = '#/'; };
  }
};

function need() { if (!me) { location.hash = '#/login'; throw new Error('Hãy đăng nhập'); } }

async function route() {
  renderNav();
  const el = $('#app');
  const path = (location.hash.replace('#', '') || '/');
  try {
    if (path.startsWith('/box/')) await boxPage(el, parseInt(path.slice(5)));
    else await (pages[path] || pages['/'])(el);
  } catch (e) { toast(e.message); }
}
// Link đích sau khi vượt link: /?activate=ID&t=MÃ -> lưu lại rồi chuyển sang trang kích hoạt
(function readActivation() {
  const q = new URLSearchParams(location.search);
  if (q.get('activate') && q.get('t')) {
    sessionStorage.setItem('pending', JSON.stringify({ id: Number(q.get('activate')), t: q.get('t'), ref: document.referrer }));
    history.replaceState(null, '', location.pathname + '#/activate');
  }
})();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) api('/me').then((d) => { me = d.user; renderNav(); }).catch(() => {});
});
window.addEventListener('hashchange', route);
(async () => {
  if (token) { try { me = (await api('/me')).user; } catch { token = null; localStorage.removeItem('token'); } }
  renderNav(); route();
})();
