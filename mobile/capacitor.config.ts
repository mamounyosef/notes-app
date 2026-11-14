import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.mamoun.notes',
  appName: 'Notes',
  webDir: 'www',
  android: {
    // Test builds (NOTES_DEBUG=1) can be inspected from chrome://inspect.
    webContentsDebuggingEnabled: process.env.NOTES_DEBUG === '1',
    // Android 15 and later draw apps under the system bars: keep the page clear of them.
    adjustMarginsForEdgeToEdge: 'auto',
  },
  plugins: {
    CapacitorUpdater: {
      autoUpdate: false,
      // Updates come only from your own server: no Capgo cloud, no usage stats sent anywhere.
      statsUrl: '',
      updateUrl: '',
      channelUrl: '',
      // Its logs would print the update link with the app's key.
      osLogging: false,
      disableJSLogging: true,
      appReadyTimeout: 15000,
      autoDeleteFailed: true,
      autoDeletePrevious: true,
    },
    Keyboard: {
      resizeOnFullScreen: true,
    },
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
}

export default config
