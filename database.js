const { Pool } = require('pg');

// Dùng DATABASE_URL từ Render (PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Tạo bảng nếu chưa có
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        balance BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        amount BIGINT,
        type TEXT,
        order_code BIGINT,
        status TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('Database init error:', err);
  } finally {
    client.release();
  }
}

initDatabase();

// Lấy số dư
async function getBalance(userId) {
  const result = await pool.query(
    'SELECT balance FROM users WHERE user_id = $1',
    [userId]
  );
  return result.rows[0]?.balance || 0;
}

// Cộng tiền
async function addBalance(userId, amount, orderCode = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Upsert user
    await client.query(
      `INSERT INTO users (user_id, balance) 
       VALUES ($1, $2) 
       ON CONFLICT (user_id) 
       DO UPDATE SET balance = users.balance + $2`,
      [userId, amount]
    );
    
    // Ghi log transaction
    if (orderCode) {
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, order_code, status) 
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, amount, 'deposit', orderCode, 'success']
      );
    }
    
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Add balance error:', err);
    return false;
  } finally {
    client.release();
  }
}

// Trừ tiền (mua hàng)
async function deductBalance(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      'UPDATE users SET balance = balance - $1 WHERE user_id = $2 AND balance >= $1',
      [amount, userId]
    );
    
    if (result.rowCount > 0) {
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, status) 
         VALUES ($1, $2, $3, $4)`,
        [userId, amount, 'purchase', 'success']
      );
      await client.query('COMMIT');
      return true;
    }
    
    await client.query('ROLLBACK');
    return false;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Deduct balance error:', err);
    return false;
  } finally {
    client.release();
  }
}

// Top người dùng
async function getTopUsers(limit = 10) {
  const result = await pool.query(
    'SELECT user_id, balance FROM users ORDER BY balance DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

module.exports = { getBalance, addBalance, deductBalance, getTopUsers };