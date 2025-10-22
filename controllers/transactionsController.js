const helpers = require("./transactionsHelpers");

exports.handlePostback = async (req, res, next) => {
  try {
    helpers.initFirebase();

    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const payload = helpers.normalizePayload(req);

    if (!payload.uid || !payload.mid) {
      return res
        .status(400)
        .json({ error: "Missing required fields: uid and mid" });
    }

    const isValid = await helpers.validateUserAndModel(
      payload.uid,
      payload.mid
    );
    if (!isValid) {
      return res.status(404).json({
        error: "invalid_user_model",
        message: "User or model not found in required collections",
      });
    }

    const fields = Object.keys(payload).filter((k) => k !== "_meta");
    if (fields.length === 0) {
      return res.status(400).json({ error: "Empty payload" });
    }

    const db = require("firebase-admin").database();
    const collection =
      process.env.FIREBASE_TRANSACTIONS_COLLECTION || "transactions";
    const baseRef = db.ref(collection);
    const id = helpers.resolveId(payload);

    if (id) {
      const ref = baseRef.child(String(id));
      const snap = await ref.once("value");
      if (snap.exists()) {
        return res.status(409).json({
          error: "transaction_exists",
          message: "Transaction ID already present",
        });
      }
      await ref.set(payload);

      let subsUpdated = false;
      try {
        subsUpdated = await helpers.incrementSubs(
          payload.uid,
          payload.mid,
          payload
        );
      } catch (err) {
        console.error("Failed to update subs for idempotent write", err);
      }

      return res
        .status(200)
        .json({ ok: true, key: ref.key, idempotent: true, subsUpdated });
    } else {
      const ref = baseRef.push();
      await ref.set(payload);

      let subsUpdated = false;
      try {
        subsUpdated = await helpers.incrementSubs(
          payload.uid,
          payload.mid,
          payload
        );
      } catch (err) {
        console.error("Failed to update subs for push write", err);
      }

      return res
        .status(200)
        .json({ ok: true, key: ref.key, idempotent: false, subsUpdated });
    }
  } catch (err) {
    return next(err);
  }
};
