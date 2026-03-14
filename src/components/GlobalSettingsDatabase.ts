import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface GlobalSettingsProfile {
  id: string;
  name: string;
  order: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileSettings {
  id: string;
  profile_id: string;
  setting_type: string;
  settings: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

class GlobalSettingsService {
  async listProfiles(): Promise<GlobalSettingsProfile[]> {
    const { data, error } = await supabase
      .from('global_settings_profiles')
      .select('*')
      .order('order', { ascending: true });

    if (error) {
      console.error('Failed to list profiles:', error);
      throw error;
    }

    return data || [];
  }

  async getDefaultProfile(): Promise<GlobalSettingsProfile | null> {
    const { data, error } = await supabase
      .from('global_settings_profiles')
      .select('*')
      .order('order', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Failed to get default profile:', error);
      return null;
    }

    return data;
  }

  async getProfile(id: string): Promise<GlobalSettingsProfile | null> {
    const { data, error } = await supabase
      .from('global_settings_profiles')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('Failed to get profile:', error);
      throw error;
    }

    return data;
  }

  async createProfile(name: string, order?: number): Promise<GlobalSettingsProfile> {
    const { data, error } = await supabase
      .from('global_settings_profiles')
      .insert([{ name, order: order || 0 }])
      .select()
      .single();

    if (error) {
      console.error('Failed to create profile:', error);
      throw error;
    }

    return data;
  }

  async updateProfile(id: string, updates: Partial<GlobalSettingsProfile>): Promise<GlobalSettingsProfile> {
    const { data, error } = await supabase
      .from('global_settings_profiles')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Failed to update profile:', error);
      throw error;
    }

    return data;
  }

  async deleteProfile(id: string): Promise<void> {
    const { error } = await supabase
      .from('global_settings_profiles')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Failed to delete profile:', error);
      throw error;
    }
  }

  async getProfileSettings(profileId: string, settingType: string): Promise<ProfileSettings | null> {
    const { data, error } = await supabase
      .from('profile_settings')
      .select('*')
      .eq('profile_id', profileId)
      .eq('setting_type', settingType)
      .maybeSingle();

    if (error) {
      console.error('Failed to get profile settings:', error);
      throw error;
    }

    return data;
  }

  async getAllProfileSettings(profileId: string): Promise<ProfileSettings[]> {
    const { data, error } = await supabase
      .from('profile_settings')
      .select('*')
      .eq('profile_id', profileId);

    if (error) {
      console.error('Failed to get all profile settings:', error);
      throw error;
    }

    return data || [];
  }

  async saveProfileSettings(
    profileId: string,
    settingType: string,
    settings: Record<string, unknown>
  ): Promise<ProfileSettings> {
    const existing = await this.getProfileSettings(profileId, settingType);

    if (existing) {
      const { data, error } = await supabase
        .from('profile_settings')
        .update({ settings, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        console.error('Failed to update profile settings:', error);
        throw error;
      }

      return data;
    } else {
      const { data, error } = await supabase
        .from('profile_settings')
        .insert([{ profile_id: profileId, setting_type: settingType, settings }])
        .select()
        .single();

      if (error) {
        console.error('Failed to create profile settings:', error);
        throw error;
      }

      return data;
    }
  }

  async deleteProfileSettings(profileId: string, settingType: string): Promise<void> {
    const { error } = await supabase
      .from('profile_settings')
      .delete()
      .eq('profile_id', profileId)
      .eq('setting_type', settingType);

    if (error) {
      console.error('Failed to delete profile settings:', error);
      throw error;
    }
  }
}

export const globalSettingsService = new GlobalSettingsService();
