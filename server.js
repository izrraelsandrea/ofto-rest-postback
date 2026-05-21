// server.js
require("dotenv").config();
const admin = require("firebase-admin");
const express = require("express");
const morgan = require("morgan");
const { rateLimit } = require("express-rate-limit");
const transactionsController = require("./controllers/transactionsController");

const app = express();

// Logging & parsers
// Note: morgan "tiny" logs method + URL only — never request bodies, so passwords are never logged.
app.use(morgan("tiny"));
app.use(express.json({ limit: "100kb" })); // application/json
app.use(express.urlencoded({ extended: true })); // application/x-www-form-urlencoded

// Rate limiting — auth endpoints only (brute force / credential stuffing protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // max 10 attempts per IP per window
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many authentication attempts. Please try again in 15 minutes.",
  },
});

// CORS
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "http://localhost:5173"
).split(",");
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Client session — proxies to OnlyFansAPI keeping the API key server-side
app.post("/api/client-sessions", async (req, res) => {
  try {
    const response = await fetch(
      "https://app.onlyfansapi.com/api/client-sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          display_name: "My Platform",
          proxy_country: "us",
        }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).send(err);
    }

    const data = await response.json();
    const token =
      data?.data?.token || data.token || data.client_session_token || data.id;
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OnlyFans Authentication ─────────────────────────────────────────────────

// Poll OnlyFansAPI until we reach a conclusive state (2FA pending, authenticated, or failed).
async function pollUntilActionNeeded(
  attemptId,
  { maxAttempts = 12, intervalMs = 1500 } = {},
) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `https://app.onlyfansapi.com/api/authenticate/${attemptId}`,
      {
        headers: { Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}` },
      },
    );
    if (!res.ok)
      throw Object.assign(new Error(`Poll error ${res.status}`), {
        status: res.status,
      });
    const data = await res.json();
    // Conclusive states: authenticated, failed, or any "needs-*" (OTP, face-id, etc.)
    const done =
      data.state === "authenticated" ||
      data.state === "failed" ||
      (typeof data.state === "string" && data.state.startsWith("needs-"));
    if (done) return data;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Authentication timed out — no state change after polling");
}

// Detect if a poll response demands face/selfie ID (unsupported).
// Known face-ID states from OnlyFansAPI: "needs-face-id", "needs-selfie"
function requiresFaceId(data) {
  return (
    data.state === "needs-face-id" ||
    data.state === "needs-selfie" ||
    data.faceIdRequired === true ||
    data.selfieVerificationRequired === true ||
    data.twoFactorType === "face_id" ||
    data.twoFactorType === "selfie" ||
    data.lastAttempt?.face_otp != null
  );
}

// POST /api/auth/start — Fire the authentication request and return attempt_id immediately.
// The frontend must then poll GET /api/auth/status/:attempt_id until it gets a conclusive state.
// Body: { email, password }
// Response: { attempt_id }
app.post("/api/auth/start", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const startRes = await fetch(
      "https://app.onlyfansapi.com/api/authenticate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_type: "email_password",
          email,
          password,
          proxyCountry: "us",
          force_connect: true,
        }),
      },
    );

    if (!startRes.ok) {
      const err = await startRes.text();
      return res.status(startRes.status).send(err);
    }

    const { attempt_id } = await startRes.json();
    // Return immediately — let the frontend poll /api/auth/status/:attempt_id
    return res.json({ attempt_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/status/:attempt_id — Single poll, normalized for the frontend.
// Returns: { status: "pending"|"authenticated"|"two_factor_required"|"failed", state, account?, otp_phone_ending? }
app.get("/api/auth/status/:attempt_id", async (req, res) => {
  try {
    const r = await fetch(
      `https://app.onlyfansapi.com/api/authenticate/${req.params.attempt_id}`,
      { headers: { Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}` } },
    );
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).send(err);
    }
    const data = await r.json();

    if (requiresFaceId(data)) {
      return res.status(422).json({
        error: "face_id_not_supported",
        message:
          "This account requires Face ID / selfie verification, which is not supported.",
      });
    }

    if (data.state === "authenticated") {
      return res.json({
        status: "authenticated",
        state: data.state,
        account: data.account,
      });
    }

    if (typeof data.state === "string" && data.state.startsWith("needs-")) {
      return res.json({
        status: "two_factor_required",
        state: data.state,
        otp_phone_ending: data.lastAttempt?.otp_phone_ending ?? null,
      });
    }

    if (data.state === "failed") {
      return res.status(400).json({ status: "failed", state: data.state });
    }

    // Still in progress — frontend should keep polling
    return res.json({ status: "pending", state: data.state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/send-email/:attempt_id — Trigger a 2FA verification email to the creator.
// No body required. Use when status is "two_factor_required" and the user chooses email delivery.
app.post("/api/auth/send-email/:attempt_id", async (req, res) => {
  try {
    const r = await fetch(
      `https://app.onlyfansapi.com/api/authenticate/${req.params.attempt_id}/send-email-to-creator`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}` },
      },
    );
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).send(err);
    }
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/submit-2fa/:attempt_id — Submit OTP code.
// Body: { code }
// OnlyFansAPI always returns {"message":"OTP submitted successfully"} on acceptance —
// even for wrong codes. The real outcome is only visible by polling after submission.
// This endpoint submits the code then polls until the state resolves, returning the
// true result: authenticated, invalid code (canRetry), or failed.
app.put("/api/auth/submit-2fa/:attempt_id", async (req, res) => {
  const { attempt_id } = req.params;
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "code is required" });
  }
  try {
    const r = await fetch(
      `https://app.onlyfansapi.com/api/authenticate/${attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      },
    );

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).send(err);
    }

    // Submission acknowledged — now poll until the real outcome is known.
    // Typically resolves in 2–5s (well within Heroku's 30s request timeout).
    const maxAttempts = 15;
    const intervalMs = 1500;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const statusRes = await fetch(
        `https://app.onlyfansapi.com/api/authenticate/${attempt_id}`,
        {
          headers: { Authorization: `Bearer ${process.env.ONLYFANS_API_KEY}` },
        },
      );
      if (!statusRes.ok) continue;
      const data = await statusRes.json();

      // Truly authenticated
      if (data.state === "authenticated") {
        return res.json({ status: "authenticated", account: data.account });
      }

      // Wrong code — OnlyFans went back to needing OTP.
      // The attempt is still alive (progress: "retrying_otp") and accepts another
      // submission. Re-authentication is not possible while the attempt is active
      // ("Previous authentication attempt is still in progress"). Return the same
      // attempt_id so the frontend can let the user try again immediately.
      if (typeof data.state === "string" && data.state.startsWith("needs-")) {
        if (requiresFaceId(data)) {
          return res.status(422).json({
            error: "face_id_not_supported",
            message:
              "This account requires Face ID / selfie verification, which is not supported.",
          });
        }
        console.log(
          "[submit-2fa] wrong code — attempt still alive, returning same attempt_id:",
          attempt_id,
        );
        return res.status(400).json({
          error: "invalid_code",
          message: "Incorrect code. Please try again.",
          canRetry: true,
          status: "two_factor_required",
          state: data.state,
          attempt_id, // still valid — frontend must reuse this
          otp_phone_ending: data.lastAttempt?.otp_phone_ending ?? null,
        });
      }

      // Failed entirely
      if (data.state === "failed") {
        return res
          .status(400)
          .json({ error: "authentication_failed", status: "failed" });
      }

      // Still "authenticating" — keep polling
    }

    // Timed out waiting for the OTP result — tell frontend to keep polling status itself
    return res.status(202).json({
      status: "pending",
      message:
        "OTP submitted. Poll /api/auth/status/:attempt_id for the result.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S2S postback endpoint (accepts GET & POST)
app.all("/postback", transactionsController.handlePostback);

// 404 fallback
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Postback server listening on http://localhost:${PORT}`);
});
