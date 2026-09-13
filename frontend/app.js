/**
 * Local Drop — Frontend
 * ----------------------
 * Handles, in order:
 *  1. Signaling connection (WebSocket) + room join UI
 *  2. RTCPeerConnection setup — offer/answer/ICE exchange
 *  3. File transfer over RTCDataChannel — chunking, reassembly, download
 *
 * See docs/architecture.md for the full explanation of each stage, and
 * docs/decisions.md for a debugging story worth rereading before an
 * interview (a real bug we hit and fixed while building this).
 */

// Local testing uses your own machine's signaling server. Once deployed,
// replace REMOTE_SIGNALING_HOST below with your actual Render backend
// hostname (no protocol, no trailing slash) — e.g. "local-drop-backend.onrender.com".
// The app automatically switches between ws:// (local) and wss:// (deployed,
// since Render serves over https) based on where the page itself is running.
const REMOTE_SIGNALING_HOST = "local-drop-inoc.onrender.com";
const SIGNALING_URL =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "ws://localhost:8080"
    : `wss://${REMOTE_SIGNALING_HOST}`;

const joinScreen = document.getElementById("join-screen");
const roomScreen = document.getElementById("room-screen");
const roomInput = document.getElementById("room-input");
const joinBtn = document.getElementById("join-btn");
const statusLine = document.getElementById("status-line");
const roomCodeDisplay = document.getElementById("room-code-display");
const peerStatus = document.getElementById("peer-status");
const peerIndicator = document.getElementById("peer-indicator");
const filePickerText = document.querySelector(".picker-text");

let socket = null;
let isInitiator = false;
let pc = null;
let dataChannel = null;

const transferArea = document.getElementById("transfer-area");
const fileInput = document.getElementById("file-input");
const sendBtn = document.getElementById("send-btn");
const progressFill = document.getElementById("progress-fill");
const transferStatus = document.getElementById("transfer-status");
const downloadLink = document.getElementById("download-link");
const truckScene = document.getElementById("truck-scene");

const qrWrap = document.getElementById("qr-wrap");
const qrCodeEl = document.getElementById("qr-code");
const shareLinkInput = document.getElementById("share-link");
const copyLinkBtn = document.getElementById("copy-link-btn");
const copyRoomBtn = document.getElementById("copy-room-btn");

// 16KB is a conservative chunk size that stays well under typical
// RTCDataChannel message size limits across browsers.
const CHUNK_SIZE = 16 * 1024;

// Receiving-side state — reset each time a new file transfer begins.
let incomingFileMeta = null; // { name, size, mimeType }
let incomingChunks = [];
let incomingBytesReceived = 0;

/**
 * STUN servers help a browser discover its own "public" address/port so
 * it can tell the other peer how to reach it directly, even through a
 * home router's NAT. Multiple STUN servers here just adds redundancy —
 * if one is slow/unreachable, another can still respond.
 *
 * TURN is a further fallback for restrictive networks/NATs where STUN
 * alone can't find a path (see docs/architecture.md). Left as an opt-in
 * hook via window.LOCAL_DROP_TURN so adding a real TURN server later
 * doesn't require touching this file's logic — just set that global
 * before app.js runs (e.g. in a small inline <script> in index.html).
 */
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // Example:
    // window.LOCAL_DROP_TURN = {
    //   urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"],
    //   username: "your-user",
    //   credential: "your-password",
    // };
    ...(window.LOCAL_DROP_TURN ? [window.LOCAL_DROP_TURN] : []),
  ],
};

/**
 * Creates the RTCPeerConnection and wires up the two things every
 * WebRTC app needs regardless of what data you're sending:
 *  1. onicecandidate — fires repeatedly as the browser discovers ways
 *     it might be reachable; each one must be sent to the other peer.
 *  2. connectionstatechange — lets us show real connection status
 *     instead of guessing.
 */
function createPeerConnection() {
  console.log("[TRACE] createPeerConnection() called");
  const connection = new RTCPeerConnection(RTC_CONFIG);
  console.log("[TRACE] RTCPeerConnection object created:", connection);

  connection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      console.log("[TRACE] local candidate found:", {
        type: event.candidate.type, // host / srflx / relay
        protocol: event.candidate.protocol,
        address: event.candidate.address,
        port: event.candidate.port,
      });
      socket.send(
        JSON.stringify({
          type: "ice-candidate",
          candidate: event.candidate,
        }),
      );
    } else {
      console.log(
        "[TRACE] candidate gathering finished (null candidate = end-of-candidates)",
      );
    }
  });

  connection.addEventListener("connectionstatechange", () => {
    console.log("Connection state:", connection.connectionState);
    if (connection.connectionState === "connected") {
      peerStatus.textContent =
        "Connected directly — peer-to-peer link is live.";
      setPeerIndicator("online", "Connected");
    } else if (connection.connectionState === "failed") {
      peerStatus.textContent =
        "Connection failed — the browsers could not find a direct route. Try same Wi‑Fi/network or add a TURN server.";
      setPeerIndicator("offline", "Failed");
      setStatus("Connection failed", "error");
      resetTransferUI();
    } else if (
      ["disconnected", "closed"].includes(connection.connectionState)
    ) {
      peerStatus.textContent = `Connection ${connection.connectionState}.`;
      setPeerIndicator("offline", "Offline");
      resetTransferUI();
    }
  });

  connection.addEventListener("iceconnectionstatechange", () => {
    console.log("ICE connection state:", connection.iceConnectionState);
    if (connection.iceConnectionState === "failed") {
      setStatus("ICE failed — network path unavailable", "error");
      peerStatus.textContent =
        "ICE negotiation failed. This usually means the devices are not reachable directly (NAT/firewall/VPN).";
    }
  });

  connection.addEventListener("icegatheringstatechange", () => {
    console.log("ICE gathering state:", connection.iceGatheringState);
  });

  // On the NON-initiator side, the data channel arrives via this event
  // rather than being created locally — the initiator created it, and
  // this is how the other peer receives a handle to that same channel.
  connection.addEventListener("datachannel", (event) => {
    console.log("[TRACE] datachannel event received (answerer side)");
    dataChannel = setupDataChannel(event.channel);
  });

  return connection;
}

/**
 * Attaches lifecycle + message handling to the data channel.
 *
 * Message protocol (kept deliberately simple):
 *  - A STRING message is always file metadata (JSON: name/size/mimeType),
 *    sent once at the start of a transfer.
 *  - Any BINARY message (ArrayBuffer) after that is a file chunk, in
 *    order, until we've received `size` bytes total.
 * This lets the receiver tell "here's a new file starting" apart from
 * "here's more of the file" without a more complex framing format.
 */
function setupDataChannel(channel) {
  channel.binaryType = "arraybuffer";

  channel.addEventListener("open", () => {
    console.log("[TRACE] data channel OPEN");
    peerStatus.textContent = "Connected directly — peer-to-peer link is live.";
    setPeerIndicator("online", "Connected");
    transferArea.classList.remove("hidden");
    sendBtn.disabled = false;
  });

  channel.addEventListener("close", () => {
    console.log("[TRACE] data channel closed");
    setPeerIndicator("offline", "Offline");
    resetTransferUI();
  });

  channel.addEventListener("error", (event) => {
    console.error("[ERROR] data channel error:", event);
    setTransferStatus("Transfer error — connection may have dropped.", false);
  });

  channel.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      // New file incoming — reset receive state.
      incomingFileMeta = JSON.parse(event.data);
      incomingChunks = [];
      incomingBytesReceived = 0;
      animateTruck("download");
      setTransferStatus(`Receiving "${incomingFileMeta.name}"…`, true);
      downloadLink.classList.add("hidden");
      console.log("[TRACE] incoming file metadata:", incomingFileMeta);
      return;
    }

    // Otherwise it's a binary chunk (ArrayBuffer).
    incomingChunks.push(event.data);
    incomingBytesReceived += event.data.byteLength;

    const percent = Math.min(
      100,
      Math.round((incomingBytesReceived / incomingFileMeta.size) * 100),
    );
    progressFill.style.width = `${percent}%`;
    setTransferStatus(
      `Receiving "${incomingFileMeta.name}"… ${percent}%`,
      true,
    );

    if (incomingBytesReceived >= incomingFileMeta.size) {
      finishIncomingFile();
    }
  });

  return channel;
}

/**
 * Reassembles all received chunks into a single Blob and turns the
 * download link into a real, clickable download for the received file.
 */
function finishIncomingFile() {
  const blob = new Blob(incomingChunks, { type: incomingFileMeta.mimeType });
  const url = URL.createObjectURL(blob);

  downloadLink.href = url;
  downloadLink.download = incomingFileMeta.name;
  // Keep the download button label generic — filename is shown above.
  downloadLink.textContent = "Download received file";
  // Preserve the original filename in a tooltip and accessible label.
  downloadLink.title = incomingFileMeta.name;
  downloadLink.setAttribute(
    "aria-label",
    `Download received file (${incomingFileMeta.name})`,
  );
  downloadLink.classList.remove("hidden");

  setTransferStatus(
    `Received "${incomingFileMeta.name}" — ready to download.`,
    false,
  );
  console.log("[TRACE] file fully received, blob created:", blob);

  // Clear state so a second transfer in the same session starts clean.
  incomingChunks = [];
  incomingBytesReceived = 0;
}

/**
 * Reads the chosen file and streams it over the data channel in
 * CHUNK_SIZE pieces. Sends a metadata string message first so the
 * receiver knows the file name/size/type and total to expect.
 */
async function sendFile(file) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    setTransferStatus("Not connected to a peer yet.", false);
    return;
  }

  setTransferStatus(`Sending "${file.name}"… 0%`, true);

  dataChannel.send(
    JSON.stringify({
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    }),
  );

  let offset = 0;
  const buffer = await file.arrayBuffer();

  function sendNextChunk() {
    if (offset >= buffer.byteLength) {
      setTransferStatus(`Sent "${file.name}" — done.`, false);
      progressFill.style.width = "100%";
      return;
    }

    // Basic backpressure handling: if the channel's internal send
    // buffer is getting full, wait before queueing more — otherwise
    // we'd risk overwhelming the channel on large files.
    if (dataChannel.bufferedAmount > CHUNK_SIZE * 8) {
      setTimeout(sendNextChunk, 10);
      return;
    }

    const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
    dataChannel.send(chunk);
    offset += chunk.byteLength;

    const percent = Math.round((offset / buffer.byteLength) * 100);
    progressFill.style.width = `${percent}%`;
    setTransferStatus(`Sending "${file.name}"… ${percent}%`, true);

    // Yield back to the event loop between chunks rather than blocking
    // in a tight loop — keeps the UI responsive during large transfers.
    setTimeout(sendNextChunk, 0);
  }

  sendNextChunk();
}

/**
 * Runs on the INITIATOR's side once the second peer joins. Creating
 * the offer is what kicks off the whole negotiation.
 *
 * IMPORTANT: we must create a data channel (or add a media track)
 * BEFORE calling createOffer(). Without at least one, the resulting
 * SDP has no "m=" line — meaning nothing to negotiate transport for —
 * and ICE will never start gathering candidates at all. This was the
 * actual bug behind "nothing happens": the offer/answer were being
 * exchanged, but they were empty shells.
 */
async function startAsInitiator() {
  console.log("[TRACE] startAsInitiator() called");
  try {
    pc = createPeerConnection();

    dataChannel = pc.createDataChannel("file-transfer");
    setupDataChannel(dataChannel);
    console.log("[TRACE] data channel created (initiator side)");

    const offer = await pc.createOffer();
    console.log("[TRACE] offer created:", offer);
    await pc.setLocalDescription(offer);
    console.log("[TRACE] local description set, sending offer to peer");

    socket.send(JSON.stringify({ type: "offer", offer }));
    console.log("[TRACE] offer sent over socket");
  } catch (err) {
    console.error("[ERROR] startAsInitiator failed:", err);
  }
}

/**
 * Runs on the NON-initiator's side when an offer arrives. Answering
 * completes the handshake — after this, ICE candidates from both sides
 * finish the job of finding a working network path.
 */
async function handleOffer(offer) {
  console.log("[TRACE] handleOffer() called with:", offer);
  try {
    pc = createPeerConnection();

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    console.log("[TRACE] remote description (offer) set");
    const answer = await pc.createAnswer();
    console.log("[TRACE] answer created:", answer);
    await pc.setLocalDescription(answer);
    console.log("[TRACE] local description (answer) set, sending to peer");

    socket.send(JSON.stringify({ type: "answer", answer }));
    console.log("[TRACE] answer sent over socket");
  } catch (err) {
    console.error("[ERROR] handleOffer failed:", err);
  }
}

async function handleAnswer(answer) {
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleRemoteIceCandidate(candidate) {
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    // Candidates can arrive slightly out of order in edge cases;
    // logging (not throwing) keeps one bad candidate from killing
    // the whole negotiation.
    console.warn("Failed to add ICE candidate:", err);
  }
}

function setStatus(text, type = "neutral") {
  statusLine.className = `status ${type}`;
  statusLine.innerHTML = `<span class="status-dot"></span>${text}`;
}

function setPeerIndicator(state, text) {
  peerIndicator.className = `peer-indicator ${state}`;
  peerIndicator.textContent = text;
}

function randomRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function connectSignaling(roomCode) {
  socket = new WebSocket(SIGNALING_URL);

  socket.addEventListener("open", () => {
    setStatus("Connected to server — joining room…", "neutral");
    socket.send(JSON.stringify({ type: "join-room", roomCode }));
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    handleSignalingMessage(msg);
  });

  socket.addEventListener("close", () => {
    setStatus("Disconnected from server", "error");
    setPeerIndicator("offline", "Offline");
    joinBtn.disabled = false;
  });

  socket.addEventListener("error", () => {
    setStatus("Could not reach signaling server — is it running?", "error");
    setPeerIndicator("offline", "Offline");
    joinBtn.disabled = false;
  });
}

function handleSignalingMessage(msg) {
  console.log("[TRACE] signaling message received:", msg);
  switch (msg.type) {
    case "joined-room": {
      isInitiator = msg.isInitiator;
      showRoomScreen(msg.roomCode);
      peerStatus.textContent = isInitiator
        ? "Waiting for the other device to join…"
        : "Joined — waiting to connect…";
      setPeerIndicator("offline", isInitiator ? "Waiting" : "Joined");
      if (isInitiator) {
        showJoinQR(msg.roomCode);
      }
      break;
    }

    case "peer-joined": {
      peerStatus.textContent = "Peer found — negotiating connection…";
      setPeerIndicator("online", "Connecting");
      hideJoinQR();
      // Only the initiator creates the offer. The other side just waits
      // for it (handled in the 'offer' case below).
      if (isInitiator) {
        startAsInitiator();
      }
      break;
    }

    case "offer": {
      handleOffer(msg.offer);
      break;
    }

    case "answer": {
      handleAnswer(msg.answer);
      break;
    }

    case "ice-candidate": {
      handleRemoteIceCandidate(msg.candidate);
      break;
    }

    case "peer-left": {
      peerStatus.textContent = "The other device disconnected.";
      setPeerIndicator("offline", "Offline");
      if (pc) {
        pc.close();
        pc = null;
      }
      resetTransferUI();
      if (isInitiator) {
        showJoinQR(roomCodeDisplay.textContent);
      }
      break;
    }

    case "room-full": {
      setStatus(
        "That room already has 2 people — try a different code.",
        "error",
      );
      socket.close();
      break;
    }

    default:
      console.log("Unhandled message:", msg);
  }
}

/**
 * Called whenever the connection drops (peer-left, data channel closed,
 * or the RTCPeerConnection itself fails/disconnects) so a peer leaving
 * mid-transfer doesn't leave stale progress bars, a stuck "Send"
 * button, or an old download link behind.
 */
function resetTransferUI() {
  transferArea.classList.add("hidden");
  downloadLink.classList.add("hidden");
  progressFill.style.width = "0%";
  setTransferStatus("", false);
  filePickerText.textContent = "Choose a file";
  fileInput.value = "";
  sendBtn.disabled = true;
  dataChannel = null;
}

function showRoomScreen(roomCode) {
  roomCodeDisplay.textContent = roomCode;
  joinScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
}

/**
 * Builds the join URL for a room and renders it as a QR code (via the
 * qrcodejs library loaded in index.html), plus a copyable text fallback.
 *
 * IMPORTANT — a common gotcha: this URL uses window.location, which
 * will be "http://localhost:PORT/?room=..." if you're testing by
 * opening index.html directly. A QR code encoding "localhost" is only
 * scannable/openable on the SAME device — it means nothing to another
 * phone. For a real cross-device test, serve this over your machine's
 * LAN IP (e.g. http://192.168.x.x:5500) or, once deployed, your real
 * domain will make this work correctly for anyone.
 */
function buildJoinUrl(roomCode) {
  const url = new URL(window.location.href);
  url.search = `?room=${roomCode}`;
  return url.toString();
}

function showJoinQR(roomCode) {
  const joinUrl = buildJoinUrl(roomCode);

  qrCodeEl.innerHTML = ""; // clear any previous QR before rendering a new one
  // eslint-disable-next-line no-undef -- QRCode comes from the CDN script in index.html
  new QRCode(qrCodeEl, {
    text: joinUrl,
    width: 160,
    height: 160,
    colorDark: "#000000",
    colorLight: "#ffffff",
  });

  shareLinkInput.value = joinUrl;
  qrWrap.classList.remove("hidden");
}

function hideJoinQR() {
  qrWrap.classList.add("hidden");
}

copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
    const original = copyLinkBtn.textContent;
    copyLinkBtn.textContent = "Copied!";
    setTimeout(() => {
      copyLinkBtn.textContent = original;
    }, 1500);
  } catch (err) {
    console.warn("Clipboard write failed:", err);
    shareLinkInput.select();
  }
});

// Copy the active room code (small button next to the badge). The
// element may not exist for users on the join flow, so guard access.
if (typeof copyRoomBtn !== "undefined" && copyRoomBtn) {
  copyRoomBtn.addEventListener("click", async () => {
    const roomCode = roomCodeDisplay.textContent.trim();
    if (!roomCode || roomCode === "—") return;

    try {
      await navigator.clipboard.writeText(roomCode);
      const original = copyRoomBtn.textContent;
      copyRoomBtn.textContent = "Copied!";
      setTimeout(() => {
        copyRoomBtn.textContent = original;
      }, 1500);
    } catch (err) {
      console.warn("Room code clipboard copy failed:", err);
      // Fallback for older browsers
      const ta = document.createElement("textarea");
      ta.value = roomCode;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copyRoomBtn.textContent = "Copied!";
      setTimeout(() => {
        copyRoomBtn.textContent = "Copy";
      }, 1500);
    }
  });
}

/**
 * If the page was opened with ?room=XXXXXX in the URL (e.g. from
 * scanning a QR code or tapping a shared link), auto-fill and
 * auto-join that room instead of waiting for a manual click.
 */
function autoJoinFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");
  if (roomFromUrl) {
    roomInput.value = roomFromUrl;
    joinBtn.click();
  }
}

joinBtn.addEventListener("click", () => {
  const typed = roomInput.value.trim();
  const roomCode = typed || randomRoomCode();
  joinBtn.disabled = true;
  setStatus("Connecting…", "neutral");
  connectSignaling(roomCode);
});

roomInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    joinBtn.click();
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) {
    filePickerText.textContent = "Choose a file";
    return;
  }

  const displayName =
    file.name.length > 24 ? `${file.name.slice(0, 24)}…` : file.name;
  filePickerText.textContent = displayName;
});

sendBtn.addEventListener("click", () => {
  const file = fileInput.files[0];
  if (!file) {
    transferStatus.textContent = "Choose a file first.";
    return;
  }
  animateTruck("send");
  sendFile(file);
});

function setTransferStatus(message, isLoading = false) {
  transferStatus.classList.toggle("loading", isLoading);
  transferStatus.innerHTML = isLoading
    ? `<span class="mini-loader"></span>${message}`
    : message;
}

function animateTruck(direction) {
  truckScene.classList.remove("send", "download");
  void truckScene.offsetWidth;
  truckScene.classList.add(direction);

  const duration = direction === "download" ? 2800 : 2400;

  setTimeout(() => {
    truckScene.classList.remove(direction);
  }, duration);
}

// Must run last — after joinBtn's click handler is registered above —
// since this may simulate a click on it immediately on page load.
autoJoinFromUrl();
