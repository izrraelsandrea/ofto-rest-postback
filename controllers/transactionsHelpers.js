const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

require("dotenv").config();

let firebaseReady = false;

function initFirebase() {
  if (firebaseReady) return;
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_DATABASE_URL,
    FIREBASE_SERVICE_ACCOUNT_PATH,
  } = process.env;

  if (!FIREBASE_DATABASE_URL) {
    throw new Error(
      "Missing Firebase environment variable: FIREBASE_DATABASE_URL."
    );
  }

  // If env vars for cert are present, use them; otherwise use application default
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        databaseURL: FIREBASE_DATABASE_URL,
      });
    }
    firebaseReady = true;
    return;
  }

  const privateKey =
    typeof FIREBASE_PRIVATE_KEY === "string"
      ? FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
      : FIREBASE_PRIVATE_KEY;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
      databaseURL: FIREBASE_DATABASE_URL,
    });
  }
  firebaseReady = true;
}

function normalizePayload(req) {
  const merged = { ...(req.query || {}), ...(req.body || {}) };

  for (const k of Object.keys(merged)) {
    if (typeof merged[k] === "string") merged[k] = merged[k].trim();
  }

  merged.uid = merged.uid || merged.user_id || merged.user || null;
  merged.mid = merged.mid || merged.model_id || merged.model || null;

  merged.tid =
    merged.tid ||
    merged.id ||
    merged.tx_id ||
    merged.transaction_id ||
    merged.reference ||
    null;

  merged._meta = {
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
    userAgent: req.headers["user-agent"] || null,
    method: req.method,
    receivedAt:
      admin.database && admin.apps.length
        ? admin.database.ServerValue.TIMESTAMP
        : Date.now(),
  };

  return merged;
}

function resolveId(payload) {
  return payload && payload.tid ? String(payload.tid) : null;
}

async function validateUserAndModel(uid, mid) {
  const db = admin.database();
  const collections = ["publicDashboards", "users"];

  try {
    const checks = await Promise.all(
      collections.map(async (collection) => {
        const ref = db.ref(`${collection}/${uid}/models/${mid}`);
        const snap = await ref.once("value");
        return snap.exists();
      })
    );

    return checks.every(Boolean);
  } catch (err) {
    console.error("validateUserAndModel error", err);
    return false;
  }
}

// Increment subs and optionally replace clicks if payload.clicks provided
async function incrementSubs(uid, mid, payload) {
  const db = admin.database();
  const collections = ["publicDashboards", "users"];

  try {
    const results = await Promise.all(
      collections.map(async (collection) => {
        const modelRef = db.ref(`${collection}/${uid}/models/${mid}`);
        const subsRef = modelRef.child("subs");

        // Transaction increments subs atomically per node
        const txResult = await subsRef.transaction((current) => {
          if (current === null || current === undefined) return 1;
          if (typeof current === "number") return current + 1;
          const n = Number(current);
          return Number.isFinite(n) ? n + 1 : 1;
        });

        const subsOk = txResult && txResult.committed === true;

        // If clicks provided, replace the full value (validate numeric)
        let clicksOk = true;
        if (
          payload &&
          Object.prototype.hasOwnProperty.call(payload, "clicks")
        ) {
          const raw = payload.clicks;
          const clicksVal =
            typeof raw === "string" ? Number(raw.trim()) : Number(raw);
          if (!Number.isFinite(clicksVal)) {
            clicksOk = false;
          } else {
            await modelRef.child("clicks").set(clicksVal);
            clicksOk = true;
          }
        }

        return subsOk && clicksOk;
      })
    );

    return results.every(Boolean);
  } catch (err) {
    console.error("incrementSubs error", err);
    return false;
  }
}

module.exports = {
  initFirebase,
  normalizePayload,
  resolveId,
  validateUserAndModel,
  incrementSubs,
};
