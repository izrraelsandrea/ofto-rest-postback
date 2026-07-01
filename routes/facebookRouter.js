const { Router } = require("express");
const admin = require("firebase-admin");
const { initFirebase } = require("../controllers/transactionsHelpers");

const router = Router();

const FB_API_VERSION = process.env.FB_API_VERSION || "v21.0";

/**
 * GET /api/adpostback/conversions
 *
 * Receives raw postback data via query string and forwards it to the Meta Conversions API.
 *
 * Required query param:
 *   - click_id  {string}  The Facebook Click ID (fbclid) sent by Meta ads.
 *
 * Optional query params (all extras land in custom_data):
 *   - event_name  {string}  Conversions API event name (default: "Lead")
 *   - event_source_url  {string}
 *   - value  {number}
 *   - currency  {string}  e.g. "USD"
 *   - ...any other param is forwarded as-is inside custom_data
 */
router.get("/conversions", async (req, res) => {
  const pixelId = process.env.FB_PIXEL_ID;
  const accessToken = process.env.FB_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.error("[adpostback] FB_PIXEL_ID or FB_ACCESS_TOKEN not configured");
    return res
      .status(500)
      .json({ error: "Facebook integration not configured" });
  }

  const {
    click_id,
    event_name = "Lead",
    event_source_url,
    value,
    currency,
    test_event_code,
    ...rest
  } = req.query;

  if (!click_id) {
    return res.status(400).json({ error: "Missing required field: click_id" });
  }

  // Build the user_data object.
  // fbc must follow Meta's format: fb.1.{creation_time}.{fbclid}
  // If the value already has the prefix, use it as-is; otherwise wrap it.
  const fbc = click_id.startsWith("fb.")
    ? click_id
    : `fb.1.${Math.floor(Date.now() / 1000)}.${click_id}`;

  const user_data = {
    fbc,
    client_ip_address: req.ip,
    client_user_agent: req.headers["user-agent"] || "",
  };

  // Collect any remaining fields as custom_data
  const custom_data = { ...rest };
  if (value !== undefined) custom_data.value = value;
  if (currency !== undefined) custom_data.currency = currency;

  const eventPayload = {
    event_name,
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    user_data,
    ...(event_source_url ? { event_source_url } : {}),
    ...(Object.keys(custom_data).length > 0 ? { custom_data } : {}),
  };

  const url = `https://graph.facebook.com/${FB_API_VERSION}/${pixelId}/events`;

  // Save to Firebase before sending to Facebook
  try {
    initFirebase();
    const db = admin.database();
    await db.ref("postback_logs").push({
      received_at: new Date().toISOString(),
      raw_query: req.query,
      payload_sent: eventPayload,
      ip: req.ip,
    });
  } catch (logErr) {
    console.error("[adpostback] Failed to write postback_log:", logErr);
  }

  try {
    const fbRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [eventPayload],
        access_token: accessToken,
        ...(test_event_code ? { test_event_code } : {}),
      }),
    });

    const fbData = await fbRes.json();

    if (!fbRes.ok) {
      console.error(
        "[adpostback] Conversions API error:",
        JSON.stringify(fbData, null, 2),
      );
      return res.status(fbRes.status).json({
        error: "Facebook Conversions API error",
        details: fbData,
        sent: eventPayload,
      });
    }

    console.log(
      "[adpostback] Event sent:",
      JSON.stringify(eventPayload, null, 2),
    );
    console.log("[adpostback] FB response:", JSON.stringify(fbData, null, 2));

    return res
      .status(200)
      .json({ ok: true, result: fbData, sent: eventPayload });
  } catch (err) {
    console.error("[adpostback] Fetch error:", err);
    return res
      .status(500)
      .json({ error: "Failed to reach Facebook Conversions API" });
  }
});

module.exports = router;
