/*
  # Create face_label_role_defaults table

  ## Summary
  This migration creates a global lookup table that maps face labels to their default roles.
  When a user assigns a role to a face (e.g., face "1" → "Right"), that mapping is saved here.
  When a new shape is opened, this table is consulted to auto-assign roles to faces that have
  a known label (like "1" through "6"). New faces without a known label (e.g., "S1.1" subtractor
  faces) get no default role assigned.

  ## New Tables
  - `face_label_role_defaults`
    - `id` (uuid, primary key)
    - `label` (text, unique) - the face label like "1", "2", "3-1", etc.
    - `role` (text) - the role like "Right", "Left", "Top", etc.
    - `created_at` (timestamptz)
    - `updated_at` (timestamptz)

  ## Security
  - RLS enabled
  - Public read access (unauthenticated users can read defaults)
  - Authenticated users can insert/update/delete

  ## Notes
  1. The label field is unique - each label has exactly one default role
  2. On conflict (upsert), the role is updated
  3. Initial defaults are seeded for labels 1-6 matching the previous hardcoded behavior
*/

CREATE TABLE IF NOT EXISTS face_label_role_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text UNIQUE NOT NULL,
  role text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE face_label_role_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read face label role defaults"
  ON face_label_role_defaults FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert face label role defaults"
  ON face_label_role_defaults FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update face label role defaults"
  ON face_label_role_defaults FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete face label role defaults"
  ON face_label_role_defaults FOR DELETE
  TO authenticated
  USING (true);

INSERT INTO face_label_role_defaults (label, role) VALUES
  ('1', 'Right'),
  ('2', 'Left'),
  ('3', 'Top'),
  ('4', 'Bottom'),
  ('5', 'Door'),
  ('6', 'Back')
ON CONFLICT (label) DO NOTHING;
