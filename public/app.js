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
  // 64KB chunks (up from 16KB): fewer send()/await round-trips per file means
  // less per-chunk overhead, which matters most on mobile — this alone
  // noticeably speeds up multi-minute video transfers.
  const CHUNK_SIZE = 64 * 1024;
  const P2P_TIMEOUT_MS = 9000;
  // High/low water marks for datachannel backpressure. We let the buffer
  // fill up to BACKPRESSURE_HIGH before pausing, then resume the instant the
  // browser fires 'bufferedamountlow' (buffer back under BACKPRESSURE_LOW) —
  // event-driven, instead of the old fixed 30ms poll loop which could leave
  // the channel idle for stretches even after it was ready for more data.
  const BACKPRESSURE_HIGH = 16 * 1024 * 1024;
  const BACKPRESSURE_LOW = 1 * 1024 * 1024;

  function waitForBufferedAmountLow(dc) {
    if (dc.bufferedAmount <= BACKPRESSURE_HIGH) return Promise.resolve();
    return new Promise(resolve => {
      dc.bufferedAmountLowThreshold = BACKPRESSURE_LOW;
      // 'bufferedamountlow' only fires on a future transition across the
      // threshold — if the buffer already drained below it by the time we
      // set it (between the check above and here), no event will ever come
      // and we'd hang forever. Re-check once more before committing to the
      // event wait.
      if (dc.bufferedAmount <= BACKPRESSURE_LOW) { resolve(); return; }
      const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); resolve(); };
      dc.addEventListener('bufferedamountlow', onLow);
    });
  }

  // ---------- elapsed-time stopwatch (used on both wait/transfer screens) ----------
  function fmtElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function makeStopwatch(elementId) {
    let handle = null, start = null;
    return {
      start() {
        this.stop();
        start = Date.now();
        const el = $(elementId);
        if (el) el.textContent = '0:00';
        handle = setInterval(() => {
          const el2 = $(elementId);
          if (el2) el2.textContent = fmtElapsed(Date.now() - start);
        }, 1000);
      },
      stop() {
        if (handle) clearInterval(handle);
        handle = null;
      },
      reset() {
        this.stop();
        const el = $(elementId);
        if (el) el.textContent = '0:00';
      }
    };
  }
  const sendStopwatch = makeStopwatch('sendElapsed');
  const recvStopwatch = makeStopwatch('recvElapsed');

  // ---------- toast popup (e.g. "both devices connected") ----------
  let toastTimer = null;
  function showToast(message) {
    const el = $('toast');
    const txt = $('toastText');
    if (!el || !txt) return;
    txt.textContent = message;
    el.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
  }

  const FILE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  const DOWNLOAD_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';

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

  // #fileInput is restricted to accept="image/*,video/*". On iOS/Android this
  // makes the browser open the lightweight native media picker (PHPicker /
  // Android Photo Picker) directly, instead of the generic "Photo Library /
  // Take Photo / Browse" action sheet — that generic sheet, and the
  // full file-system browser behind "Browse", are what make attaching feel
  // slow even for small files. #fileInputOther (no accept restriction) is a
  // fallback for anything that isn't a photo or video.
  //
  // Even with the fast picker, large/iCloud videos can still take a moment
  // to hand back to the page, with zero native progress feedback — that
  // looks exactly like the page is frozen. This block shows a "preparing"
  // state as soon as the browser returns focus to the tab, and a reassuring
  // note if it's still not resolved a few seconds later — and gives up
  // automatically so the UI never stays stuck if the user cancels instead.
  let pickerPending = false;
  let pickerFocusTimer = null;
  let pickerNoteTimer = null;
  let pickerGiveUpTimer = null;

  function clearPickerProcessingUI() {
    pickerPending = false;
    if (pickerFocusTimer) clearTimeout(pickerFocusTimer);
    if (pickerNoteTimer) clearTimeout(pickerNoteTimer);
    if (pickerGiveUpTimer) clearTimeout(pickerGiveUpTimer);
    $('filepick').classList.remove('processing');
    $('filepickHint').textContent = 'Tap to choose photos or videos';
    $('filepickSubhint').textContent = 'Opens the fast picker';
    $('filepickNote').classList.remove('visible');
  }

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
    $('fileInputOther').value = '';
    $('btnStartSend').disabled = true;
    $('sendProgress').classList.add('hidden');
    $('sendProgress').innerHTML = '';
    $('qrbox').innerHTML = '';
    sendStopwatch.reset();
    clearPickerProcessingUI();
  }

  function openPicker(input) {
    pickerPending = true;
    input.click();
  }

  $('filepick').onclick = () => openPicker($('fileInput'));
  $('chooseOtherLink').onclick = () => openPicker($('fileInputOther'));

  // The tab loses focus while the native picker is open and regains it once
  // the user finishes (picks a file OR cancels). If onchange hasn't already
  // fired by then, the browser is still processing the selection.
  window.addEventListener('focus', () => {
    if (!pickerPending) return;
    if (pickerFocusTimer) clearTimeout(pickerFocusTimer);
    pickerFocusTimer = setTimeout(() => {
      if (!pickerPending) return; // onchange already resolved it
      $('filepick').classList.add('processing');
      $('filepickHint').textContent = 'Preparing your file…';
      $('filepickSubhint').textContent = 'Hang tight, this can take a moment';
      pickerNoteTimer = setTimeout(() => {
        if (pickerPending) $('filepickNote').classList.add('visible');
      }, 6000);
      // If the user actually cancelled the picker, no onchange will ever
      // fire — don't leave the UI stuck in "preparing" forever.
      pickerGiveUpTimer = setTimeout(() => {
        if (pickerPending) clearPickerProcessingUI();
      }, 120000);
    }, 400); // short grace period so a fast pick never flashes this state
  });

  function handleFilesPicked(fileList) {
    clearPickerProcessingUI();
    selectedFiles = Array.from(fileList);
    const list = $('fileList');
    list.innerHTML = '';
    selectedFiles.forEach(f => {
      const row = document.createElement('div');
      row.innerHTML = `<span class="fname">${f.name}</span><span class="fsize">${fmtBytes(f.size)}</span>`;
      list.appendChild(row);
    });
    $('btnStartSend').disabled = selectedFiles.length === 0;
  }

  $('fileInput').onchange = e => handleFilesPicked(e.target.files);
  $('fileInputOther').onchange = e => handleFilesPicked(e.target.files);

  $('btnStartSend').onclick = () => {
    sendCode = genCode();
    $('sendCode').textContent = sendCode;
    const url = `${location.origin}/?code=${sendCode}`;
    $('qrbox').innerHTML = '';
    // eslint-disable-next-line no-undef
    new QRCode($('qrbox'), { text: url, width: 176, height: 176, correctLevel: QRCode.CorrectLevel.M });
    $('sendDot').className = 'dot active';
    $('sendStatusText').textContent = 'Waiting for the other device to join…';
    showScreen('screen-send-wait');
    sendStopwatch.start();

    const s = ensureSocket();
    s.emit('join', { code: sendCode });
    s.off('peer-joined');
    s.on('peer-joined', () => startP2PAsSender());
    // Server confirms this once BOTH sides are in the room — fires for
    // sender and receiver at the same moment, so this is a reliable signal
    // to surface a "connected" notification (rather than each side guessing
    // independently, which is what caused the sender/receiver status text
    // to drift out of sync before).
    s.off('both-connected');
    s.on('both-connected', () => showToast('Connected! Both devices are online.'));
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
    $('sendStatusText').textContent = 'Other device joined. Trying a direct connection…';
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
    const header = document.createElement('div');
    header.className = 'progress-current';
    header.id = 'progressCurrentLabel';
    container.appendChild(header);
    files.forEach((f, i) => {
      const item = document.createElement('div');
      item.className = 'progress-item';
      item.id = `progress-item-${i}`;
      item.innerHTML = `
        <div class="meta"><span>${f.name}</span><span class="meta-right"><span class="status-chip" id="chip-${i}">Queued</span><span id="pct-${i}">0%</span></span></div>
        <div class="bar-track"><div class="bar-fill" id="bar-${i}"></div></div>`;
      container.appendChild(item);
    });
    setActiveFile(files, 0);
  }

  // Marks which file (by index) is currently transferring so the UI makes
  // it obvious what's happening first when multiple files are queued up,
  // instead of showing several 0%-100% bars with no indication of order.
  function setActiveFile(files, index) {
    const label = $('progressCurrentLabel');
    if (label) {
      label.textContent = index < files.length
        ? `Sending file ${index + 1} of ${files.length} — ${files[index].name}`
        : `All ${files.length} file${files.length === 1 ? '' : 's'} sent`;
    }
    files.forEach((f, i) => {
      const item = $(`progress-item-${i}`);
      const chip = $(`chip-${i}`);
      if (!item || !chip) return;
      item.classList.remove('active', 'done');
      if (i < index) { item.classList.add('done'); chip.textContent = 'Sent'; }
      else if (i === index) { item.classList.add('active'); chip.textContent = 'Sending…'; }
      else { chip.textContent = 'Queued'; }
    });
  }

  async function sendViaP2P() {
    const tag = document.createElement('div');
    tag.className = 'tag p2p';
    tag.textContent = 'DIRECT CONNECTION';
    $('sendStatusText').parentElement.before(tag);
    $('sendDot').className = 'dot good';
    $('sendStatusText').textContent = 'Sending directly, device to device…';
    buildProgressUI($('sendProgress'), selectedFiles);

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      setActiveFile(selectedFiles, i);
      sendDC.send(JSON.stringify({ type: 'meta', index: i, total: selectedFiles.length, name: file.name, size: file.size, mime: file.type }));
      let offset = 0;
      while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        await waitForBufferedAmountLow(sendDC);
        sendDC.send(buf);
        offset += buf.byteLength;
        const pct = Math.round((offset / file.size) * 100);
        $(`bar-${i}`).style.width = pct + '%';
        $(`pct-${i}`).textContent = pct + '%';
      }
      sendDC.send(JSON.stringify({ type: 'file-end', index: i }));
    }
    sendDC.send(JSON.stringify({ type: 'all-done' }));
    setActiveFile(selectedFiles, selectedFiles.length);
    $('sendStatusText').textContent = 'All files sent!';
    sendStopwatch.stop();
  }

  function fallbackToRelay() {
    if (usingRelay) return;
    usingRelay = true;
    const tag = document.createElement('div');
    tag.className = 'tag relay';
    tag.textContent = 'SERVER RELAY (DIRECT CONNECTION UNAVAILABLE)';
    $('sendStatusText').parentElement.before(tag);
    $('sendDot').className = 'dot warn';
    $('sendStatusText').textContent = 'Uploading via server…';
    buildProgressUI($('sendProgress'), selectedFiles);
    uploadFilesSequentially(0);
  }

  function uploadFilesSequentially(index) {
    if (index >= selectedFiles.length) {
      socket.emit('relay-done', { code: sendCode });
      setActiveFile(selectedFiles, selectedFiles.length);
      $('sendStatusText').textContent = 'Uploaded. Waiting for the other device to download…';
      sendStopwatch.stop();
      return;
    }
    setActiveFile(selectedFiles, index);
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
    recvStopwatch.reset();
  }

  $('btnJoin').onclick = () => joinRoom($('codeInput').value.trim().toUpperCase());

  function joinRoom(code) {
    if (!code || code.length < 4) return;
    recvCode = code;
    showScreen('screen-recv-wait');
    // Honest, incremental status: don't claim "connected" until the server
    // actually confirms the sender is present too (see 'both-connected'
    // below) — this used to say "Connected..." immediately on joining,
    // which could read as connected well before the sender's screen agreed.
    $('recvStatusText').textContent = 'Joining room…';
    recvStopwatch.start();

    const s = ensureSocket();
    s.emit('join', { code });

    s.off('both-connected');
    s.on('both-connected', () => {
      $('recvStatusText').textContent = 'Connected. Waiting for sender to start…';
      showToast('Connected! Both devices are online.');
    });

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
      $('recvStatusText').textContent = 'Files ready — tap to download.';
      recvStopwatch.stop();
      files.forEach(f => {
        const row = document.createElement('div');
        row.className = 'received-item';
        row.innerHTML = `<span class="file-icon">${FILE_ICON_SVG}</span>
          <div class="meta-col"><div class="name">${f.name}</div><div class="size">${fmtBytes(f.size)}</div></div>
          <a href="/api/relay/${recvCode}/file/${f.id}" download="${f.name}">${DOWNLOAD_ICON_SVG}Download</a>`;
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
      $('recvStatusText').textContent = 'Receiving files directly from sender…';
      $('recvProgress').classList.remove('hidden');
    };
    dc.onmessage = evt => {
      if (typeof evt.data === 'string') {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'meta') {
          recvMeta = msg;
          recvChunks = [];
          recvReceived = 0;
          // msg.index/msg.total come from the sender — use them so it's
          // clear which file (of however many were selected) is currently
          // coming through, instead of just a bare, unlabeled progress bar.
          $('recvProgress').innerHTML = `
            <div class="progress-current">Receiving file ${msg.index + 1} of ${msg.total} — ${msg.name}</div>
            <div class="progress-item active">
              <div class="meta"><span>${msg.name}</span><span class="meta-right"><span class="status-chip">Receiving…</span><span id="rpct">0%</span></span></div>
              <div class="bar-track"><div class="bar-fill" id="rbar"></div></div>
            </div>`;
        } else if (msg.type === 'file-end') {
          const blob = new Blob(recvChunks, { type: recvMeta.mime || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const row = document.createElement('div');
          row.className = 'received-item';
          row.innerHTML = `<span class="file-icon">${FILE_ICON_SVG}</span>
            <div class="meta-col"><div class="name">${recvMeta.name}</div><div class="size">${fmtBytes(recvMeta.size)}</div></div>
            <a href="${url}" download="${recvMeta.name}">${DOWNLOAD_ICON_SVG}Save</a>`;
          $('recvFiles').appendChild(row);
          recvChunks = [];
        } else if (msg.type === 'all-done') {
          p2pAllDone = true;
          $('recvStatusText').textContent = 'All files received!';
          $('recvProgress').classList.add('hidden');
          recvStopwatch.stop();
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
