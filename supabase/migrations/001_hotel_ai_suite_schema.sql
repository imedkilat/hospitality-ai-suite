-- Hospitality AI Suite: dedicated Supabase schema
-- Run in the Supabase SQL editor (or `supabase db push`) on a new project.

create extension if not exists vector with schema extensions;

-- Knowledge base (RAG).
-- 3072 dimensions = Gemini gemini-embedding-001 default output.
-- At this size (tens of chunks) no ANN index is needed; sequential scan is fast.
create table public.hotel_knowledge_documents (
  id bigserial primary key,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(3072),
  created_at timestamptz not null default now()
);

-- Similarity search used by the n8n Supabase Vector Store node.
create or replace function public.match_hotel_knowledge_documents(
  query_embedding extensions.vector(3072),
  match_count int default 4,
  filter jsonb default '{}'::jsonb
)
returns table (id bigint, content text, metadata jsonb, similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  select d.id, d.content, d.metadata,
         1 - (d.embedding <=> query_embedding) as similarity
  from public.hotel_knowledge_documents d
  where d.embedding is not null
    and d.metadata @> filter
  order by d.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

-- One row per chat turn (also feeds "unanswered questions" reporting).
create table public.hotel_chat_logs (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  question text not null,
  answer text,
  topic text,
  can_answer boolean,
  guest_name text,
  guest_email text,
  created_at timestamptz not null default now()
);
create index hotel_chat_logs_session_idx on public.hotel_chat_logs (session_id, created_at);
create index hotel_chat_logs_unanswered_idx on public.hotel_chat_logs (created_at) where can_answer = false;

-- Guests who identify themselves. Email is unique when present.
create table public.hotel_guests (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index hotel_guests_email_unique
  on public.hotel_guests (lower(email))
  where email is not null and email <> '';

-- Questions the assistant could not answer, handed to hotel staff.
create table public.hotel_escalations (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  guest_id uuid references public.hotel_guests(id) on delete set null,
  question text not null,
  transcript jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index hotel_escalations_status_idx on public.hotel_escalations (status, created_at);

-- Only the n8n workflows (service role key) read and write these tables.
-- RLS is enabled with no policies, so the public API cannot access them.
alter table public.hotel_knowledge_documents enable row level security;
alter table public.hotel_chat_logs enable row level security;
alter table public.hotel_guests enable row level security;
alter table public.hotel_escalations enable row level security;
