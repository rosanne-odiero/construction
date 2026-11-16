export default {
  expo: {
    name: "PM Buddy Site",
    slug: "pm-buddy-site",
    version: "0.1.0",
    platforms: ["android", "ios"],
    orientation: "portrait",
    scheme: "pmbuddy-site",
    userInterfaceStyle: "light",
    android: {
      package: "ke.co.pmbuddy.site",
      permissions: ["CAMERA", "ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "NFC"],
      // Still photos only, no gallery/file import and no overlays (data minimisation).
      blockedPermissions: [
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.SYSTEM_ALERT_WINDOW",
      ],
      allowBackup: false,
    },
    ios: {
      bundleIdentifier: "ke.co.pmbuddy.site",
      supportsTablet: true,
      infoPlist: {
        NSCameraUsageDescription: "Scan worker cards and take a fresh attendance photo.",
        NSLocationWhenInUseUsageDescription: "Optionally attach the capture location.",
      },
    },
    plugins: [
      ["expo-sqlite", { useSQLCipher: true }],
      ["expo-secure-store", { configureAndroidBackup: true }],
      [
        "expo-camera",
        {
          cameraPermission: "Scan worker cards and take attendance photos.",
          recordAudioAndroid: false,
        },
      ],
      ["expo-location", { locationWhenInUsePermission: "Optionally attach attendance location." }],
      ["react-native-nfc-manager", { nfcPermission: "Read a worker's PM Buddy NFC card." }],
    ],
  },
};
