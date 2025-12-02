export class TestSuite {
    constructor(room, ui) {
        this.room = room;
        this.ui = ui;

        this.role = 'peer';
        this.hostId = null;
        this.peerStats = {}; // Tracking incoming traffic as Host
        
        // Aggregate RX for Host Dashboard
        this.aggregateRx = { bytes: 0, count: 0 };

        // Latency & Jitter
        this.latencyRunning = false;
        this.latencyInterval = null;
        this.prevRtt = 0;
        this.jitter = 0;

        // Throughput
        this.throughputRunning = false;
        this.throughputInterval = null;
        this.throughputStats = { sent: 0, bytes: 0, startTime: 0 };
        this.payloadSize = 100;

        // Incoming Metrics
        this.rxCount = 0;
        this.lastRxCheck = Date.now();
        
        // Convergence
        this.convergenceStart = 0;
        this.convergenceKey = null;

        // Setup Listeners
        this.room.onmessage = (e) => this.handleMessage(e);
        
        // Start background monitor
        this.startBackgroundMonitor();
    }

    updateTopology(role, hostId) {
        this.role = role;
        this.hostId = hostId;
        // Reset aggregates on role change
        this.aggregateRx = { bytes: 0, count: 0 };
    }

    broadcastLog(msg, type='system') {
        const username = this.room.peers[this.room.clientId]?.username || 'Me';
        this.ui.logLatency(`${msg}`, type); // Local log
        
        this.room.send({
            type: 'sys-log',
            message: msg,
            logType: type,
            senderName: username,
            echo: false
        });
    }

    handleMessage(e) {
        const data = e.data;
        const now = performance.now();

        // 0. System Log Sync
        if (data.type === 'sys-log') {
            const senderName = data.senderName || 'Unknown';
            this.ui.logLatency(`[${senderName}] ${data.message}`, data.logType || 'info');
            return;
        }

        // 1. Latency: P2P Ping (Host Side Logic)
        if (data.type === 'p2p-ping' && data.target === this.room.clientId) {
            this.room.send({
                type: 'p2p-pong',
                target: data.sender,
                pingTimestamp: data.timestamp,
                echo: false
            });
            // Visual feedback for host - aggregate to dashboard
            this.aggregateRx.count++; 
        }

        // 2. Latency: P2P Pong (Peer Side Logic)
        if (data.type === 'p2p-pong' && data.target === this.room.clientId) {
            const rtt = now - data.pingTimestamp;
            this.ui.updateDashboardMetric('p2p-rtt', rtt.toFixed(0));
            this.ui.logLatency(`P2P RTT (via Host): ${rtt.toFixed(2)}ms`, 'success');
            // We use this RTT for the chart if we are in P2P mode
            this.ui.recordChartData(rtt);
        }

        // 3. Throughput: Load Packet (Host Side Logic)
        if (data.type === 'throughput-load' && data.target === this.room.clientId) {
            // Rough estimation of payload size including overhead
            const approxSize = data.payload ? data.payload.length + 50 : 50;
            this.trackPeerTraffic(data.sender, approxSize);
        }

        // 4. Throughput: Stats Report (Peer Side Logic)
        if (data.type === 'throughput-report' && data.target === this.room.clientId) {
            this.ui.updateDashboardMetric('host-rx', data.kbps);
        }

        // Handle Standard Echo Latency Pings (Fallback / Self Test)
        if (data.type === 'test-ping' && data.sender === this.room.clientId) {
            const rtt = now - data.timestamp;
            
            // Calculate Jitter (RFC 1889ish simplified)
            // J = J + (|RTT - prevRTT| - J) / 16
            const diff = Math.abs(rtt - this.prevRtt);
            this.jitter += (diff - this.jitter) / 16;
            this.prevRtt = rtt;

            this.ui.logLatency(`Server RTT: ${rtt.toFixed(2)}ms | Jitter: ${this.jitter.toFixed(2)}ms`);
            this.ui.updateDashboardMetric('ping', rtt.toFixed(0));
            this.ui.updateDashboardMetric('jitter', this.jitter.toFixed(1));
            
            // Only chart server RTT if not doing P2P
            if (!this.hostId) this.ui.recordChartData(rtt);
        }
    }

    trackPeerTraffic(senderId, bytes) {
        // Global Host Aggregate
        this.aggregateRx.bytes += bytes;
        this.aggregateRx.count++;

        if (!this.peerStats[senderId]) {
            this.peerStats[senderId] = { bytes: 0, count: 0, lastReport: Date.now() };
        }
        const stats = this.peerStats[senderId];
        stats.bytes += bytes;
        stats.count++;

        const now = Date.now();
        if (now - stats.lastReport > 1000) {
            // Send report back to peer
            const elapsed = (now - stats.lastReport) / 1000;
            const kbps = ((stats.bytes / 1024) / elapsed).toFixed(1);
            const pps = Math.round(stats.count / elapsed);
            
            this.room.send({
                type: 'throughput-report',
                target: senderId,
                kbps,
                pps,
                echo: false
            });
            
            // NOTE: We rely on startBackgroundMonitor to update the dashboard 'rx' metrics
            // to avoid overwriting values from other peers.
            
            // Reset
            stats.bytes = 0;
            stats.count = 0;
            stats.lastReport = now;
        }
    }

    startBackgroundMonitor() {
        // Monitor RX Rate (Incoming updates)
        setInterval(() => {
            const now = Date.now();
            const elapsed = (now - this.lastRxCheck) / 1000;
            
            if (elapsed >= 1) {
                // 1. Calculated Aggregate RX (From throughput/latency tests)
                if (this.aggregateRx.count > 0) {
                    const rxRate = Math.round(this.aggregateRx.count / elapsed);
                    const rxKbps = ((this.aggregateRx.bytes / 1024) / elapsed).toFixed(1);
                    
                    this.ui.updateDashboardMetric('rx', rxRate); // PPS
                    this.ui.updateDashboardMetric('host-rx', rxKbps); // KB/s
                    
                    // Reset
                    this.aggregateRx = { bytes: 0, count: 0 };
                } else if (this.rxCount > 0) {
                     // Fallback to generic background noise if no test traffic
                     const rxRate = Math.round(this.rxCount / elapsed);
                     this.ui.updateDashboardMetric('rx', rxRate);
                     this.ui.updateDashboardMetric('host-rx', 0);
                } else {
                     this.ui.updateDashboardMetric('rx', 0);
                     this.ui.updateDashboardMetric('host-rx', 0);
                }

                this.rxCount = 0;
                this.lastRxCheck = now;
            }
        }, 1000);
    }

    // Called by app when presence updates arrive
    onPresenceUpdate() {
        // Removed generic RX count here to focus on test traffic, or keep it for background noise?
        // Let's keep it for general noise monitoring
        this.rxCount++;
    }

    // Called by app when room state updates arrive
    onRoomStateUpdate(state) {
        // Check for convergence test key
        if (this.convergenceKey && state[this.convergenceKey]) {
            const end = performance.now();
            const duration = end - this.convergenceStart;
            
            this.ui.updateDashboardMetric('conv', duration.toFixed(0));
            this.ui.logLatency(`Convergence Confirmation: ${duration.toFixed(2)}ms`, 'success');
            
            // Cleanup
            this.room.updateRoomState({ [this.convergenceKey]: null });
            this.convergenceKey = null;
        }
    }

    // --- Latency Test ---
    startLatencyTest() {
        if (this.latencyRunning) return;
        this.latencyRunning = true;
        this.broadcastLog("Starting Latency Test (5 pings/sec)", "system");
        
        // Reset jitter
        this.jitter = 0;
        this.prevRtt = 0;

        this.latencyInterval = setInterval(() => {
            if (this.hostId && this.role === 'peer') {
                // P2P Mode
                this.room.send({
                    type: 'p2p-ping',
                    target: this.hostId,
                    sender: this.room.clientId,
                    timestamp: performance.now(),
                    echo: false 
                });
            } else {
                // Echo Mode
                this.room.send({
                    type: 'test-ping',
                    timestamp: performance.now(),
                    sender: this.room.clientId,
                    echo: true 
                });
            }
        }, 200);
    }

    stopLatencyTest() {
        this.latencyRunning = false;
        clearInterval(this.latencyInterval);
        this.broadcastLog("Stopped Latency Test", "system");
        this.ui.updateDashboardMetric('p2p-rtt', '--');
    }

    // --- Throughput Test ---
    startThroughputTest(sizeBytes, intervalMs) {
        if (this.throughputRunning) return;
        this.throughputRunning = true;
        this.throughputStats = { sent: 0, bytes: 0, startTime: Date.now() };

        this.broadcastLog(`Starting Throughput Load: ${sizeBytes}B @ ${intervalMs}ms`, "warning");

        // Create junk payload
        const filler = "X".repeat(Math.max(0, sizeBytes - 50)); // -50 for overhead

        this.throughputInterval = setInterval(() => {
            if (!this.throughputRunning) return;

            // Update presence or Send Event?
            // Switching to Event for P2P routing control
            
            if (this.hostId && this.role === 'peer') {
                this.room.send({
                    type: 'throughput-load',
                    target: this.hostId,
                    sender: this.room.clientId,
                    payload: filler,
                    echo: false
                });
            } else {
                // Fallback / Broadcast Load
                // We use presence here if no specific host, to stress test everyone
                this.room.updatePresence({
                    test_mode: 'throughput',
                    timestamp: Date.now(),
                    payload: filler
                });
            }

            // Update Stats
            this.throughputStats.sent++;
            this.throughputStats.bytes += sizeBytes;

            const elapsedSec = (Date.now() - this.throughputStats.startTime) / 1000;
            const pps = Math.round(this.throughputStats.sent / elapsedSec);
            const kbps = ((this.throughputStats.bytes / 1024) / elapsedSec).toFixed(1);
            const totalMb = (this.throughputStats.bytes / 1024 / 1024).toFixed(2);

            this.ui.updateThroughputStats({ pps, kbps, totalMb });
            this.ui.updateDashboardMetric('pps', pps);
            this.ui.updateDashboardMetric('bw', kbps);
        }, intervalMs);
    }

    stopThroughputTest() {
        this.throughputRunning = false;
        clearInterval(this.throughputInterval);
        // Clean up presence just in case we used it
        this.room.updatePresence({ test_mode: null, payload: null });
        
        this.broadcastLog("Stopped Throughput Test", "system");

        this.ui.updateThroughputStats(null);
        this.ui.updateDashboardMetric('pps', 0);
        this.ui.updateDashboardMetric('bw', 0);
        this.ui.updateDashboardMetric('host-rx', 0);
    }

    // --- Stress Test (Room State) ---
    async runConvergenceTest() {
        if (this.convergenceKey) return; // Already running
        
        const key = `conv_test_${this.room.clientId}_${Date.now()}`;
        this.convergenceKey = key;
        this.convergenceStart = performance.now();
        
        this.broadcastLog("Starting State Convergence Test...", "system");
        
        // Trigger update
        this.room.updateRoomState({
            [key]: { timestamp: Date.now() }
        });
    }

    async addStressObjects(count) {
        this.broadcastLog(`Adding ${count} stress objects to Room State`, "warning");
        const batch = {};
        const prefix = `stress_${this.room.clientId}_${Date.now()}_`;

        for (let i = 0; i < count; i++) {
            batch[`${prefix}${i}`] = {
                x: Math.random() * 1000,
                y: Math.random() * 1000,
                color: '#' + Math.floor(Math.random()*16777215).toString(16),
                updated: Date.now()
            };
        }

        // Note: Sending huge objects in one go might hit WebSocket frame limits.
        // Websim handles reasonably large JSONs, but let's see.
        this.room.updateRoomState({
            stress_objects: {
                ...(this.room.roomState.stress_objects || {}),
                ...batch
            }
        });
    }

    clearStressObjects() {
        this.broadcastLog("Clearing all stress objects", "danger");
        // To delete, we set keys to null, or set the parent key to null if we want to wipe it all
        // Ideally we wipe the specific keys we created, but for a stress test, let's nuke the collection
        this.room.updateRoomState({
            stress_objects: null
        });
    }
}