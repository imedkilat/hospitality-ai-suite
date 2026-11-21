import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import fs from "fs";
import pdfParse from "pdf-parse-debugging-disabled";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// single sources of truth
const sessions = {};
const recentSessions = [];
const stats = {
  totalSessions: 0,
  topics: {},
  unansweredQuestions: 0,
  currentPdf: null,
};

let currentPdfPath = null;
let currentPdfMeta = null;
let hotelText = ""; // extracted text from the last uploaded hotel PDF (admin preview only)

// n8n webhook URLs (set these in backend/.env, see .env.example).
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
const N8N_ESCALATE_URL = process.env.N8N_ESCALATE_URL || "";
const N8N_INGEST_URL = process.env.N8N_INGEST_URL || "";

// Writing to the knowledge base is OFF by default. The admin routes in this
// prototype have no authentication, so anyone who could reach /api/admin/pdf
// could otherwise change what the assistant tells guests. Enable only on a
// private/local run, or after adding authentication to the admin routes.
const ENABLE_PDF_INGEST = process.env.ENABLE_PDF_INGEST === "true";

// Storage for uploaded PDF
const upload = multer({
  dest: path.join(__dirname, "../uploads"),
});

// -------- Admin routes --------
// Upload hotel PDF
app.post("/api/admin/pdf", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    currentPdfPath = req.file.path;

    const dataBuffer = fs.readFileSync(currentPdfPath);
    const parsed = await pdfParse(dataBuffer);
    hotelText = parsed.text || "";

    currentPdfMeta = {
      filename: req.file.originalname,
      uploadedAt: new Date().toISOString(),
    };

    // Update stats so admin panel shows the current PDF
    stats.currentPdf = currentPdfMeta;

    // Send the text to the n8n ingest workflow, which chunks it, embeds it and
    // stores it in the Supabase knowledge base used by the chat workflow.
    let ingested = false;
    if (ENABLE_PDF_INGEST && N8N_INGEST_URL && hotelText.trim()) {
      const ingestRes = await fetch(N8N_INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: hotelText,
          title: req.file.originalname,
          source: req.file.originalname,
        }),
      });
      if (!ingestRes.ok) {
        throw new Error(`Knowledge base ingest failed (${ingestRes.status})`);
      }
      ingested = true;
    }

    console.log("PDF uploaded & parsed successfully:", {
      filename: req.file.originalname,
      size: req.file.size,
      textLength: hotelText.length,
      ingested,
    });

    return res.json({
      ok: true,
      textLength: hotelText.length,
      filename: req.file.originalname,
      ingested,
    });
  } catch (err) {
    console.error("Error parsing PDF:", err.message);
    console.error("File path was:", currentPdfPath);
    return res.status(500).json({
      error: "Failed to parse PDF",
      details: err.message,
    });
  }
});

// Get stats
app.get("/api/admin/stats", (_req, res) => {
  const topicsArr = Object.entries(stats.topics || {}).map(
    ([topic, count]) => ({ topic, count })
  );
  res.json({
    totalSessions: stats.totalSessions || 0,
    unansweredQuestions: stats.unansweredQuestions || 0,
    lastUpdate: new Date().toISOString(),
    currentPdf: stats.currentPdf || null,
    topics: topicsArr,
    recentSessions, // [{ id, questionCount, status, startTime }]
  });
});

// -------- Chat routes --------
import crypto from "node:crypto";

// Chat message: frontend -> backend -> n8n -> backend -> frontend
app.post("/api/chat/message", async (req, res) => {
  const { sessionId: clientSid, message } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing or invalid message" });
  }

  // Generate session ID if not provided (first message)
  const sessionId = clientSid || crypto.randomUUID();

  // The n8n chat workflow retrieves hotel facts from the knowledge base itself.
  const payloadToN8n = {
    sessionId,
    message: message.trim(),
  };

  let reply = "Sorry, I don't have that information right now.";
  let topic = "Uncategorized";
  let canAnswer = true;

  try {
    if (!N8N_WEBHOOK_URL) throw new Error("N8N_WEBHOOK_URL is not set");
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadToN8n),
    });

    if (response.ok) {
      const data = await response.json();
      const out = Array.isArray(data) ? data[0] : data;

      reply = out?.answer || out?.reply || reply;
      topic = out?.topic || topic;
      canAnswer = out?.canAnswer !== false;
      // Count topics for the admin dashboard
      if (topic && topic !== "Uncategorized") {
        stats.topics[topic] = (stats.topics[topic] || 0) + 1;
      }
    } else {
      canAnswer = false;
      reply = "I'm having trouble reaching the AI right now.";
    }
  } catch (err) {
    console.error("Chat error:", err.message);
    canAnswer = false;
    reply = "Something went wrong. Please try again.";
  }

  // Session tracking
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      questions: 0,
      unansweredCount: 0,
      startedAt: new Date().toISOString(),
      status: "Resolved",
      messages: [],
    };
    stats.totalSessions += 1;
    recentSessions.unshift({
      id: sessionId,
      questionCount: 0,
      status: "Resolved",
      startTime: new Date().toISOString(),
    });
    if (recentSessions.length > 50) recentSessions.pop();
  }

  // After getting reply from n8n, store both user message and bot reply
  sessions[sessionId].messages.push(
    {
      sender: "user",
      text: message.trim(),
      timestamp: new Date().toISOString(),
    },
    { sender: "bot", text: reply, timestamp: new Date().toISOString() }
  );
  sessions[sessionId].questions += 1;
  const recentSession = recentSessions.find((s) => s.id === sessionId);
  if (recentSession) recentSession.questionCount += 1;

  if (!canAnswer) {
    sessions[sessionId].unansweredCount += 1;
    sessions[sessionId].status = "Needs Review";
    if (recentSession) recentSession.status = "Needs Review";
    stats.unansweredQuestions += 1;
  }

  // This is what frontend receives — includes sessionId!
  res.json({
    reply,
    topic,
    canAnswer,
    sessionId, // always include — critical for first message!
  });
});

// New: Get chat history for a session
app.get("/api/chat/history", (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing sessionId" });
  }

  const session = sessions[sessionId];
  if (!session) {
    return res.json([]); // No history
  }

  // Build full conversation from session data
  const history = [];

  // Add all questions and answers (you need to store them!)
  if (session.messages && Array.isArray(session.messages)) {
    history.push(...session.messages);
  }

  res.json(history);
});

// Escalate unanswered question (called from frontend contact form)
app.post("/api/chat/escalate", async (req, res) => {
  const { name, email, phone, question, transcript, sessionId } =
    req.body || {};

  if (sessionId && sessions[sessionId]) {
    sessions[sessionId].status = "Needs Review";
    const rs = recentSessions.find((s) => s.id === sessionId);
    if (rs) rs.status = "Needs Review";
  }

  // The n8n escalation workflow expects `conversation: [{ from, text }]`.
  // Prefer the server-side session history over what the browser sends.
  const history = sessionId && sessions[sessionId]?.messages;
  const conversation = Array.isArray(history)
    ? history.map((m) => ({
        from: m.sender === "bot" ? "bot" : "guest",
        text: m.text,
      }))
    : Array.isArray(transcript)
    ? transcript.map((m) => ({
        from: m.sender === "bot" || m.from === "bot" ? "bot" : "guest",
        text: m.text,
      }))
    : [];

  const payload = { sessionId, name, email, phone, question, conversation };

  try {
    if (!N8N_ESCALATE_URL) throw new Error("N8N_ESCALATE_URL is not set");
    const r = await fetch(N8N_ESCALATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error("n8n escalate error:", r.status, await r.text());
      return res.status(500).json({ ok: false });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Escalate error:", err.message);
    res.status(500).json({ ok: false });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log("Backend listening on port", port);
});
