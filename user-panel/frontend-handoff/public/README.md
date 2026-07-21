# Public Directory - APK Downloads

This directory is used to store the Android APK file for download.

## Setup Instructions

1. Place your built Android APK file here and rename it to: `app-release.apk`

2. The APK will be available for download at:
   - Endpoint: `/api/download/android`
   - Full URL: `https://your-domain.com/api/download/android`

3. Users can download the APK by:
   - Clicking "Download App" in the Share modal (user panel)
   - Accessing the download link directly from the menu

## Building Your APK

If you need to build an Android APK from this web app:

### Option 1: Using Capacitor (Recommended)
```bash
npm install @capacitor/core @capacitor/cli
npx cap init
npx cap add android
npm run build
npx cap sync
npx cap open android
# Build APK in Android Studio
```

### Option 2: Using Cordova
```bash
npm install -g cordova
cordova create android-app
cd android-app
cordova platform add android
cordova build android --release
```

### Option 3: PWA to APK Tools
- Use TWA (Trusted Web Activities)
- Use PWABuilder.com
- Use Bubblewrap

## File Structure
```
public/
├── README.md (this file)
└── app-release.apk (place your APK here)
```

## Security Notes

- Make sure the APK is signed with your keystore
- Keep your keystore file secure and never commit it to git
- Update the version number in SystemConfig when releasing new APK
- Test the APK thoroughly before deployment

## Admin Panel Settings

Administrators can update the download URL from the Admin Panel:
1. Login to Admin Panel
2. Go to System Configuration
3. Update "Android URL" field
4. Save changes

The default URL is `/api/download/android` which serves from this directory.
