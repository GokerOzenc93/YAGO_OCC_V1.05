/*
  # Create Panel Joint Types Table

  1. New Tables
    - `panel_joint_types`
      - `id` (uuid, primary key)
      - `name` (text) - Name of the preset
      - `settings` (jsonb) - All panel joint settings stored as JSON
      - `is_default` (boolean) - Whether this is the default preset
      - `created_at` (timestamptz) - When the preset was created
      - `updated_at` (timestamptz) - When the preset was last updated
      - `user_id` (uuid) - Reference to auth.users for ownership

  2. Security
    - Enable RLS on `panel_joint_types` table
    - Add policy for authenticated users to read all presets
    - Add policy for authenticated users to create their own presets
    - Add policy for authenticated users to update their own presets
    - Add policy for authenticated users to delete their own presets
*/

CREATE TABLE IF NOT EXISTS panel_joint_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE panel_joint_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read all panel joint type presets"
  ON panel_joint_types
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create their own panel joint type presets"
  ON panel_joint_types
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own panel joint type presets"
  ON panel_joint_types
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own panel joint type presets"
  ON panel_joint_types
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_panel_joint_types_user_id ON panel_joint_types(user_id);
CREATE INDEX IF NOT EXISTS idx_panel_joint_types_is_default ON panel_joint_types(is_default);
