import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Loaded as the very first import in index.ts so environment variables are
// populated BEFORE any other module's import-time code reads process.env
// (ES module imports are all evaluated before the importing module's body,
// so calling dotenv.config() in the index body would run too late).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo-root .env first (shared keys), then apps/server/.env so server-scoped
// values win when the same key is defined in both.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
