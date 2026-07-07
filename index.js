
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

// Railway Volume ???êµ¬ ?€?¥ì†Œ ì§€??(ì¡´ì¬?˜ë©´ ?¬ìš©, ?†ìœ¼ë©?__dirname)
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ============================================================
// ?¤ì •
// ============================================================
const { BUBEE_ID, BUBEE_PW, TARGET_VOD_KEYS, TARGET_USER_KEYS, CHECK_INTERVAL_SEC, BUBEE_ROOM_ID, PORT } = process.env;

const CONFIG = {
    checkIntervalMs: (parseInt(CHECK_INTERVAL_SEC) || 30) * 1000,
    apiBase: 'https://api.bubeelive.com/v2/sites/2',
    siteBase: 'https://www.bubeelive.com',
    port: PORT || 8080,
    configPath: path.join(__dirname, 'config.json')
};

const CHROME_EXE = process.platform === 'win32'
  ? (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') 
     ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' 
     : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  : process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

// ============================================================
// ? í‹¸ë¦¬í‹°
// ============================================================
const delay = ms => new Promise(res => setTimeout(res, ms));
function log(msg) {
    const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    console.log(`[${time}] ${msg}`);
}

// ============================================================
// ì¿ í‚¤ ?ë™ ê°±ì‹  (auth_token 15ë¶„ë§ˆ??ë§Œë£Œ?˜ë?ë¡?refresh_token?¼ë¡œ ê°±ì‹ )
// ============================================================
async function refreshAuthToken() {
    try {
        const cookiePath = path.join(__dirname, 'cookies.json');
        if (!fs.existsSync(cookiePath)) return;
        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
        const refreshCookie = cookies.find(c => c.name === 'auth_refresh_token');
        if (!refreshCookie) return;

        const refreshToken = refreshCookie.value;
        
        // ë¶€ë¹„ë¼?´ë¸Œ ? í° ê°±ì‹  API ?¸ì¶œ
        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.bubeelive.com',
                path: '/v2/sites/2/auth/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${refreshToken}`,
                    'Origin': 'https://www.bubeelive.com',
                    'Referer': 'https://www.bubeelive.com/'
                }
            };
            const req = https.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.end();
        });

        if (result && result.data && result.data.token) {
            const newToken = result.data.token;
            const newRefresh = result.data.refresh_token || refreshToken;
            
            // cookies.json ?…ë°?´íŠ¸
            const updated = cookies.map(c => {
                if (c.name === 'auth_token') return { ...c, value: `Bearer ${newToken}` };
                if (c.name === 'auth_refresh_token') return { ...c, value: newRefresh };
                return c;
            });
            fs.writeFileSync(cookiePath, JSON.stringify(updated, null, 2));
            
            // ?´ë ¤?ˆëŠ” ëª¨ë“  ë¸Œë¼?°ì? ??—????? í° ì£¼ì…
            if (global.activeRooms) {
                for (const [, p] of global.activeRooms.entries()) {
                    if (!p.isClosed()) {
                        await p.setCookie(
                            { name: 'auth_token', value: `Bearer ${newToken}`, domain: '.bubeelive.com', path: '/' },
                            { name: 'auth_refresh_token', value: newRefresh, domain: '.bubeelive.com', path: '/' }
                        ).catch(() => {});
                    }
                }
            }
            log(`?”„ [? í° ê°±ì‹  ?±ê³µ] ??auth_token ë°œê¸‰ ?„ë£Œ!`);
        } else {
            log(`? ï¸ [? í° ê°±ì‹ ] ?‘ë‹µ ?´ìƒ: ${JSON.stringify(result)}`);
        }
    } catch(e) {
        log(`??[? í° ê°±ì‹  ?¤íŒ¨] ${e.message}`);
    }
}

// 10ë¶„ë§ˆ???ë™ ê°±ì‹  (auth_token ? íš¨ê¸°ê°„ 15ë¶„ì´ë¯€ë¡??‰ë„‰?˜ê²Œ 10ë¶?
setInterval(refreshAuthToken, 10 * 60 * 1000);


// ============================================================
// ?€ê²??¤ì • ë¡œë“œ/?€??(?˜ê²½ë³€??+ ?Œì¼)
// ============================================================
let targets = []; // Array of { id: Number, name: String, type: 'vod_key' | 'user_key' }
const activeRooms = new Map(); // vod_key -> Page

function loadConfig() {
    // 1. ?˜ê²½ë³€??ê¸°ë°˜ ê¸°ë³¸ ?¤ì • ë¡œë“œ
    const envVodKeys = (TARGET_VOD_KEYS || BUBEE_ROOM_ID || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
    const envUserKeys = (TARGET_USER_KEYS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
    
    const initialTargets = [];
    envVodKeys.forEach(id => initialTargets.push({ id, name: `?˜ê²½ë³€??ë°?${id})`, type: 'vod_key' }));
    envUserKeys.forEach(id => initialTargets.push({ id, name: `?˜ê²½ë³€??BJ(${id})`, type: 'user_key' }));

    // 2. ?Œì¼ ê¸°ë°˜ ?¤ì • ë¡œë“œ
    if (fs.existsSync(CONFIG.configPath)) {
        try {
            const fileData = JSON.parse(fs.readFileSync(CONFIG.configPath, 'utf8'));
            targets = fileData;
        } catch (e) {
            log('? ï¸ config.json ?Œì‹± ?ëŸ¬, ?Œì¼ ?¤ì •??ì´ˆê¸°?”í•©?ˆë‹¤.');
            targets = [...initialTargets];
        }
    } else {
        targets = [...initialTargets];
        saveConfig();
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG.configPath, JSON.stringify(targets, null, 2));
    } catch(e) {
        log('??config.json ?€???¤íŒ¨: ' + e.message);
    }
}

// ============================================================
// Express ???€?œë³´???œë²„
// ============================================================
function startDashboard() {
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());
    
    // ?•ì  ?Œì¼ ?œë¹™ (UI)
    app.use(express.static(path.join(__dirname, 'public')));

    // ?„ì¬ ?€ê²?ëª©ë¡ ì¡°íšŒ
    app.get('/api/targets', (req, res) => {
        res.json({
            targets: targets,
            activeRooms: Array.from(activeRooms.keys())
        });
    });

    // ?€ê²?ì¶”ê?
    app.post('/api/targets', async (req, res) => {
        let { id, name, type, settings } = req.body;
        if (!id || !name || !type) return res.status(400).json({ message: '?Œë¼ë¯¸í„° ?„ë½' });
        
        // ?? ?¸ì˜ ê¸°ëŠ¥: ?¬ìš©?ê? ë°©ë²ˆ??vod_key)ë¥??…ë ¥?´ë„, ?ë™?¼ë¡œ ?‰ìƒ ê³ ìœ  ID(user_key)ë¡?ë³€?˜í•´ì£¼ëŠ” ë¡œì§!
        if (type === 'vod_key') {
            try {
                // axios ?€??Node 18+ ?¤ì´?°ë¸Œ fetch ?¬ìš© (ëª¨ë“ˆ ?˜ì¡´???ëŸ¬ ë°©ì?)
                const response = await fetch(`${CONFIG.apiBase}/live/rooms/${id}`, {
                    signal: AbortSignal.timeout(3000)
                });
                const data = await response.json();
                const targetLive = data?.lives?.find(l => String(l.vod_key) === String(id));
                if (targetLive && targetLive.user_key) {
                    // ì°¾ì•˜?¤ë©´ user_key ëª¨ë“œë¡?ê°•ì œ ë³€ê²½í•˜ê³??€??                    log(`?’¡ ë°©ë²ˆ??${id})?ì„œ ? ì? ê³ ìœ  ID(${targetLive.user_key}) ?ë™ ì¶”ì¶œ ?±ê³µ!`);
                    id = targetLive.user_key;
                    type = 'user_key';
                    if (name === '?ê¸¸?? || !name) name = targetLive.v_subject || name; // ?´ë¦„???ë™ ?„ì„±
                }
            } catch (e) {
                log('API ì¡°íšŒ ?¤íŒ¨ë¡?ë³€???ëµ');
            }
        }

        // ì¤‘ë³µ ì²´í¬
        if (targets.find(t => t.id === Number(id))) {
            return res.status(400).json({ message: '?´ë? ?±ë¡??ID?…ë‹ˆ??' });
        }

        // ê¸°ë³¸ ?¤ì •ê°’ì´ ?†ë‹¤ë©?ê°•ì œ ì£¼ì…
        const defaultSettings = { autoAttendance: true, autoWelcome: true, enableCommands: true };
        const targetSettings = settings || defaultSettings;

        targets.push({ id: Number(id), name, type, settings: targetSettings });
        saveConfig();
        log(`???€?œë³´?œì—???€ê²?ì¶”ê??? ${name} (${id} / ${type})`);
        res.json({ success: true });
    });

    // ?€ê²??? œ
    app.delete('/api/targets/:id', async (req, res) => {
        const id = Number(req.params.id);
        const idx = targets.findIndex(t => t.id === id);
        if (idx !== -1) {
            const target = targets[idx];
            log(`?—‘ï¸??€?œë³´?œì—???€ê²??? œ?? ${target.name} (${id})`);
            
            // ?? œ ???„ì¬ ë´‡ì´ ?¤ì–´ê°€ ?ˆëŠ” ë°©ì´ ?ˆë‹¤ë©?ê°•ì œë¡??˜ì˜¤ê¸?            let targetVodKey = null;
            if (target.type === 'vod_key') targetVodKey = target.id;
            else {
                // user_key??ê²½ìš° ?„ì¬ ì¼œì ¸?ˆëŠ” ?œì„± ë°©ë“¤ ì¤‘ì—??ì°¾ì•„???«ìŒ
                for (const [vKey, page] of activeRooms.entries()) {
                    // page ê°ì²´???íƒœ???°ë¼ ?¤ë¥´ì§€ë§? ê°€???ˆì „??ê±?ëª¨ë‹ˆ?°ë§ ë£¨í”„ê°€ ?¤ì‹œ ëª??¤ì–´ê°€ê²?activeRooms?ì„œ ë¹¼ëŠ” ê²?                    // ?„ì¬ activeRooms?ëŠ” p (Page ê°ì²´)ê°€ ?€?¥ë˜???ˆìŒ.
                    if (page && !page.isClosed()) {
                        try {
                            await page.close();
                            log(`?šª ?€ê²??? œë¡??¸í•´ ë°©ì†¡ë°?${vKey})?ì„œ ê°•ì œ ?´ì¥?ˆìŠµ?ˆë‹¤.`);
                        } catch(e){}
                    }
                    activeRooms.delete(vKey); 
                }
            }

            if (targetVodKey && activeRooms.has(targetVodKey)) {
                const page = activeRooms.get(targetVodKey);
                if (page && !page.isClosed()) {
                    try {
                        await page.close();
                        log(`?šª ?€ê²??? œë¡??¸í•´ ë°©ì†¡ë°?${targetVodKey})?ì„œ ê°•ì œ ?´ì¥?ˆìŠµ?ˆë‹¤.`);
                    } catch(e){}
                }
                activeRooms.delete(targetVodKey);
            }

            targets.splice(idx, 1);
            saveConfig();
        }
        res.json({ success: true });
    });

    // ?? [?”ë²„ê¹? ?„ì¬ ë°©ì†¡ë°??”ë©´ ìº¡ì²˜ ?”ë“œ?¬ì¸??ì¶”ê?
    app.get('/api/debug/screenshot', async (req, res) => {
        if (activeRooms.size === 0) {
            return res.status(404).send('?„ì¬ ?…ì¥??ë°©ì´ ?†ìŠµ?ˆë‹¤.');
        }
        try {
            // ì²?ë²ˆì§¸ ë°©ì˜ ?˜ì´ì§€ ê°ì²´ ê°€?¸ì˜¤ê¸?            const firstRoomKey = activeRooms.keys().next().value;
            const page = activeRooms.get(firstRoomKey);
            if (!page || page.isClosed()) {
                return res.status(500).send('?˜ì´ì§€ê°€ ?´ë? ?«í˜”?µë‹ˆ??');
            }
            const screenshotBuffer = await page.screenshot({ type: 'png' });
            res.set('Content-Type', 'image/png');
            res.send(screenshotBuffer);
        } catch (e) {
            res.status(500).send('?¤í¬ë¦°ìƒ· ìº¡ì²˜ ?¤íŒ¨: ' + e.message);
        }
    });

    // ?€ê²?ê°œë³„ ?¤ì • ë³€ê²?    app.patch('/api/targets/:id/settings', (req, res) => {
        const id = Number(req.params.id);
        const idx = targets.findIndex(t => t.id === id);
        if (idx !== -1) {
            if (!targets[idx].settings) {
                targets[idx].settings = { autoWelcome: false, autoAttendance: false, enableCommands: true };
            }
            targets[idx].settings = { ...targets[idx].settings, ...req.body };
            saveConfig();
            log(`?™ï¸ ?¤ì • ë³€ê²½ë¨: ${targets[idx].name} (${id}) -> ${JSON.stringify(req.body)}`);
            
            // ?”¥ ?œì„±?”ëœ ë°©ì´ ?ˆë‹¤ë©??¤ì‹œê°„ìœ¼ë¡??¤ì • ì£¼ì…
            if (global.activeRooms) {
                const targetId = String(id);
                // activeRooms???¤ëŠ” vod_key?´ë?ë¡? ëª¨ë“  ë°©ì„ ?œíšŒ?˜ë©° ?€??ë°©ì„ ì°¾ìŠµ?ˆë‹¤.
                for (const [vod_key, p] of global.activeRooms.entries()) {
                    const targetInfo = targets.find(t => t.id === Number(vod_key) || t.id === String(vod_key));
                    if (targetInfo && String(targetInfo.id) === targetId && !p.isClosed()) {
                        p.evaluate((newSettings) => {
                            window.BOT_SETTINGS = newSettings;
                        }, targets[idx].settings).catch(e => log(`?¤ì‹œê°??¤ì • ?™ê¸°???¤íŒ¨: ${e.message}`));
                        log(`??[ë°?${vod_key}] ë³€ê²½ëœ ?¤ì •??ë´‡ì—ê²??¤ì‹œê°„ìœ¼ë¡??„ì†¡ ?„ë£Œ!`);
                    }
                }
            }

            res.json({ success: true, settings: targets[idx].settings });
        } else {
            res.status(404).json({ message: '?€ê²Ÿì„ ì°¾ì„ ???†ìŠµ?ˆë‹¤.' });
        }
    });

    app.use(express.json());

    app.get('/live', (req, res) => {
        res.send(`
            <html>
                <head>
                    <title>ë¶€ë¹„ë¼?´ë¸Œ ë´??¤ì‹œê°??œì–´</title>
                    <meta charset="utf-8">
                    <style>
                        body { background: #111; color: white; text-align: center; font-family: sans-serif; margin: 0; padding: 20px; }
                        img { max-width: 100%; max-height: 70vh; border: 3px solid #ff4444; border-radius: 10px; cursor: crosshair; }
                        .controls { margin-bottom: 15px; padding: 15px; background: #222; border-radius: 10px; display: inline-block; }
                        button, input { padding: 10px 15px; font-size: 16px; margin: 5px; border-radius: 5px; border: none; }
                        button { cursor: pointer; background: #44aaff; color: white; font-weight: bold; }
                        button:hover { background: #3388cc; }
                        .manual-btn { background: #ff4444; }
                    </style>
                    <script>
                        setInterval(() => {
                            const img = document.getElementById('live-img');
                            img.src = '/live-image?t=' + new Date().getTime();
                        }, 1000);

                        async function toggleManual() {
                            await fetch('/api/live/manual', { method: 'POST' });
                            alert('?˜ë™ ì¡°ì‘ ëª¨ë“œê°€ ì¼œì¡Œ?µë‹ˆ?? ë´‡ì´ ?€?´í•‘??ë©ˆì¶”ê³??€ê¸°í•©?ˆë‹¤.');
                        }
                        async function sendClick(e) {
                            const img = e.target;
                            const rect = img.getBoundingClientRect();
                            const x = e.clientX - rect.left;
                            const y = e.clientY - rect.top;
                            await fetch('/api/live/click', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ x: x, y: y, width: img.clientWidth, height: img.clientHeight })
                            });
                        }
                        async function sendText() {
                            const text = document.getElementById('kb-input').value;
                            if (!text) return;
                            await fetch('/api/live/type', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ text: text })
                            });
                            document.getElementById('kb-input').value = '';
                        }
                        async function sendKey(action) {
                            await fetch('/api/live/type', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: action })
                            });
                        }
                    </script>
                </head>
                <body>
                    <h1>?”´ ?¤ì‹œê°?CCTV ë°??ê²© ?œì–´</h1>
                    <div class="controls">
                        <button class="manual-btn" onclick="toggleManual()">?›‘ ?˜ë™ ì¡°ì‘ ëª¨ë“œ ì¼œê¸° (ë´?ë©ˆì¶¤)</button><br><br>
                        <input type="text" id="kb-input" placeholder="ë´‡ì—ê²?ë³´ë‚¼ ê¸€???…ë ¥..." />
                        <button onclick="sendText()">?…ë ¥ ?„ì†¡</button>
                        <button onclick="sendKey('Backspace')">ì§€?°ê¸°(Back)</button>
                        <button onclick="sendKey('Enter')">?”í„°(Enter)</button>
                    </div>
                    <p style="color: yellow;">?’¡ ?„ë˜ ?”ë©´???´ë¦­?˜ë©´ ë´‡ì˜ ë§ˆìš°?¤ê? ?‘ê°™???´ë¦­?©ë‹ˆ??</p>
                    <img id="live-img" src="/live-image" onclick="sendClick(event)" />
                </body>
            </html>
        `);
    });

    app.post('/api/live/manual', (req, res) => {
        global.manualMode = true;
        res.json({ success: true });
    });

    app.post('/api/live/click', async (req, res) => {
        if (global.livePage && !global.livePage.isClosed()) {
            const { x, y, width, height } = req.body;
            const targetX = x * (1280 / width);
            const targetY = y * (720 / height);
            try { await global.livePage.mouse.click(targetX, targetY); } catch(e){}
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false });
        }
    });

    app.post('/api/live/type', async (req, res) => {
        if (global.livePage && !global.livePage.isClosed()) {
            const { text, action } = req.body;
            try {
                if (action) await global.livePage.keyboard.press(action);
                else if (text) await global.livePage.keyboard.type(text);
            } catch(e){}
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false });
        }
    });

    app.get('/live-image', async (req, res) => {
        if (global.livePage && !global.livePage.isClosed()) {
            try {
                const buffer = await global.livePage.screenshot({ type: 'jpeg', quality: 60 });
                res.set('Content-Type', 'image/jpeg');
                res.send(buffer);
            } catch(e) {
                res.status(500).send('Screenshot error');
            }
        } else {
            res.status(404).send('Not running');
        }
    });

    app.listen(CONFIG.port, () => {
        log(`?Œ ???€?œë³´???œë²„ ?¤í”ˆ: http://localhost:${CONFIG.port}`);
        log(`?”´ ?¤ì‹œê°?CCTV ?ê²©?œì–´: http://localhost:${CONFIG.port}/live`);
    });
}

// ============================================================
// API ?µì‹  (ê²½ëŸ‰ ?´ë§)
// ============================================================
function fetchLiveList() {
    const url = `${CONFIG.apiBase}/vod/live-list?link_cd=ALL&offset=0&limit=100`;
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'x-user-agent': 'kpoplive_app/DESKTOP/PG/1.0.0/kr/ko/N/10',
                'Accept': 'application/json',
                'Referer': CONFIG.siteBase + '/',
                'Origin': CONFIG.siteBase
            },
            timeout: 10000
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject).on('timeout', function () {
            this.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

// ============================================================
// ê°•ë ¥??ë¡œê·¸??ë¡œì§
// ============================================================
async function doLogin(page) {
    global.livePage = page;
    log('?” ë¡œê·¸???œë„ ì¤?..');

    // ë¸Œë¼?°ì? ?´ë? ?™ì‘ ëª¨ë‹ˆ?°ë§
    page.on('console', msg => log(`[ë¸Œë¼?°ì? ì½˜ì†”] ${msg.type().toUpperCase()}: ${msg.text()}`));
    page.on('dialog', async dialog => {
        log(`[?š¨ ë¸Œë¼?°ì? ?Œë¦¼ì°??š¨] ${dialog.message()}`);
        await dialog.accept();
    });
    page.on('request', request => {
        const url = request.url();
        if (url.includes('login') || url.includes('auth') || url.includes('signin')) {
            log(`[?¤íŠ¸?Œí¬ ?”ì²­] ${request.method()} ${url}`);
        }
    });
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('login') || url.includes('auth') || url.includes('signin')) {
            log(`[?¤íŠ¸?Œí¬ ?‘ë‹µ] ${response.status()} ${url}`);
            try {
                const text = await response.text();
                log(`[?‘ë‹µ ?´ìš©] ${text.substring(0, 500)}`);
            } catch(e) {}
        }
    });
    const publicDir = path.join(__dirname, 'public');
    
    try { await page.goto(`${CONFIG.siteBase}`, { waitUntil: 'networkidle2', timeout: 20000 }); } catch (e) {}
    await delay(3000);
    log('?” ë¡œê·¸???µì…˜ ?ìƒ‰ ì¤?..');

    // 1. ë©”ì¸ ?”ë©´ ?íƒœ ìº¡ì²˜
    try { await page.screenshot({ path: path.join(publicDir, 'debug1.png') }); } catch(e){}

    // ?•ì‹¤???¤ì´?°ë¸Œ ë§ˆìš°???´ë¦­?¼ë¡œ ë¡œê·¸??ë²„íŠ¼(?¤ë”) ?„ë¥´ê¸?    try {
        await page.click('.btn-login');
        log('?‘‰ ë©”ì¸ ë¡œê·¸??ë²„íŠ¼ ?´ë¦­ ?„ë£Œ');
    } catch(e) {
        log('? ï¸ btn-login ?´ë˜?¤ë? ì°¾ì„ ???†ìŠµ?ˆë‹¤. ?ë°”?¤í¬ë¦½íŠ¸ ?´ë¦­ ?œë„');
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a, div, li, span'));
            const loginBtn = btns.find(e => e.innerText && e.innerText.includes('ë¡œê·¸??) && !e.innerText.includes('ì¹´ì¹´??) && e.offsetHeight > 0);
            if (loginBtn) loginBtn.click();
        });
    }

    await delay(2000);
    
    // ?? ë¶€ë¹„ë¼?´ë¸Œ ? ê·œ ë¡œê·¸??UI ?€?? "?„ì´?”ë¡œ ?œì‘?˜ê¸°" ë²„íŠ¼ ?´ë¦­
    log('?‘‰ ë¡œê·¸???˜ë‹¨ ? íƒ: "?„ì´?”ë¡œ ?œì‘?˜ê¸°" ì°¾ëŠ” ì¤?..');
    const clickedIdStart = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, div, li, span')).reverse();
        const idStartBtn = els.find(e => {
            if (!e.innerText) return false;
            const txt = e.innerText.replace(/\n/g, '').replace(/\s+/g, ' ');
            // ë¶€ëª?ëª¨ë‹¬ ?„ì²´ê°€ ? íƒ?˜ëŠ” ê²ƒì„ ë°©ì? (?ìŠ¤??ê¸¸ì´ ?œí•œ)
            return txt.includes('?„ì´?”ë¡œ ?œì‘?˜ê¸°') && !txt.includes('ì¹´ì¹´??) && e.offsetHeight > 0 && txt.length < 30;
        });
        if (idStartBtn) {
            const clickable = idStartBtn.closest('button') || idStartBtn.closest('a') || idStartBtn.closest('li') || idStartBtn;
            clickable.click();
            return true;
        }
        return false;
    });

    if (clickedIdStart) {
        log('??"?„ì´?”ë¡œ ?œì‘?˜ê¸°" ?´ë¦­ ?„ë£Œ');
        await delay(1500); // ?¼ìœ¼ë¡??„í™˜???Œê¹Œì§€ ì¶©ë¶„???€ê¸?    } else {
        log('? ï¸ "?„ì´?”ë¡œ ?œì‘?˜ê¸°" ë²„íŠ¼??ì°¾ì„ ???†ìŠµ?ˆë‹¤. ?´ë? ?¼ì´ ?´ë ¤?ˆë‹¤ê³?ê°€?•í•©?ˆë‹¤.');
    }
    
    // 2. ëª¨ë‹¬ ?„í™˜ ???íƒœ ìº¡ì²˜
    try { await page.screenshot({ path: path.join(publicDir, 'debug2.png') }); } catch(e){}
    
    let loginSuccess = false;
    for (let i = 0; i < 10; i++) {
        if (global.manualMode) {
            log('?›‘ ?˜ë™ ì¡°ì‘ ëª¨ë“œ ?œì„±?”ë¨. ë´‡ì´ ?…ë ¥??ë©ˆì¶”ê³??¬ìš©?ì˜ ?…ë ¥??ê¸°ë‹¤ë¦½ë‹ˆ??..');
            const isLoginModalOpen = await page.evaluate(() => {
                const input = document.querySelector('input[type="password"]');
                return input && input.offsetWidth > 0;
            });

            if (!isLoginModalOpen) {
                log('???˜ë™ ë¡œê·¸???±ê³µ ê°ì?!');
                loginSuccess = true;
                break;
            }
            await delay(2000);
            i--; // ?˜ë™ ëª¨ë“œ?ì„œ??ë°˜ë³µ ?Ÿìˆ˜ë¥??Œì§„?˜ì? ?ŠìŒ (ë¬´í•œ ?€ê¸?
            continue;
        }

        log(`?‘‰ ?„ì´??ë¹„ë?ë²ˆí˜¸ ?¤ì´?°ë¸Œ ?…ë ¥ ?œë„ (${i + 1}/10)`);
        
        let idTyped = false;
        const idInputs = await page.$$('input[name="id"], input[placeholder*="?„ì´??], input[type="email"]');
        for (const el of idInputs) {
            if (await el.evaluate(e => e.offsetWidth > 0)) {
                await el.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await delay(100);
                await el.type(BUBEE_ID, { delay: 100 });
                idTyped = true;
                break;
            }
        }
        
        let pwTyped = false;
        const pwInputs = await page.$$('input[type="password"]');
        for (const el of pwInputs) {
            if (await el.evaluate(e => e.offsetWidth > 0)) {
                await el.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await delay(100);
                await el.type(BUBEE_PW, { delay: 100 });
                pwTyped = true;
                break;
            }
        }
        
        if (idTyped && pwTyped) {
            await delay(500);
            
            // ?? ëª¨ë‹¬ ì°??ˆì˜ ìµœì¢… "ë¡œê·¸?? ë²„íŠ¼ ì°¾ì•„??Puppeteer ?¤ì´?°ë¸Œ ?´ë¦­
            const btns = await page.$$('button, div, span');
            for (const btn of btns) {
                const isTarget = await btn.evaluate(b => {
                    if (!b.innerText) return false;
                    const txt = b.innerText.trim();
                    return txt === 'ë¡œê·¸?? && b.offsetHeight > 0 && b.closest('header') === null;
                });
                
                if (isTarget) {
                    await btn.evaluate(b => {
                        const clickable = b.closest('button') || b;
                        clickable.removeAttribute('disabled');
                        clickable.style.pointerEvents = 'auto';
                    });
                    
                    try {
                        await btn.click();
                        log('??ëª¨ë‹¬ ë¡œê·¸??ë²„íŠ¼ ?¤ì´?°ë¸Œ ?´ë¦­ ?„ë£Œ');
                    } catch(e) {
                        log('? ï¸ ?¤ì´?°ë¸Œ ?´ë¦­ ?¤íŒ¨, JS ?´ë¦­ ?œë„');
                        await btn.evaluate(b => (b.closest('button')||b).click());
                    }
                    break;
                }
            }
            
            await delay(500);
            await page.keyboard.press('Enter');
            await delay(3000); // ë¡œê·¸??ì²˜ë¦¬ ?€ê¸?            
            const isLoginModalOpen = await page.evaluate(() => {
                const input = document.querySelector('input[type="password"]');
                return input && input.offsetWidth > 0;
            });

            if (!isLoginModalOpen) {
                loginSuccess = true;
                break;
            }
        }
        await delay(1000);
    }
    
    // 4. ë¡œê·¸???œë„ ??ìµœì¢… ?íƒœ ìº¡ì²˜
    try { await page.screenshot({ path: path.join(publicDir, 'debug4.png') }); } catch(e){}
    
    if (!loginSuccess) {
        log('??[ì¹˜ëª…???¤ë¥˜] ?„ì´??ë¹„ë?ë²ˆí˜¸ ?…ë ¥ ?¼ì„ ì°¾ì? ëª»í–ˆê±°ë‚˜ ë¡œê·¸?¸ì´ ê±°ë??˜ì—ˆ?µë‹ˆ?? (ìº¡ì°¨ ??');
    } else {
        log('???„ì´??ë¹„ë?ë²ˆí˜¸ ?…ë ¥ ë°?ë¡œê·¸??ìµœì¢… ?µê³¼!');
    }

    return loginSuccess;
}

// ============================================================
// ë©”ì¸
// ============================================================
async function main() {
    log('============================================================');
    log('?? ë¶€ë¹„ë¼?´ë¸Œ ?˜ì´ë¸Œë¦¬??AI ë§¤í¬ë¡?(?€?œë³´???¬í•¨)');
    log('============================================================');

    if (!BUBEE_ID || !BUBEE_PW) {
        log('??BUBEE_ID, BUBEE_PW ?˜ê²½ë³€?˜ê? ?†ìŠµ?ˆë‹¤.');
        return;
    }

    loadConfig();
    startDashboard();

    const userscriptContent = fs.readFileSync(path.join(__dirname, 'userscript.js'), 'utf8');

    log('?Œ ë¸Œë¼?°ì? ?”ì§„ ?œì‘ ì¤?..');
    const browser = await puppeteer.launch({
        executablePath: CHROME_EXE,
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', '--disable-gpu',
            '--window-size=1280,720'
        ]
    });
    
    // ?? ì¿ í‚¤(Cookie) ?„ë¦¬?¨ìŠ¤ ?¥ì°©!
    try {
        const cookiePath = path.join(__dirname, 'cookies.json');
        if (fs.existsSync(cookiePath)) {
            let cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
            cookies = cookies.map(c => ({ ...c, url: CONFIG.siteBase }));
            const pages = await browser.pages();
            await pages[0].setCookie(...cookies);
            log(`??[ì¿ í‚¤ ?„ë¦¬?¨ìŠ¤] ?…ì¥ê¶?Cookie) ?¥ì°© ?„ë£Œ! ?´ì œ ë¡œê·¸???”ë©´ ?†ì´ ë¬´ì  ?íƒœë¡??ŒíŒŒ?©ë‹ˆ??`);
        } else {
            log(`? ï¸ [ì¿ í‚¤ ?„ë½] cookies.json ?Œì¼???†ìŠµ?ˆë‹¤! (ë¹„ë¡œê·¸ì¸ ?íƒœë¡?ì§„ì…?©ë‹ˆ??`);
        }
    } catch(e) { log(`??[ì¿ í‚¤ ?ëŸ¬] ${e.message}`); }

    const activeRooms = new Map();
    global.activeRooms = activeRooms;

    async function openRoom(vod_key, bj_name, user_key) {
        if (activeRooms.has(vod_key)) return;
        log(`?Ÿ¢ [?…ì¥] ë°©ì†¡ ?‘ì† ?œì‘: ${bj_name} (ë°©ë²ˆ?? ${vod_key})`);
        
        // ?€ê²??¤ì • ì°¾ê¸° (user_key ?ëŠ” vod_key ë§¤ì¹­)
        const target = targets.find(t => t.id === vod_key || (user_key && t.id === user_key)) || {};
        const defaultSettings = { autoWelcome: false, autoAttendance: false, enableCommands: true };
        const settings = { ...defaultSettings, ...(target.settings || {}) };

        const p = await browser.newPage();
        global.livePage = p;
        await p.setViewport({ width: 1280, height: 720 });
        
        // ?? ë°??…ì¥ ?œì—??ì¿ í‚¤ ê°•ì œ ?¥ì°© ë°?LocalStorage ì£¼ì… (SPA ?¼ìš°???°íšŒ)
        try {
            const cookiePath = path.join(__dirname, 'cookies.json');
            if (fs.existsSync(cookiePath)) {
                let cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
                // Puppeteerê°€ ì¿ í‚¤ë¥?ë¬´ì‹œ?˜ì? ?Šë„ë¡?url ëª…ì‹œ
                cookies = cookies.map(c => ({ ...c, url: CONFIG.siteBase }));
                await p.setCookie(...cookies);
                
                // ?„ë¡ ?¸ì—”??Vue/React)ê°€ LocalStorageë¥?ê²€?¬í•´???•ê²¨?´ëŠ” ê²ƒì„ ë°©ì?
                await p.evaluateOnNewDocument((cookieData) => {
                    cookieData.forEach(c => {
                        localStorage.setItem(c.name, c.value);
                        if (c.name === 'auth_token' && c.value.startsWith('Bearer ')) {
                            localStorage.setItem('token', c.value.replace('Bearer ', ''));
                        }
                    });
                }, cookies);
            }
        } catch(e) { log(`[ì¿ í‚¤ ì£¼ì… ?ëŸ¬] ${e.message}`); }
        
        await p.setRequestInterception(true);
        p.on('request', req => {
            const rt = req.resourceType();
            const u = req.url().toLowerCase();
            if (rt === 'media' || u.endsWith('.ts') || u.endsWith('.m3u8')) req.abort();
            else req.continue();
        });

        // ?? ?€?œë³´???¤ì •??ë¸Œë¼?°ì? ì»¨í…?¤íŠ¸ë¡?ì£¼ì…
        await p.evaluateOnNewDocument(`window.BOT_SETTINGS = ${JSON.stringify(settings)};`);
        await p.evaluateOnNewDocument(userscriptContent);
        
        p.on('console', msg => {
            const t = msg.text();
            if (t.includes('WebGL') || t.includes('favicon')) return;
            if (t.includes('[ë¶€ë¹„ë¼?´ë¸Œ ?¬í¼]') || t.includes('[?„ì†¡ ?„ë£Œ]') || t.includes('[?€ê¸°ì—´ ì¶”ê?]')) {
                log(`[ë°?${vod_key} ë¡œë´‡] ${t}`);
            }
        });

        try { await p.goto(`${CONFIG.siteBase}/lives/play/${vod_key}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch(e) { }
        activeRooms.set(vod_key, p);
    }

    async function closeRoom(vod_key) {
        if (!activeRooms.has(vod_key)) return;
        log(`?”´ [ì¢…ë£Œ] ë°©ì†¡ ì¢…ë£Œ ê°ì?. ??„ ?«ìŠµ?ˆë‹¤. (ë°©ë²ˆ?? ${vod_key})`);
        const p = activeRooms.get(vod_key);
        try { await p.close(); } catch(e) {}
        activeRooms.delete(vod_key);
    }

    log('?“¡ API ëª¨ë‹ˆ?°ë§ ?œì‘ (30ì´?ì£¼ê¸°)');
    setInterval(async () => {
        try {
            const data = await fetchLiveList();
            if (!data.vod_list) {
                log(`[ê²½ê³ ] API ?‘ë‹µ??vod_listê°€ ?†ìŠµ?ˆë‹¤! ?‘ë‹µ ?´ìš©: ${JSON.stringify(data).substring(0, 200)}`);
                return;
            }
            const lives = data.vod_list || [];
            
            const currentLiveVodKeys = new Set();
            const targetVodKeys = targets.filter(t => t.type === 'vod_key').map(t => t.id);
            const targetUserKeys = targets.filter(t => t.type === 'user_key').map(t => t.id);
            
            lives.forEach(v => {
                if (v.v_state === 1 && !v.v_end_date) {
                    if (targetVodKeys.includes(v.vod_key) || targetUserKeys.includes(v.user_key)) {
                        currentLiveVodKeys.add(v.vod_key);
                        if (!activeRooms.has(v.vod_key)) {
                            openRoom(v.vod_key, v.v_subject || v.user_key, v.user_key);
                        }
                    }
                }
            });

            for (const activeVodKey of activeRooms.keys()) {
                if (!currentLiveVodKeys.has(activeVodKey)) {
                    await closeRoom(activeVodKey);
                }
            }
        } catch (e) {
            log(`??ëª¨ë‹ˆ?°ë§ API ?¤ë¥˜: ${e.message}`);
        }
    }, CONFIG.checkIntervalMs);
}

process.on('unhandledRejection', e => log(`[ê²½ê³ ] ë¬´ì‹œ???ëŸ¬: ${e.message}`));
process.on('uncaughtException', e => log(`[ê²½ê³ ] ?¬ê°???ëŸ¬: ${e.message}`));

main().catch(e => { console.error(e); });
