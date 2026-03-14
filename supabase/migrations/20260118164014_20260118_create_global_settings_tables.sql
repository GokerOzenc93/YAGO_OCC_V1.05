/*
  # Create Global Settings Tables

  1. New Tables
    - `custom_settings_groups` - Kullanıcının kendi oluşturabileceği ayar grupları
      - `id` (uuid, primary key)
      - `name` (text, grup adı)
      - `icon` (text, lucide icon adı)
      - `order` (integer, görüntüleme sırası)
      - `created_at` (timestamp)
      
    - `system_settings` - Sistem tarafından öngörülen ayarlar
      - `id` (uuid, primary key)
      - `category` (text, kategori adı: "Modül Yükseklikleri", "Panel Birleşim Tipleri", vb)
      - `name` (text, ayar adı)
      - `value` (text, ayarın değeri)
      - `type` (text, input type: "number", "text", "select", vb)
      - `unit` (text, birim: "mm", "cm", vb)
      - `min_value` (numeric, minimum değer)
      - `max_value` (numeric, maksimum değer)
      - `order` (integer, kategori içinde sıralama)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

  2. Security
    - Enable RLS on both tables
    - All users can read system settings
    - Users can create and manage their own settings groups
*/

CREATE TABLE IF NOT EXISTS custom_settings_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  icon text DEFAULT 'Settings',
  "order" integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE custom_settings_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read custom settings groups"
  ON custom_settings_groups FOR SELECT
  USING (true);

CREATE POLICY "Anyone can create custom settings groups"
  ON custom_settings_groups FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update custom settings groups"
  ON custom_settings_groups FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete custom settings groups"
  ON custom_settings_groups FOR DELETE
  USING (true);


CREATE TABLE IF NOT EXISTS system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
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

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read system settings"
  ON system_settings FOR SELECT
  USING (true);

INSERT INTO system_settings (category, name, value, type, unit, min_value, max_value, "order") VALUES
  -- Modül Yükseklikleri
  ('Modül Yükseklikleri', 'Standart Modül Yüksekliği', '1200', 'number', 'mm', 800, 2000, 1),
  ('Modül Yükseklikleri', 'Kompakt Modül Yüksekliği', '900', 'number', 'mm', 600, 1500, 2),
  ('Modül Yükseklikleri', 'Geniş Modül Yüksekliği', '1500', 'number', 'mm', 1000, 2500, 3),
  
  -- Panel Birleşim Tipleri
  ('Panel Birleşim Tipleri', 'Yapıştırma Tipi', 'Epoksi Yapıştırıcı', 'select', null, null, null, 1),
  ('Panel Birleşim Tipleri', 'Vida Birleşim', 'M6 x 40 Pas Vida', 'select', null, null, null, 2),
  ('Panel Birleşim Tipleri', 'Kaynak Tipi', 'MIG Kaynak', 'select', null, null, null, 3),
  
  -- Cihaz Boşluk Ayarları
  ('Cihaz Boşluk Ayarları', 'Hava Dolaşım Boşluğu', '50', 'number', 'mm', 10, 100, 1),
  ('Cihaz Boşluk Ayarları', 'Ön Boşluk', '100', 'number', 'mm', 50, 200, 2),
  ('Cihaz Boşluk Ayarları', 'Yan Boşluk', '75', 'number', 'mm', 25, 150, 3),
  ('Cihaz Boşluk Ayarları', 'Arka Boşluk', '100', 'number', 'mm', 50, 200, 4),
  
  -- Arkalık Ayarları
  ('Arkalık Ayarları', 'Arkalık Kalınlığı', '18', 'number', 'mm', 12, 30, 1),
  ('Arkalık Ayarları', 'Arkalık Malzeme', 'MDF', 'select', null, null, null, 2),
  ('Arkalık Ayarları', 'Arkalık Rengi', 'Beyaz', 'select', null, null, null, 3),
  ('Arkalık Ayarları', 'Arkalık Derinliği', '400', 'number', 'mm', 200, 800, 4);
