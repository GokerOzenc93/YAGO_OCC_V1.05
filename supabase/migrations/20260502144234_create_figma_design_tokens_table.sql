/*
  # Create Figma Design Tokens Table

  1. New Tables
    - `figma_design_tokens`
      - `id` (uuid, primary key)
      - `component_name` (text) - Figma component name (e.g., "btn/kutu-ekle")
      - `component_path` (text) - Full path in Figma tree
      - `figma_node_id` (text) - Figma node identifier
      - `figma_file_id` (text) - Figma file identifier
      - `tokens` (jsonb) - All extracted design tokens (colors, sizes, spacing, etc.)
      - `synced_at` (timestamptz) - Last sync time from Figma
      - `created_at` (timestamptz) - Record creation time
      - `updated_at` (timestamptz) - Record update time

  2. Security
    - Enable RLS on `figma_design_tokens` table
    - Add policy for authenticated users to read tokens
    - Add policy for authenticated users to manage tokens

  3. Indexes
    - Unique constraint on (figma_file_id, figma_node_id) for upsert operations
    - Index on component_name for fast lookups

  4. Notes
    - Tokens are stored as JSONB for flexibility (different components may have different properties)
    - The upsert constraint ensures re-syncing from Figma updates existing records
*/

CREATE TABLE IF NOT EXISTS figma_design_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_name text NOT NULL,
  component_path text,
  figma_node_id text NOT NULL,
  figma_file_id text NOT NULL,
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(figma_file_id, figma_node_id)
);

CREATE INDEX IF NOT EXISTS idx_figma_design_tokens_component_name 
  ON figma_design_tokens(component_name);

CREATE INDEX IF NOT EXISTS idx_figma_design_tokens_file_id 
  ON figma_design_tokens(figma_file_id);

ALTER TABLE figma_design_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read design tokens"
  ON figma_design_tokens
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert design tokens"
  ON figma_design_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update design tokens"
  ON figma_design_tokens
  FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete design tokens"
  ON figma_design_tokens
  FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Service role has full access to design tokens"
  ON figma_design_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
