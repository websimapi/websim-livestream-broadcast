import DOMPurify from 'dompurify';

const room = new WebsimSocket();
let currentUser = null;
let projectCreator = null;
let isOwner = false;

// WebRTC Configuration
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// State
let localStream = null;
let peerConnections = {}; // Host: map of clientId -> RTCPeerConnection
let hostConnection = null; // Viewer: RTCPeerConnection to Host
let iceCandidateBuffer = []; // Viewer: buffer for candidates arriving before remote description
let isBroadcasting = false;
let joinTimeout = null;

// UI Elements
const ui = {
    video: document.getElementById('main-video'),
    placeholder: document.getElementById('video-placeholder'),
    statusText: document.getElementById('status-text'),
    hostControls: document.getElementById('host-controls'),
    liveControls: document.getElementById('live-controls'),
    streamTitleInput: document.getElementById('stream-title-input'),
    btnStart: document.getElementById('btn-start-stream'),
    btnStop: document.getElementById('btn-stop-stream'),
    
    // Info
    displayTitle: document.getElementById('stream-title-display'),
    displayHost: document.getElementById('streamer-name'),
    displayAvatar: document.getElementById('streamer-avatar'),
    viewerCount: document.getElementById('viewer-count'),
    hostStats: document.getElementById('live-stats'),

    // Chat
    chatMsgs: document.getElementById('chat-messages'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
};

// --- Initialization ---
async function init() {
    // 1. Auth & Role Check
    try {
        currentUser = await window.websim.getCurrentUser();
        projectCreator = await window.websim.getCreator();
        isOwner = (currentUser && projectCreator && currentUser.id === projectCreator.id);
    } catch (e) {
        console.error("Auth failed", e);
        // Fallback for non-logged in or errors
        isOwner = false;
        currentUser = { username: "Guest_" + Math.floor(Math.random()*1000), id: `guest-${Date.now()}` };
    }

    await room.initialize();
    
    // Initial UI State
    setupUI();

    // Subscribe to State
    room.subscribeRoomState(handleRoomState);
    room.subscribePresence(handlePresence);
    
    // Websocket Messages (Signaling + Chat)
    room.onmessage = handleMessage;

    console.log("Initialized. Role:", isOwner ? "Potential Host" : "Viewer");
}

function setupUI() {
    if (isOwner) {
        // Check if there is already an active broadcaster in the room state
        checkHostCapability();
    } else {
        // Not owner
        ui.hostControls.classList.add('hidden');
    }

    // Chat
    ui.chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = ui.chatInput.value.trim();
        if (!text) return;
        
        room.send({
            type: 'chat',
            text: text,
            username: currentUser.username,
            userId: currentUser.id, // helpful for styling host vs others
            echo: true 
        });
        ui.chatInput.value = '';
    });

    // Broadcast Controls
    ui.btnStart.addEventListener('click', startBroadcast);
    ui.btnStop.addEventListener('click', stopBroadcast);
}

// --- Logic: Role Management ---
function checkHostCapability() {
    if (!isOwner) return;

    const state = room.roomState;
    const broadcasterId = state.broadcasterId;
    
    // Default assumptions
    let showStartControls = false;
    let showLiveControls = false;

    if (!state.isLive || !broadcasterId) {
        // Clean state, ready to host
        showStartControls = true;
    } else {
        // State says someone is live.
        // Check if that someone is actually here (Zombie check)
        const broadcasterPresent = room.peers[broadcasterId];
        
        if (!broadcasterPresent) {
            console.log("Zombie broadcast detected (host missing). Resetting state...");
            room.updateRoomState({ isLive: false, broadcasterId: null, streamTitle: null });
            showStartControls = true; // Optimistic
        } else if (broadcasterId === room.clientId) {
             // It says I am the broadcaster.
             if (isBroadcasting) {
                 showLiveControls = true;
             } else {
                 // I am the broadcaster ID, but I am not locally broadcasting (e.g. refresh).
                 console.log("State mismatch (I am host but not streaming). Resetting...");
                 room.updateRoomState({ isLive: false, broadcasterId: null });
                 showStartControls = true;
             }
        } else {
            // Another valid peer is broadcasting
            showStartControls = false;
            showLiveControls = false;
        }
    }

    // Apply UI
    if (showStartControls) {
        ui.hostControls.classList.remove('hidden');
        ui.liveControls.classList.add('hidden');
    } else if (showLiveControls) {
        ui.hostControls.classList.add('hidden');
        ui.liveControls.classList.remove('hidden');
    } else {
        ui.hostControls.classList.add('hidden');
        ui.liveControls.classList.add('hidden');
    }
}

// --- Logic: Streaming (Host Side) ---
async function startBroadcast() {
    try {
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always" },
            audio: true
        });

        // Handle stream stop via browser UI
        localStream.getVideoTracks()[0].onended = () => stopBroadcast();

        // Show local preview
        ui.video.srcObject = localStream;
        ui.video.muted = true; // Don't hear myself

        // Update UI
        isBroadcasting = true;
        ui.hostControls.classList.add('hidden');
        ui.liveControls.classList.remove('hidden');
        ui.placeholder.classList.remove('visible');

        // Update Room State
        room.updateRoomState({
            isLive: true,
            broadcasterId: room.clientId,
            streamTitle: ui.streamTitleInput.value,
            startedAt: Date.now()
        });

        addSystemMessage("Broadcast started.");

    } catch (err) {
        console.error("Error starting stream:", err);
        alert("Could not start screen capture.");
    }
}

function stopBroadcast() {
    if (!isBroadcasting) return;

    // Stop tracks
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Close all peer connections
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};

    // Update Room State
    room.updateRoomState({
        isLive: false,
        broadcasterId: null
    });

    // Reset UI
    isBroadcasting = false;
    ui.video.srcObject = null;
    ui.hostControls.classList.remove('hidden');
    ui.liveControls.classList.add('hidden');
    ui.placeholder.classList.add('visible');
    ui.statusText.textContent = "Broadcast Ended";
    
    addSystemMessage("Broadcast ended.");
}

// --- Logic: WebRTC Signaling ---

// 1. Handle Messages (Signaling + Chat)
async function handleMessage(e) {
    const data = e.data;
    // Note: room.send sends { ...data }, receiver gets { ...data, clientId, username, etc }
    const fromId = data.clientId;

    if (data.type === 'chat') {
        addChatMessage(data);
        return;
    }

    // Signaling: Filter by target!
    // If the message is not intended for us (and it's a signaling message), ignore it.
    // 'join-request' is an exception as it targets the broadcasterId which is in room state,
    // but the host should check if they are the target.
    const isSignaling = data.type.startsWith('signal-');
    if (isSignaling && data.target !== room.clientId) {
        return;
    }

    // Host Logic: Handling join requests and answers
    if (isBroadcasting && isOwner && room.roomState.broadcasterId === room.clientId) {
        if (data.type === 'join-request') {
            // Only accept if we are the target (broadcaster)
            if (data.target === room.clientId) {
                createHostPeerConnection(fromId);
            }
        } else if (data.type === 'signal-answer') {
            const pc = peerConnections[fromId];
            if (pc) {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                } catch (err) {
                    console.error("Host: Error setting remote description", err);
                }
            }
        } else if (data.type === 'signal-ice') {
            const pc = peerConnections[fromId];
            if (pc && data.candidate) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (err) {
                    console.error("Host: Error adding ICE candidate", err);
                }
            }
        }
    }

    // Viewer Logic: Handling offers and candidates
    if (!isBroadcasting) {
        // Verify message is from current broadcaster
        if (fromId === room.roomState.broadcasterId) {
            if (data.type === 'signal-offer') {
                // Ensure this offer is specifically for ME
                if (data.target === room.clientId) {
                    handleOffer(data);
                }
            } else if (data.type === 'signal-ice') {
                // Ensure this candidate is for ME
                if (data.target === room.clientId && data.candidate) {
                    const candidate = new RTCIceCandidate(data.candidate);
                    // If remote description is set, add immediately. Otherwise buffer.
                    if (hostConnection && hostConnection.remoteDescription && hostConnection.remoteDescription.type) {
                        hostConnection.addIceCandidate(candidate).catch(err => console.error("Viewer: ICE Error", err));
                    } else {
                        iceCandidateBuffer.push(candidate);
                    }
                }
            }
        }
    }
}

// 2. Host: Create Connection for a Viewer
async function createHostPeerConnection(targetClientId) {
    console.log(`Creating PC for viewer ${targetClientId}`);
    if (peerConnections[targetClientId]) peerConnections[targetClientId].close();

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnections[targetClientId] = pc;

    // Add Tracks
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    // ICE Handling
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            room.send({
                type: 'signal-ice',
                target: targetClientId,
                candidate: event.candidate,
                echo: false
            });
        }
    };

    // Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    room.send({
        type: 'signal-offer',
        target: targetClientId,
        sdp: offer,
        echo: false
    });
}

// 3. Viewer: Handle Offer
async function handleOffer(data) {
    console.log("Received Offer from Host");
    
    if (hostConnection) hostConnection.close();
    hostConnection = new RTCPeerConnection(RTC_CONFIG);
    iceCandidateBuffer = []; // Reset buffer

    // Handle Incoming Stream
    hostConnection.ontrack = (event) => {
        console.log("Received Track");
        // Robust stream assignment
        const stream = event.streams[0] || new MediaStream([event.track]);

        if (ui.video.srcObject !== stream) {
            ui.video.srcObject = stream;
            // Note: We leave the video muted to allow autoplay to work without interaction
            // ui.video.muted = false; 
            ui.placeholder.classList.remove('visible');
            
            // Explicitly play to ensure video starts
            ui.video.play().catch(e => console.log("Autoplay blocked, user interaction required:", e));
        }
    };

    // ICE Handling
    hostConnection.onicecandidate = (event) => {
        if (event.candidate) {
            room.send({
                type: 'signal-ice',
                target: data.clientId, // Send back to host
                candidate: event.candidate,
                echo: false
            });
        }
    };

    await hostConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    
    // Process any buffered candidates that arrived while setting remote description
    while (iceCandidateBuffer.length > 0) {
        hostConnection.addIceCandidate(iceCandidateBuffer.shift()).catch(e => console.error("Buffered ICE Error:", e));
    }

    const answer = await hostConnection.createAnswer();
    await hostConnection.setLocalDescription(answer);

    room.send({
        type: 'signal-answer',
        target: data.clientId,
        sdp: answer,
        echo: false
    });
}

// --- State Handlers ---

function handleRoomState(state) {
    // Info Updates
    if (state.streamTitle) ui.displayTitle.textContent = state.streamTitle;
    
    // Owner Logic: Update Controls based on state
    if (isOwner) {
        checkHostCapability();
    }

    // Check Broadcaster
    if (state.isLive && state.broadcasterId) {
        const hostPeer = room.peers[state.broadcasterId];
        if (hostPeer) {
            ui.displayHost.textContent = hostPeer.username;
            ui.displayAvatar.src = hostPeer.avatarUrl;
            ui.displayAvatar.classList.remove('hidden');
        }

        // Logic for Viewer Joining
        // If we are not the broadcaster (by ID), request join
        if (state.broadcasterId !== room.clientId && !hostConnection) {
             // Only join if host exists (not zombie)
             if (room.peers[state.broadcasterId]) {
                 console.log("Stream detected, requesting join...");
                 ui.statusText.textContent = "Joining Stream...";
                 ui.placeholder.classList.add('visible');
                 
                 if (joinTimeout) clearTimeout(joinTimeout);
                 joinTimeout = setTimeout(() => {
                     room.send({
                         type: 'join-request',
                         target: state.broadcasterId,
                         echo: false
                     });
                 }, 1000);
             }
        }
    } else {
        // Stream Ended
        if (!isBroadcasting) {
            ui.statusText.textContent = "Waiting for stream...";
            ui.placeholder.classList.add('visible');
            if (hostConnection) {
                hostConnection.close();
                hostConnection = null;
            }
            ui.video.srcObject = null;
        }
    }
}

function handlePresence(presence) {
    // Update Viewer Count
    const count = Object.keys(room.peers).length;
    ui.viewerCount.textContent = `${count} Viewer${count !== 1 ? 's' : ''}`;

    // Update Host Stats
    if (isBroadcasting) {
        const peerCount = Object.keys(peerConnections).length;
        ui.hostStats.textContent = `Peers: ${peerCount} | Streaming Active`;
    }
    
    // Owner: Check for zombie host on presence change
    if (isOwner) {
        checkHostCapability();
    }
}

// --- Chat UI ---
function addChatMessage(data) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    
    const isHost = (projectCreator && data.userId === projectCreator.id);
    
    const cleanText = DOMPurify.sanitize(data.text);
    
    div.innerHTML = `
        <span class="chat-author ${isHost ? 'host' : ''}">${DOMPurify.sanitize(data.username)}:</span>
        <span class="chat-text">${cleanText}</span>
    `;
    
    ui.chatMsgs.appendChild(div);
    ui.chatMsgs.scrollTop = ui.chatMsgs.scrollHeight;
}

function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = text;
    ui.chatMsgs.appendChild(div);
    ui.chatMsgs.scrollTop = ui.chatMsgs.scrollHeight;
}

// Start
init();