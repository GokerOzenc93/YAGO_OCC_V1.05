/*
  # Fix Geometry Catalog RLS Policies

  This migration updates RLS policies to allow anonymous access
  since the application doesn't use authentication.

  Changes:
  - Drop existing restrictive policies
  - Create new policies that allow public access
*/

DROP POLICY IF EXISTS "Anyone can read geometry catalog" ON geometry_catalog;
DROP POLICY IF EXISTS "Authenticated users can insert to catalog" ON geometry_catalog;
DROP POLICY IF EXISTS "Authenticated users can update catalog" ON geometry_catalog;
DROP POLICY IF EXISTS "Authenticated users can delete from catalog" ON geometry_catalog;

CREATE POLICY "Allow public read access"
  ON geometry_catalog
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public insert access"
  ON geometry_catalog
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Allow public update access"
  ON geometry_catalog
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public delete access"
  ON geometry_catalog
  FOR DELETE
  TO anon, authenticated
  USING (true);
