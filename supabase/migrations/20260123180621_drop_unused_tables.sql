/*
  # Drop Unused Tables

  This migration removes three tables that are no longer needed:
  
  1. `volumes` - 3D furniture design volumes table
  2. `geometry_catalog` - Geometry catalog table
  
  These tables are being removed to clean up the database schema.
*/

DROP TABLE IF EXISTS volumes CASCADE;
DROP TABLE IF EXISTS geometry_catalog CASCADE;
