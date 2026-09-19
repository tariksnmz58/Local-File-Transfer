const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');

let mainWindow;
let httpServer = null;
let sharedFiles = [];
let uploadedFiles = [];
let currentPin = '';
let serverPort = 8080;
let uploadDir = '';

// ─── Ağ IP'sini bul ───
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    // VPN ve sanal adaptörleri atla
    const skipAdapters = ['nordlynx', 'vpn', 'tailscale', 'zerotier', 'docker', 'veth', 'vmware', 'virtualbox', 'hyper-v', 'vethernet'];
    // Sanal subnet'leri atla (VirtualBox: 192.168.56.x, Windows ICS: 192.168.137.x)
    const skipSubnets = ['192.168.56.', '192.168.137.'];
    
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        const nameLower = name.toLowerCase();
        if (skipAdapters.some(skip => nameLower.includes(skip))) continue;

        for (const iface of interfaces[name]) {
            const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
            if (isIPv4 && !iface.internal) {
                const addr = iface.address;
                if (skipSubnets.some(sub => addr.startsWith(sub))) continue;
                
                // Skor hesapla: Wi-Fi + 192.168 en yüksek
                let score = 0;
                if (addr.startsWith('192.168.')) score += 100;
                if (addr.startsWith('10.')) score += 10;
                if (nameLower.includes('wi-fi') || nameLower.includes('wifi') || nameLower.includes('wlan')) score += 50;
                else if (nameLower.includes('ethernet') || nameLower.includes('eth')) score += 30;
                
                candidates.push({ addr, name, score });
            }
        }
    }
    
    if (candidates.length === 0) return '127.0.0.1';
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].addr;
}

// ─── PIN üret ───
function generatePin() {
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

// ─── Dosya boyutunu formatla ───
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// ─── Log gönder ───
function sendLog(msg) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log', msg);
    }
}

// ─── Multipart parser ───
function parseMultipart(buffer, boundary) {
    const files = [];
    const boundaryBuffer = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;

    while (true) {
        const idx = buffer.indexOf(boundaryBuffer, start);
        if (idx === -1) break;
        if (start > 0) {
            parts.push(buffer.slice(start, idx));
        }
        start = idx + boundaryBuffer.length;
    }

    for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headerStr = part.slice(0, headerEnd).toString('utf-8');
        const body = part.slice(headerEnd + 4, part.length - 2); // remove trailing \r\n

        const filenameMatch = headerStr.match(/filename="(.+?)"/);
        if (filenameMatch && body.length > 0) {
            let filename = filenameMatch[1];
            // Handle UTF-8 encoded filenames
            try {
                filename = decodeURIComponent(filename);
            } catch (e) { }
            files.push({ filename, data: body });
        }
    }
    return files;
}

// ─── Web arayüzü CSS ───
function getWebCSS() {
    return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    body {
        font-family: 'Inter', 'Segoe UI', sans-serif;
        background: linear-gradient(135deg, #0c0e1a 0%, #141829 40%, #1a1040 100%);
        color: #e2e8f0;
        min-height: 100vh;
        padding: 0;
        margin: 0;
    }
    .page-wrapper {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
    }
    .container {
        width: 100%;
        max-width: 520px;
        background: rgba(30, 35, 60, 0.85);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(120, 130, 255, 0.15);
        border-radius: 24px;
        padding: 40px 36px;
        box-shadow: 0 25px 60px rgba(0,0,0,0.5), 0 0 80px rgba(99, 102, 241, 0.08);
    }
    .logo-icon {
        width: 56px; height: 56px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 28px;
        margin: 0 auto 20px;
        box-shadow: 0 8px 24px rgba(99, 102, 241, 0.3);
    }
    h2 {
        text-align: center;
        font-size: 24px;
        font-weight: 700;
        color: #f1f5f9;
        margin-bottom: 8px;
    }
    .subtitle {
        text-align: center;
        color: #94a3b8;
        font-size: 14px;
        margin-bottom: 32px;
    }
    .pin-input-group {
        display: flex;
        gap: 10px;
        justify-content: center;
        margin-bottom: 28px;
    }
    .pin-input-group input {
        width: 56px;
        height: 64px;
        text-align: center;
        font-size: 26px;
        font-weight: 700;
        border: 2px solid rgba(120, 130, 255, 0.2);
        border-radius: 14px;
        background: rgba(15, 18, 35, 0.8);
        color: #e2e8f0;
        outline: none;
        transition: all 0.3s;
        caret-color: #818cf8;
    }
    .pin-input-group input:focus {
        border-color: #6366f1;
        box-shadow: 0 0 20px rgba(99, 102, 241, 0.25);
        background: rgba(20, 24, 50, 0.9);
    }
    .btn-primary {
        display: block;
        width: 100%;
        padding: 16px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: white;
        border: none;
        border-radius: 14px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
        letter-spacing: 0.3px;
    }
    .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 30px rgba(99, 102, 241, 0.35);
    }
    .btn-primary:active { transform: translateY(0); }
    .error-msg {
        text-align: center;
        color: #f87171;
        font-size: 13px;
        margin-top: 12px;
        display: none;
    }

    /* ─── Dosya Listesi ─── */
    .file-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid rgba(120, 130, 255, 0.12);
    }
    .file-header h2 { margin: 0; text-align: left; }
    .badge {
        background: rgba(99, 102, 241, 0.15);
        color: #818cf8;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 600;
    }
    .tab-bar {
        display: flex;
        gap: 4px;
        background: rgba(15, 18, 35, 0.6);
        border-radius: 12px;
        padding: 4px;
        margin-bottom: 24px;
    }
    .tab-btn {
        flex: 1;
        padding: 12px;
        border: none;
        border-radius: 10px;
        background: transparent;
        color: #94a3b8;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
    }
    .tab-btn.active {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: white;
        box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .file-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: rgba(15, 18, 35, 0.6);
        border: 1px solid rgba(120, 130, 255, 0.08);
        border-radius: 14px;
        padding: 16px 20px;
        margin-bottom: 10px;
        transition: all 0.3s;
    }
    .file-card:hover {
        border-color: rgba(120, 130, 255, 0.2);
        transform: translateX(4px);
        background: rgba(20, 24, 50, 0.7);
    }
    .file-info { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
    .file-icon {
        width: 42px; height: 42px;
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(139, 92, 246, 0.15));
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        flex-shrink: 0;
    }
    .file-name {
        font-weight: 600;
        font-size: 14px;
        color: #e2e8f0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .file-size { color: #64748b; font-size: 12px; margin-top: 2px; }
    .btn-download {
        display: flex;
        align-items: center;
        gap: 6px;
        background: rgba(99, 102, 241, 0.12);
        color: #818cf8;
        border: 1px solid rgba(99, 102, 241, 0.2);
        padding: 10px 18px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
        text-decoration: none;
        white-space: nowrap;
    }
    .btn-download:hover {
        background: #6366f1;
        color: white;
        border-color: #6366f1;
        transform: translateY(-1px);
    }

    /* ─── Upload ─── */
    .upload-zone {
        border: 2px dashed rgba(120, 130, 255, 0.25);
        border-radius: 16px;
        padding: 40px 20px;
        text-align: center;
        transition: all 0.3s;
        cursor: pointer;
        background: rgba(15, 18, 35, 0.4);
        position: relative;
    }
    .upload-zone:hover, .upload-zone.dragover {
        border-color: #6366f1;
        background: rgba(99, 102, 241, 0.06);
        box-shadow: 0 0 30px rgba(99, 102, 241, 0.1);
    }
    .upload-zone .upload-icon {
        font-size: 48px;
        margin-bottom: 12px;
        display: block;
    }
    .upload-zone p { color: #94a3b8; font-size: 14px; }
    .upload-zone .highlight { color: #818cf8; font-weight: 600; cursor: pointer; }
    .upload-zone input[type="file"] {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
    }
    .upload-progress {
        margin-top: 20px;
        display: none;
    }
    .progress-bar-bg {
        width: 100%;
        height: 8px;
        background: rgba(15, 18, 35, 0.6);
        border-radius: 4px;
        overflow: hidden;
    }
    .progress-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #6366f1, #8b5cf6);
        border-radius: 4px;
        transition: width 0.3s;
        width: 0%;
    }
    .progress-text {
        text-align: center;
        font-size: 13px;
        color: #94a3b8;
        margin-top: 8px;
    }
    .upload-success {
        color: #34d399;
        font-weight: 600;
        text-align: center;
        margin-top: 16px;
        display: none;
    }
    .empty-state {
        text-align: center;
        padding: 40px 20px;
        color: #64748b;
    }
    .empty-state .empty-icon { font-size: 48px; margin-bottom: 12px; display: block; }
    `;
}

// ─── PIN giriş sayfası ───
function getPinPage(errorMsg = '') {
    return `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Giriş - Dosya Merkezi</title>
    <style>${getWebCSS()}</style>
</head>
<body>
    <div class="page-wrapper">
        <div class="container">
            <div class="logo-icon">🔐</div>
            <h2>Güvenlik Doğrulama</h2>
            <p class="subtitle">Dosyalara erişmek için PIN kodunu girin</p>
            <form id="pinForm" action="/" method="GET" onsubmit="return submitPin()">
                <div class="pin-input-group">
                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="pin-digit" autofocus>
                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="pin-digit">
                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="pin-digit">
                    <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="pin-digit">
                </div>
                <input type="hidden" name="pin" id="hiddenPin">
                <button type="submit" class="btn-primary">Erişim Sağla</button>
                <p class="error-msg" id="errorMsg" ${errorMsg ? 'style="display:block"' : ''}>${errorMsg || 'Geçersiz PIN kodu'}</p>
            </form>
        </div>
    </div>
    <script>
        const digits = document.querySelectorAll('.pin-digit');
        digits.forEach((input, i) => {
            input.addEventListener('input', (e) => {
                input.value = input.value.replace(/[^0-9]/g, '');
                if (input.value && i < 3) digits[i + 1].focus();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !input.value && i > 0) digits[i - 1].focus();
            });
            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
                for (let j = 0; j < 4 && j < text.length; j++) {
                    digits[j].value = text[j];
                }
                if (text.length >= 4) digits[3].focus();
            });
        });
        function submitPin() {
            const pin = Array.from(digits).map(d => d.value).join('');
            if (pin.length < 4) {
                document.getElementById('errorMsg').textContent = 'Lütfen 4 haneli PIN girin';
                document.getElementById('errorMsg').style.display = 'block';
                return false;
            }
            document.getElementById('hiddenPin').value = pin;
            return true;
        }
    </script>
</body>
</html>`;
}

// ─── Dosya listesi sayfası ───
function getFilePage(pin) {
    let downloadCards = '';
    if (sharedFiles.length === 0) {
        downloadCards = `<div class="empty-state"><span class="empty-icon">📭</span><p>Henüz paylaşılan dosya yok</p></div>`;
    } else {
        for (let i = 0; i < sharedFiles.length; i++) {
            const f = sharedFiles[i];
            const ext = path.extname(f.name).toLowerCase();
            let icon = '📄';
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) icon = '🖼️';
            else if (['.mp4', '.avi', '.mkv', '.mov'].includes(ext)) icon = '🎬';
            else if (['.mp3', '.wav', '.flac', '.ogg'].includes(ext)) icon = '🎵';
            else if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) icon = '📦';
            else if (['.pdf'].includes(ext)) icon = '📑';
            else if (['.doc', '.docx', '.txt'].includes(ext)) icon = '📝';
            else if (['.xls', '.xlsx', '.csv'].includes(ext)) icon = '📊';
            else if (['.exe', '.msi'].includes(ext)) icon = '⚙️';

            downloadCards += `
            <div class="file-card">
                <div class="file-info">
                    <div class="file-icon">${icon}</div>
                    <div>
                        <div class="file-name">${escapeHtml(f.name)}</div>
                        <div class="file-size">${formatSize(f.size)}</div>
                    </div>
                </div>
                <a href="/dosya/${i}?pin=${pin}" class="btn-download">
                    <span>⬇</span> İndir
                </a>
            </div>`;
        }
    }

    return `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dosya Merkezi</title>
    <style>${getWebCSS()}</style>
</head>
<body>
    <div class="page-wrapper">
        <div class="container" style="max-width: 580px;">
            <div class="file-header">
                <h2>📁 Dosya Merkezi</h2>
                <span class="badge">${sharedFiles.length} dosya</span>
            </div>

            <div class="tab-bar">
                <button class="tab-btn active" onclick="switchTab('download')">⬇ İndir</button>
                <button class="tab-btn" onclick="switchTab('upload')">⬆ Yükle</button>
            </div>

            <div class="tab-content active" id="tab-download">
                ${downloadCards}
            </div>

            <div class="tab-content" id="tab-upload">
                <div class="upload-zone" id="uploadZone">
                    <span class="upload-icon">☁️</span>
                    <p>Dosyaları buraya sürükleyin veya <span class="highlight">dosya seçin</span></p>
                    <p style="font-size:12px; margin-top:8px; color:#64748b;">Birden fazla dosya seçebilirsiniz</p>
                    <input type="file" id="fileInput" multiple>
                </div>
                <div class="upload-progress" id="uploadProgress">
                    <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressFill"></div></div>
                    <p class="progress-text" id="progressText">Yükleniyor...</p>
                </div>
                <p class="upload-success" id="uploadSuccess">✅ Dosya(lar) başarıyla yüklendi!</p>
            </div>
        </div>
    </div>
    <script>
        function switchTab(tab) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById('tab-' + tab).classList.add('active');
        }

        const zone = document.getElementById('uploadZone');
        const input = document.getElementById('fileInput');

        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
        });
        input.addEventListener('change', () => { if (input.files.length > 0) uploadFiles(input.files); });

        function uploadFiles(files) {
            const formData = new FormData();
            for (let i = 0; i < files.length; i++) formData.append('files', files[i]);

            const prog = document.getElementById('uploadProgress');
            const fill = document.getElementById('progressFill');
            const text = document.getElementById('progressText');
            const success = document.getElementById('uploadSuccess');

            prog.style.display = 'block';
            success.style.display = 'none';
            fill.style.width = '0%';
            text.textContent = 'Yükleniyor... 0%';

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/yukle?pin=${pin}');

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    fill.style.width = pct + '%';
                    text.textContent = 'Yükleniyor... ' + pct + '%';
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) {
                    fill.style.width = '100%';
                    text.textContent = 'Tamamlandı!';
                    success.style.display = 'block';
                    setTimeout(() => { prog.style.display = 'none'; }, 2000);
                } else {
                    text.textContent = 'Hata oluştu!';
                    fill.style.background = '#f87171';
                }
            };
            xhr.onerror = () => { text.textContent = 'Bağlantı hatası!'; };
            xhr.send(formData);
        }
    </script>
</body>
</html>`;
}

// ─── HTML escape ───
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── HTTP Sunucu oluştur ───
function createHttpServer() {
    return new Promise((resolve, reject) => {
        httpServer = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const pin = url.searchParams.get('pin');

            // ─── Ana sayfa ───
            if (url.pathname === '/') {
                if (pin !== currentPin) {
                    const errorMsg = pin !== null ? 'Geçersiz PIN kodu! Tekrar deneyin.' : '';
                    const html = getPinPage(errorMsg);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
                    res.end(html);
                    if (pin !== null) {
                        sendLog(`⚠️ [${req.socket.remoteAddress}] Geçersiz PIN denemesi!`);
                    }
                    return;
                }
                const html = getFilePage(pin);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
                res.end(html);
                sendLog(`🌐 [${req.socket.remoteAddress}] Dosya listesine erişti`);
                return;
            }

            // ─── Dosya indirme ───
            const downloadMatch = url.pathname.match(/^\/dosya\/(\d+)$/);
            if (downloadMatch) {
                if (pin !== currentPin) {
                    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end('Erişim Reddedildi! Geçersiz PIN.');
                    return;
                }
                const idx = parseInt(downloadMatch[1]);
                if (idx < 0 || idx >= sharedFiles.length) {
                    res.writeHead(404);
                    res.end('Dosya bulunamadı');
                    return;
                }
                const file = sharedFiles[idx];
                sendLog(`⬇️ [${req.socket.remoteAddress}] indiriyor: ${file.name}`);
                mainWindow.webContents.send('file-status', { index: idx, status: 'İndiriliyor' });

                const encodedName = encodeURIComponent(file.name);
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
                    'Content-Length': file.size
                });

                const stream = fs.createReadStream(file.path);
                stream.pipe(res);
                stream.on('end', () => {
                    sendLog(`✅ [${req.socket.remoteAddress}] tamamladı: ${file.name}`);
                    mainWindow.webContents.send('file-status', { index: idx, status: 'Tamamlandı' });
                });
                stream.on('error', (err) => {
                    sendLog(`❌ İndirme hatası: ${file.name} - ${err.message}`);
                    mainWindow.webContents.send('file-status', { index: idx, status: 'Hata' });
                    if (!res.headersSent) {
                        res.writeHead(500);
                    }
                    res.end();
                });
                return;
            }

            // ─── Dosya yükleme ───
            if (url.pathname === '/yukle' && req.method === 'POST') {
                if (pin !== currentPin) {
                    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end('Erişim Reddedildi!');
                    return;
                }

                const contentType = req.headers['content-type'] || '';
                const boundaryMatch = contentType.match(/boundary=(.+)/);
                if (!boundaryMatch) {
                    res.writeHead(400);
                    res.end('Geçersiz istek');
                    return;
                }

                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const buffer = Buffer.concat(chunks);
                        const files = parseMultipart(buffer, boundaryMatch[1]);

                        if (!fs.existsSync(uploadDir)) {
                            fs.mkdirSync(uploadDir, { recursive: true });
                        }

                        for (const file of files) {
                            const safeName = file.filename.replace(/[/\\:*?"<>|]/g, '_');
                            let finalPath = path.join(uploadDir, safeName);

                            // Aynı isimde dosya varsa numaralandır
                            let counter = 1;
                            while (fs.existsSync(finalPath)) {
                                const ext = path.extname(safeName);
                                const base = path.basename(safeName, ext);
                                finalPath = path.join(uploadDir, `${base} (${counter})${ext}`);
                                counter++;
                            }

                            fs.writeFileSync(finalPath, file.data);

                            const uploadInfo = {
                                name: path.basename(finalPath),
                                size: file.data.length,
                                path: finalPath,
                                from: req.socket.remoteAddress,
                                time: new Date().toLocaleTimeString('tr-TR')
                            };
                            uploadedFiles.push(uploadInfo);

                            sendLog(`⬆️ [${req.socket.remoteAddress}] yükledi: ${uploadInfo.name} (${formatSize(file.data.length)})`);
                            mainWindow.webContents.send('file-uploaded', uploadInfo);

                            // Masaüstü bildirimi
                            if (Notification.isSupported()) {
                                new Notification({
                                    title: 'Yeni Dosya Yüklendi!',
                                    body: `${uploadInfo.name} - ${formatSize(file.data.length)}`
                                }).show();
                            }
                        }

                        res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('OK');
                    } catch (err) {
                        sendLog(`❌ Yükleme hatası: ${err.message}`);
                        res.writeHead(500);
                        res.end('Sunucu hatası');
                    }
                });
                return;
            }

            // 404
            res.writeHead(404);
            res.end('Sayfa bulunamadı');
        });

        function tryListen(port) {
            httpServer.listen(port, '0.0.0.0', () => {
                serverPort = port;
                resolve(port);
            });
        }

        httpServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                const nextPort = serverPort + 1;
                serverPort = nextPort;
                sendLog(`⚠️ Port ${nextPort - 1} kullanımda, ${nextPort} deneniyor...`);
                tryListen(nextPort);
            } else {
                reject(err);
            }
        });

        tryListen(serverPort);
    });
}

// ─── Electron penceresi ───
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 960,
        height: 640,
        minWidth: 860,
        minHeight: 580,
        title: 'Dosya Paylaşım',
        backgroundColor: '#0c0e1a',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);
}

// ─── IPC Handlers ───
app.whenReady().then(() => {
    // Yükleme dizini
    uploadDir = path.join(app.getPath('downloads'), 'DosyaPaylasim-Yuklemeler');

    ipcMain.handle('select-files', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile', 'multiSelections'],
            title: 'Paylaşılacak Dosyaları Seçin'
        });
        if (result.canceled) return null;

        sharedFiles = result.filePaths.map(fp => {
            const stats = fs.statSync(fp);
            return {
                name: path.basename(fp),
                path: fp,
                size: stats.size
            };
        });
        return sharedFiles.map(f => ({ name: f.name, size: f.size, sizeFormatted: formatSize(f.size) }));
    });

    ipcMain.handle('start-server', async () => {
        try {
            currentPin = generatePin();
            serverPort = 8080;
            const port = await createHttpServer();
            const ip = getLocalIP();
            const address = `http://${ip}:${port}`;

            // QR kod üret (base64 data URL)
            const qrDataUrl = await QRCode.toDataURL(address, {
                width: 140,
                margin: 1,
                color: { dark: '#e2e8f0', light: '#00000000' }
            });

            sendLog(`🚀 Sunucu başlatıldı: ${address}`);
            sendLog(`🔒 PIN Kodu: ${currentPin}`);
            sendLog(`📂 Yüklenen dosyalar: ${uploadDir}`);

            return {
                success: true,
                pin: currentPin,
                address,
                qrDataUrl,
                port
            };
        } catch (err) {
            sendLog(`❌ Sunucu hatası: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('stop-server', () => {
        if (httpServer) {
            httpServer.close();
            httpServer = null;
        }
        sharedFiles = [];
        uploadedFiles = [];
        currentPin = '';
        serverPort = 8080;
        sendLog('🛑 Sunucu durduruldu ve sistem temizlendi.');
        return true;
    });

    ipcMain.handle('open-upload-folder', () => {
        if (fs.existsSync(uploadDir)) {
            shell.openPath(uploadDir);
        }
    });

    ipcMain.handle('get-upload-dir', () => uploadDir);

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (httpServer) httpServer.close();
    if (process.platform !== 'darwin') app.quit();
});
