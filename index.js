
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

    // 로그인 API
    app.post('/api/login', (req, res) => {
        const { id, password } = req.body;
        const masterPw = process.env.MASTER_PASSWORD || 'master1234';
        
        if (id === 'master' && password === masterPw) {
            return res.json({ success: true, role: 'master', token: 'master_token' });
        }
        
        const target = targets.find(t => String(t.id) === String(id));
        if (target && target.password === password) {
            return res.json({ success: true, role: 'bj', token: String(id) });
        }
        
        return res.status(401).json({ message: '아이디 또는 비밀번호가 틀렸습니다.' });
    });

    // 특정 봇 DB 가져오기
    app.get('/api/bot-db/:id', (req, res) => {
        const id = req.params.id;
        const dbPath = path.join(DATA_DIR, `db_${id}.json`);
        if (fs.existsSync(dbPath)) {
            try {
                const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                res.json(db);
            } catch (e) {
                res.status(500).json({ message: 'DB 파싱 에러' });
            }
        } else {
            res.json({});
        }
    });

    // 특정 봇 DB 통째로 덮어쓰기 (클라이언트 대시보드 저장용)
    app.post('/api/bot-db/:id', (req, res) => {
        const id = req.params.id;
        const newDb = req.body;
        const dbPath = path.join(DATA_DIR, `db_${id}.json`);
        try {
            fs.writeFileSync(dbPath, JSON.stringify(newDb, null, 2));
            
            // 실시간 봇(Puppeteer) 뇌에 주입!
            let injected = false;
            if (global.activeRooms) {
                for (const [vod_key, p] of global.activeRooms.entries()) {
                    if ((String(vod_key) === String(id) || String(p.user_key) === String(id)) && !p.isClosed()) {
                        p.evaluate((db) => {
                            if (typeof window.updateBotDB === 'function') {
                                window.updateBotDB(db);
                            }
                        }, newDb).catch(() => {});
                        injected = true;
                    }
                }
            }
            
            res.json({ success: true, injected });
        } catch (e) {
            res.status(500).json({ message: 'DB 저장 실패' });
        }
    });

    // 특정 비제이 비밀번호 변경
    app.put('/api/targets/:id/password', (req, res) => {
        const id = Number(req.params.id);
        const { password } = req.body;
        const target = targets.find(t => t.id === id);
        if (target) {
            target.password = password;
            saveConfig();
            res.json({ success: true });
        } else {
            res.status(404).json({ message: '타겟을 찾을 수 없습니다.' });
        }
    });

    // 현재 타겟 목록 조회
    app.get('/api/targets', (req, res) => {
        const activeIds = new Set();
        for (const [vod_key, p] of activeRooms.entries()) {
            activeIds.add(String(vod_key));
            if (p.user_key) activeIds.add(String(p.user_key));
        }
        res.json({
            targets: targets,
            activeRooms: Array.from(activeIds)
        });
    });

    // 타겟 추가
    app.post('/api/targets', async (req, res) => {
        let { id, name, type, settings, password } = req.body;
        if (!id || !name || !type) return res.status(400).json({ message: '파라미터 누락' });
        
        // 🚀 편의 기능: 사용자가 방번호(vod_key)를 입력해도, 자동으로 평생 고유 ID(user_key)로 변환해주는 로직!
        if (type === 'vod_key') {
            try {
                const url = `${CONFIG.apiBase}/vod/live-list?link_cd=ALL&offset=0&limit=1000`;
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

        targets.push({ id: Number(id), name, type, settings: targetSettings, password: password || '1234' });
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

    const sseClients = new Map();

    app.get('/player/:roomKey', (req, res) => {
        const roomKey = req.params.roomKey;
        res.send(`<!DOCTYPE html>
<html><head><title>BJ 전용 유튜브 플레이어</title>
<style>body{margin:0;background:#000;color:#fff;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;}
#player-container{width:100%;height:100%;max-width:1280px;max-height:720px;display:none;}</style>
</head><body>
<h2 id="status" style="margin:20px;">🎶 대기 중... (채팅창에서 신청곡이 들어오면 자동 재생됩니다)</h2>
<div id="player-container"><div id="player"></div></div>
<script>
    var player;
    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    function onYouTubeIframeAPIReady() {
        player = new YT.Player('player', {
            height: '100%', width: '100%', videoId: '',
            playerVars: { 'autoplay': 1, 'controls': 1 },
            events: { 'onStateChange': onPlayerStateChange, 'onReady': onPlayerReady }
        });
    }

    function onPlayerReady(event) { connectSSE(); }

    function onPlayerStateChange(event) {
        if (event.data == YT.PlayerState.ENDED) {
            fetch('/api/live/music-ended', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ roomKey: '${roomKey}' }) });
            document.getElementById('player-container').style.display = 'none';
            document.getElementById('status').style.display = 'block';
            document.getElementById('status').innerText = "🎶 다음 신청곡을 기다리는 중...";
        }
    }

    function connectSSE() {
        const evtSource = new EventSource('/api/live/music-stream/${roomKey}');
        evtSource.onmessage = function(e) {
            const data = JSON.parse(e.data);
            if (data.type === 'play' && data.videoId) {
                document.getElementById('status').style.display = 'none';
                document.getElementById('player-container').style.display = 'block';
                player.loadVideoById(data.videoId);
            }
        };
        evtSource.onerror = function() { console.log("SSE 에러, 재연결 중..."); };
    }
</script></body></html>`);
    });

    app.get('/api/live/music-stream/:roomKey', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const roomKey = req.params.roomKey;
        sseClients.set(roomKey, res);
        req.on('close', () => { sseClients.delete(roomKey); });
    });

    app.post('/api/live/music-ended', async (req, res) => {
        const { roomKey } = req.body;
        const page = global.activeRooms ? (global.activeRooms.get(roomKey) || global.activeRooms.get(Number(roomKey))) : null;
        if (page && !page.isClosed()) {
            page.evaluate(() => { if (typeof processNextSong === 'function') processNextSong(); }).catch(e=>{});
        }
        res.json({success: true});
    });

    app.post('/api/live/play-music', async (req, res) => {
        const { roomKey, songName } = req.body;
        try {
            const yts = require('yt-search');
            const r = await yts(songName);
            if (r.videos.length > 0) {
                const videoId = r.videos[0].videoId;
                const client = sseClients.get(roomKey) || sseClients.get(String(roomKey));
                if (client) {
                    client.write(`data: ${JSON.stringify({ type: 'play', videoId })}\n\n`);
                    res.json({ success: true, duration: r.videos[0].seconds });
                    return;
                } else {
                    res.json({ success: false, msg: 'BJ가 플레이어 창을 켜지 않았습니다' });
                    return;
                }
            }
            res.json({ success: false, msg: '검색된 영상이 없습니다' });
        } catch (e) {
            res.status(500).json({ success: false, err: e.message });
        }
    });

    app.get('/live', (req, res) => {
        res.send(`<!DOCTYPE html>
<html><head><title>실시간 CCTV</title><meta charset="utf-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:white;font-family:sans-serif;padding:16px}
h1{text-align:center;color:#ff4466;font-size:20px;margin-bottom:12px}
.ctrl{text-align:center;margin-bottom:12px;padding:10px;background:#1a1a1a;border-radius:8px}
.ctrl input{padding:8px;font-size:14px;border-radius:5px;border:none;width:200px;margin:3px}
.ctrl button{padding:8px 12px;font-size:14px;border-radius:5px;border:none;cursor:pointer;background:#44aaff;color:white;font-weight:bold;margin:3px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
.card{background:#1a1a1a;border:2px solid #333;border-radius:10px;overflow:hidden}
.ct{background:#222;padding:9px 13px;font-size:13px;font-weight:bold;color:#ffcc00;display:flex;align-items:center;gap:7px}
.dot{width:9px;height:9px;background:#ff4444;border-radius:50%;animation:blink 1s infinite;flex-shrink:0}
.card img{width:100%;display:block;cursor:crosshair}
.lbl{padding:4px 12px;font-size:11px;color:#666;background:#111}
.bg-card{border-color:#224488}.bg-card .ct{color:#88ccff}.bg-card .dot{background:#4488ff!important}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.empty{text-align:center;color:#555;padding:50px;font-size:15px}
.ts{text-align:center;color:#444;font-size:11px;margin-bottom:8px}
</style></head><body>
<h1>🔴 실시간 CCTV</h1>
<div class="ctrl">
<input id="kb" placeholder="봇에게 보낼 글자...">
<button onclick="sendText()">전송</button>
<button onclick="sendKey('Backspace')">지우기</button>
<button onclick="sendKey('Enter')">엔터</button>
</div>
<div class="ts" id="ts"></div>
<div class="grid" id="grid"><div class="empty">⏳ 로딩 중...</div></div>
<script>
function sendText(){var t=document.getElementById('kb').value;if(!t)return;fetch('/api/live/type',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});document.getElementById('kb').value='';}
function sendKey(a){fetch('/api/live/type',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});}
function sendClick(e,k){var img=e.target,r=img.getBoundingClientRect();fetch('/api/live/click',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:e.clientX-r.left,y:e.clientY-r.top,width:img.clientWidth,height:img.clientHeight,roomKey:k})});}
function refresh(){
    fetch('/api/live/rooms').then(r=>r.json()).then(d=>{
        var g=document.getElementById('grid'), rooms=d.rooms||[];
        if(!rooms.length){g.innerHTML='<div class="empty">봇이 입장한 방 없음</div>';return;}
        if(g.querySelector('.empty')) g.innerHTML='';
        var currentKeys = {}; rooms.forEach(r => currentKeys[r.key] = true);
        Array.from(g.children).forEach(c => { if(!currentKeys[c.dataset.id]) g.removeChild(c); });
        rooms.forEach(r => {
            var card = g.querySelector('[data-id="'+r.key+'"]');
            if(!card) {
                card = document.createElement('div'); card.className = 'card' + (r.type==='bg'?' bg-card':''); card.dataset.id = r.key;
                card.innerHTML = '<div class="ct"><span class="dot"></span>'+r.name+'</div><img onclick="sendClick(event,\\''+r.key+'\\')" onerror="this.style.opacity=.3"><div class="lbl">key:'+r.key+'</div>';
                g.appendChild(card);
            }
            card.querySelector('img').src = '/live-image?room='+r.key+'&t='+Date.now();
        });
        document.getElementById('ts').textContent='갱신:'+new Date().toLocaleTimeString('ko-KR');
    }).catch(()=>{});
}
refresh();setInterval(refresh,3000);
</script></body></html>`);
    });

    app.get('/api/live/rooms', (req, res) => {
        const rooms = [];
        if (global.activeRooms) {
            for (const [vod_key, p] of global.activeRooms.entries()) {
                if (p && !p.isClosed()) rooms.push({ key: String(vod_key), name: p.bjName || p.user_key || String(vod_key), type: 'room' });
            }
        }
        if (global.bgPage && !global.bgPage.isClosed()) rooms.push({ key: 'bg', name: '🌐 메인화면', type: 'bg' });
        res.json({ rooms });
    });

    app.post('/api/live/manual', (req, res) => { global.manualMode = true; res.json({ success: true }); });

    app.post('/api/live/click', async (req, res) => {
        const { x, y, width, height, roomKey } = req.body;
        let page = null;
        if (roomKey === 'bg') page = global.bgPage;
        else if (roomKey && global.activeRooms) page = global.activeRooms.get(roomKey) || global.activeRooms.get(Number(roomKey));
        if (!page || page.isClosed()) page = global.livePage && !global.livePage.isClosed() ? global.livePage : global.bgPage;
        if (page && !page.isClosed()) { try { await page.mouse.click(x*(1280/width), y*(720/height)); } catch(e){} res.json({ success: true }); }
        else res.status(404).json({ success: false });
    });

    app.post('/api/live/type', async (req, res) => {
        const page = global.livePage && !global.livePage.isClosed() ? global.livePage : global.bgPage;
        if (page && !page.isClosed()) {
            const { text, action } = req.body;
            try { if (action) await page.keyboard.press(action); else if (text) await page.keyboard.type(text); } catch(e){}
            res.json({ success: true });
        } else res.status(404).json({ success: false });
    });

    app.get('/live-image', async (req, res) => {
        const roomKey = req.query.room;
        let page = null;
        if (roomKey === 'bg') page = global.bgPage;
        else if (roomKey && global.activeRooms) page = global.activeRooms.get(roomKey) || global.activeRooms.get(Number(roomKey));
        if (!page || page.isClosed()) page = global.livePage && !global.livePage.isClosed() ? global.livePage : global.bgPage;
        if (page && !page.isClosed()) {
            try { const buf = await page.screenshot({ type: 'jpeg', quality: 55 }); res.set('Content-Type', 'image/jpeg'); res.send(buf); }
            catch(e) { res.status(500).send('err'); }
        } else res.status(404).send('not running');
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
            const url = `${CONFIG.apiBase}/vod/live-list?link_cd=ALL&offset=0&limit=1000`;
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
    
    // 공통 헬퍼: 텍스트 포함 요소를 찾아 화면 좌표로 실제 마우스 클릭
    async function clickByText(keywords, options = {}) {
        const { timeout = 15000, exact = false } = options;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const result = await page.evaluate((kws, ex) => {
                const all = Array.from(document.querySelectorAll('button, a, li, span, div, input[type="submit"]'));
                for (const kw of kws) {
                    const el = all.find(e => {
                        if (!e.innerText || e.offsetWidth === 0 || e.offsetHeight === 0) return false;
                        const txt = e.innerText.replace(/\s+/g, ' ').trim();
                        return ex ? txt === kw : txt.includes(kw);
                    });
                    if (el) {
                        const r = el.getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: kw };
                    }
                }
                return null;
            }, keywords, exact);
            if (result) {
                await page.mouse.move(result.x, result.y);
                await delay(100);
                await page.mouse.click(result.x, result.y);
                log(`✅ "${result.found}" 클릭 완료 (좌표: ${Math.round(result.x)}, ${Math.round(result.y)})`);
                return true;
            }
            await delay(800);
        }
        return false;
    }

    // 공통 헬퍼: 셀렉터로 input 찾아서 값 입력 (3중 fallback)
    async function typeIntoInput(selectors, value, label) {
        const start = Date.now();
        while (Date.now() - start < 12000) {
            for (const sel of selectors) {
                try {
                    const el = await page.$(sel);
                    if (!el) continue;
                    const visible = await el.evaluate(e => e.offsetWidth > 0 && e.offsetHeight > 0);
                    if (!visible) continue;
                    
                    await el.click({ clickCount: 3 });
                    await delay(100);
                    await page.keyboard.down('Control');
                    await page.keyboard.press('a');
                    await page.keyboard.up('Control');
                    await page.keyboard.press('Backspace');
                    await delay(100);
                    await el.type(value, { delay: 80 });
                    
                    // 입력 후 실제 value 확인
                    const typed = await el.evaluate(e => e.value);
                    if (typed && typed.length > 0) {
                        log(`✅ ${label} 입력 완료 (${typed.length}자)`);
                        return true;
                    }
                } catch(e) {}
            }
            await delay(500);
        }
        log(`❌ ${label} 입력 실패`);
        return false;
    }

    // ─────────────────────────────────────
    // STEP 1: 메인 사이트 열기
    // ─────────────────────────────────────
    log('📡 사이트 접속 중...');
    try { await page.goto(`${CONFIG.siteBase}`, { waitUntil: 'networkidle2', timeout: 30000 }); } catch(e) {
        try { await page.goto(`${CONFIG.siteBase}`, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch(e2) {}
    }
    await delay(3000);
    try { await page.screenshot({ path: path.join(publicDir, 'debug1.png') }); } catch(e){}
    log('📸 debug1.png 저장 완료');

    // STEP 2: 이미 로그인 되어있는지 확인 (로그인 버튼이 없으면 이미 로그인)
    const alreadyLoggedIn = await page.evaluate(() => {
        return !Array.from(document.querySelectorAll('button, a, span, div'))
            .some(e => e.offsetWidth > 0 && e.offsetHeight > 0 
                && e.children.length === 0 
                && e.innerText && e.innerText.trim() === '로그인');
    });
    if (alreadyLoggedIn) {
        log('✅ 이미 로그인 상태. 스킵.');
        return true;
    }

    // STEP 3: 헤더 로그인 버튼 클릭 (named function으로 재사용 가능)
    async function clickLoginHeaderBtn() {
        for (let i = 0; i < 20; i++) {
            const coord = await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('button, a, li, span, div'));
                const el = all.find(e => {
                    if (!e.offsetWidth || !e.offsetHeight) return false;
                    const nonIconChildren = Array.from(e.children).filter(c => c.tagName !== 'IMG' && c.tagName !== 'SVG' && c.tagName !== 'I');
                    const txt = e.innerText ? e.innerText.replace(/\s+/g, '').trim() : '';
                    return txt === '로그인' && nonIconChildren.length === 0;
                });
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left + r.width/2, y: r.top + r.height/2 };
            });
            if (coord) {
                await page.mouse.move(coord.x, coord.y);
                await delay(150);
                await page.mouse.click(coord.x, coord.y);
                log(`✅ 로그인 버튼 클릭 완료 (${Math.round(coord.x)}, ${Math.round(coord.y)})`);
                return true;
            }
            await delay(700);
        }
        return false;
    }

    // 아이디로 시작하기 OR 최근 로그인 계정 클릭
    async function clickIdLoginBtn() {
        const keywords = ['아이디로 시작하기', '아이디로시작하기', '아이디 로그인', BUBEE_ID, BUBEE_ID.substring(0, 4)];
        for (let i = 0; i < 10; i++) {
            const coord = await page.evaluate((kws) => {
                const all = Array.from(document.querySelectorAll('button, a, li, span, div, p'));
                for (const kw of kws) {
                    const el = all.find(e => {
                        if (!e.offsetWidth || !e.offsetHeight) return false;
                        const txt = e.innerText ? e.innerText.replace(/\s+/g, '').trim() : '';
                        return txt.includes(kw.replace(/\s+/g, ''));
                    });
                    if (el) {
                        const r = el.getBoundingClientRect();
                        return { x: r.left + r.width/2, y: r.top + r.height/2, found: kw };
                    }
                }
                return null;
            }, keywords);
            if (coord) {
                await page.mouse.move(coord.x, coord.y);
                await delay(150);
                await page.mouse.click(coord.x, coord.y);
                log(`✅ "${coord.found}" 클릭 완료`);
                return true;
            }
            await delay(500);
        }
        return false;
    }

    log('👉 STEP 3: 헤더 로그인 버튼 클릭...');
    const headerClicked = await clickLoginHeaderBtn();
    if (!headerClicked) log('⚠️ 로그인 버튼 못 찾음. 다음 단계 진행...');

    // 모달이 뜰 때까지 최대 10초 대기 (modal container 또는 소셜 로그인 버튼 감지)
    log('⏳ 로그인 모달 대기 중...');
    let modalDetected = false;
    for (let i = 0; i < 20; i++) {
        const detected = await page.evaluate(() => {
            // 모달 안에 소셜 로그인 버튼이나 아이디 입력창이 보이면 OK
            const hasIdInput = !!document.querySelector('input[name="id"], input[name="userId"], input[placeholder*="아이디"]');
            const hasSocialBtn = Array.from(document.querySelectorAll('button, a, li, div, span'))
                .some(e => e.offsetWidth > 0 && e.innerText && (
                    e.innerText.includes('아이디로 시작하기') ||
                    e.innerText.includes('카카오') ||
                    e.innerText.includes('구글') ||
                    e.innerText.includes('Google') ||
                    e.innerText.includes('Kakao')
                ));
            return hasIdInput || hasSocialBtn;
        });
        if (detected) { modalDetected = true; break; }
        await delay(500);
    }
    try { await page.screenshot({ path: path.join(publicDir, 'debug2.png') }); } catch(e){}

    if (!modalDetected) {
        log('⚠️ 모달 감지 실패. 그냥 계속 진행...');
    } else {
        log('✅ 로그인 모달 감지 완료!');
    }

    // STEP 4: 모달 안에서 아이디 로그인 경로 선택
    // 이미 ID/PW 폼이 열려있으면 스킵, 아니면 소셜 선택화면에서 "아이디로 시작하기" 클릭
    log('👉 STEP 4: 로그인 방식 선택...');
    const alreadyHasIdForm = await page.evaluate(() => {
        const el = document.querySelector('input[name="id"], input[name="userId"], input[placeholder*="아이디"]');
        return !!(el && el.offsetWidth > 0);
    });

    if (alreadyHasIdForm) {
        log('✅ STEP 4: 이미 아이디 입력 폼이 열려있음. 스킵.');
    } else {
        // 소셜 선택 화면 → "아이디로 시작하기" 클릭
        const found = await clickIdLoginBtn();
        if (found) {
            log('✅ STEP 4: 로그인 방식 선택 완료. 폼 대기...');
            await delay(2000);
        } else {
            log('⚠️ STEP 4: 버튼 못 찾음.');
        }
    }
    try { await page.screenshot({ path: path.join(publicDir, 'debug3.png') }); } catch(e){}

    // ─────────────────────────────────────
    // STEP 5: 아이디/비밀번호 입력 (최대 8회 재시도)
    // ─────────────────────────────────────
    log('👉 STEP 5: 아이디/비밀번호 입력 시작...');
    let loginSuccess = false;

    for (let attempt = 0; attempt < 8; attempt++) {
        // 수동 모드 처리
        if (global.manualMode) {
            log('🛑 수동 조작 모드. 사용자가 로그인할 때까지 대기...');
            const modalOpen = await page.evaluate(() => !!document.querySelector('input[type="password"]'));
            if (!modalOpen) { loginSuccess = true; break; }
            await delay(2000); attempt--; continue;
        }

        log(`  시도 ${attempt + 1}/8: 아이디 입력...`);
        const idOk = await typeIntoInput([
            'input[name="id"]', 
            'input[name="userId"]',
            'input[name="loginId"]',
            'input[placeholder*="아이디"]', 
            'input[placeholder*="이메일"]',
            'input[type="email"]'
        ], BUBEE_ID, '아이디');

        log(`  시도 ${attempt + 1}/8: 비밀번호 입력...`);
        const pwOk = await typeIntoInput([
            'input[type="password"]',
            'input[name="password"]',
            'input[name="pw"]',
            'input[placeholder*="비밀번호"]'
        ], BUBEE_PW, '비밀번호');

        if (idOk && pwOk) {
            await delay(300);
            
            // 로그인 버튼 클릭 (헤더 제외, 모달 안)
            const submitClicked = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                const loginBtn = btns.find(b => {
                    if (!b.innerText && b.value !== '로그인') return false;
                    const txt = (b.innerText || b.value || '').trim();
                    return txt === '로그인' && b.offsetHeight > 0 && b.closest('.modal, form, [class*="login"], [class*="Login"]');
                }) || btns.find(b => {
                    const txt = (b.innerText || b.value || '').trim();
                    return (txt === '로그인' || txt === '시작하기' || txt === '확인') && b.offsetHeight > 0 && b.closest('header') === null;
                });
                if (loginBtn) {
                    loginBtn.removeAttribute('disabled');
                    loginBtn.click();
                    return true;
                }
                return false;
            });
            
            if (!submitClicked) {
                // 버튼을 못 찾으면 Enter로 제출
                log('  버튼 못 찾음. Enter 키로 제출...');
                await page.keyboard.press('Enter');
            }

            await delay(4000);
            try { await page.screenshot({ path: path.join(publicDir, 'debug4.png') }); } catch(e){}

            // 로그인 성공 여부 확인: 비밀번호 창이 사라졌으면 성공
            const stillHasPasswordInput = await page.evaluate(() => {
                const pw = document.querySelector('input[type="password"]');
                return pw && pw.offsetWidth > 0;
            });

            if (!stillHasPasswordInput) {
                loginSuccess = true;
                log('✅ 로그인 성공!');
                break;
            } else {
                log(`  ⚠️ 아직 로그인 창이 열려있음. 재시도...`);
            }
        } else {
            log(`  ⚠️ 입력 폼을 찾지 못함. 재시도...`);
        }
        await delay(1500);
    }

    if (!loginSuccess) {
        log('❌ [치명적] 자동 로그인 실패. debug*.png 파일을 확인하세요.');
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
        
        // 메인 백그라운드 탭 생성
        global.bgPage = await global.browser.newPage();
        await global.bgPage.setViewport({ width: 1280, height: 720 });

        if (rawCookies.length > 0) {
            let cookies = rawCookies.map(c => ({ ...c, url: CONFIG.siteBase }));
            await global.bgPage.setCookie(...cookies);
            await global.bgPage.goto(CONFIG.siteBase, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
            
            // ✅ 쿠키 주입 후 실제로 로그인됐는지 확인
            const loginBtnVisible = await global.bgPage.evaluate(() => {
                return Array.from(document.querySelectorAll('button, a, span, div'))
                    .some(e => e.offsetWidth > 0 && e.offsetHeight > 0 
                        && e.children.length === 0 
                        && e.innerText && e.innerText.trim() === '로그인');
            });

            if (!loginBtnVisible) {
                log(`✅ [쿠키 프리패스] 입장권(Cookie) 장착 완료! 백그라운드 무한 연장 엔진 가동!`);
            } else {
                log(`⚠️ [쿠키 만료] 저장된 쿠키가 만료되었습니다. 자동 로그인 시도...`);
                const loginOk = await doLogin(global.bgPage);
                if (loginOk) {
                    // 새 쿠키 저장
                    const newCookies = await global.bgPage.cookies();
                    if (newCookies.find(c => c.name === 'auth_token')) {
                        fs.writeFileSync(cookiePath, JSON.stringify(newCookies, null, 2));
                        log('✅ [새 쿠키 저장] 로그인 성공, 새 쿠키를 저장했습니다!');
                    }
                } else {
                    log('❌ [로그인 실패] 자동 로그인에 실패했습니다. CCTV에서 직접 로그인해주세요.');
                }
            }
        } else {
            log(`⚠️ [쿠키 없음] 저장된 쿠키가 없습니다. 자동 로그인 시도...`);
            await global.bgPage.goto(CONFIG.siteBase, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
            const loginOk = await doLogin(global.bgPage);
            if (loginOk) {
                const newCookies = await global.bgPage.cookies();
                if (newCookies.find(c => c.name === 'auth_token')) {
                    fs.writeFileSync(path.join(DATA_DIR, 'cookies.json'), JSON.stringify(newCookies, null, 2));
                    log('✅ [새 쿠키 저장] 로그인 성공, 쿠키를 저장했습니다!');
                }
            } else {
                log('❌ [로그인 실패] 자동 로그인에 실패했습니다.');
            }
        }
        
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
                        log('⚠️ [토큰 백업 실패] 백그라운드 탭 로그아웃 감지! 자동 재로그인 시도...');
                        await doLogin(global.bgPage);
                        const newCookies = await global.bgPage.cookies();
                        if (newCookies.find(c => c.name === 'auth_token')) {
                            fs.writeFileSync(path.join(DATA_DIR, 'cookies.json'), JSON.stringify(newCookies, null, 2));
                            log('✅ [재로그인 성공] 쿠키 갱신 완료!');
                        }
                    }
                }
            } catch(e) { log('⚠️ 백그라운드 탭 새로고침 지연: ' + e.message); }
        }, 10 * 60 * 1000);
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
            if (
                rt === 'media' || 
                u.endsWith('.ts') || 
                u.endsWith('.m3u8') || 
                u.endsWith('.flv') || 
                u.includes('live-video') || 
                u.includes('/stream/') || 
                u.includes('.mp4')
            ) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // 🚀 비디오 재생 완벽 차단 (CPU/메모리 절약)
        await p.evaluateOnNewDocument(() => {
            Object.defineProperty(HTMLMediaElement.prototype, 'play', {
                configurable: true,
                get: () => function() { return Promise.resolve(); }
            });
            Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
                configurable: true,
                get: () => function() {}
            });
            Object.defineProperty(HTMLMediaElement.prototype, 'load', {
                configurable: true,
                get: () => function() {}
            });
            // DOM이 로드되면 비디오 태그 자체를 계속해서 삭제
            const observer = new MutationObserver(() => {
                document.querySelectorAll('video').forEach(v => v.remove());
            });
            document.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, { childList: true, subtree: true });
            });
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

        try { 
            await p.goto(`${CONFIG.siteBase}/lives/play/${vod_key}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); 
        } catch(e) { 
            log(`❌ [입장 실패] ${title} 방 접속 타임아웃 (30초 후 재시도)`);
            try { await p.close(); } catch(err){}
            return; // 에러 시 activeRooms에 추가하지 않음 -> 다음 주기에 다시 시도
        }
        
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
            const targetVodKeys = targets.filter(t => t.type === 'vod_key').map(t => String(t.id));
            const targetUserKeys = targets.filter(t => t.type === 'user_key').map(t => String(t.id));
            
            lives.forEach(v => {
                if (v.v_state === 1 && !v.v_end_date) {
                    if (targetVodKeys.includes(String(v.vod_key)) || targetUserKeys.includes(String(v.user_key))) {
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
