/*
  # Create Global Settings Profiles Table

  1. New Tables
    - `global_settings_profiles`
      - `id` (uuid, primary key)
      - `name` (text) - profile name
      - `order` (integer) - display order
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

    - `profile_settings`
      - `id` (uuid, primary key)
      - `profile_id` (uuid, foreign key to global_settings_profiles)
      - `setting_type` (text) - e.g., 'panel_joint', 'backrest'
      - `settings` (jsonb) - the actual settings data
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

  2. Security
    - Enable RLS on both tables
    - Add policies for public access (no auth required for this app)

  3. Notes
    - Each profile can have multiple setting types
    - Settings are stored as JSONB for flexibility
*/

CREATE TABLE IF NOT EXISTS global_settings_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  "order" integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES global_settings_profiles(id) ON DELETE CASCADE,
  setting_type text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(profile_id, setting_type)
);

ALTER TABLE global_settings_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on global_settings_profiles"
  ON global_settings_profiles FOR SELECT
  USING (true);

CREATE POLICY "Allow public insert on global_settings_profiles"
  ON global_settings_profiles FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow public update on global_settings_profiles"
  ON global_settings_profiles FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public delete on global_settings_profiles"
  ON global_settings_profiles FOR DELETE
  USING (true);

CREATE POLICY "Allow public read on profile_settings"
  ON profile_settings FOR SELECT
  USING (true);

CREATE POLICY "Allow public insert on profile_settings"
  ON profile_settings FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow public update on profile_settings"
  ON profile_settings FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public delete on profile_settings"
  ON profile_settings FOR DELETE
  USING (true);

INSERT INTO global_settings_profiles (name, "order") 
VALUES ('Default', 0)
ON CONFLICT DO NOTHING;