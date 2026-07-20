
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

// Railway Volume 등 영구 저장소 지원 (존재하면 사용, 없으면 __dirname)
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ============================================================
// 설정
// ============================================================
const { BUBEE_ID, BUBEE_PW, TARGET_VOD_KEYS, TARGET_USER_KEYS, CHECK_INTERVAL_SEC, BUBEE_ROOM_ID, PORT } = process.env;

const CONFIG = {
    checkIntervalMs: (parseInt(CHECK_INTERVAL_SEC) || 30) * 1000,
    apiBase: 'https://api.bubeelive.com/v2/sites/2',
    siteBase: 'https://www.bubeelive.com',
    port: PORT || 8080,
    configPath: CONFIG_FILE
};

const CHROME_EXE = process.platform === 'win32'
  ? (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') 
     ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' 
     : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  : process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

// ============================================================
// 유틸리티
// ============================================================
const delay = ms => new Promise(res => setTimeout(res, ms));
function log(msg) {
    const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    console.log(`[${time}] ${msg}`);
}

// ============================================================
// 쿠키 자동 갱신 (백그라운드 탭을 이용한 자연 갱신)
// ============================================================
// 기존의 강제 API 호출 방식은 서버 갱신 주소 변경 등으로 막힐 수 있으므로,
// 브라우저 백그라운드에 메인화면을 띄워두고 새로고침하여 사이트 자체 로직으로 갱신을 유도합니다.



// ============================================================
// 타겟 설정 로드/저장 (환경변수 + 파일)
// ============================================================
let targets = []; // Array of { id: Number, name: String, type: 'vod_key' | 'user_key' }
const activeRooms = new Map(); // vod_key -> Page

function loadConfig() {
    // 1. 환경변수 기반 기본 설정 로드
    const envVodKeys = (TARGET_VOD_KEYS || BUBEE_ROOM_ID || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
    const envUserKeys = (TARGET_USER_KEYS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
    
    const initialTargets = [];
    envVodKeys.forEach(id => initialTargets.push({ id, name: `환경변수 방(${id})`, type: 'vod_key' }));
    envUserKeys.forEach(id => initialTargets.push({ id, name: `환경변수 BJ(${id})`, type: 'user_key' }));

    // 2. 파일 기반 설정 로드
    if (fs.existsSync(CONFIG.configPath)) {
        try {
            const fileData = JSON.parse(fs.readFileSync(CONFIG.configPath, 'utf8'));
            targets = fileData;
        } catch (e) {
            log('⚠️ config.json 파싱 에러, 파일 설정을 초기화합니다.');
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
        log('❌ config.json 저장 실패: ' + e.message);
    }
}

// ============================================================
// Express 웹 대시보드 서버
// ============================================================
function startDashboard() {
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());
    
    // 정적 파일 서빙 (UI)
    app.use(express.static(path.join(__dirname, 'public')));

    // 현재 타겟 목록 조회
    app.get('/api/targets', (req, res) => {
        res.json({
            targets: targets,
            activeRooms: Array.from(activeRooms.keys())
        });
    });

    // 타겟 추가
    app.post('/api/targets', async (req, res) => {
        let { id, name, type, settings } = req.body;
        if (!id || !name || !type) return res.status(400).json({ message: '파라미터 누락' });
        
        // 🚀 편의 기능: 사용자가 방번호(vod_key)를 입력해도, 자동으로 평생 고유 ID(user_key)로 변환해주는 로직!
        if (type === 'vod_key') {
            try {
                const url = `${CONFIG.apiBase}/vod/live-list?link_cd=ALL&offset=0&limit=100`;
                const headers = { 'x-user-agent': 'kpoplive_app/DESKTOP/PG/1.0.0/kr/ko/N/10' };
                try {
                    const cookiePath = path.join(__dirname, 'cookies.json');
                    if (fs.existsSync(cookiePath)) {
                        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
                        const token = cookies.find(c => c.name === 'auth_token');
                        if (token) headers['Authorization'] = token.value;
                    }
                } catch(e) {}
                
                const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
                const data = await response.json();
                const targetLive = (data.vod_list || []).find(l => String(l.vod_key) === String(id));
                
                if (targetLive && targetLive.user_key) {
                    // 찾았다면 user_key 모드로 강제 변경하고 저장
                    log(`💡 방번호(${id})에서 유저 고유 ID(${targetLive.user_key}) 자동 추출 성공!`);
                    id = targetLive.user_key;
                    type = 'user_key';
                    if (name === '홍길동' || !name) name = targetLive.bj_nick || targetLive.v_subject || name; // 이름도 자동 완성
                } else {
                    return res.status(400).json({ message: '현재 라이브 중인 방송이 아니거나 유효하지 않은 방 번호입니다.' });
                }
            } catch (e) {
                log('API 조회 실패로 변환 생략: ' + e.message);
                return res.status(500).json({ message: '부비라이브 서버 응답이 없습니다. 잠시 후 다시 시도해주세요.' });
            }
        }

        // 중복 체크
        if (targets.find(t => t.id === Number(id))) {
            return res.status(400).json({ message: '이미 등록된 ID입니다.' });
        }

        // 기본 설정값이 없다면 강제 주입
        const defaultSettings = { autoAttendance: true, autoWelcome: true, enableCommands: true };
        const targetSettings = settings || defaultSettings;

        targets.push({ id: Number(id), name, type, settings: targetSettings });
        saveConfig();
        log(`✅ 대시보드에서 타겟 추가됨: ${name} (${id} / ${type})`);
        res.json({ success: true });
    });

    // 타겟 삭제
    app.delete('/api/targets/:id', async (req, res) => {
        const id = Number(req.params.id);
        const idx = targets.findIndex(t => t.id === id);
        if (idx !== -1) {
            const target = targets[idx];
            log(`🗑️ 대시보드에서 타겟 삭제됨: ${target.name} (${id})`);
            
            // 삭제 시 현재 봇이 들어가 있는 방이 있다면 강제로 나오기
            let targetVodKey = null;
            if (target.type === 'vod_key') targetVodKey = target.id;
            else {
                // user_key인 경우 현재 켜져있는 활성 방들 중에서 찾아서 닫음
                for (const [vKey, page] of activeRooms.entries()) {
                    // page 객체나 상태에 따라 다르지만, 가장 안전한 건 모니터링 루프가 다시 못 들어가게 activeRooms에서 빼는 것
                    // 현재 activeRooms에는 p (Page 객체)가 저장되어 있음.
                    if (page && !page.isClosed()) {
                        try {
                            await page.close();
                            log(`🚪 타겟 삭제로 인해 방송방(${vKey})에서 강제 퇴장했습니다.`);
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
                        log(`🚪 타겟 삭제로 인해 방송방(${targetVodKey})에서 강제 퇴장했습니다.`);
                    } catch(e){}
                }
                activeRooms.delete(targetVodKey);
            }

            targets.splice(idx, 1);
            saveConfig();
        }
        res.json({ success: true });
    });

    // 🚀 [디버깅] 현재 방송방 화면 캡처 엔드포인트 추가
    app.get('/api/debug/screenshot', async (req, res) => {
        if (activeRooms.size === 0) {
            return res.status(404).send('현재 입장한 방이 없습니다.');
        }
        try {
            // 첫 번째 방의 페이지 객체 가져오기
            const firstRoomKey = activeRooms.keys().next().value;
            const page = activeRooms.get(firstRoomKey);
            if (!page || page.isClosed()) {
                return res.status(500).send('페이지가 이미 닫혔습니다.');
            }
            const screenshotBuffer = await page.screenshot({ type: 'png' });
            res.set('Content-Type', 'image/png');
            res.send(screenshotBuffer);
        } catch (e) {
            res.status(500).send('스크린샷 캡처 실패: ' + e.message);
        }
    });

    // 타겟 개별 설정 변경
    app.patch('/api/targets/:id/settings', (req, res) => {
        const idStr = String(req.params.id);
        const idx = targets.findIndex(t => String(t.id) === idStr);
        if (idx !== -1) {
            if (!targets[idx].settings) {
                targets[idx].settings = { autoWelcome: false, autoAttendance: false, enableCommands: true };
            }
            targets[idx].settings = { ...targets[idx].settings, ...req.body };
            saveConfig();
            log(`⚙️ 설정 변경됨: ${targets[idx].name} (${idStr}) -> ${JSON.stringify(req.body)}`);
            
            // 🔥 활성화된 방이 있다면 실시간으로 설정 주입
            if (global.activeRooms) {
                for (const [vod_key, p] of global.activeRooms.entries()) {
                    if ((String(vod_key) === idStr || String(p.user_key) === idStr) && !p.isClosed()) {
                        p.evaluate((newSettings) => {
                            if (typeof window.updateBotSettings === 'function') {
                                window.updateBotSettings(newSettings);
                            } else {
                                window.BOT_SETTINGS = newSettings;
                            }
                        }, targets[idx].settings).catch(e => log(`실시간 설정 동기화 실패: ${e.message}`));
                        log(`⚡ [방 ${vod_key}] 변경된 설정을 봇에게 실시간으로 전송 완료!`);
                    }
                }
            }

            res.json({ success: true, settings: targets[idx].settings });
        } else {
            res.status(404).json({ message: '타겟을 찾을 수 없습니다.' });
        }
    });

    app.use(express.json());

    app.get('/live', (req, res) => {
        res.send(`
            <html>
                <head>
                    <title>부비라이브 봇 실시간 제어</title>
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
                            alert('수동 조작 모드가 켜졌습니다! 봇이 타이핑을 멈추고 대기합니다.');
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
                    <h1>🔴 실시간 CCTV 및 원격 제어</h1>
                    <div class="controls">
                        <button class="manual-btn" onclick="toggleManual()">🛑 수동 조작 모드 켜기 (봇 멈춤)</button><br><br>
                        <input type="text" id="kb-input" placeholder="봇에게 보낼 글자 입력..." />
                        <button onclick="sendText()">입력 전송</button>
                        <button onclick="sendKey('Backspace')">지우기(Back)</button>
                        <button onclick="sendKey('Enter')">엔터(Enter)</button>
                    </div>
                    <p style="color: yellow;">💡 아래 화면을 클릭하면 봇의 마우스가 똑같이 클릭합니다!</p>
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
        log(`🌐 웹 대시보드 서버 오픈: http://localhost:${CONFIG.port}`);
        log(`🔴 실시간 CCTV 원격제어: http://localhost:${CONFIG.port}/live`);
    });
}

// ============================================================
// API 통신 (경량 폴링)
// ============================================================
function fetchLiveList() {
    return new Promise((resolve, reject) => {
        const headers = {
            'x-user-agent': 'kpoplive_app/DESKTOP/PG/1.0.0/kr/ko/N/10',
            'Accept': 'application/json',
            'Referer': CONFIG.siteBase + '/',
            'Origin': CONFIG.siteBase
        };
        const fetchCookies = async () => {
            try {
                if (global.bgPage && !global.bgPage.isClosed()) {
                    const cookies = await global.bgPage.cookies();
                    const token = cookies.find(c => c.name === 'auth_token');
                    if (token) {
                        headers['Authorization'] = decodeURIComponent(token.value);
                        return;
                    }
                }
                let cookiePath = path.join(DATA_DIR, 'cookies.json');
                const defaultCookiePath = path.join(__dirname, 'cookies.json');
                
                let rawCookies = [];
                if (fs.existsSync(cookiePath)) {
                    rawCookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
                }
                
                if (!rawCookies.find(c => c.name === 'auth_token') && fs.existsSync(defaultCookiePath)) {
                    rawCookies = JSON.parse(fs.readFileSync(defaultCookiePath, 'utf8'));
                }
                
                const token = rawCookies.find(c => c.name === 'auth_token');
                if (token) headers['Authorization'] = decodeURIComponent(token.value);
            } catch(e) {}
        };

        fetchCookies().then(() => {
            const url = `${CONFIG.apiBase}/vod/live-list?link_cd=ALL&offset=0&limit=100`;
            https.get(url, { headers, timeout: 10000 }, res => {
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
    });
}

// ============================================================
// 강력한 로그인 로직
// ============================================================
async function doLogin(page) {
    global.livePage = page;
    log('🔐 로그인 시도 중...');

    // 브라우저 내부 동작 모니터링
    page.on('console', msg => log(`[브라우저 콘솔] ${msg.type().toUpperCase()}: ${msg.text()}`));
    page.on('dialog', async dialog => {
        log(`[🚨 브라우저 알림창 🚨] ${dialog.message()}`);
        await dialog.accept();
    });
    page.on('request', request => {
        const url = request.url();
        if (url.includes('login') || url.includes('auth') || url.includes('signin')) {
            log(`[네트워크 요청] ${request.method()} ${url}`);
        }
    });
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('login') || url.includes('auth') || url.includes('signin')) {
            log(`[네트워크 응답] ${response.status()} ${url}`);
            try {
                const text = await response.text();
                log(`[응답 내용] ${text.substring(0, 500)}`);
            } catch(e) {}
        }
    });
    const publicDir = path.join(__dirname, 'public');
    
    try { await page.goto(`${CONFIG.siteBase}`, { waitUntil: 'networkidle2', timeout: 20000 }); } catch (e) {}
    await delay(3000);
    log('🔍 로그인 옵션 탐색 중...');

    // 1. 메인 화면 상태 캡처
    try { await page.screenshot({ path: path.join(publicDir, 'debug1.png') }); } catch(e){}

    // 확실한 네이티브 마우스 클릭으로 로그인 버튼(헤더) 누르기
    try {
        await page.click('.btn-login');
        log('👉 메인 로그인 버튼 클릭 완료');
    } catch(e) {
        log('⚠️ btn-login 클래스를 찾을 수 없습니다. 자바스크립트 클릭 시도');
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a, div, li, span'));
            const loginBtn = btns.find(e => e.innerText && e.innerText.includes('로그인') && !e.innerText.includes('카카오') && e.offsetHeight > 0);
            if (loginBtn) loginBtn.click();
        });
    }

    await delay(2000);
    
    // 🚀 부비라이브 신규 로그인 UI 대응: "아이디로 시작하기" 버튼 클릭
    log('👉 로그인 수단 선택: "아이디로 시작하기" 찾는 중...');
    const clickedIdStart = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, div, li, span')).reverse();
        const idStartBtn = els.find(e => {
            if (!e.innerText) return false;
            const txt = e.innerText.replace(/\n/g, '').replace(/\s+/g, ' ');
            // 부모 모달 전체가 선택되는 것을 방지 (텍스트 길이 제한)
            return txt.includes('아이디로 시작하기') && !txt.includes('카카오') && e.offsetHeight > 0 && txt.length < 30;
        });
        if (idStartBtn) {
            const clickable = idStartBtn.closest('button') || idStartBtn.closest('a') || idStartBtn.closest('li') || idStartBtn;
            clickable.click();
            return true;
        }
        return false;
    });

    if (clickedIdStart) {
        log('✅ "아이디로 시작하기" 클릭 완료');
        await delay(1500); // 폼으로 전환될 때까지 충분히 대기
    } else {
        log('⚠️ "아이디로 시작하기" 버튼을 찾을 수 없습니다. 이미 폼이 열려있다고 가정합니다.');
    }
    
    // 2. 모달 전환 후 상태 캡처
    try { await page.screenshot({ path: path.join(publicDir, 'debug2.png') }); } catch(e){}
    
    let loginSuccess = false;
    for (let i = 0; i < 10; i++) {
        if (global.manualMode) {
            log('🛑 수동 조작 모드 활성화됨. 봇이 입력을 멈추고 사용자의 입력을 기다립니다...');
            const isLoginModalOpen = await page.evaluate(() => {
                const input = document.querySelector('input[type="password"]');
                return input && input.offsetWidth > 0;
            });

            if (!isLoginModalOpen) {
                log('✅ 수동 로그인 성공 감지!');
                loginSuccess = true;
                break;
            }
            await delay(2000);
            i--; // 수동 모드에서는 반복 횟수를 소진하지 않음 (무한 대기)
            continue;
        }

        log(`👉 아이디/비밀번호 네이티브 입력 시도 (${i + 1}/10)`);
        
        let idTyped = false;
        const idInputs = await page.$$('input[name="id"], input[placeholder*="아이디"], input[type="email"]');
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
            
            // 🚀 모달 창 안의 최종 "로그인" 버튼 찾아서 Puppeteer 네이티브 클릭
            const btns = await page.$$('button, div, span');
            for (const btn of btns) {
                const isTarget = await btn.evaluate(b => {
                    if (!b.innerText) return false;
                    const txt = b.innerText.trim();
                    return txt === '로그인' && b.offsetHeight > 0 && b.closest('header') === null;
                });
                
                if (isTarget) {
                    await btn.evaluate(b => {
                        const clickable = b.closest('button') || b;
                        clickable.removeAttribute('disabled');
                        clickable.style.pointerEvents = 'auto';
                    });
                    
                    try {
                        await btn.click();
                        log('✅ 모달 로그인 버튼 네이티브 클릭 완료');
                    } catch(e) {
                        log('⚠️ 네이티브 클릭 실패, JS 클릭 시도');
                        await btn.evaluate(b => (b.closest('button')||b).click());
                    }
                    break;
                }
            }
            
            await delay(500);
            await page.keyboard.press('Enter');
            await delay(3000); // 로그인 처리 대기
            
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
    
    // 4. 로그인 시도 후 최종 상태 캡처
    try { await page.screenshot({ path: path.join(publicDir, 'debug4.png') }); } catch(e){}
    
    if (!loginSuccess) {
        log('❌ [치명적 오류] 아이디/비밀번호 입력 폼을 찾지 못했거나 로그인이 거부되었습니다! (캡차 등)');
    } else {
        log('✅ 아이디/비밀번호 입력 및 로그인 최종 통과!');
    }

    return loginSuccess;
}

// ============================================================
// 메인
// ============================================================
async function main() {
    log('============================================================');
    log('🚀 부비라이브 하이브리드 AI 매크로 (대시보드 포함)');
    log('============================================================');

    if (!BUBEE_ID || !BUBEE_PW) {
        log('❌ BUBEE_ID, BUBEE_PW 환경변수가 없습니다.');
        return;
    }

    loadConfig();
    startDashboard();

    const userscriptContent = fs.readFileSync(path.join(__dirname, 'userscript.js'), 'utf8');

    log('🌐 브라우저 엔진 시작 중...');
    global.browser = await puppeteer.launch({
        executablePath: CHROME_EXE,
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', '--disable-gpu',
            '--window-size=1280,720'
        ]
    });
    
    // 🚀 쿠키(Cookie) 프리패스 장착!
    try {
        let cookiePath = path.join(DATA_DIR, 'cookies.json');
        const defaultCookiePath = path.join(__dirname, 'cookies.json');
        
        let rawCookies = [];
        if (fs.existsSync(cookiePath)) {
            rawCookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
        }
        
        if (!rawCookies.find(c => c.name === 'auth_token') && fs.existsSync(defaultCookiePath)) {
            rawCookies = JSON.parse(fs.readFileSync(defaultCookiePath, 'utf8'));
        }
        
        if (rawCookies.length > 0) {
            let cookies = rawCookies.map(c => ({ ...c, url: CONFIG.siteBase }));
            
            // 메인 백그라운드 탭 생성 (자동 갱신용)
            global.bgPage = await global.browser.newPage();
            await global.bgPage.setCookie(...cookies);
            await global.bgPage.goto(CONFIG.siteBase, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
            log(`✅ [쿠키 프리패스] 입장권(Cookie) 장착 완료! 백그라운드 무한 연장 엔진 가동!`);
            
            // 10분마다 새로고침하여 부비라이브 자체 로직이 토큰을 자동 연장하도록 유도
            setInterval(async () => {
                try { 
                    if (global.bgPage && !global.bgPage.isClosed()) {
                        await global.bgPage.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                        // 🚀 최신 쿠키 백업 (로그아웃 된 상태면 덮어쓰지 않음)
                        const currentCookies = await global.bgPage.cookies();
                        if (currentCookies.find(c => c.name === 'auth_token')) {
                            fs.writeFileSync(path.join(DATA_DIR, 'cookies.json'), JSON.stringify(currentCookies, null, 2));
                            log('🔄 [토큰 생명 연장] 백그라운드 탭 새로고침 및 최신 쿠키 백업 완료');
                        } else {
                            log('⚠️ [토큰 백업 실패] 백그라운드 탭 로그아웃 감지! 볼륨 덮어쓰기를 방지합니다.');
                        }
                    }
                } catch(e) { log('⚠️ 백그라운드 탭 새로고침 지연: ' + e.message); }
            }, 10 * 60 * 1000);
            
        } else {
            log(`⚠️ [쿠키 누락] cookies.json 파일이 없습니다! (비로그인 상태로 진입합니다)`);
        }
    } catch(e) { log(`❌ [쿠키 에러] ${e.message}`); }

    const activeRooms = new Map();
    global.activeRooms = activeRooms;

    async function openRoom(vod_key, bj_name, user_key) {
        if (activeRooms.has(vod_key)) return;
        log(`🟢 [입장] 방송 접속 시작: ${bj_name} (방번호: ${vod_key})`);
        
        // 타겟 설정 찾기 (user_key 또는 vod_key 매칭)
        const target = targets.find(t => t.id === vod_key || (user_key && t.id === user_key)) || {};
        const defaultSettings = { autoWelcome: false, autoAttendance: false, enableCommands: true };
        const settings = { ...defaultSettings, ...(target.settings || {}) };

        const p = await global.browser.newPage();
        global.livePage = p;
        await p.setViewport({ width: 1280, height: 720 });
        
        // 🚀 방 입장 시에도 쿠키 강제 장착 및 LocalStorage 주입 (SPA 라우터 우회)
        try {
            const cookiePath = path.join(__dirname, 'cookies.json');
            if (fs.existsSync(cookiePath)) {
                let cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
                // Puppeteer가 쿠키를 무시하지 않도록 url 명시
                cookies = cookies.map(c => ({ ...c, url: CONFIG.siteBase }));
                await p.setCookie(...cookies);
                
                // 프론트엔드(Vue/React)가 LocalStorage를 검사해서 튕겨내는 것을 방지
                await p.evaluateOnNewDocument((cookieData) => {
                    cookieData.forEach(c => {
                        localStorage.setItem(c.name, c.value);
                        if (c.name === 'auth_token' && c.value.startsWith('Bearer ')) {
                            localStorage.setItem('token', c.value.replace('Bearer ', ''));
                        }
                    });
                }, cookies);
            }
        } catch(e) { log(`[쿠키 주입 에러] ${e.message}`); }
        
        await p.setRequestInterception(true);
        p.on('request', req => {
            const rt = req.resourceType();
            const u = req.url().toLowerCase();
            if (rt === 'media' || u.endsWith('.ts') || u.endsWith('.m3u8')) req.abort();
            else req.continue();
        });

        // 🚀 대시보드 설정 및 서버 영구 DB를 브라우저 컨텍스트로 주입
        const roomDbKey = user_key || vod_key;
        const dbPath = path.join(DATA_DIR, `db_${roomDbKey}.json`);
        
        // 🚀 긴급 마이그레이션: 기존 vod_key DB의 데이터를 user_key DB로 병합 (1회성)
        if (user_key) {
            const oldDbPath = path.join(DATA_DIR, `db_${vod_key}.json`);
            const migratedFlag = path.join(DATA_DIR, `db_${vod_key}_migrated.json`);
            if (fs.existsSync(oldDbPath) && !fs.existsSync(migratedFlag)) {
                try {
                    let oldData = JSON.parse(fs.readFileSync(oldDbPath, 'utf8'));
                    let newData = {};
                    if (fs.existsSync(dbPath)) {
                        newData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                    }
                    // 병합 (기존 vod_key에 있던 프로필, 미션 등 보존, 겹치면 새 데이터 우선)
                    newData.settings = { ...(oldData.settings || {}), ...(newData.settings || {}) };
                    // 새 데이터가 비어있을 때만 옛날 데이터 가져옴
                    if (!newData.settings.bjProfileText && oldData.settings?.bjProfileText) {
                        newData.settings.bjProfileText = oldData.settings.bjProfileText;
                    }
                    newData.missions = (newData.missions && newData.missions.length) ? newData.missions : (oldData.missions || []);
                    newData.keeps = (newData.keeps && newData.keeps.length) ? newData.keeps : (oldData.keeps || []);
                    newData.notices = (newData.notices && newData.notices.length) ? newData.notices : (oldData.notices || []);
                    
                    fs.writeFileSync(dbPath, JSON.stringify(newData, null, 2));
                    fs.writeFileSync(migratedFlag, 'done'); // 마이그레이션 완료 표시
                    log(`📦 [마이그레이션] 구버전 DB(${vod_key}) 데이터를 신규 DB(${user_key})에 성공적으로 병합했습니다!`);
                } catch(e) {
                    log(`❌ 마이그레이션 실패: ${e.message}`);
                }
            }
        }

        let initialDB = null;
        if (fs.existsSync(dbPath)) {
            try { initialDB = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch(e){}
        }

        await p.evaluateOnNewDocument(`
            window.BOT_SETTINGS = ${JSON.stringify(settings)};
            window.BOT_DB = ${JSON.stringify(initialDB)};
            window.ROOM_KEY = '${roomDbKey}';
        `);

        // 🚀 저장 함수(exposeFunction)
        await p.exposeFunction('saveRoomDB', async (data) => {
            try { fs.writeFileSync(dbPath, JSON.stringify(data, null, 2)); } catch(e) {}
        });
        await p.evaluateOnNewDocument(userscriptContent);
        
        p.on('console', msg => {
            const t = msg.text();
            if (t.includes('WebGL') || t.includes('favicon')) return;
            if (t.includes('[부비라이브 헬퍼]') || t.includes('[전송 완료]') || t.includes('[대기열 추가]')) {
                log(`[방 ${vod_key} 로봇] ${t}`);
            }
        });

        try { await p.goto(`${CONFIG.siteBase}/lives/play/${vod_key}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch(e) { }
        p.user_key = user_key;
        p.vod_key = vod_key;
        activeRooms.set(vod_key, p);
    }

    async function closeRoom(vod_key) {
        if (!activeRooms.has(vod_key)) return;
        log(`🔴 [종료] 방송 종료 감지. 탭을 닫습니다. (방번호: ${vod_key})`);
        const p = activeRooms.get(vod_key);
        try { await p.close(); } catch(e) {}
        activeRooms.delete(vod_key);
    }

    log('📡 API 모니터링 시작 (30초 주기)');
    setInterval(async () => {
        try {
            const data = await fetchLiveList();
            if (!data.vod_list) {
                log(`[경고] API 응답에 vod_list가 없습니다! 응답 내용: ${JSON.stringify(data).substring(0, 200)}`);
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
                            if (global.keptRooms) global.keptRooms.delete(v.vod_key);
                            openRoom(v.vod_key, v.v_subject || v.user_key, v.user_key);
                        }
                    }
                }
            });

            for (const activeVodKey of activeRooms.keys()) {
                if (!currentLiveVodKeys.has(activeVodKey)) {
                    // await closeRoom(activeVodKey); // 🚀 방송이 종료되더라도 봇이 나가지 않도록 주석 처리 (대시보드에서 삭제할 때만 퇴장)
                    if (!global.keptRooms) global.keptRooms = new Set();
                    if (!global.keptRooms.has(activeVodKey)) {
                        log(`[방 유지] 방송(${activeVodKey})이 종료되었지만 봇은 방에 남습니다.`);
                        global.keptRooms.add(activeVodKey);
                    }
                }
            }
        } catch (e) {
            log(`❌ 모니터링 API 오류: ${e.message}`);
        }
    }, CONFIG.checkIntervalMs);
}

process.on('unhandledRejection', e => log(`[경고] 무시된 에러: ${e.message}`));
process.on('uncaughtException', e => log(`[경고] 심각한 에러: ${e.message}`));

main().catch(e => { console.error(e); });
