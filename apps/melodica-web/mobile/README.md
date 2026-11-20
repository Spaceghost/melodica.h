# Melodica Mobile

Melodica Mobile runs the existing station, Rooms, Garden, Conquest and walk player. The phone supplies background location, system media controls, audio routing, a station widget and the system file picker. A walk stays in the app’s private storage until the listener exports it.

## Android

Build the shared player from the repository root with the Node and Emscripten versions used in CI. The Android project requires Java 17 and Android SDK 36.

```sh
git submodule update --init
npm ci
sh scripts/fetch-scrobble-ui.sh
sh scripts/build.sh
mobile/android/gradlew -p mobile/android assembleDebug
```

The installable package is `mobile/android/build/outputs/apk/debug/MelodicaMobile-debug.apk`. The app packages `dist/` under the usual spacegho.st player origin. It uses the same account and radio services as the web player. Sign in to Pandora for radio, or open **Walks** and start a recording as a guest.

## iPhone, Apple Watch and CarPlay

On a Mac with Xcode and XcodeGen, run `cd mobile/ios && xcodegen generate && open Melodica.xcodeproj`. Select the Melodica scheme. The iOS deployment target is 17 and the watchOS target is 10. The iPhone loads the player from `https://spacegho.st/melodica/app/`. Its native controls require a published web build containing the phone adapter from this checkout.

For signed devices, select your team and provision the app and widget with the `group.st.spacegho.melodica.mobile` App Group. The watch target uses WatchConnectivity. For an approved CarPlay build, select `CarPlay.entitlements` as the Melodica target’s signing entitlements. [Apple CarPlay developer program](https://developer.apple.com/carplay/)

## Using phone features

1. Open **Walks** and press **Start a walk** before locking the screen. **Pause GPS** leaves audio running. **Finish walk** moves the completed route into the journal. A process restart leaves the draft paused for recovery.
2. Open **Phone audio** below the player to choose Wi-Fi and cellular quality, configure the ten-band equalizer for the current output, or pin a station. Equalization uses a playable copy of the current personal station track and preserves the original signal if decoding fails.
3. For remote controls, open **Control another device** on two players on the same Wi-Fi and sign in to the same Pandora account. Copy the invitation to the other device and the reply back to the first. **Move playback here** pauses the source before starting the destination.
4. Open **Listens** to search or export listening history. The account menu’s private session pauses scrobbling for the account and clears its current Now Playing entry. End the session to restore the previous setting.

The 79 selected feature descriptions and outstanding verification items are in [the feature selection](../docs/MOBILE-FEATURES.md).
