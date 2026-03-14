import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin (only once)
const app = getApps().length === 0 ? initializeApp({
  credential: cert(path.join(__dirname, '../../../service-account.json'))
}) : getApp();

export const db = getFirestore(app);
