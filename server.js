// server.js
require("dotenv").config();
const admin = require("firebase-admin");
const express = require("express");
const morgan = require("morgan");
const transactionsController = require("./controllers/transactionsController");

const app = express();

// Logging & parsers
app.use(morgan("tiny"));
app.use(express.json({ limit: "100kb" })); // application/json
app.use(express.urlencoded({ extended: true })); // application/x-www-form-urlencoded

// CORS
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "http://localhost:5173"
).split(",");
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
