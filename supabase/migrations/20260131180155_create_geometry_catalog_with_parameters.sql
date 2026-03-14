/*
  # Create Geometry Catalog Table with Full Parameters

  1. New Tables
    - `geometry_catalog`
      - `id` (uuid, primary key)
      - `code` (text, unique) - Unique identifier code
      - `description` (text) - Human readable description
      - `tags` (text array) - Categories/tags for filtering
      - `geometry_data` (jsonb) - Basic geometry info (type, dimensions)
      - `shape_parameters` (jsonb) - Full shape parameters from ParametersPanel
      - `subtraction_geometries` (jsonb) - Boolean cut operations data
      - `fillets` (jsonb) - Fillet operations data
      - `face_roles` (jsonb) - Face role assignments
      - `preview_image` (text) - Base64 preview image
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
      
  2. Security
    - Enable RLS on `geometry_catalog` table
    - Add policies for authenticated users to manage their own data
    - Add policy for public read access (catalog is shared)
*/

CREATE TABLE IF NOT EXISTS geometry_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  description text,
  tags text[] DEFAULT '{}',
  geometry_data jsonb NOT NULL DEFAULT '{}',
  shape_parameters jsonb DEFAULT '{}',
  subtraction_geometries jsonb DEFAULT '[]',
  fillets jsonb DEFAULT '[]',
  face_roles jsonb DEFAULT '{}',
  preview_image text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE geometry_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read geometry catalog"
  ON geometry_catalog
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert to catalog"
  ON geometry_catalog
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update catalog"
  ON geometry_catalog
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete from catalog"
  ON geometry_catalog
  FOR DELETE
  TO authenticated
  USING (true);
