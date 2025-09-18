import express from "express";
import morgan from "morgan";
import cors from 'cors'
const PORT = process.env.PORT || 3000;
const DEFAULT_API_URL = process.env.API_URL || "https://api-dev.jivebird.com/jbcards/v2/upload/jb/";
const DEFAULT_AUTH_HEADER = process.env.AUTH_HEADER || ""; 
const DEFAULT_MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? "2", 10);
const DEFAULT_PAUSE_MS = parseInt(process.env.PAUSE_MS_BETWEEN ?? "500", 10);

const app = express();
app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: true, credentials: false }));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toFormBody(obj) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    sp.append(k, String(v));
  }
  return sp;
}

/**
 * Post one single-recipient request to the Django endpoint.
 * @param {string} apiUrl - target single-recipient endpoint
 * @param {object} formObj - key-value fields (will be sent as x-www-form-urlencoded)
 * @param {string} authHeader - full Authorization header value, e.g. "Token abc..." or "Bearer eyJ..."
 */
async function postOnce(apiUrl, formObj, authHeader) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (authHeader) headers["Authorization"] = authHeader;

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: toFormBody(formObj),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: resp.status, body: json };
}

async function postWithRetry(apiUrl, formObj, authHeader, retries, pauseMs) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await postOnce(apiUrl, formObj, authHeader);
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, attempt, ...res };
      }
      last = res;
    } catch (e) {
      last = { status: 0, body: { error: String(e) } };
    }
    if (attempt < retries) await sleep(pauseMs);
  }
  return { ok: false, ...last };
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

/**
 * POST /send-bulk
 * Accepts token from FE (preferred) via:
 *   - Header:  Authorization: Token <token>   OR   Authorization: Bearer <jwt>
 *   - Body:    { "authHeader": "Token <token>" }  (fallback, if you can’t set headers)
 *
 * Body JSON:
 * {
 *   "apiUrl": "https://.../jbcards/v2/upload/jb/",     // optional; defaults to env
 *   "authHeader": "Token abc...",                      // optional; header wins if both present
 *   "base": { "song_id":"94", "card_id":"486", "message":"...", "is_web":"1", "card_image_url":"..." },
 *   "recipients": [ { "name":"...", "phone":"+91..." }, ... ],
 *   "pauseMs": 500,         // optional
 *   "maxRetries": 2         // optional
 * }
 */
app.post("/send-bulk", async (req, res) => {
  try {
    const apiUrl = (req.body?.apiUrl || DEFAULT_API_URL).trim();

    // 1) Prefer Authorization header from the FE
    // 2) Fallback to body.authHeader
    // 3) Finally fallback to DEFAULT_AUTH_HEADER (env)
    const authHeader =
      (req.headers.authorization && req.headers.authorization.trim()) ||
      (req.body?.authHeader && req.body.authHeader.trim()) ||
      DEFAULT_AUTH_HEADER;

    if (!authHeader) {
      return res.status(400).json({ error: "Missing auth (send 'Authorization' header or 'authHeader' in body)" });
    }

    const base = req.body?.base || {};
    const recipients = req.body?.recipients || [];
    const pauseMs = Number.isFinite(req.body?.pauseMs) ? req.body.pauseMs : DEFAULT_PAUSE_MS;
    const maxRetries = Number.isFinite(req.body?.maxRetries) ? req.body.maxRetries : DEFAULT_MAX_RETRIES;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients must be a non-empty array" });
    }

    // Normalize is_web to string "1" / "0" for Django view
    if (base.is_web !== undefined) {
      base.is_web = ["1", "true", "True", 1, true].includes(base.is_web) ? "1" : "0";
    }

    const results = [];
    let success = 0, failed = 0;

    for (let idx = 0; idx < recipients.length; idx++) {
      const r = recipients[idx] || {};
      const name = r.name || "";
      const phone = r.phone;

      if (!phone) {
        results.push({ index: idx + 1, name, phone, ok: false, status: 400, body: { error: "Missing phone" } });
        failed++;
        continue;
      }

      const payload = { ...base, receipt_phone: phone };
      if (name) payload.receipt_name = name;

      const out = await postWithRetry(apiUrl, payload, authHeader, maxRetries, pauseMs);
      results.push({ index: idx + 1, name, phone, ok: out.ok, status: out.status, body: out.body });
      if (out.ok) success++; else failed++;

      await sleep(pauseMs);
    }

    return res.json({ summary: { total: recipients.length, success, failed }, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`jb-bulk-tester listening on :${PORT}`);
  console.log(`Default API URL: ${DEFAULT_API_URL}`);
});
