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

// Health
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

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
