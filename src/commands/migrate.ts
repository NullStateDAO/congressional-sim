import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';

const config = loadConfig();
const pool = createPool(config);
try {
  await migrate(pool);
  console.log('Database schema is ready.');
} finally {
  await pool.end();
}
