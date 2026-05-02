import path from 'path';
import dotenv from 'dotenv';

export function loadEnv() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
  dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });
}
