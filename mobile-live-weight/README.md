# The Terminal Live

Mobile app for pairing with The Terminal desktop app and viewing live weight from Firebase Realtime Database.

## Run

From the project root:

```sh
npm run mobile:start
```

Or from this folder:

```sh
npm run start
```

Use Expo Go to scan the Expo development QR. Inside the mobile app, tap **Scan QR Code** and scan the **Mobile Live Weight** QR from the desktop login page.

## Pairing Format

The desktop app QR uses this format:

```text
the-terminal://live-weight?productCode=...&databaseURL=...&path=scales/.../latest&statusPath=scales/.../status
```

The app reads the `databaseURL`, subscribes to the live weight `path`, and subscribes to `statusPath` for terminal online/offline heartbeat status.

## Firebase Rules

The mobile app only reads the live value. During testing, the database needs read access to the paired scale path:

```json
{
  "rules": {
    "scales": {
      "$productCode": {
        "latest": {
          ".read": true,
          ".write": true
        },
        "status": {
          ".read": true,
          ".write": true
        }
      }
    }
  }
}
```

For production, replace open read/write access with authenticated rules.
