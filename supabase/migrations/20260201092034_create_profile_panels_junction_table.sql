/*
  # Create Profile Panels Junction Table

  1. New Tables
    - profile_panels: Links profiles to panel geometries
      - id (uuid, primary key)
      - profile_id (uuid) - Reference to global_settings_profiles
      - catalog_geometry_id (uuid) - Reference to geometry_catalog
      - role (text) - Panel role
      - offset_x, offset_y, offset_z (numeric) - Position offsets
      - rotation_x, rotation_y, rotation_z (numeric) - Rotation in degrees
      - visible (boolean) - Visibility flag
      - order (integer) - Display order
      - created_at, updated_at (timestamptz)

  2. Security
    - Enable RLS
    - Policies for authenticated users to manage profile panels
*/

CREATE TABLE IF NOT EXISTS profile_panels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES global_settings_profiles(id) ON DELETE CASCADE,
  catalog_geometry_id uuid NOT NULL REFERENCES geometry_catalog(id) ON DELETE CASCADE,
  role text NOT NULL,
  offset_x numeric DEFAULT 0,
  offset_y numeric DEFAULT 0,
  offset_z numeric DEFAULT 0,
  rotation_x numeric DEFAULT 0,
  rotation_y numeric DEFAULT 0,
  rotation_z numeric DEFAULT 0,
  visible boolean DEFAULT true,
  "order" integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE profile_panels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read profile panels"
  ON profile_panels
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert profile panels"
  ON profile_panels
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update profile panels"
  ON profile_panels
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete profile panels"
  ON profile_panels
  FOR DELETE
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_profile_panels_profile_id ON profile_panels(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_panels_catalog_id ON profile_panels(catalog_geometry_id);
CREATE INDEX IF NOT EXISTS idx_profile_panels_role ON profile_panels(role);