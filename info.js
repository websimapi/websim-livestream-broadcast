export const systemInfoHTML = `
    <h2>Realtime System Architecture & Limits</h2>
    
    <h3>1. Topology & Mechanism</h3>
    <p>
        The WebsimSocket system utilizes a <strong>Relayed Mesh</strong> topology. 
        While it simulates a peer-to-peer environment (where everyone sees everyone's state), 
        all traffic is routed through a central WebSocket server.
    </p>
    <ul>
        <li><strong>Eventual Consistency:</strong> State updates are not atomic transactions. Client A sends an update, Server relays it, Client B receives it. Conflicts are usually last-write-wins based on server arrival time.</li>
        <li><strong>Protocol:</strong> JSON over Secure WebSockets (WSS).</li>
    </ul>

    <h3>2. Stability Thresholds (Estimates)</h3>
    <p>Based on standard browser WebSocket implementations and single-threaded JS parsing:</p>
    <ul>
        <li><strong>Stable Peers:</strong> 20-30 active peers sending 10 updates/second (Game Loop frequency) is generally smooth.</li>
        <li><strong>Degraded Peers:</strong> 50+ peers. You will likely experience "Rubber-banding" as the main thread struggles to parse 50 incoming JSON packets every 100ms.</li>
        <li><strong>Maximum Theoretical Peers:</strong> ~100-200. At this level, the system functions as a chat room, but real-time movement will lag significantly. The bottleneck is client-side JSON parsing and rendering, not necessarily the server bandwidth.</li>
    </ul>

    <h3>3. Data Constraints</h3>
    <ul>
        <li><strong>Room State:</strong> Shared global state. Do not use Arrays; use Objects/Dictionaries. Arrays merge poorly in realtime systems. Large state objects (>1MB) will cause noticeable hitches when updated.</li>
        <li><strong>Presence:</strong> Ephemeral. Ideal for cursors, avatars, and high-frequency data. If a client disconnects, their presence is automatically garbage collected.</li>
        <li><strong>Events:</strong> Fire-and-forget. Not guaranteed to arrive in order, or at all if the network hiccups. Use for sounds/particles, never for game logic (like "Player Died").</li>
    </ul>

    <h3>4. Testing Methodology</h3>
    <p>
        To truly determine the "Maximum Number of Peers", you cannot use a single client. 
        <strong>Open this URL in 10-20 separate tabs</strong>. 
        Use the "Throughput" tool in each tab to simulate load, then watch the "Latency" tab in your main window to see how RTT degrades as node count increases.
    </p>

    <h3>5. Analyzing Results</h3>
    <div class="analysis-grid">
        <div class="analysis-item">
            <h4>Jitter (Stability)</h4>
            <p>
                <strong>Ideal:</strong> &lt; 10ms<br>
                <strong>Poor:</strong> &gt; 50ms<br>
                High jitter means the WebSocket event loop is blocked. If this spikes during the "Stress" or "Throughput" tests, the browser's main thread is struggling to serialize/deserialize the JSON volume.
            </p>
        </div>
        <div class="analysis-item">
            <h4>State Convergence</h4>
            <p>
                <strong>Ideal:</strong> ~= RTT (Round Trip Time)<br>
                <strong>Poor:</strong> &gt; 2x RTT<br>
                This measures the time it takes for a Room State change (e.g., picking up an item) to travel to the server and back to you. If this is high, players will see "ghost items" that they can't pick up because the server hasn't confirmed the removal yet.
            </p>
        </div>
        <div class="analysis-item">
            <h4>RX Rate (Incoming Updates)</h4>
            <p>
                This metric shows how many Presence updates your client is processing per second from <em>other</em> peers.
                <br><strong>Formula:</strong> <code>N_Peers * N_Updates_Per_Sec</code>.
                <br>If you have 10 peers sending 10 updates/s, you should see ~100 RX/s. If this number drops while peers are constant, the network is dropping packets or the client is throttled.
            </p>
        </div>
    </div>
`;

