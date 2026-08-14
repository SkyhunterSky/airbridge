(() => {
'use strict';

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const screens = ['screen-home', 'screen-send-pick', 'screen-send-wait', 'screen-recv-join', 'screen-recv-wait'];
function showScreen(id) {
screens.forEach(s => $(s).classList.toggle('hidden', s !== id));
}
function fmtBytes(n) {
if (n < 1024) return n + ' B';
if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function genCode() {
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const ICE_SERVERS = [
{ urls: 'stun:stun.l.google.com:19302' },
{ urls: 'stun:stun1.l.google.com:19302' }
];
const CHUNK_SIZE = 16 * 1024;
const P2P_TIMEOUT_MS = 9000;
const BACKPRESSURE_LIMIT = 8 * 1024 * 1024;

// ---------- tiny WebSocket shim with a socket.io-like on/off/emit API ----------
let socket = null;
function ensureSocket() {
if (socket) return socket;
const listeners = {};
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);
const shim = {
emit(type, payload) {
const msg = Object.assign({ type }, payload || {});
const send = () => ws.send(JSON.stringify(msg));
if (ws.readyState === WebSocket.OPEN) send();
else ws.addEventListener('open', send, { once: true });
},
on(type, cb) {
listeners[type] = listeners[type] || [];
listeners[type].push(cb);
},
off(type) {
delete listeners[type];
}
};
ws.onmessage = evt => {
let msg;
try { msg = JSON.parse(evt.data); } catch (e) { return; }
(listeners[msg.type] || []).forEach(cb => cb(msg));
};
socket = shim;
return socket;
}

// =====================================================================
// HOME
// =====================================================================
$('btnSend').onclick = () => { resetSendState(); showScreen('screen-send-pick'); };
$('btnReceive').onclick = () => { resetRecvState(); showScreen('screen-recv-join'); };
$('backFromPick').onclick = () => showScreen('screen-home');
$('backFromJoin').onclick = () => showScreen('screen-home');

// =====================================================================
// SEND FLOW
// =====================================================================
let selectedFiles = [];
let sendCode = null;
let sendPC = null;
let sendDC = null;
let usingRelay = false;
let p2pTimer = null;
let p2pSucceeded = false;

function resetSendState() {
selectedFiles = [];
sendCode = null;
usingRelay = false;
p2pSucceeded = false;
if (p2pTimer) clearTimeout(p2pTimer);
if (sendPC) { try { sendPC.close(); } catch (e) {} }
sendPC = null; sendDC = null;
$('fileList').innerHTML = '';
$('fileInput').value = '';
$('btnStartSend').disabled = true;
$('sendProgress').classList.add('hidden');
$('sendProgress').innerHTML = '';
$('qrbox').innerHTML = '';
}

$('filepick').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
selectedFiles = Array.from(e.target.files);
const list = $('fileList');
list.innerHTML = '';
selectedFiles.forEach(f => {
const row = document.createElement('div');
row.innerHTML = `<span>${f.name}</span><span>${fmtBytes(f.size)}</span>`;
list.appendChild(row);
});
$('btnStartSend').disabled = selectedFiles.length === 0;
};

$('btnStartSend').onclick = () => {
sendCode = genCode();
$('sendCode').textContent = sendCode;
const url = `${location.origin}/?code=${sendCode}`;
$('qrbox').innerHTML = '';
new QRCode($('qrbox'), { text: url, width: 176, height: 176, correctLevel: QRCode.CorrectLevel.M });
$('sendDot').className = 'dot active';
$('sendStatusText').textContent = 'Waiting for the other device to join...';
showScreen('screen-send-wait');

const s = ensureSocket();
s.emit('join', { code: sendCode });
s.off('peer-joined');
s.on('peer-joined', () => startP2PAsSender());
s.off('signal');
s.on('signal', async ({ data }) => {
if (!sendPC) return;
if (data.type === 'answer') {
await sendPC.setRemoteDescription(new RTCSessionDescription(data));
} else if (data.candidate) {
try { await sendPC.addIceCandidate(data.candidate); } catch (e) {}
}
});
};

async function startP2PAsSender() {
if (sendPC) return; // already attempting
$('sendStatusText').textContent = 'Other device joined. Trying a direct connection...';
sendPC = new RTCPeerConnection({ iceServers: ICE_SERVERS });
sendPC.onicecandidate = e => {
if (e.candidate) socket.emit('signal', { code: sendCode, data: { candidate: e.candidate } });
};

sendDC = sendPC.createDataChannel('files');
sendDC.binaryType = 'arraybuffer';
sendDC.onopen = () => {
if (usingRelay) return; // already fell back, ignore late connection
p2pSucceeded = true;
if (p2pTimer) clearTimeout(p2pTimer);
sendViaP2P();
};

p2pTimer = setTimeout(() => {
if (!p2pSucceeded) fallbackToRelay();
}, P2P_TIMEOUT_MS);

const offer = await sendPC.createOffer();
await sendPC.setLocalDescription(offer);
socket.emit('signal', { code: sendCode, data: offer });
}

function buildProgressUI(container, files) {
container.innerHTML = '';
container.classList.remove('hidden');
files.forEach((f, i) => {
const item = document.createElement('div');
item.className = 'progress-item';
item.innerHTML = `
<div class="meta"><span>${f.name}</span><span id="pct-${i}">0%</span></div>
<div class="bar-track"><div class="bar-fill" id="bar-${i}"></div></div>`;
container.appendChild(item);
});
}

async function sendViaP2P() {
const tag = document.createElement('div');
tag.className = 'tag p2p';
tag.textContent = 'DIRECT CONNECTION';
$('sendStatusText').parentElement.before(tag);
$('sendDot').className = 'dot good';
$('sendStatusText').textContent = 'Sending directly, device to device...';
buildProgressUI($('sendProgress'), selectedFiles);

for (let i = 0; i < selectedFiles.length; i++) {
const file = selectedFiles[i];
sendDC.send(JSON.stringify({ type: 'meta', index: i, total: selectedFiles.length, name: file.name, size: file.size, mime: file.type }));
let offset = 0;
while (offset < file.size) {
const slice = file.slice(offset, offset + CHUNK_SIZE);
const buf = await slice.arrayBuffer();
while (sendDC.bufferedAmount > BACKPRESSURE_LIMIT) {
await new Promise(r => setTimeout(r, 30));
}
sendDC.send(buf);
offset += buf.byteLength;
const pct = Math.round((offset / file.size) * 100);
$(`bar-${i}`).style.width = pct + '%';
$(`pct-${i}`).textContent = pct + '%';
}
sendDC.send(JSON.stringify({ type: 'file-end', index: i }));
}
sendDC.send(JSON.stringify({ type: 'all-done' }));
$('sendStatusText').textContent = 'All files sent!';
}

function fallbackToRelay() {
if (usingRelay) return;
usingRelay = true;
const tag = document.createElement('div');
tag.className = 'tag relay';
tag.textContent = 'SERVER RELAY (DIRECT CONNECTION UNAVAILABLE)';
$('sendStatusText').parentElement.before(tag);
$('sendDot').className = 'dot warn';
$('sendStatusText').textContent = 'Uploading via server...';
buildProgressUI($('sendProgress'), selectedFiles);
uploadFilesSequentially(0);
}

function uploadFilesSequentially(index) {
if (index >= selectedFiles.length) {
socket.emit('relay-done', { code: sendCode });
$('sendStatusText').textContent = 'Uploaded. Waiting for the other device to download...';
return;
}
const file = selectedFiles[index];
const qs = `name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || 'application/octet-stream')}`;
const xhr = new XMLHttpRequest();
xhr.open('POST', `/api/relay/${sendCode}/upload?${qs}`);
xhr.upload.onprogress = e => {
if (!e.lengthComputable) return;
const pct = Math.round((e.loaded / e.total) * 100);
$(`bar-${index}`).style.width = pct + '%';
$(`pct-${index}`).textContent = pct + '%';
};
xhr.onload = () => {
if (xhr.status >= 200 && xhr.status < 300) {
uploadFilesSequentially(index + 1);
} else {
$('sendStatusText').textContent = `Upload failed for ${file.name}.`;
}
};
xhr.onerror = () => {
$('sendStatusText').textContent = `Upload failed for ${file.name}. Check your connection and try again.`;
};
xhr.send(file);
}

$('cancelSend').onclick = () => {
if (sendCode) fetch(`/api/relay/${sendCode}`, { method: 'DELETE' }).catch(() => {});
resetSendState();
showScreen('screen-home');
};

// =====================================================================
// RECEIVE FLOW
// =====================================================================
let recvCode = null;
let recvPC = null;
let recvChunks = [];
let recvMeta = null;
let recvReceived = 0;
let relayShown = false;
let p2pAllDone = false;

function resetRecvState() {
recvCode = null;
recvChunks = [];
recvMeta = null;
recvReceived = 0;
relayShown = false;
p2pAllDone = false;
if (recvPC) { try { recvPC.close(); } catch (e) {} }
recvPC = null;
$('codeInput').value = '';
$('recvProgress').classList.add('hidden');
$('recvProgress').innerHTML = '';
$('recvFiles').innerHTML = '';
}

$('btnJoin').onclick = () => joinRoom($('codeInput').value.trim().toUpperCase());

function joinRoom(code) {
if (!code || code.length < 4) return;
recvCode = code;
showScreen('screen-recv-wait');
$('recvStatusText').textContent = 'Connected. Waiting for sender to start...';

const s = ensureSocket();
s.emit('join', { code });

s.off('signal');
s.on('signal', async ({ data }) => {
if (data.type === 'offer') {
recvPC = new RTCPeerConnection({ iceServers: ICE_SERVERS });
recvPC.onicecandidate = e => {
if (e.candidate) socket.emit('signal', { code: recvCode, data: { candidate: e.candidate } });
};
recvPC.ondatachannel = ev => setupReceiveChannel(ev.channel);
await recvPC.setRemoteDescription(new RTCSessionDescription(data));
const answer = await recvPC.createAnswer();
await recvPC.setLocalDescription(answer);
socket.emit('signal', { code: recvCode, data: answer });
} else if (data.candidate && recvPC) {
try { await recvPC.addIceCandidate(data.candidate); } catch (e) {}
}
});

s.off('relay-ready');
s.on('relay-ready', ({ files }) => {
if (p2pAllDone) return; // already got everything via P2P
relayShown = true;
const tag = document.createElement('div');
tag.className = 'tag relay';
tag.textContent = 'SERVER RELAY';
$('recvStatusText').parentElement.before(tag);
$('recvDot').className = 'dot warn';
$('recvStatusText').textContent = 'Files ready - tap to download.';
files.forEach(f => {
const row = document.createElement('div');
row.className = 'received-item';
row.innerHTML = `<div><div class="name">${f.name}</div><div class="size">${fmtBytes(f.size)}</div></div>
<a href="/api/relay/${recvCode}/file/${f.id}" download="${f.name}">Download</a>`;
$('recvFiles').appendChild(row);
});
});
}

function setupReceiveChannel(dc) {
dc.binaryType = 'arraybuffer';
const tag = document.createElement('div');
tag.className = 'tag p2p';
tag.textContent = 'DIRECT CONNECTION';
dc.onopen = () => {
if (relayShown) return;
$('recvStatusText').parentElement.before(tag);
$('recvDot').className = 'dot good';
$('recvStatusText').textContent = 'Receiving files directly from sender...';
$('recvProgress').classList.remove('hidden');
};
dc.onmessage = evt => {
if (typeof evt.data === 'string') {
const msg = JSON.parse(evt.data);
if (msg.type === 'meta') {
recvMeta = msg;
recvChunks = [];
recvReceived = 0;
$('recvProgress').innerHTML = `
<div class="progress-item">
<div class="meta"><span>${msg.name}</span><span id="rpct">0%</span></div>
<div class="bar-track"><div class="bar-fill" id="rbar"></div></div>
</div>`;
} else if (msg.type === 'file-end') {
const blob = new Blob(recvChunks, { type: recvMeta.mime || 'application/octet-stream' });
const url = URL.createObjectURL(blob);
const row = document.createElement('div');
row.className = 'received-item';
row.innerHTML = `<div><div class="name">${recvMeta.name}</div><div class="size">${fmtBytes(recvMeta.size)}</div></div>
<a href="${url}" download="${recvMeta.name}">Save</a>`;
$('recvFiles').appendChild(row);
recvChunks = [];
} else if (msg.type === 'all-done') {
p2pAllDone = true;
$('recvStatusText').textContent = 'All files received!';
$('recvProgress').classList.add('hidden');
}
} else {
recvChunks.push(evt.data);
recvReceived += evt.data.byteLength;
if (recvMeta) {
const pct = Math.round((recvReceived / recvMeta.size) * 100);
const bar = $('rbar'); const pctEl = $('rpct');
if (bar) bar.style.width = pct + '%';
if (pctEl) pctEl.textContent = pct + '%';
}
}
};
}

$('cancelRecv').onclick = () => { resetRecvState(); showScreen('screen-home'); };

// =====================================================================
// Deep link: ?code=XXXXXX opens straight into receive+join
// =====================================================================
const params = new URLSearchParams(location.search);
const urlCode = params.get('code');
if (urlCode) {
resetRecvState();
$('codeInput').value = urlCode.toUpperCase();
showScreen('screen-recv-join');
} else {
showScreen('screen-home');
}
})();
