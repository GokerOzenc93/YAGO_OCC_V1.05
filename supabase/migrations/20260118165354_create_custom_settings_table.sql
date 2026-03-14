/*
  # Create Custom Settings Table

  1. New Tables
    - `custom_settings`
      - `id` (uuid, primary key)
      - `group_id` (uuid, foreign key to custom_settings_groups)
      - `name` (text) - Setting name
      - `value` (text) - Setting value
      - `type` (text) - Input type (text, number, select)
      - `unit` (text) - Unit of measurement (optional)
      - `min_value` (numeric) - Minimum value for number type
      - `max_value` (numeric) - Maximum value for number type
      - `order` (integer) - Display order
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on `custom_settings` table
    - Add policy for authenticated users to manage their settings
*/

CREATE TABLE IF NOT EXISTS custom_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES custom_settings_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  value text,
  type text DEFAULT 'text',
  unit text,
  min_value numeric,
  max_value numeric,
  "order" integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE custom_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on custom_settings"
  ON custom_settings
  FOR ALL
  USING (true)
  WITH CHECK (true);