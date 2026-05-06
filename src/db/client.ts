import postgres from 'postgres';
import { config } from '../config.js';

export const sql = postgres(config.DATABASE_URL, {
  max: 3,
  idle_timeout: 30,
  connect_timeout: 10,
});
