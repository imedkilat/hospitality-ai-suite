# Hospitality AI Suite

An AI front desk for hotels, built almost entirely in **n8n**. Guests chat with an assistant that answers from the hotel's own knowledge base (RAG). When it doesn't know something, it says so, emails the hotel team, and saves the guest and the full conversation for follow-up.

No custom AI backend logic: the intelligence lives in three n8n workflows backed by Supabase (Postgres + pgvector) and Google Gemini.

## How it works

```
Guest (React chat UI)
      |
      v
Express backend (thin proxy, keeps n8n URLs private)
      |
      +--> n8n  hotel-chat              AI Agent + Gemini + vector search + session memory
      |                                 logs every turn -> hotel_chat_logs
      |
      +--> n8n  hotel-escalate          emails hotel staff, upserts guest, saves transcript
      |                                 -> hotel_guests, hotel_escalations
      |
      +--> n8n  hotel-knowledge-ingest  text -> chunks -> Gemini embeddings -> pgvector
                                        -> hotel_knowledge_documents
```

| Workflow | Webhook | What it does |
|---|---|---|
| `hotel-chat` | `POST /webhook/hotel-chat` | Retrieves facts from the knowledge base, answers in plain text, returns `{ answer, topic, canAnswer }`. Never invents "we don't have X"; unknown means escalate. |
| `hotel-escalate` | `POST /webhook/hotel-escalate` | Sends an email with the question and transcript, creates or updates the guest by email, stores the escalation. |
| `hotel-knowledge-ingest` | `POST /webhook/hotel-knowledge-ingest` | Splits text into 800-character chunks (100 overlap), embeds with `gemini-embedding-001`, stores in Supabase. |

## Stack

n8n, Google Gemini (chat + embeddings), Supabase (Postgres, pgvector, RLS), Node.js/Express, React + Vite.

## Repo layout

```
n8n/                 importable workflow JSON (credentials stripped)
supabase/migrations/ database schema (tables, vector search function, RLS)
backend/             Express proxy between the UI and n8n
frontend/, src/      React chat UI
docs/sample-data/    sample hotel guide PDF to try the knowledge base with
```

## Setup

1. **Supabase**: create a project, then run `supabase/migrations/001_hotel_ai_suite_schema.sql` in the SQL editor.
2. **n8n**: import the three files in `n8n/`. Create credentials and attach them: a *Supabase API* credential (project URL + service role key), a *Google Gemini (PaLM)* credential, and a *Gmail OAuth2* credential. Set `ESCALATION_RECIPIENT` in the *Build Escalation Email* node. Publish the workflows.
3. **Load the knowledge base**: send your hotel's text to the ingest webhook, for example:
   ```bash
   curl -X POST "$N8N_INGEST_URL" -H "Content-Type: application/json" \
     -d '{"title":"Hotel guide","source":"guide.pdf","text":"Check-in is 3 PM..."}'
   ```
4. **Backend**:
   ```bash
   cd backend
   cp .env.example .env   # fill in your n8n webhook URLs
   npm install
   npm start
   ```
5. **Frontend**: point `VITE_API_BASE_URL` at the backend and run `npm run dev`.

### Backend environment

| Variable | Purpose |
|---|---|
| `N8N_WEBHOOK_URL` | `hotel-chat` production webhook |
| `N8N_ESCALATE_URL` | `hotel-escalate` production webhook |
| `N8N_INGEST_URL` | `hotel-knowledge-ingest` production webhook |
| `ENABLE_PDF_INGEST` | `true` lets the upload endpoint extract PDF text and send it to the ingest workflow. Off by default, because anyone who can upload can change what the assistant tells guests. |

## Security notes

- The `n8n/` exports contain no credentials. Never commit `.env` files or API keys.
- All tables have Row Level Security enabled with no policies, so only the n8n service role can read or write them.
- Before exposing this publicly, protect the ingest webhook (n8n Header Auth) and keep `ENABLE_PDF_INGEST=false` unless uploads are authenticated.
- Supabase free projects pause after about a week of inactivity; restore the project before a demo.

## Roadmap

Staff dashboard for open escalations, unanswered-question analytics from `hotel_chat_logs`, authenticated knowledge management, and multi-property support.
