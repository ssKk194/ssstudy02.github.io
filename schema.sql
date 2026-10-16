-- ═══════════════════════════════════════════════════════
-- STUDYVAULT — Supabase SQL Schema (Updated for New Subjects)
-- ═══════════════════════════════════════════════════════

-- ── WIPE EXISTING TABLES ──
DROP TABLE IF EXISTS exam_scores CASCADE;
DROP TABLE IF EXISTS study_plan CASCADE;
DROP TABLE IF EXISTS notices CASCADE;
DROP TABLE IF EXISTS exams CASCADE;
DROP TABLE IF EXISTS notes CASCADE;

-- ── 1. NOTES table ─────────────────────────────────────
CREATE TABLE notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  subject     text NOT NULL CHECK (subject IN ('dsa','cn','coa','vm','os','se','ap','m1','m2','evs','other')),
  pages       int,
  file_url    text,           
  file_path   text,           
  file_name   text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ── 2. EXAMS / PAPERS table ────────────────────────────
CREATE TABLE exams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  category    text NOT NULL CHECK (category IN ('mock','prev','assign')),
  subject     text,
  duration_minutes int DEFAULT 0, -- 0 means no timer
  questions   int,
  marks       int,
  difficulty  text CHECK (difficulty IN ('easy','medium','hard')),
  status      text DEFAULT 'active',  
  exam_date   timestamptz,            -- Window start time (when students can begin opening)
  exam_end_date timestamptz,          -- Window end time (after this, paper is closed)
  access_code text,                   -- Admin-set unique security pass code
  barcode     text,                   -- Unique barcode serial identifier
  file_url    text,
  file_path   text,
  created_at  timestamptz DEFAULT now()
);

-- ── 3. NOTICES table ───────────────────────────────────
CREATE TABLE notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('important','resources','deadlines')),
  links       jsonb DEFAULT '[]',     
  file_url    text,
  file_name   text,
  created_at  timestamptz DEFAULT now()
);

-- ── 4. STUDY PLAN table ────────────────────────────────
CREATE TABLE study_plan (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_name    text NOT NULL,          
  day_status  text DEFAULT 'upcoming' CHECK (day_status IN ('done','active','upcoming')),
  items       jsonb DEFAULT '[]',     
  week_start  date NOT NULL DEFAULT current_date,
  created_at  timestamptz DEFAULT now()
);

-- ── 5. EXAM SCORES (Submissions) table ─────────────────
CREATE TABLE exam_scores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  exam_id     uuid REFERENCES exams(id) ON DELETE SET NULL,
  exam_title  text,
  subject     text,
  score       int,
  max_score   int,
  time_taken_minutes int,
  attempted_at timestamptz DEFAULT now()
);

-- ═══════════════════════════════════════════════════════
-- SIMPLE RLS POLICIES
-- ═══════════════════════════════════════════════════════

ALTER TABLE notes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_plan  ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notes_read"   ON notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "notes_write"  ON notes FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "exams_read"   ON exams FOR SELECT TO authenticated USING (true);
CREATE POLICY "exams_write"  ON exams FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "notices_read"   ON notices FOR SELECT TO authenticated USING (true);
CREATE POLICY "notices_write"  ON notices FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "plan_read"   ON study_plan FOR SELECT TO authenticated USING (true);
CREATE POLICY "plan_write"  ON study_plan FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "scores_read"   ON exam_scores FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "scores_insert" ON exam_scores FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- 6. PROFILES (for persistent settings like avatars, names, and signatures)
CREATE TABLE profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  display_name text,
  avatar_url  text,
  signature_url text,
  student_id  text,
  subscription_tier text DEFAULT 'free',
  subscription_expiry timestamptz,
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_read" ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "admin_profiles_update" ON profiles FOR UPDATE TO authenticated USING ((auth.jwt() ->> 'email') = 'souriksamanta927@gmail.com');

-- 7. PENDING PAYMENTS (Admin Approval Workflow)
CREATE TABLE pending_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  user_email text NOT NULL,
  tier text NOT NULL,
  utr text NOT NULL,
  admin_utr text,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE pending_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payments_read" ON pending_payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "payments_insert" ON pending_payments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "payments_update" ON pending_payments FOR UPDATE TO authenticated USING (true);

-- ═══════════════════════════════════════════════════════
-- PGVECTOR & CHATGPT (RAG) INTEGRATION
-- ═══════════════════════════════════════════════════════

-- 1. Enable the pgvector extension to work with embedding vectors
create extension if not exists vector;

-- 2. Create a table to store your documents and their embeddings
create table if not exists documents (
  id bigserial primary key,
  content text, -- The text content (e.g., chunks of notes or study materials)
  metadata jsonb, -- Additional info like source file, subject, etc.
  embedding vector(768) -- Gemini's text-embedding-004 outputs 768 dimensions
);

-- 3. Secure the documents table
alter table documents enable row level security;
create policy "documents_read" on documents for select to authenticated using (true);
create policy "documents_write" on documents for all to authenticated using (true) with check (true);

-- 4. Create a function to search for documents (Cosine Similarity Search)
-- This function will be called by your frontend/edge-function when integrating ChatGPT/Gemini
create or replace function match_documents (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;

-- ═══════════════════════════════════════════════════════
-- 9. GLOBAL PUSH NOTIFICATIONS
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS global_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL, -- 'exam', 'note', 'notice'
  reference_id uuid,  -- Link to the created item
  created_at timestamptz DEFAULT now()
);

ALTER TABLE global_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notifications_read" ON global_notifications;
DROP POLICY IF EXISTS "notifications_all" ON global_notifications;
CREATE POLICY "notifications_all" ON global_notifications FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Trigger Function to auto-create notifications (SECURITY DEFINER allows trigger to write notifications)
CREATE OR REPLACE FUNCTION notify_new_content()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'exams' THEN
    INSERT INTO global_notifications (title, message, type, reference_id)
    VALUES ('New Exam: ' || NEW.title, 'A new exam has been uploaded.', 'exam', NEW.id);
  ELSIF TG_TABLE_NAME = 'notes' THEN
    INSERT INTO global_notifications (title, message, type, reference_id)
    VALUES ('New Note: ' || NEW.title, 'New study material is available.', 'note', NEW.id);
  ELSIF TG_TABLE_NAME = 'notices' THEN
    INSERT INTO global_notifications (title, message, type, reference_id)
    VALUES ('Notice: ' || NEW.title, NEW.body, 'notice', NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach triggers
DROP TRIGGER IF EXISTS on_new_exam ON exams;
CREATE TRIGGER on_new_exam AFTER INSERT ON exams FOR EACH ROW EXECUTE FUNCTION notify_new_content();

DROP TRIGGER IF EXISTS on_new_note ON notes;
CREATE TRIGGER on_new_note AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION notify_new_content();

DROP TRIGGER IF EXISTS on_new_notice ON notices;
CREATE TRIGGER on_new_notice AFTER INSERT ON notices FOR EACH ROW EXECUTE FUNCTION notify_new_content();

-- ═══════════════════════════════════════════════════════
-- 10. DAILY CHALLENGES / BRAINSTORMING (DSA & QUIZ)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS daily_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  type text NOT NULL CHECK (type IN ('dsa', 'quiz', 'brainstorm')),
  difficulty text DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  problem_statement text NOT NULL,
  starter_code text,
  test_cases text,
  options jsonb DEFAULT '[]', -- for MCQ/Quiz: [{"text": "O(log n)", "is_correct": true}]
  explanation text,
  points int DEFAULT 10,
  solution_hint text,
  official_answer text,
  live_date date DEFAULT current_date,
  created_at timestamptz DEFAULT now()
);

-- Safely ensure columns exist on daily_challenges if table existed earlier
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'daily_challenges' AND column_name = 'points') THEN
    ALTER TABLE daily_challenges ADD COLUMN points int DEFAULT 10;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'daily_challenges' AND column_name = 'official_answer') THEN
    ALTER TABLE daily_challenges ADD COLUMN official_answer text;
  END IF;
END $$;

-- Ensure table has user_id or create freshly
CREATE TABLE IF NOT EXISTS daily_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge_id uuid REFERENCES daily_challenges(id) ON DELETE CASCADE,
  user_email text,
  submission_code text,
  selected_option int,
  status text DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'wrong', 'reviewing')),
  feedback text,
  score_awarded int DEFAULT 0,
  submitted_at timestamptz DEFAULT now()
);

-- Safely add user_id column if the table already existed earlier without it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'daily_submissions' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE daily_submissions ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE daily_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_challenges_read" ON daily_challenges;
CREATE POLICY "daily_challenges_read" ON daily_challenges FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "daily_challenges_all" ON daily_challenges;
CREATE POLICY "daily_challenges_all" ON daily_challenges FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "daily_submissions_read" ON daily_submissions;
CREATE POLICY "daily_submissions_read" ON daily_submissions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "daily_submissions_insert" ON daily_submissions;
CREATE POLICY "daily_submissions_insert" ON daily_submissions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "daily_submissions_update" ON daily_submissions;
CREATE POLICY "daily_submissions_update" ON daily_submissions FOR UPDATE TO authenticated USING (true);

-- Realtime notification trigger for daily challenge (SECURITY DEFINER allows writing notifications)
CREATE OR REPLACE FUNCTION notify_new_daily_challenge()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO global_notifications (title, message, type, reference_id)
  VALUES ('Daily Challenge Live: ' || NEW.title, 'New ' || UPPER(NEW.type) || ' challenge is live today! Solve & earn points.', 'daily', NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_new_daily_challenge ON daily_challenges;
CREATE TRIGGER on_new_daily_challenge AFTER INSERT ON daily_challenges FOR EACH ROW EXECUTE FUNCTION notify_new_daily_challenge();

-- ═══════════════════════════════════════════════════════
-- 10. SUPABASE STORAGE BUCKET & POLICIES ('studyvault')
-- ═══════════════════════════════════════════════════════
-- Enables PDF & document uploads to the studyvault bucket

INSERT INTO storage.buckets (id, name, public)
VALUES ('studyvault', 'studyvault', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Allow public and authenticated read access
DROP POLICY IF EXISTS "Public Storage Read Access" ON storage.objects;
CREATE POLICY "Public Storage Read Access" ON storage.objects
FOR SELECT TO public USING (bucket_id = 'studyvault');

-- Allow uploads to studyvault
DROP POLICY IF EXISTS "Public Storage Upload Access" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Storage Upload Access" ON storage.objects;
CREATE POLICY "Public Storage Upload Access" ON storage.objects
FOR INSERT TO public WITH CHECK (bucket_id = 'studyvault');

-- Allow updates and deletions
DROP POLICY IF EXISTS "Public Storage Update Access" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Storage Update Access" ON storage.objects;
CREATE POLICY "Public Storage Update Access" ON storage.objects
FOR UPDATE TO public USING (bucket_id = 'studyvault');

DROP POLICY IF EXISTS "Public Storage Delete Access" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Storage Delete Access" ON storage.objects;
CREATE POLICY "Public Storage Delete Access" ON storage.objects
FOR DELETE TO public USING (bucket_id = 'studyvault');

-- Ensure notes and exams write access is active
DROP POLICY IF EXISTS "notes_read_public" ON notes;
DROP POLICY IF EXISTS "notes_write_public" ON notes;
CREATE POLICY "notes_read_public" ON notes FOR SELECT TO public USING (true);
CREATE POLICY "notes_write_public" ON notes FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "exams_read_public" ON exams;
DROP POLICY IF EXISTS "exams_write_public" ON exams;
CREATE POLICY "exams_read_public" ON exams FOR SELECT TO public USING (true);
CREATE POLICY "exams_write_public" ON exams FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "notices_read_public" ON notices;
DROP POLICY IF EXISTS "notices_write_public" ON notices;
CREATE POLICY "notices_read_public" ON notices FOR SELECT TO public USING (true);
CREATE POLICY "notices_write_public" ON notices FOR ALL TO public USING (true) WITH CHECK (true);

