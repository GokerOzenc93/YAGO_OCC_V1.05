import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const hasSupabaseConfig = supabaseUrl && supabaseAnonKey;

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export interface CatalogItem {
  id: string;
  code: string;
  description: string;
  tags: string[];
  geometry_data: any;
  shape_parameters?: any;
  subtraction_geometries?: any[];
  fillets?: any[];
  face_roles?: Record<number, string>;
  preview_image?: string;
  created_at: string;
  updated_at: string;
}

export const catalogService = {
  async getAll(): Promise<CatalogItem[]> {
    if (!supabase) {
      console.warn('Supabase not configured - running in local mode');
      return [];
    }

    const { data, error } = await supabase
      .from('geometry_catalog')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching catalog items:', error);
      return [];
    }

    return data || [];
  },

  async save(item: {
    code: string;
    description: string;
    tags: string[];
    geometry_data: any;
    shape_parameters?: any;
    subtraction_geometries?: any[];
    fillets?: any[];
    face_roles?: Record<number, string>;
    preview_image?: string;
  }): Promise<CatalogItem | null> {
    if (!supabase) {
      console.warn('Supabase not configured - cannot save to catalog');
      throw new Error('Database not configured');
    }

    const { data: existing } = await supabase
      .from('geometry_catalog')
      .select('id')
      .eq('code', item.code)
      .maybeSingle();

    if (existing) {
      const { data, error } = await supabase
        .from('geometry_catalog')
        .update({
          description: item.description,
          tags: item.tags,
          geometry_data: item.geometry_data,
          shape_parameters: item.shape_parameters || {},
          subtraction_geometries: item.subtraction_geometries || [],
          fillets: item.fillets || [],
          face_roles: item.face_roles || {},
          preview_image: item.preview_image,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        console.error('Error updating catalog item:', error);
        throw error;
      }

      return data;
    }

    const { data, error } = await supabase
      .from('geometry_catalog')
      .insert([{
        ...item,
        shape_parameters: item.shape_parameters || {},
        subtraction_geometries: item.subtraction_geometries || [],
        fillets: item.fillets || [],
        face_roles: item.face_roles || {},
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error saving catalog item:', error);
      throw error;
    }

    return data;
  },

  async delete(id: string): Promise<boolean> {
    if (!supabase) {
      console.warn('Supabase not configured - cannot delete from catalog');
      return false;
    }

    const { error } = await supabase
      .from('geometry_catalog')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting catalog item:', error);
      return false;
    }

    return true;
  },

  async update(id: string, updates: Partial<CatalogItem>): Promise<CatalogItem | null> {
    if (!supabase) {
      console.warn('Supabase not configured - cannot update catalog');
      return null;
    }

    const { data, error } = await supabase
      .from('geometry_catalog')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating catalog item:', error);
      return null;
    }

    return data;
  }
};
