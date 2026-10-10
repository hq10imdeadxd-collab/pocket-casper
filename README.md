# 🌙 Pocket Casper

A private AI chat that runs **entirely on your iPhone**. No server, no account, and no internet once a model is
downloaded. It's a web app (PWA): you add it to your Home Screen from Safari and it works like a normal app,
even in airplane mode.

## How it works
- The model runs on the phone's GPU through **WebGPU** with [WebLLM](https://github.com/mlc-ai/web-llm)
  (`vendor/web-llm.js`, v0.2.85), in a background worker (`worker.js`) so the chat stays smooth.
- The first time you pick a model it downloads once (0.7–2.4 GB) and is stored on the phone. After that
  everything runs offline. Chats are saved on the phone only.
- `sw.js` keeps the app itself available offline. `manifest.webmanifest` + the icons make it installable.

## Requirements
- **iPhone with iOS 26 or newer** (Safari added WebGPU in iOS 26). iPhone 16 is fine.
- About 1–3 GB of free storage for one model.

## Models
| Model | Download | On the PC's RTX 3060 | Notes |
|---|---|---|---|
| **Qwen 3.5 · 2B** (recommended) | 1.1 GB | 50 tok/s | Newest; best balance |
| Llama 3.2 · 3B | 1.8 GB | 55 tok/s | Natural writer |
| Qwen 3 · 1.7B | 1.0 GB | 61 tok/s | Can "think first" (Settings) |
| Llama 3.2 · 1B | 0.7 GB | 109 tok/s | Fastest, simpler answers |
| Qwen 3.5 · 4B | 2.4 GB | – | Smartest; may not fit in the phone's memory |

An iPhone GPU is roughly 5–7x slower than the 3060, so expect about 8–20 tok/s on the phone. Measure with
`tools/bench.html` (open it, then run `await bench(["<model id>"])` in the console).
Left out after testing: Qwen 3.5 0.8B (too weak) and Gemma 3 1B (fails to load in this WebLLM version).

## Test on this PC
```
python serve.py
```
then open http://localhost:8800 in Chrome or Edge. (Close Casper's model first or it will hog the GPU and make
everything look slow.)

## Put it on the iPhone
The phone has to load the app once from an **HTTPS** address (WebGPU and offline mode require it). Options:
1. **GitHub Pages** (free, works from anywhere): push this folder to a GitHub repo and turn on Pages.
2. **From this PC via Tailscale** (private): `tailscale serve` gives the PC an HTTPS address only your devices
   can reach. The PC only needs to be on while installing or updating.

Then on the iPhone: open the address in **Safari** → **Share** → **Add to Home Screen** → open the new icon →
*Choose a model* (on Wi-Fi). Done; it works offline from then on.

## Updating
Change the files, bump `VERSION` in `sw.js` (and `app.js`), and republish. The app picks up the new version the
next time it's opened online and asks you to reopen it.

## Files
`index.html`, `style.css`, `app.js` (UI + chat), `worker.js` (model runner), `sw.js` (offline), `manifest.webmanifest`,
`icons/` (from `tools/make_icons.py`), `vendor/` (WebLLM, marked, DOMPurify), `serve.py` (local test server).
