/*
  # Create face_label_panel_defaults table

  ## Summary
  This migration creates a global lookup table that stores which face labels should
  have panels enabled by default. When a user toggles a panel on/off for a face
  (e.g., face "4" → panel ON), that mapping is saved here. When geometry changes
  (e.g., after a boolean subtraction), this table is consulted to restore panel
  selections for known labels. Subtractor faces (S1.1, etc.) and fillet faces (F1, etc.)
  are never auto-assigned from this table.

  ## New Tables
  - `face_label_panel_defaults`
    - `id` (uuid, primary key)
    - `label` (text, unique) - the face label like "1", "4", "6", etc.
    - `has_panel` (boolean) - whether this face should have a panel by default
    - `created_at` (timestamptz)
    - `updated_at` (timestamptz)

  ## Security
  - RLS enabled
  - Public read access (anon and authenticated can read)
  - Authenticated users can insert/update/delete

  ## Notes
  1. The label field is unique - each label has exactly one panel default setting
  2. On conflict (upsert), has_panel is updated
*/

CREATE TABLE IF NOT EXISTS face_label_panel_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text UNIQUE NOT NULL,
  has_panel boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE face_label_panel_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read face label panel defaults"
  ON face_label_panel_defaults FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert face label panel defaults"
  ON face_label_panel_defaults FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update face label panel defaults"
  ON face_label_panel_defaults FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete face label panel defaults"
  ON face_label_panel_defaults FOR DELETE
  TO authenticated
  USING (true);
