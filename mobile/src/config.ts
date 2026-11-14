import generated from './generated/config.json'

export interface AppConfig {
  supabaseUrl: string
  supabaseKey: string
  updateBase: string
  otaToken: string
  bundleVersion: string
  nativeVersion: number
  builtAt: string
}

export const config = generated as AppConfig
