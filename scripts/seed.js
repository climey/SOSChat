const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

async function run() {
  const name = process.env.SEED_ADMIN_NAME || 'Administrador';
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@sosbuscas.com.br').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 6) {
    console.warn('[seed] SEED_ADMIN_PASSWORD não definida (mínimo 6 caracteres); nenhum admin criado');
    await pool.end();
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  const { rowCount } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [name, email, hash]
  );
  console.log(rowCount ? `[seed] admin criado: ${email}` : `[seed] admin já existia: ${email}`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
