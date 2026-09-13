# Local Drop

Browser-to-browser peer-to-peer file transfer, built with WebRTC.
Send a file straight from one browser to another — no upload, no
cloud storage, no file size limits imposed by a server, since the
file never touches the server at all.

**Live demo:** _add your deployed link here once live_

## How it works

```
Browser A ──┐                       ┌── Browser B
            │      WebSocket        │
            └──────► signaling ◄────┘
                    server (Node.js)
                (relays connection setup
                 only — never sees files)

Browser A ═══════ RTCDataChannel ═══════ Browser B
                (actual file transfer —
                 direct, peer-to-peer)
```

A small Node.js signaling server helps two browsers find each other
and exchange WebRTC connection details. Once that handshake completes,
the server steps out of the picture entirely — the file itself moves
directly between the two browsers over an `RTCDataChannel`.

## Features

- Room-code based pairing (create or join a 6-digit room)
- QR code + shareable link for instant mobile pairing — scan and join,
  no typing required
- Chunked file transfer with live progress on both ends
- STUN-based NAT traversal (with a documented, opt-in TURN fallback
  hook for stricter networks)
- No file size limit, no server-side storage — the file only ever
  exists in the two browsers involved

## Stack

- **Backend:** Node.js, `ws` (plain WebSocket server) — signaling only
- **Frontend:** Vanilla HTML/CSS/JS, WebRTC APIs directly (no wrapper
  libraries), `qrcodejs` for QR generation

## Project structure

```
local-drop/
├── backend/     — signaling server (Node.js)
├── frontend/    — the actual app (HTML/CSS/JS)
└── docs/
    ├── architecture.md   — how each part works, step by step
    └── decisions.md      — design tradeoffs + a real bug found and
                            fixed while building this
```

## Running it locally

**Backend:**
```bash
cd backend
npm install
npm start
```
Runs on `ws://localhost:8080`.

**Frontend:**
Just open `frontend/index.html` in two browser tabs. For a real
cross-device test (not just two tabs on one machine), serve the
`frontend` folder over your local network IP instead of opening the
file directly — see `docs/architecture.md` for why `file://`/`localhost`
won't work across two separate devices.

## Why this project

Most portfolio projects are CRUD apps talking to a database. This one
is deliberately different — it's about real-time peer-to-peer
networking: signaling, SDP, ICE negotiation, NAT traversal, and
`RTCDataChannel`. See `docs/decisions.md` for a concrete example: a
real bug hit while building this (an empty SDP offer with no `m=`
line, because a data channel wasn't created before generating the
offer) and how it was diagnosed and fixed.
