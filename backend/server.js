/**
 * Local Drop — Signaling Server
 * ------------------------------
 * WHY this file exists:
 * WebRTC lets two browsers talk directly, but they have no way to find
 * each other on their own. This server is the "matchmaker" — it never
 * sees file data, only tiny connection-setup messages (SDP offers/answers
 * and ICE candidates). Once two peers are connected, this server steps
 * out of the picture entirely.
 *
 * Design choice: everything lives in memory (a JS Map). No database.
 * If the server restarts, all rooms are gone — that's fine, because
 * rooms are meant to be short-lived (one file-transfer session).
 */

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// rooms: Map<roomCode, Set<ws>>
// A Set (not array) because we need fast add/remove and no duplicates.
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Sends a JSON message to a single socket, guarding against sockets
 * that closed mid-flight (common with flaky networks).
 */
function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Relays a message to the OTHER peer(s) in the same room — never back
 * to the sender. This is the core of signaling: peer A's offer must
 * reach peer B, not bounce back to A.
 */
function relayToRoom(roomCode, senderWs, data) {
  const peers = rooms.get(roomCode);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== senderWs) {
      send(peer, data);
    }
  }
}

wss.on("connection", (ws) => {
  // Track which room this socket belongs to, so we can clean up on disconnect.
  ws.roomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      log("Ignoring non-JSON message:", err.message);
      return;
    }

    switch (msg.type) {
      case "join-room": {
        const { roomCode } = msg;
        if (!roomCode) return;

        // We cap rooms at 2 peers — Local Drop is a 1:1 transfer tool,
        // not a group chat. This keeps the mental model (and the code)
        // simple for a v1.
        const existing = rooms.get(roomCode) || new Set();
        if (existing.size >= 2) {
          send(ws, { type: "room-full" });
          return;
        }

        existing.add(ws);
        rooms.set(roomCode, existing);
        ws.roomCode = roomCode;

        const peerCount = existing.size;
        log(`Peer joined room "${roomCode}" (${peerCount}/2)`);

        // Tell the joining peer whether they're first (must create the
        // WebRTC offer) or second (must wait for an offer and answer it).
        send(ws, {
          type: "joined-room",
          roomCode,
          isInitiator: peerCount === 1,
        });

        // If a second peer just joined, let the first peer know it can
        // start the WebRTC handshake now.
        if (peerCount === 2) {
          relayToRoom(roomCode, ws, { type: "peer-joined" });
        }
        break;
      }

      // These three message types are pure relays: the server does not
      // need to understand SDP or ICE candidate contents at all. It just
      // forwards whatever the browser's WebRTC API produced.
      case "offer":
      case "answer":
      case "ice-candidate": {
        if (!ws.roomCode) return;
        relayToRoom(ws.roomCode, ws, msg);
        break;
      }

      default:
        log("Unknown message type:", msg.type);
    }
  });

  ws.on("close", () => {
    if (!ws.roomCode) return;
    const peers = rooms.get(ws.roomCode);
    if (peers) {
      peers.delete(ws);
      relayToRoom(ws.roomCode, ws, { type: "peer-left" });
      if (peers.size === 0) {
        rooms.delete(ws.roomCode);
        log(`Room "${ws.roomCode}" closed (empty)`);
      }
    }
  });
});

log(`Signaling server listening on ws://localhost:${PORT}`);
