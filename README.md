# Blox Fruits Blind Box (bản rút gọn)

Chức năng: đăng ký/đăng nhập, chọn và mua acc (trừ coin + giao acc trong 1 transaction, mỗi acc chỉ bán 1 lần), bộ sưu tập, lịch sử coin.
Admin: **cộng coin cho user**, **tạo nhóm acc**, **thêm acc** (mỗi acc có tên hiển thị, mô tả, giá riêng) (mật khẩu acc mã hóa AES-256-GCM), bật/tắt túi, khóa user.

```
web/      Frontend tĩnh (HTML/CSS/JS) -> GitHub Pages
server/   Backend Node.js + Express + PostgreSQL -> Render/Railway
```

## Bước 1. Tạo database (Neon, miễn phí)
1. Vào https://neon.tech, tạo project, copy **connection string** (dạng `postgresql://...`).

## Bước 2. Chạy thử trên máy
```bash
cd server
cp .env.example .env      # rồi điền giá trị
npm install
npm start
```
Tạo khóa bí mật:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ACCOUNT_ENCRYPTION_KEY
```
Mở frontend: `cd web && npx serve -l 8080` rồi vào http://localhost:8080 (nhớ thêm `http://localhost:8080` vào `CLIENT_URL`).
Bảng database và tài khoản admin tự tạo khi server chạy lần đầu (lấy từ `ADMIN_USERNAME` / `ADMIN_PASSWORD`).

## Bước 3. Đưa lên GitHub
1. Tạo repo mới trên GitHub, upload toàn bộ nội dung thư mục này (hoặc `git init && git push`). **Không** upload file `.env`.
2. Repo > **Settings > Pages > Source: GitHub Actions**. Workflow `.github/workflows/pages.yml` sẽ tự deploy thư mục `web/` mỗi lần push vào nhánh `main`.

## Bước 4. Deploy backend (Render, miễn phí)
1. https://render.com > New > **Web Service** > chọn repo GitHub.
2. Root Directory: `server`. Build: `npm install`. Start: `npm start`.
3. Environment: điền `DATABASE_URL`, `JWT_SECRET`, `ACCOUNT_ENCRYPTION_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `INITIAL_USER_COINS`, và
   `CLIENT_URL=https://TEN_BAN.github.io` (chỉ domain, không có `/ten-repo`).
4. Deploy xong, copy URL dạng `https://xxx.onrender.com`.

## Bước 5. Nối frontend với backend
Sửa `web/config.js`: `window.API_URL = 'https://xxx.onrender.com';` rồi commit/push. Web chạy tại `https://TEN_BAN.github.io/TEN_REPO/`.

## Cách dùng
- Đăng nhập bằng tài khoản admin (đặt trong ENV) > menu **Admin**: tạo túi, thêm acc, cộng coin cho user.
- Người dùng xem danh sách acc (acc1, acc2, ...) trong nhóm, chọn acc muốn mua. Username/mật khẩu chỉ hiện sau khi mua xong.
- Giá acc bỏ trống thì lấy giá mặc định của nhóm. Độ hiếm chỉ là nhãn hiển thị.

## Lưu ý
- Render gói miễn phí sẽ "ngủ" khi không có truy cập, lần mở đầu chậm ~30-60 giây.
- **Mất khóa `ACCOUNT_ENCRYPTION_KEY` = không giải mã được acc đã thêm.** Hãy lưu lại.
- Chỉ nhập acc game của chính bạn / được phép bán.
- Lỗi CORS: kiểm tra `CLIENT_URL` đúng domain GitHub Pages.
