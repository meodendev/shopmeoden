const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Tạo bảng nếu chưa có (chạy mỗi lần khởi động, an toàn khi chạy lại)
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
      locked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS boxes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL CHECK (price > 0),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      box_id INTEGER NOT NULL REFERENCES boxes(id),
      username TEXT NOT NULL,
      enc_password TEXT NOT NULL,
      info TEXT NOT NULL DEFAULT '',
      rarity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      owner_id INTEGER REFERENCES users(id),
      pulled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_accounts_box_status ON accounts(box_id, status);
    CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);
  `);
}

module.exports = { pool, initSchema };
