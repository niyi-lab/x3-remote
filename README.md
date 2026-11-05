# X3 Remote

Phone app for a DIY remote start on a 2021 BMW X3. It's an installable web app (PWA): open it in
Chrome on Android, tap **Install app**, and it runs full screen from its own icon.

The app talks MQTT over secure WebSockets to a private EMQX Cloud server, and the car's ESP32
controller listens there. **This repository holds no server address, passwords or keys.** You
enter your login once in the app, and it's kept only in that phone's storage.

## What it does

- **Hold to start:** hold the button for 1.5 s, so a stray tap can't start the car. The start
  request carries the run time (10, 15 or 20 min) and the outside temperature from Open-Meteo.
- **While running:** a countdown, engine speed and coolant temperature, and hold to stop.
- **Status:** whether the car is online, battery voltage, signal strength.
- **Activity:** what the car reports, in plain words.
- **Demo mode:** try it without a car (Settings → Demo mode).

## Topics

| Topic | Direction | Payload |
|---|---|---|
| `x3/cmd` | phone → car | `start <minutes> <outside °C>`, `stop`, `status`, `ping` |
| `x3/state` | car → phone, retained | `online`, or `offline` (the car's last will) |
| `x3/status` | car → phone, retained | JSON: `engine`, `rssi`, `vbat`, `rpm`, `coolant`, `ends` (Unix time), `runMin`, `t` |
| `x3/log` | car → phone | a line of plain text |

## Files

| File | What it is |
|---|---|
| `index.html`, `app.css`, `app.js` | The app: no build step, no framework |
| `vendor/mqtt.min.js` | MQTT.js 5.16.1 browser bundle (MIT, `vendor/LICENSE-mqtt.md`) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install and offline support |

## Setup link

`https://<this site>/#host=<server address>&user=<username>` fills in the setup form. The part
after `#` never leaves the phone, and the app clears it from the address bar.

## Safety

The app only asks. The car's firmware decides whether a start is allowed: engine off, car
stopped, brake press confirmed, a time limit, and a shutdown if anyone touches the brake.
