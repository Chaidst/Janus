import { initializeApp, cert, getApps, getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin (only once)
let app;
if (getApps().length === 0) {
  // Check if running on Cloud Run (K_SERVICE env var is set)
  if (process.env.K_SERVICE) {
    // Cloud Run - use default credentials (service account is provided by Cloud Run)
    app = initializeApp();
  } else {
    // Local development - use service account file
    app = initializeApp({
      credential: cert(path.join(__dirname, "../../../service-account.json")),
    });
  }
} else {
  app = getApp();
}

export const db = getFirestore(app);
