// ----- Firebase config -----
// Replace this config with your Firebase project's config
const firebaseConfig = {
  apiKey: "AIzaSyBZmrM-2dZ9nFJu7-AVGLL83UlxEAWoi3Y",
  authDomain: "lamegel-7a836.firebaseapp.com",
  databaseURL: "https://lamegel-7a836-default-rtdb.firebaseio.com",
  projectId: "lamegel-7a836",
  storageBucket: "lamegel-7a836.appspot.com",
  messagingSenderId: "512932953865",
  appId: "1:512932953865:web:38ccec7d1e7a4008875dd8",
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// DOM elements
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chatInput");
const nextBtn = document.getElementById("nextBtn");
const connectFriendBtn = document.getElementById("connectFriendBtn");
const friendCodeInput = document.getElementById("friendCodeInput");
const statusText = document.getElementById("statusText");

// Globals
let localStream = null;
let peerConnection = null;
let dataChannel = null;
let roomId = null;
let isCaller = false;
let typingTimeout = null;
let strangerRef = null;
let chatRef = null;

const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// Utility to create unique IDs for rooms and friend codes
function makeId(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Show message in chat area
function addMessage(text, fromSelf = false) {
  const p = document.createElement("p");
  p.textContent = text;
  if (fromSelf) p.classList.add("own-message");
  chatMessages.appendChild(p);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Clear chat messages
function clearMessages() {
  chatMessages.innerHTML = "";
}

// Start camera and show preview
async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localVideo.srcObject = localStream;
  } catch (err) {
    alert("Could not access camera/microphone: " + err.message);
  }
}

// Create RTCPeerConnection and setup event handlers
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  // Add local stream tracks to connection
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  // Remote stream handler
  peerConnection.ontrack = (event) => {
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
  };

  // ICE candidate handler
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      db.ref(`rooms/${roomId}/candidates/${isCaller ? "caller" : "callee"}`).push(event.candidate.toJSON());
    }
  };

  // Data channel setup
  if (isCaller) {
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannel();
  } else {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel();
    };
  }
}

// Setup data channel handlers for chat
function setupDataChannel() {
  dataChannel.onopen = () => {
    console.log("Data channel open");
    chatInput.disabled = false;
  };

  dataChannel.onmessage = (event) => {
    addMessage(event.data, false);
  };

  dataChannel.onclose = () => {
    console.log("Data channel closed");
    chatInput.disabled = true;
  };
}

// Send chat message
function sendMessage(text) {
  if (!dataChannel || dataChannel.readyState !== "open") return;
  dataChannel.send(text);
  addMessage(text, true);
}

// Listen for typing (shows typing indicator)
function handleTyping() {
  if (!dataChannel || dataChannel.readyState !== "open") return;

  dataChannel.send("__typing__"); // Special message for typing

  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    dataChannel.send("__stoptyping__");
  }, 1500);
}

// Show typing indicator
function showTyping(show) {
  if (show) {
    statusText.textContent = "Stranger is typing...";
  } else {
    statusText.textContent = "You're now chatting with a random stranger. Say hi!";
  }
}

// Clear room in Firebase when disconnecting
async function cleanupRoom() {
  if (!roomId) return;
  await db.ref(`rooms/${roomId}`).remove();
  roomId = null;
  peerConnection = null;
  dataChannel = null;
  remoteVideo.srcObject = null;
  clearMessages();
  statusText.textContent = "Disconnected. Click Next to find someone else.";
}

// Matchmaking logic: connect with random stranger
async function startRandomChat() {
  await cleanupRoom();
  statusText.textContent = "Looking for a stranger...";

  // Generate room id for caller
  roomId = makeId(8);
  isCaller = true;

  // Write 'waiting' state to DB
  await db.ref(`waiting/${roomId}`).set(true);

  // Look for other waiting rooms
  const waitingSnapshot = await db.ref("waiting").once("value");
  let foundRoom = null;

  waitingSnapshot.forEach((child) => {
    if (child.key !== roomId) {
      foundRoom = child.key;
      return true; // break loop
    }
  });

  if (foundRoom) {
    // Found stranger waiting - join as callee
    roomId = foundRoom;
    isCaller = false;
    await db.ref(`waiting/${foundRoom}`).remove();
    setupConnection();
  } else {
    // No waiting room found, wait as caller
    setupConnection();
  }
}

// Setup WebRTC connection, signaling with Firebase
async function setupConnection() {
  statusText.textContent = "Connecting...";
  createPeerConnection();

  // ICE candidate listener
  db.ref(`rooms/${roomId}/candidates/${isCaller ? "callee" : "caller"}`).on("child_added", async (snapshot) => {
    const candidate = new RTCIceCandidate(snapshot.val());
    await peerConnection.addIceCandidate(candidate);
  });

  if (isCaller) {
    // Caller creates offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await db.ref(`rooms/${roomId}/offer`).set(offer.toJSON());

    // Listen for answer
    db.ref(`rooms/${roomId}/answer`).on("value", async (snapshot) => {
      const answer = snapshot.val();
      if (!answer) return;
      const rtcAnswer = new RTCSessionDescription(answer);
      await peerConnection.setRemoteDescription(rtcAnswer);
      statusText.textContent = "Connected! Say hi!";
    });
  } else {
    // Callee listens for offer
    db.ref(`rooms/${roomId}/offer`).on("value", async (snapshot) => {
      const offer = snapshot.val();
      if (!offer) return;

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await db.ref(`rooms/${roomId}/answer`).set(answer.toJSON());
      statusText.textContent = "Connected! Say hi!";
    });
  }

  // Cleanup on connection state change
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === "disconnected" || peerConnection.connectionState === "failed") {
      cleanupRoom();
    }
  };
}

// Friend code connection
async function connectToFriend() {
  const code = friendCodeInput.value.trim().toUpperCase();
  if (!code) {
    alert("Enter a valid friend code");
    return;
  }

  await cleanupRoom();

  roomId = code;
  isCaller = true;

  // Setup connection using friend code as roomId
  await setupConnection();
}

// Event listeners
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && chatInput.value.trim()) {
    sendMessage(chatInput.value.trim());
    chatInput.value = "";
  } else {
    handleTyping();
  }
});

nextBtn.addEventListener("click", () => {
  startRandomChat();
});

connectFriendBtn.addEventListener("click", () => {
  connectToFriend();
});

// Initialize
(async () => {
  await startCamera();
  chatInput.disabled = true;
  startRandomChat();
})();
