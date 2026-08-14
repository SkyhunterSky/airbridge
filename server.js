// AirBridge — zero-dependency file transfer server.
// Pure Node.js (http, crypto, fs, path, url) — no npm install required.
// Serves the static frontend, a hand-rolled WebSocket endpoint for WebRTC
// signaling, and an HTTP relay (upload/download) used as a fallback when a
// direct peer-to-peer connection can't be established.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const RELAY_DIR = path.join(__dirname, 'relay-tmp');
const TTL_MS = 30 * 60 * 1000; // auto-delete relay files after 30 minutes

if (!fs.existsSync(RELAY_DIR)) fs.mkdirSync(RELAY_DIR, { recursive: true });

// ===========================================================================
// Static file serving
// ===========================================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8'
        };

        function serveStatic(res, filename, contentType) {
        const filePath = path.join(PUBLIC_DIR, filename);
        fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
        });
        }

        // ===========================================================================
        // Relay (HTTP upload / download fallback)
        // ===========================================================================
        // rooms[code] = { files: [{id, filename, name, size, type}] }
        const rooms = {};

        function roomDir(code) {
        return path.join(RELAY_DIR, code);
        }

        function cleanupRoom(code) {
        fs.rm(roomDir(code), { recursive: true, force: true }, () => {});
        delete rooms[code];
        }

        function scheduleCleanup(code) {
        setTimeout(() => cleanupRoom(code), TTL_MS);
        }

        function safeCode(code) {
        return /^[A-Za-z0-9]{4,12}$/.test(code);
        }

        function handleUpload(req, res, code, query) {
        if (!safeCode(code)) { res.writeHead(400); return res.end('bad code'); }
        const dir = roomDir(code);
        fs.mkdirSync(dir, { recursive: true });

        const name = decodeURIComponent(query.name || 'file');
        const type = decodeURIComponent(query.type || 'application/octet-stream');
        const id = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(name);
        const filename = id + ext;
        const dest = path.join(dir, filename);

        const writeStream = fs.createWriteStream(dest);
        req.pipe(writeStream);

        req.on('error', () => { writeStream.destroy(); res.writeHead(500); res.end('upload error'); });

        writeStream.on('finish', () => {
        const size = fs.statSync(dest).size;
        if (!rooms[code]) rooms[code] = { files: [] };
        rooms[code].files.push({ id, filename, name, size, type });
        scheduleCleanup(code);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        });
        writeStream.on('error', () => { res.writeHead(500); res.end('write error'); });
        }

        function handleListFiles(res, code) {
        const room = rooms[code];
        const files = room ? room.files.map(({ id, name, size, type }) => ({ id, name, size, type })) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
        }

        function handleDownload(res, code, fileId) {
        const room = rooms[code];
        const f = room && room.files.find(x => x.id === fileId);
        if (!f) { res.writeHead(404); return res.end('Not found'); }
        const filePath = path.join(roomDir(code), f.filename);
        if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, {
        'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"`,
        'Content-Type': f.type || 'application/octet-stream',
        'Content-Length': fs.statSync(filePath).size
        });
        fs.createReadStream(filePath).pipe(res);
        }

        function handleCleanup(res, code) {
        cleanupRoom(code);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        }


        // ===========================================================================
        // HTTP server + router
        // ===========================================================================
        const server = http.createServer((req, res) => {
        const parsed = url.parse(req.url, true);
        const pathname = decodeURI(parsed.pathname);

        if (req.method === 'GET' && pathname === '/') return serveStatic(res, 'index.html', MIME['.html']);
        if (req.method === 'GET' && pathname === '/app.js') return serveStatic(res, 'app.js', MIME['.js']);

        let m;
        if (req.method === 'POST' && (m = pathname.match(/^\/api\/relay\/([A-Za-z0-9]+)\/upload$/))) {
        return handleUpload(req, res, m[1], parsed.query);
        }
        if (req.method === 'GET' && (m = pathname.match(/^\/api\/relay\/([A-Za-z0-9]+)\/files$/))) {
        return handleListFiles(res, m[1]);
        }
        if (req.method === 'GET' && (m = pathname.match(/^\/api\/relay\/([A-Za-z0-9]+)\/file\/([a-f0-9]+)$/))) {
        return handleDownload(res, m[1], m[2]);
        }
        if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/relay\/([A-Za-z0-9]+)$/))) {
        return handleCleanup(res, m[1]);
        }

        res.writeHead(404);
        res.end('Not found');
        });

        // ===========================================================================
        // Minimal WebSocket server (RFC 6455) — used only for WebRTC signaling.
        // No fragmentation support needed: browsers send our small JSON control
        // messages as single unfragmented text frames.
        // ===========================================================================
        const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
        const wsRooms = new Map(); // code -> Set<socket>

        function wsBroadcast(code, obj, exceptSocket) {
        const set = wsRooms.get(code);
        if (!set) return;
        const payload = Buffer.from(JSON.stringify(obj), 'utf8');
        for (const sock of set) {
        if (sock !== exceptSocket && !sock.destroyed) sendFrame(sock, payload, 0x1);
        }
        }

        function wsSend(socket, obj) {
        sendFrame(socket, Buffer.from(JSON.stringify(obj), 'utf8'), 0x1);
        }

        function sendFrame(socket, payload, opcode) {
        if (socket.destroyed) return;
        const len = payload.length;
        let header;
        if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
        } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
        } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(len, 6);
        }
        try { socket.write(Buffer.concat([header, payload])); } catch (e) {}
        }

        function processBuffer(socket) {
        while (true) {
        const buf = socket._wsBuffer;
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const opcode = b0 & 0x0f;
        const masked = !!(b1 & 0x80);
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
        } else if (len === 127) {
        if (buf.length < 10) return;
        len = buf.readUInt32BE(6); // assume payload fits in 32 bits
        offset = 10;
        }
        let maskKey = null;
        if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
        }
        if (buf.length < offset + len) return; // wait for more data
        let payload = buf.slice(offset, offset + len);
        if (masked) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
        }
        socket._wsBuffer = buf.slice(offset + len);

        if (opcode === 0x8) { // close
        socket.end();
        return;
        } else if (opcode === 0x9) { // ping -> pong
        sendFrame(socket, payload, 0xA);
        } else if (opcode === 0x1) { // text
        onWsMessage(socket, payload.toString('utf8'));
        }
        // binary/pong frames are not used by this app
        }
        }

        function onWsMessage(socket, text) {
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        if (!msg || !msg.type) return;

        if (msg.type === 'join') {
        const code = msg.code;
        if (!code) return;
        socket._room = code;
        if (!wsRooms.has(code)) wsRooms.set(code, new Set());
        const set = wsRooms.get(code);
        const peerCount = set.size;
        set.add(socket);
        wsSend(socket, { type: 'joined', code, peerCount });
        wsBroadcast(code, { type: 'peer-joined' }, socket);
        } else if (msg.type === 'signal') {
        if (!msg.code) return;
        wsBroadcast(msg.code, { type: 'signal', data: msg.data }, socket);
        } else if (msg.type === 'relay-done') {
        const code = msg.code;
        const room = rooms[code];
        const files = room ? room.files.map(({ id, name, size, type }) => ({ id, name, size, type })) : [];
        wsBroadcast(code, { type: 'relay-ready', files }, null);
        }
        }

        function onWsClose(socket) {
        if (socket._room && wsRooms.has(socket._room)) {
        const set = wsRooms.get(socket._room);
        set.delete(socket);
        if (set.size === 0) wsRooms.delete(socket._room);
        else wsBroadcast(socket._room, { type: 'peer-left' }, null);
        }
        }

        server.on('upgrade', (req, socket) => {
        if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
        const key = req.headers['sec-websocket-key'];
        if (!key) { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
        socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        socket._wsBuffer = Buffer.alloc(0);
        socket.on('data', chunk => {
        socket._wsBuffer = Buffer.concat([socket._wsBuffer, chunk]);
        try { processBuffer(socket); } catch (e) { socket.destroy(); }
        });
        socket.on('close', () => onWsClose(socket));
        socket.on('error', () => {});
        });

        server.listen(PORT, () => {
        console.log(`AirBridge listening on http://localhost:${PORT}`);
        });
        
