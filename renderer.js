// ─── DOM elementleri ───
const fileTableBody = document.getElementById('fileTableBody');
const fileTable = document.getElementById('fileTable');
const emptyTable = document.getElementById('emptyTable');
const fileCount = document.getElementById('fileCount');
const uploadList = document.getElementById('uploadList');
const emptyUploads = document.getElementById('emptyUploads');
const logTerminal = document.getElementById('logTerminal');
const qrImage = document.getElementById('qrImage');
const qrPlaceholder = document.getElementById('qrPlaceholder');
const pinValue = document.getElementById('pinValue');
const addressDisplay = document.getElementById('addressDisplay');
const addressText = document.getElementById('addressText');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const btnSelectFiles = document.getElementById('btnSelectFiles');
const btnShare = document.getElementById('btnShare');
const btnReset = document.getElementById('btnReset');
const btnOpenFolder = document.getElementById('btnOpenFolder');
const btnClearLog = document.getElementById('btnClearLog');

let currentFiles = [];
let serverRunning = false;

// ─── Dosya seçme ───
btnSelectFiles.addEventListener('click', async () => {
    const files = await window.api.selectFiles();
    if (!files) return;

    currentFiles = files;
    renderFileTable(files);
    btnShare.disabled = false;
    addLog(`📁 ${files.length} adet dosya seçildi.`, 'info');
});

// ─── Ağda paylaş ───
btnShare.addEventListener('click', async () => {
    if (currentFiles.length === 0) return;

    btnShare.disabled = true;
    btnSelectFiles.disabled = true;
    addLog('🚀 Sunucu başlatılıyor...', 'info');

    const result = await window.api.startServer();
    if (result.success) {
        serverRunning = true;

        // QR Kod göster
        qrImage.src = result.qrDataUrl;
        qrImage.style.display = 'block';
        qrPlaceholder.style.display = 'none';

        // PIN göster
        pinValue.textContent = result.pin;

        // Adres göster
        addressText.textContent = result.address;
        addressDisplay.style.display = 'block';

        // Durum göstergesi
        const dot = statusDot.querySelector('.dot');
        dot.classList.remove('offline');
        dot.classList.add('online');
        statusText.textContent = 'Yayında';
        statusText.style.color = '#34d399';
    } else {
        addLog(`❌ Sunucu başlatılamadı: ${result.error}`, 'error');
        btnShare.disabled = false;
        btnSelectFiles.disabled = false;
    }
});

// ─── Sistemi temizle ───
btnReset.addEventListener('click', async () => {
    await window.api.stopServer();
    serverRunning = false;

    // Tabloyu temizle
    currentFiles = [];
    fileTableBody.innerHTML = '';
    fileTable.style.display = 'none';
    emptyTable.style.display = 'flex';
    fileCount.textContent = '0 dosya';

    // Yüklenen dosyaları temizle
    uploadList.innerHTML = '';
    emptyUploads.style.display = 'flex';
    uploadList.appendChild(emptyUploads);

    // QR temizle
    qrImage.style.display = 'none';
    qrPlaceholder.style.display = 'flex';
    pinValue.textContent = '- - - -';
    addressDisplay.style.display = 'none';

    // Durum
    const dot = statusDot.querySelector('.dot');
    dot.classList.remove('online');
    dot.classList.add('offline');
    statusText.textContent = 'Çevrimdışı';
    statusText.style.color = '';

    // Butonlar
    btnSelectFiles.disabled = false;
    btnShare.disabled = true;

    addLog('🔄 Sistem temizlendi ve sunucu durduruldu.', 'warning');
});

// ─── Klasörü aç ───
btnOpenFolder.addEventListener('click', () => {
    window.api.openUploadFolder();
});

// ─── Logları temizle ───
btnClearLog.addEventListener('click', () => {
    logTerminal.innerHTML = '';
    addLog('📋 Loglar temizlendi.', 'info');
});

// ─── Dosya tablosunu güncelle ───
function renderFileTable(files) {
    fileTableBody.innerHTML = '';
    fileTable.style.display = 'table';
    emptyTable.style.display = 'none';
    fileCount.textContent = `${files.length} dosya`;

    files.forEach((file, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</td>
            <td>${file.sizeFormatted}</td>
            <td><span class="status-badge status-waiting" id="status-${idx}">⏳ Bekliyor</span></td>
        `;
        fileTableBody.appendChild(tr);
    });
}

// ─── Dosya durumu güncelle ───
window.api.onFileStatus((data) => {
    const el = document.getElementById(`status-${data.index}`);
    if (!el) return;

    el.className = 'status-badge';
    switch (data.status) {
        case 'İndiriliyor':
            el.className += ' status-downloading';
            el.textContent = '⬇ İndiriliyor';
            break;
        case 'Tamamlandı':
            el.className += ' status-done';
            el.textContent = '✅ Tamamlandı';
            break;
        case 'Hata':
            el.className += ' status-error';
            el.textContent = '❌ Hata';
            break;
        default:
            el.className += ' status-waiting';
            el.textContent = '⏳ Bekliyor';
    }
});

// ─── Dosya yüklendiğinde ───
window.api.onFileUploaded((data) => {
    emptyUploads.style.display = 'none';

    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `
        <span class="upload-item-icon">⬆️</span>
        <div class="upload-item-info">
            <div class="upload-item-name" title="${escapeHtml(data.name)}">${escapeHtml(data.name)}</div>
            <div class="upload-item-meta">${formatSize(data.size)} · ${data.from} · ${data.time}</div>
        </div>
    `;
    uploadList.appendChild(item);
    uploadList.scrollTop = uploadList.scrollHeight;
});

// ─── Log mesajı ekle ───
function addLog(msg, type = '') {
    const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = 'log-line' + (type ? ` log-${type}` : '');
    line.innerHTML = `<span class="log-time">[${time}]</span><span class="log-msg">${escapeHtml(msg)}</span>`;
    logTerminal.appendChild(line);
    logTerminal.scrollTop = logTerminal.scrollHeight;
}

// ─── Main process'ten gelen loglar ───
window.api.onLog((msg) => {
    let type = '';
    if (msg.includes('❌') || msg.includes('Hata')) type = 'error';
    else if (msg.includes('⚠️')) type = 'warning';
    else if (msg.includes('🚀') || msg.includes('✅') || msg.includes('🌐') || msg.includes('🔒') || msg.includes('📂')) type = 'info';
    addLog(msg, type);
});

// ─── Yardımcılar ───
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
