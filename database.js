const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    // Bảng users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        balance BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Bảng products (clone)
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        type TEXT,
        email TEXT,
        password TEXT,
        status TEXT DEFAULT 'available',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Bảng transactions
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        amount BIGINT,
        type TEXT,
        product_id INTEGER,
        status TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Bảng pending_clones (chờ gửi cho user)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_clones (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        product_id INTEGER,
        product_type TEXT,
        email TEXT,
        password TEXT,
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

// User functions
async function getBalance(userId) {
  const result = await pool.query('SELECT balance FROM users WHERE user_id = $1', [userId]);
  return result.rows[0]?.balance || 0;
}

async function addBalance(userId, amount, orderCode = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (user_id, balance) VALUES ($1, $2) 
       ON CONFLICT (user_id) DO UPDATE SET balance = users.balance + $2`,
      [userId, amount]
    );
    if (orderCode) {
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, status) VALUES ($1, $2, $3, $4)`,
        [userId, amount, 'deposit', 'success']
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

async function deductBalance(userId, amount, productId = null, productType = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE users SET balance = balance - $1 WHERE user_id = $2 AND balance >= $1 RETURNING balance',
      [amount, userId]
    );
    if (result.rowCount > 0) {
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, product_id, status) VALUES ($1, $2, $3, $4, $5)`,
        [userId, amount, 'purchase', productId, 'success']
      );
      await client.query('COMMIT');
      return { success: true, newBalance: result.rows[0].balance };
    }
    await client.query('ROLLBACK');
    return { success: false, newBalance: null };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Deduct balance error:', err);
    return { success: false, newBalance: null };
  } finally {
    client.release();
  }
}

// Product (Clone) functions
async function addClone(type, email, password) {
  const result = await pool.query(
    'INSERT INTO products (type, email, password, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [type, email, password, 'available']
  );
  return result.rows[0].id;
}

async function getAvailableClone(type) {
  const result = await pool.query(
    'SELECT * FROM products WHERE type = $1 AND status = $1 ORDER BY id LIMIT 1',
    [type]
  );
  return result.rows[0] || null;
}

async function markCloneSold(id) {
  await pool.query('UPDATE products SET status = $1 WHERE id = $2', ['sold', id]);
}

async function savePendingClone(userId, productId, productType, email, password) {
  await pool.query(
    'INSERT INTO pending_clones (user_id, product_id, product_type, email, password) VALUES ($1, $2, $3, $4, $5)',
    [userId, productId, productType, email, password]
  );
}

async function getAndClearPendingClone(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM pending_clones WHERE user_id = $1 ORDER BY id LIMIT 1',
      [userId]
    );
    if (result.rows.length > 0) {
      await client.query('DELETE FROM pending_clones WHERE id = $1', [result.rows[0].id]);
      await client.query('COMMIT');
      return result.rows[0];
    }
    await client.query('COMMIT');
    return null;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Get pending clone error:', err);
    return null;
  } finally {
    client.release();
  }
}

async function getAllProductsByType() {
  const result = await pool.query(
    'SELECT type, COUNT(*) as count FROM products WHERE status = $1 GROUP BY type',
    ['available']
  );
  const stats = {};
  result.rows.forEach(row => { stats[row.type] = parseInt(row.count); });
  return stats;
}

module.exports = { 
  getBalance, addBalance, deductBalance, 
  addClone, getAvailableClone, markCloneSold, 
  savePendingClone, getAndClearPendingClone, 
  getAllProductsByType 
};
