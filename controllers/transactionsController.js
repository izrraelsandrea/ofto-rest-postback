// controllers/transactionsController.js
const admin = require("firebase-admin");

let firebaseReady = false;
function initFirebase() {
  if (firebaseReady) return;
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_DATABASE_URL,
  } = process.env;

  if (
    !FIREBASE_PROJECT_ID ||
    !FIREBASE_CLIENT_EMAIL ||
    !FIREBASE_PRIVATE_KEY ||
    !FIREBASE_DATABASE_URL
  ) {
    throw new Error("Missing Firebase environment variables.");
  }

  // Support for "\n" in env private key
  const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

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
  // Merge GET query + POST body; body wins on conflicts
  const merged = { ...(req.query || {}), ...(req.body || {}) };

  // Basic normalization: trim strings
  for (const k of Object.keys(merged)) {
    if (typeof merged[k] === "string") merged[k] = merged[k].trim();
  }
  // Map common keys for uid and mid
  merged.uid = merged.uid || merged.user_id || merged.user || null;
  merged.mid = merged.mid || merged.model_id || merged.model || null;

  // Map transaction id variants into tid field for consistency
  merged.tid =
    merged.tid ||
    merged.id ||
    merged.tx_id ||
    merged.transaction_id ||
    merged.reference ||
    null;

  // Attach server metadata
  merged._meta = {
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
    userAgent: req.headers["user-agent"] || null,
    method: req.method,
    receivedAt: admin.database.ServerValue.TIMESTAMP,
  };

  return merged;
}

/**
 * Optional idempotency:
 * If the partner sends a unique id (id, tx_id, transaction_id, or reference),
 * we use it as the key so repeated postbacks overwrite instead of duplicating.
 */
function resolveId(payload) {
  return payload.tid || null;
}

exports.handlePostback = async (req, res, next) => {
  try {
    initFirebase();

    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const payload = normalizePayload(req);

    // Require uid and mid
    if (!payload.uid || !payload.mid) {
      return res
        .status(400)
        .json({ error: "Missing required fields: uid and mid" });
    }

    // Minimal sanity check: require at least one non-_meta field
    const fields = Object.keys(payload).filter((k) => k !== "_meta");
    if (fields.length === 0) {
      return res.status(400).json({ error: "Empty payload" });
    }

    const db = admin.database();
    const collection =
      process.env.FIREBASE_TRANSACTIONS_COLLECTION || "transactions";
    const baseRef = db.ref(collection);
    const id = resolveId(payload);

    let ref;
    if (id) {
      // Enforce uniqueness: if exists, reject with 409
      ref = baseRef.child(String(id));
      const snap = await ref.once("value");
      if (snap.exists()) {
        return res.status(409).json({
          error: "transaction_exists",
          message: "Transaction ID already present",
        });
      }
      await ref.set(payload);
      return res.status(200).json({
        ok: true,
        key: ref.key,
        idempotent: true,
      });
    } else {
      // Non-idempotent append
      ref = baseRef.push();
      await ref.set(payload);
      return res.status(200).json({
        ok: true,
        key: ref.key,
        idempotent: false,
      });
    }
  } catch (err) {
    return next(err);
  }
};
// Example signature validator (stub)
// function isValidSignature(sig, req) {
//   // Implement HMAC or partner-specific verification here
//   return true;
// }
