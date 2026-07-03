// ==UserScript==
// @name         부비라이브 헬퍼
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  부비라이브 방송 관리, 메모/미션 기능, 후원 집계 및 추첨 기능 탑재
// @match        https://www.bubeelive.com/lives/play/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // GUI용 한글/영문 폰트 불러오기
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap';
    if (document.head) {
        document.head.appendChild(fontLink);
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            if (document.head) document.head.appendChild(fontLink);
        });
    }

    /* ================================================================
       1. 데이터베이스 및 로컬 스토리지 관리
    ================================================================ */
    const roomIdMatch = window.location.href.match(/\/play\/([a-zA-Z0-9_]+)/);
    const CURRENT_ROOM_ID = roomIdMatch ? roomIdMatch[1] : 'global';
    const STORAGE_KEY = 'bubi_helper_db_' + CURRENT_ROOM_ID;
    let DB = {
        settings: {
            autoWelcome: true,
            autoAttendance: true,
            enableCommands: true,
            welcomeMsgNormal: '어서오세요! 반가워요❤️',
            welcomeMsgVIP: '다이아님 어서오세요! 💎✨',
            welcomeMsgHot: '열혈님 어서오세요! 🔥',
            minGift: 300, // VIP 기준 후원 개수 기본값
            cooldownSeconds: 3,
            bjProfileText: '' // 텍스트 기반 프로필(공지/소개) 저장용
        },
        attendance: {},
        fortunes: {},
        receivedGifts: {},
        userGifts: {},
        dailyRank: {},
        monthRank: {},
        missions: [], // 동적 미션 저장용
        keeps: [] // 킵 메모 저장용
    };

    function loadDB() {
        if (window.location.href === 'about:blank' || window.location.origin === 'null') return;
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            if (data) {
                const parsed = JSON.parse(data);
                DB = {
                    settings: { ...DB.settings, ...parsed.settings },
                    attendance: parsed.attendance || {},
                    fortunes: parsed.fortunes || {},
                    receivedGifts: parsed.receivedGifts || {},
                    userGifts: parsed.userGifts || {},
                    dailyRank: parsed.dailyRank || {},
                    monthRank: parsed.monthRank || {},
                    missions: parsed.missions || [],
                    keeps: parsed.keeps || []
                };
            }
        } catch (e) {
            console.error('[부비라이브 헬퍼] 로컬 데이터 로드 오류:', e);
        }
    }

    function saveDB() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
        } catch (e) {
            console.error('[부비라이브 헬퍼] 로컬 데이터 저장 오류:', e);
        }
    }

    /* ================================================================
       2. 날짜 유틸리티 (한국 표준시 KST 기준)
    ================================================================ */
    const getKSTDate = (offsetDays = 0) => {
        const d = new Date();
        const kstMs = d.getTime() + (9 * 60 * 60 * 1000);
        const kstDate = new Date(kstMs);
        kstDate.setUTCDate(kstDate.getUTCDate() + offsetDays);
        return kstDate.toISOString().slice(0, 10);
    };
    const getToday = () => getKSTDate(0);
    const getMonth = () => getKSTDate(0).slice(0, 7);
    const getYesterday = () => getKSTDate(-1);

    /* ================================================================
       3. 자동 줄바꿈 알고리즘 (긴 텍스트를 여러 줄로 분할)
    ================================================================ */
    function autoWordWrap(text, maxLength) {
        if (!text) return [];
        const words = text.split(' ');
        const lines = [];
        let currentLine = '';

        for (let word of words) {
            if (word.length > maxLength) {
                if (currentLine) {
                    lines.push(currentLine.trim());
                    currentLine = '';
                }
                while (word.length > maxLength) {
                    lines.push(word.substring(0, maxLength));
                    word = word.substring(maxLength);
                }
                currentLine = word;
            } 
            else if ((currentLine + (currentLine ? ' ' : '') + word).length > maxLength) {
                lines.push(currentLine.trim());
                currentLine = word;
            } 
            else {
                currentLine += (currentLine ? ' ' : '') + word;
            }
        }
        if (currentLine) {
            lines.push(currentLine.trim());
        }
        return lines;
    }

    /* ================================================================
       4. 메시지 전송 대기열 (도배 방지 및 봇 메시지 자동 필터링)
    ================================================================ */
    const msgQueue = [];
    let lastSentTime = 0;
    const recentBotMessages = new Set(); 
    let agePopupClicked = false;

    function queueMessage(text) {
        if (!text) return;
        msgQueue.push(text);
        recentBotMessages.add(text);
        
        if (recentBotMessages.size > 50) {
            const firstVal = recentBotMessages.values().next().value;
            recentBotMessages.delete(firstVal);
        }
        logStatus(`[대기열 추가] ${text}`);
    }

    setInterval(() => {
        if (msgQueue.length === 0) return;
        const now = Date.now();
        const cooldownMs = (DB.settings.cooldownSeconds || 3) * 1000;
        if (now - lastSentTime >= cooldownMs) {
            const nextMsg = msgQueue.shift();
            const success = sendChatMessage(nextMsg);
            if (success) {
                lastSentTime = now;
                logStatus(`[전송 완료]`);
            } else {
                msgQueue.unshift(nextMsg);
            }
        }
    }, 100);

    function sendChatMessage(text) {
        const chatInput = document.querySelector('#chat-input');
        const sendButton = document.querySelector('.btn-send');
        if (!chatInput) return false;

        chatInput.value = text;
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));

        setTimeout(() => {
            if (sendButton && !sendButton.disabled) {
                sendButton.click();
            }
        }, 100);
        return true;
    }

    /* ================================================================
       5. Vue.js 내부 데이터에서 실제 유저 ID 추출하는 유틸리티
    ================================================================ */
    function getUserIdFromVue(node) {
        const commonKeys = ['userId', 'memberId', 'uid', 'user_id', 'member_id', 'username', 'loginId'];
        
        function searchObj(obj, depth = 0) {
            if (!obj || depth > 4) return null;
            if (typeof obj !== 'object') return null;
            
            for (const key of commonKeys) {
                if (obj[key] !== undefined && obj[key] !== null) return String(obj[key]);
            }
            
            for (const k of Object.keys(obj)) {
                if (k.startsWith('$') || k.startsWith('_')) continue;
                
                if (k === 'user' || k === 'member' || k === 'message' || k === 'chat' || k === 'sender') {
                    const res = searchObj(obj[k], depth + 1);
                    if (res) return res;
                }
                
                if (k === 'id' && (obj.nickname || obj.nick || obj.username || obj.loginId)) {
                    return String(obj[k]);
                }
            }
            return null;
        }

        if (node.__vue__) {
            const res = searchObj(node.__vue__);
            if (res) return res;
        }
        if (node.__vnode) {
            const res = searchObj(node.__vnode);
            if (res) return res;
        }
        return null;
    }

    /* ================================================================
       6. 운세 시스템
    ================================================================ */
    function getFortune(userId, nick) {
        const today = getToday();
        if (DB.fortunes[userId] && DB.fortunes[userId].date === today) {
            return `🔮 ${nick}님의 오늘 운세는 이미 확인하셨습니다! (${DB.fortunes[userId].score}점)`;
        }

        const score = Math.floor(Math.random() * 101);
        let text = "";
        if (score >= 90) text = "대길! 오늘은 모든 일이 순조롭게 풀릴 최고의 날입니다! 🌟";
        else if (score >= 70) text = "길! 기분 좋은 일들이 가득할 것 같은 하루네요! 😊";
        else if (score >= 40) text = "중길! 평범하지만 뜻밖의 행운이 찾아올 수 있어요! 🍀";
        else if (score >= 20) text = "소길! 차분하게 하루를 보내시면 무난할 것입니다. 👍";
        else text = "흉! 오늘은 매사에 조금만 조심하는 것이 좋겠습니다! 🛡️";

        DB.fortunes[userId] = { score, date: today };
        saveDB();

        return `🔮 [${nick}님의 오늘 운세]\n점수: ${score}점\n해석: ${text}`;
    }

    /* ================================================================
       7. 출석체크 시스템 (실제 유저 ID 기준 저장)
    ================================================================ */
    const todayChecked = new Set();
    const attendanceInProgress = new Set();

    function initTodayChecked() {
        const month = getMonth();
        const today = getToday();
        if (DB.attendance[month]) {
            Object.entries(DB.attendance[month]).forEach(([uid, data]) => {
                if (data.lastDate === today) {
                    todayChecked.add(uid);
                    if (data.nick) todayChecked.add(data.nick);
                }
            });
        }
    }

    function isBotName(nick) {
        if (!nick) return false;
        // 사용자의 요청대로 오직 '매크로봇' 이 포함된 닉네임만 무시합니다.
        return nick.includes('매크로봇');
    }

    function processAttendance(userId, nick, isHot = false, isVIP = false, isSilent = false) {
        if (!DB.settings.autoAttendance) return;
        if (isBotName(nick)) return; // 매크로봇 무시

        const today = getToday();
        const yesterday = getYesterday();
        const month = getMonth();

        // 현재 방(탭)에서 이미 인사를 건넸는지 확인 (닉네임 기반으로도 교차 검증)
        if (todayChecked.has(userId) || todayChecked.has(nick) || attendanceInProgress.has(userId) || attendanceInProgress.has(nick)) return;
        attendanceInProgress.add(userId);
        attendanceInProgress.add(nick);

        try {
            if (!DB.attendance[month]) DB.attendance[month] = {};
            
            // 고유 ID가 다를 경우를 대비해 닉네임으로 기존 기록 찾기
            let existingKey = userId;
            let existing = DB.attendance[month][userId];
            if (!existing) {
                const foundEntry = Object.entries(DB.attendance[month]).find(([k, v]) => v.nick === nick);
                if (foundEntry) {
                    existingKey = foundEntry[0];
                    existing = foundEntry[1];
                }
            }

            if (existing && existing.lastDate === today) {
                todayChecked.add(existingKey);
                todayChecked.add(nick);
                return;
            }

            const rec = existing ? { ...existing } : { nick, total: 0, consecutive: 0, lastDate: "" };
            rec.nick = nick; 
            rec.total = (rec.total || 0) + 1;
            rec.consecutive = (rec.lastDate === yesterday) ? (rec.consecutive || 0) + 1 : 1;
            rec.lastDate = today;

            DB.attendance[month][existingKey] = rec;
            todayChecked.add(existingKey);
            todayChecked.add(nick);
            saveDB();

            let allTimeTotal = 0;
            Object.values(DB.attendance).forEach(monthData => {
                if (monthData && monthData[userId]) {
                    allTimeTotal += (monthData[userId].total || 0);
                }
            });

            if (!isSilent) {
                if (isVIP && DB.settings.welcomeMsgVIP) {
                    queueMessage(`💎 [다이아] ${nick}님, ${DB.settings.welcomeMsgVIP}`);
                } else if (isHot && DB.settings.welcomeMsgHot) {
                    queueMessage(`🔥 [열혈] ${nick}님, ${DB.settings.welcomeMsgHot}`);
                } else if (DB.settings.autoWelcome && DB.settings.welcomeMsgNormal) {
                    queueMessage(`👋 ${nick}님, ${DB.settings.welcomeMsgNormal}`);
                }

                queueMessage(`✅ [출석] ${nick}님 출석 완료! (연속 ${rec.consecutive}일 / 이달 ${rec.total}일 / 누적 ${allTimeTotal}일)`);
                logStatus(`[출석 체크] ${nick} (누적: ${allTimeTotal}일)`);
            } else {
                logStatus(`[과거 내역 조용히 등록] ${nick}`);
            }

        } catch (e) {
            console.error('[부비라이브 헬퍼] 출석체크 오류:', e);
        } finally {
            attendanceInProgress.delete(userId);
        }
    }

    /* ================================================================
       8. 실시간 후원 감지 및 채팅 순위 집계
    ================================================================ */
    let lastSupportId = "";
    const recentDonations = {};

    function isDuplicateDonation(nick, amount) {
        const key = `${nick}_${amount}`;
        const now = Date.now();
        if (recentDonations[key] && (now - recentDonations[key] < 3000)) {
            // 3초 이내에 똑같은 닉네임이 똑같은 금액을 후원한 것으로 감지되면(작은 배너와 큰 배너 동시 인식 등) 하나는 무시합니다.
            return true;
        }
        recentDonations[key] = now;
        return false;
    }

    function handleBubiSupport(node) {
        try {
            const userNameEl = node.querySelector('.user-name');
            const summaryEl = node.querySelector('.summary');
            if (!userNameEl || !summaryEl) return;

            const nick = userNameEl.innerText.trim();
            const summaryText = summaryEl.innerText.trim(); 
            
            const lowerSummary = summaryText.toLowerCase();
            if (lowerSummary.includes('k') || lowerSummary.includes('m')) {
                // "1.1k..." 처럼 단위가 붙어 축약된 경우 숫자 파싱 오류(11)가 발생하므로, 
                // 정확한 개수를 띄워주는 대형 이펙트(effect-area-merge) 로직에 처리를 위임하고 여기선 무시합니다.
                return;
            }

            const amount = parseInt(summaryText.replace(/[^0-9]/g, '')) || 0;
            if (!amount) return;

            // 중복 알림 방지
            if (isDuplicateDonation(nick, amount)) return;

            logStatus(`[후원 감지] ${nick} - ${summaryText}`);

            const minGift = DB.settings.minGift || 300;
            if (amount >= minGift) {
                queueMessage(`💎💎 [VIP후원] ${nick}님 ${amount}개 후원 너무 감사합니다!! 압도적 감사!! 💎💎`);
            } else {
                queueMessage(`💖 ${nick}님 ${amount}개 후원 너무 감사합니다! 윙쿠♥❤️`);
            }

            const today = getToday();
            if (!DB.receivedGifts) DB.receivedGifts = {};
            if (!DB.receivedGifts[today]) DB.receivedGifts[today] = {};
            DB.receivedGifts[today]['스티커후원'] = (DB.receivedGifts[today]['스티커후원'] || 0) + amount;

            if (!DB.userGifts) DB.userGifts = {};
            if (!DB.userGifts[today]) DB.userGifts[today] = {};
            DB.userGifts[today][nick] = (DB.userGifts[today][nick] || 0) + amount;

            saveDB();

        } catch (e) {
            console.error('[부비라이브 헬퍼] 후원 파싱 오류:', e);
        }
    }

    function handleEffectSupport(node) {
        try {
            const nickEl = node.querySelector('.nick');
            const honeyEl = node.querySelector('.ic-honey');
            if (!nickEl || !honeyEl) return;

            const nick = nickEl.innerText.trim();
            const honeyText = honeyEl.innerText.trim();
            
            const amount = parseInt(honeyText.replace(/[^0-9]/g, '')) || 0;
            if (!amount) return;

            // 중복 알림 방지
            if (isDuplicateDonation(nick, amount)) return;

            logStatus(`[대형 후원 감지] ${nick} - ${honeyText}`);

            const minGift = DB.settings.minGift || 300;
            if (amount >= minGift) {
                queueMessage(`💎💎 [VIP후원] ${nick}님 ${amount}개 후원 너무 감사합니다!! 압도적 감사!! 💎💎`);
            } else {
                queueMessage(`💖 ${nick}님 ${amount}개 후원 너무 감사합니다! 윙쿠♥❤️`);
            }

            const today = getToday();
            if (!DB.receivedGifts) DB.receivedGifts = {};
            if (!DB.receivedGifts[today]) DB.receivedGifts[today] = {};
            DB.receivedGifts[today]['스티커후원'] = (DB.receivedGifts[today]['스티커후원'] || 0) + amount;

            if (!DB.userGifts) DB.userGifts = {};
            if (!DB.userGifts[today]) DB.userGifts[today] = {};
            DB.userGifts[today][nick] = (DB.userGifts[today][nick] || 0) + amount;

            saveDB();

        } catch (e) {
            console.error('[부비라이브 헬퍼] 대형 후원 파싱 오류:', e);
        }
    }

    function recordChatRanking(userId, nick) {
        const today = getToday();
        const month = getMonth();

        if (!DB.dailyRank) DB.dailyRank = {};
        if (!DB.dailyRank[today]) DB.dailyRank[today] = {};
        if (!DB.dailyRank[today][userId]) {
            DB.dailyRank[today][userId] = { nick, count: 0 };
        }
        DB.dailyRank[today][userId].count++;
        DB.dailyRank[today][userId].nick = nick;

        if (!DB.monthRank) DB.monthRank = {};
        if (!DB.monthRank[month]) DB.monthRank[month] = {};
        if (!DB.monthRank[month][userId]) {
            DB.monthRank[month][userId] = { nick, count: 0 };
        }
        DB.monthRank[month][userId].count++;
        DB.monthRank[month][userId].nick = nick;

        saveDB();
    }

    function getRankOutput(rankData, title) {
        if (!rankData || Object.keys(rankData).length === 0) {
            return `📊 [${title}] 오늘 아직 기록된 채팅이 없습니다.`;
        }
        const sorted = Object.values(rankData)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        let msg = `📊 [${title} TOP 5]\n`;
        sorted.forEach((item, idx) => {
            msg += `${idx + 1}등: ${item.nick} (${item.count}회)\n`;
        });
        return msg.trim();
    }

    /* ================================================================
       9. 채팅 명령어 처리기
    ================================================================ */
    const START_MS = Date.now();

    async function handleCommand(msg, userId, nick, isHostOrManager) {
        if (!DB.settings.enableCommands) return;
        const text = msg.trim();
        if (!text.startsWith('!')) return;

        const tokens = text.split(/\s+/);
        const cmd = tokens[0].toLowerCase();

        if (cmd === '!명령어' || cmd === '!도움말') {
            if (isHostOrManager) {
                queueMessage(`🤖 [매니저 명령어]\n!프로필등록 / !미션등록 / !킵 / !킵삭제\n\n👤 [일반 명령어]\n!출석 / !운세 / !타임 / !주사위 [최대치] / !뽑기 [후보들] / !프로필 / !미션 / !킵목록 / !채팅순위 / !후원순위 / !어제순위 / !한달순위`);
            } else {
                queueMessage(`🤖 [일반 명령어]\n!출석 / !운세 / !타임 / !주사위 [최대치] / !뽑기 [후보들] / !프로필 / !미션 / !킵목록 / !채팅순위 / !후원순위 / !어제순위 / !한달순위`);
            }
        }
        else if (cmd === '!출석') {
            const month = getMonth();
            const rec = DB.attendance[month]?.[userId];
            if (rec) {
                queueMessage(`📊 [출석 정보] ${nick}님은 이번 달에 총 ${rec.total}일 출석하셨습니다!`);
            } else {
                queueMessage(`📊 [출석 정보] ${nick}님은 오늘 아직 출석 기록이 없습니다. 채팅을 보내시면 자동 출석 처리됩니다.`);
            }
        }
        else if (cmd === '!운세') {
            const fortuneMsg = getFortune(userId, nick);
            queueMessage(fortuneMsg);
        }
        else if (cmd === '!타임' || cmd === '!업타임') {
            const diffSec = Math.floor((Date.now() - START_MS) / 1000);
            const hours = Math.floor(diffSec / 3600);
            const mins = Math.floor((diffSec % 3600) / 60);
            const secs = diffSec % 60;
            queueMessage(`⏱️ [봇 작동 시간] 봇이 실행된 지 ${hours}시간 ${mins}분 ${secs}초 경과했습니다.`);
        }
        else if (cmd === '!주사위') {
            const max = parseInt(tokens[1]) || 6;
            const dice = Math.floor(Math.random() * max) + 1;
            queueMessage(`🎲 [주사위] ${nick}님이 주사위를 던져 [${dice}]이(가) 나왔습니다! (1~${max})`);
        }
        else if (cmd === '!뽑기' || cmd === '!추첨') {
            const candidates = tokens.slice(1);
            if (candidates.length < 2) {
                queueMessage(`❌ 사용법: !뽑기 [후보1] [후보2] [후보3]... (최소 2개 이상 입력)`);
                return;
            }
            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            queueMessage(`🎉 [추첨 완료] 축하합니다! 당첨자는 [ ${picked} ] 입니다! ✨`);
        }
        // ================= [ 텍스트 프로필 등록 (호스트/매니저 전용) ] =================
        else if (cmd === '!프로필등록') {
            if (!isHostOrManager) {
                queueMessage(`❌ 프로필 등록은 호스트와 매니저만 가능합니다.`);
                return;
            }
            const content = text.replace(/^!프로필등록\s*/i, '').trim();
            if (content) {
                DB.settings.bjProfileText = content;
                saveDB();
                queueMessage(`✅ 프로필 공지가 성공적으로 등록되었습니다!`);
                logStatus(`[프로필 등록] 텍스트 내용 업데이트 됨`);
            } else {
                queueMessage(`❌ 등록할 내용을 뒤에 함께 적어주세요! (예: !프로필등록 방송시간은 매일 8시입니다)`);
            }
        }
        // ================= [ 등록된 프로필 텍스트 확인 (한 번에 전송) ] =================
        else if (cmd === '!프로필') {
            const profileText = DB.settings.bjProfileText;
            if (profileText && profileText.trim() !== '') {
                const rawLines = profileText.split(/\\n|\n/);
                let finalLines = [];

                rawLines.forEach(rawLine => {
                    const lineStr = rawLine.trim();
                    if (!lineStr) return;
                    
                    // 글이 길면 보기 좋게 엔터를 넣어줌
                    const wrappedLines = autoWordWrap(lineStr, 40); 
                    finalLines.push(...wrappedLines);
                });

                // 분할하지 않고, 줄바꿈(\n)으로 합쳐서 **하나의 메시지**로 전송
                const fullMsg = `📢 [프로필]\n` + finalLines.join('\n');
                queueMessage(fullMsg);
            } else {
                queueMessage(`❌ 등록된 프로필이 없습니다. '!프로필등록 [내용]' 명령어로 먼저 등록해주세요!`);
            }
        }
        // ================= [ 미션 조회 (한 번에 전송) ] =================
        else if (cmd === '!미션') {
            const missionText = DB.settings.bjMissionText;
            if (missionText && missionText.trim() !== '') {
                const rawLines = missionText.split(/\\n|\n/);
                let finalLines = [];

                rawLines.forEach(rawLine => {
                    const lineStr = rawLine.trim();
                    if (!lineStr) return;
                    
                    const wrappedLines = autoWordWrap(lineStr, 40); 
                    finalLines.push(...wrappedLines);
                });

                const fullMsg = `📜 [미션 목록]\n` + finalLines.join('\n');
                queueMessage(fullMsg);
            } else {
                queueMessage(`❌ 등록된 미션이 없습니다. '!미션등록 [내용]' 명령어로 먼저 등록해주세요!`);
            }
        }
        // ================= [ 미션 등록 (호스트/매니저 전용) ] =================
        else if (cmd === '!미션등록') {
            if (!isHostOrManager) {
                queueMessage(`❌ 미션 등록은 호스트와 매니저만 가능합니다.`);
                return;
            }
            const content = text.replace(/^!미션등록\s*/i, '').trim();
            if (content) {
                DB.settings.bjMissionText = content;
                saveDB();
                queueMessage(`✅ 미션 목록이 성공적으로 등록되었습니다!`);
                logStatus(`[미션 등록] 텍스트 내용 업데이트 됨`);
            } else {
                queueMessage(`❌ 등록할 미션 내용을 뒤에 함께 적어주세요! (예: !미션등록 1. 춤추기 2. 노래하기)`);
            }
        }
        // ================= [ 킵 메모 기능 (호스트/매니저 전용) ] =================
        else if (cmd === '!킵' || cmd === '!메모') {
            if (!isHostOrManager) {
                queueMessage(`❌ 메모 등록은 호스트와 매니저만 가능합니다.`);
                return;
            }
            const content = text.replace(/^!(킵|메모)\s*/i, '').trim();
            if (content) {
                if (!DB.keeps) DB.keeps = [];
                DB.keeps.push({ text: content, time: new Date().toTimeString().slice(0, 5) });
                saveDB();
                queueMessage(`📌 메모가 저장되었습니다! (번호: ${DB.keeps.length})`);
                logStatus(`[메모 저장] ${content}`);
            } else {
                queueMessage(`❌ 저장할 메모 내용을 함께 적어주세요! (예: !킵 8시 댄스 리액션 예약)`);
            }
        }
        else if (cmd === '!킵목록' || cmd === '!메모목록') {
            const keeps = DB.keeps || [];
            if (keeps.length > 0) {
                let msg = `📌 [저장된 메모 목록]\n`;
                keeps.forEach((item, idx) => {
                    msg += `${idx + 1}. [${item.time}] ${item.text}\n`;
                });
                queueMessage(msg.trim());
            } else {
                queueMessage(`📌 저장된 메모가 없습니다.`);
            }
        }
        else if (cmd === '!킵삭제' || cmd === '!메모삭제') {
            if (!isHostOrManager) {
                queueMessage(`❌ 메모 삭제는 호스트와 매니저만 가능합니다.`);
                return;
            }
            const arg = text.replace(/^!(킵삭제|메모삭제)\s*/i, '').trim();
            const idx = parseInt(arg) - 1;
            if (!isNaN(idx) && DB.keeps && DB.keeps[idx] !== undefined) {
                const removed = DB.keeps.splice(idx, 1);
                saveDB();
                queueMessage(`✅ [${idx + 1}번] 메모 "${removed[0].text}" 이(가) 삭제되었습니다.`);
                logStatus(`[메모 삭제] ${removed[0].text}`);
            } else {
                queueMessage(`❌ 삭제할 메모 번호를 적어주세요! (예: !킵삭제 1)`);
            }
        }
        // ================= [ 순위 집계 기능 ] =================
        else if (cmd === '!채팅순위' || cmd === '!오늘순위') {
            const today = getToday();
            const output = getRankOutput(DB.dailyRank?.[today], "오늘 채팅 순위");
            queueMessage(output);
        }
        else if (cmd === '!어제순위' || cmd === '!어제채팅순위') {
            const yesterday = getYesterday();
            const output = getRankOutput(DB.dailyRank?.[yesterday], "어제 채팅 순위");
            queueMessage(output);
        }
        else if (cmd === '!한달순위' || cmd === '!월간순위') {
            const month = getMonth();
            const output = getRankOutput(DB.monthRank?.[month], "이번 달 채팅 순위");
            queueMessage(output);
        }
        else if (cmd === '!후원순위' || cmd === '!기프트순위' || cmd === '!스티커순위') {
            const today = getToday();
            const gifts = DB.userGifts?.[today] || {};
            const sorted = Object.entries(gifts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5);
            if (!sorted.length) {
                queueMessage(`📊 오늘 후원 기록이 아직 없습니다.`);
                return;
            }
            let msg = `📊 [오늘의 후원 순위 TOP 5]\n`;
            sorted.forEach(([user, count], idx) => {
                msg += `${idx + 1}등: ${user} (${count}개)\n`;
            });
            queueMessage(msg.trim());
        }
    }

    /* ================================================================
       9-5. 19세 성인인증 및 경고 팝업 우회 처리
    ================================================================ */
    const handleAgePopup = () => {
        if (agePopupClicked) return;
        const popup = document.querySelector(
            'button[class*="age"], button[class*="adult"], ' +
            'button[class*="confirm"], button[class*="agree"]'
        );
        if (!popup) {
            const btns = [...document.querySelectorAll('button')];
            const ageBtn = btns.find(b =>
                b.innerText.includes('19세') || b.innerText.includes('성인') ||
                (b.innerText.includes('확인') && b.closest('[class*="modal"],[class*="popup"],[class*="overlay"]'))
            );
            if (ageBtn) {
                agePopupClicked = true;
                ageBtn.click();
                console.log('[19세팝업] 연령 확인 버튼 클릭 완료 (1회)');
            }
        } else {
            agePopupClicked = true;
            popup.click();
            console.log('[19세팝업] 연령 확인 버튼 클릭 완료 (1회)');
        }
    };
    // 3초마다 팝업 체크 (최초 1회 클릭 후 자동 중단)
    const ageCheckInterval = setInterval(() => {
        if (agePopupClicked) { clearInterval(ageCheckInterval); return; }
        handleAgePopup();
    }, 3000);

    /* ================================================================
       10. 실시간 DOM 감시 (MutationObserver)
    ================================================================ */
    let chatObserver = null;
    let supportObserver = null;

    function startChatObserver() {
        const chatWrap = document.querySelector('.chat-area') || document.querySelector('.chat-wrap');
        const supportArea = document.querySelector('.recently-support');

        if (chatWrap && !chatObserver) {
            chatObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType !== 1) return;

                        const msgItem = node.classList?.contains('msg-item') ? node : (node.querySelector?.('.msg-item'));
                        if (msgItem) {
                            const nameEl = msgItem.querySelector('.user-name');
                            const txtEl = msgItem.querySelector('.msg-txt');

                            if (nameEl && txtEl) {
                                const nick = nameEl.innerText.trim();
                                const msg = txtEl.innerText.trim();

                                // 매크로 봇이 켜진 직후 렌더링되는 과거 채팅 내역은 조용히 DB에 등록만 합니다.
                                const isSilent = (Date.now() - START_MS < 10000);

                                let userId = getUserIdFromVue(node);
                                if (!userId) {
                                    const imgEl = node.querySelector('figure.user-frame-img img');
                                    if (imgEl) {
                                        const src = imgEl.src || imgEl.getAttribute('data-src') || '';
                                        const match = src.match(/\/user\/\d+\/([a-zA-Z0-9_]+)/);
                                        if (match) userId = match[1];
                                    }
                                }
                                if (!userId) userId = nick;

                                const isVIP = node.classList.contains('vip-diamond') || node.innerHTML.includes('diamond');
                                const isHot = node.classList.contains('vip-hot') || node.innerHTML.includes('hot');

                                // 매크로봇 채팅은 완전히 무시
                                if (isBotName(nick)) return;

                                processAttendance(userId, nick, isHot, isVIP, isSilent);

                                // 과거 내역의 경우 명령어 및 순위 집계는 수행하지 않습니다.
                                if (isSilent) return;

                                if (!recentBotMessages.has(msg)) {
                                    recordChatRanking(userId, nick);
                                } else {
                                    recentBotMessages.delete(msg);
                                }

                                if (msg.startsWith('!')) {
                                    // 호스트(.host-content) 또는 매니저(.ic-manager) 여부 확인
                                    const isHostOrManager = !!(
                                        node.querySelector('.host-content') ||
                                        node.querySelector('.ic-manager') ||
                                        node.classList.contains('host-content') ||
                                        node.classList.contains('ic-manager')
                                    );
                                    handleCommand(msg, userId, nick, isHostOrManager);
                                }
                            }
                        }

                        if (node.classList.contains('inner') || node.querySelector('.noti-chat-join')) {
                            const nameEl = node.querySelector('.user-name');
                            const txtEl = node.querySelector('.msg-txt') || node.querySelector('p');
                            if (nameEl && txtEl && (txtEl.innerText.includes('참여') || txtEl.innerText.includes('입장'))) {
                                // 매크로 봇이 켜진 직후 렌더링되는 과거 입장 내역은 조용히 DB에 등록만 합니다.
                                const isSilent = (Date.now() - START_MS < 10000);

                                const nick = nameEl.innerText.trim();
                                if (isBotName(nick)) return; // 매크로봇 입장 무시

                                let userId = getUserIdFromVue(node) || nick;
                                if (!isSilent) logStatus(`[입장 감지] ${nick}님이 방송에 입장하셨습니다.`);
                                processAttendance(userId, nick, false, false, isSilent);
                            }
                        }

                        if (node.classList.contains('support-item') || node.querySelector('.support-item')) {
                            const targetNode = node.classList.contains('support-item') ? node : node.querySelector('.support-item');
                            handleBubiSupport(targetNode);
                        }
                    });
                });
            });

            chatObserver.observe(chatWrap, { childList: true, subtree: true });
            logStatus("[시스템] 실시간 채팅 감시 시작.");
        }

        if (supportArea && !supportObserver) {
            supportObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType !== 1) return;

                        if (node.classList.contains('support-item') || node.querySelector('.support-item')) {
                            const targetNode = node.classList.contains('support-item') ? node : node.querySelector('.support-item');
                            handleBubiSupport(targetNode);
                        }
                        if (node.classList.contains('display-area') || node.querySelector('.display-area')) {
                            const supportItem = node.querySelector('.support-item');
                            if (supportItem) handleBubiSupport(supportItem);
                        }
                    });
                });
            });

            supportObserver.observe(supportArea, { childList: true, subtree: true });
            logStatus("[시스템] 실시간 최근 후원 감시 시작.");
        }

        if (!chatWrap || !supportArea) {
            setTimeout(startChatObserver, 1500);
        }
    }

    let effectObserver = null;
    function startEffectObserver() {
        if (!effectObserver) {
            effectObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType !== 1) return;

                        // 실제 동적으로 추가되는 것은 effect-area-merge 자체가 아니라 그 내부의 배너 요소들입니다.
                        const honeyEl = node.classList.contains('ic-honey') ? node : (node.querySelector && node.querySelector('.ic-honey'));
                        if (honeyEl) {
                            // 배너 정보를 담고 있는 최상위 노드 추출
                            const rootNode = honeyEl.closest ? (honeyEl.closest('.normal-display-board') || honeyEl.closest('.effect-area-merge') || node) : node;
                            handleEffectSupport(rootNode);
                        }
                    });
                });
            });
            effectObserver.observe(document.body, { childList: true, subtree: true });
            logStatus("[시스템] 대형 이펙트 후원 감시 시작.");
        }
    }

    /* ================================================================
       11. GUI 컨트롤 패널 (유리모핑 다크 테마 디자인)
    ================================================================ */
    let panel = null;
    let isCollapsed = false;

    function createGUI() {
        if (document.getElementById('bubi-helper-gui')) return;

        panel = document.createElement('div');
        panel.id = 'bubi-helper-gui';
        panel.innerHTML = `
            <div class="bh-header">
                <span class="bh-title">🤖 부비라이브 헬퍼 v1.6</span>
                <button class="bh-btn-toggle">—</button>
            </div>
            <div class="bh-content">
                <div class="bh-section">
                    <div class="bh-section-title">기본 매크로 설정</div>
                    <div class="bh-row">
                        <label>입장 시 자동인사</label>
                        <input type="checkbox" id="bh-welcome" ${DB.settings.autoWelcome ? 'checked' : ''}>
                    </div>
                    <div class="bh-row">
                        <label>자동 출석체크</label>
                        <input type="checkbox" id="bh-attendance" ${DB.settings.autoAttendance ? 'checked' : ''}>
                    </div>
                    <div class="bh-row">
                        <label>채팅 명령어 반응 (!)</label>
                        <input type="checkbox" id="bh-commands" ${DB.settings.enableCommands ? 'checked' : ''}>
                    </div>
                    <div class="bh-row">
                        <label>도배 방지 대기 시간 (초)</label>
                        <input type="number" id="bh-cooldown" value="${DB.settings.cooldownSeconds}" min="1" max="10" style="width: 50px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: #fff; text-align: center; border-radius: 4px;">
                    </div>
                </div>

                <div class="bh-section">
                    <div class="bh-section-title">등급별 인사말 설정</div>
                    <div class="bh-input-group">
                        <label>일반 환영 메시지</label>
                        <input type="text" id="bh-msg-normal" value="${DB.settings.welcomeMsgNormal}">
                    </div>
                    <div class="bh-input-group">
                        <label>열혈 환영 메시지</label>
                        <input type="text" id="bh-msg-hot" value="${DB.settings.welcomeMsgHot}">
                    </div>
                    <div class="bh-input-group">
                        <label>다이아/VIP 환영 메시지</label>
                        <input type="text" id="bh-msg-vip" value="${DB.settings.welcomeMsgVIP}">
                    </div>
                    <div class="bh-row" style="margin-top: 10px;">
                        <label>VIP 후원 인식 기준 (개)</label>
                        <input type="number" id="bh-min-gift" value="${DB.settings.minGift}" style="width: 60px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: #fff; text-align: center; border-radius: 4px;">
                    </div>
                </div>

                <div class="bh-section">
                    <div class="bh-section-title">현재 작동 로그</div>
                    <div id="bh-log-area"></div>
                </div>

                <button class="bh-btn-save">설정 저장 및 적용</button>
            </div>
        `;

        const style = document.createElement('style');
        style.innerHTML = `
            #bubi-helper-gui {
                position: fixed;
                top: 80px;
                right: 20px;
                width: 320px;
                background: rgba(18, 18, 18, 0.75);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 16px;
                box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.4);
                color: #ffffff;
                font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                z-index: 99999;
                overflow: hidden;
                transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), height 0.3s ease;
            }
            #bubi-helper-gui.collapsed {
                height: 48px;
                width: 180px;
            }
            .bh-header {
                background: rgba(255, 255, 255, 0.08);
                padding: 12px 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: move;
                user-select: none;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }
            .bh-title {
                font-weight: 600;
                font-size: 14px;
                letter-spacing: 0.5px;
            }
            .bh-btn-toggle {
                background: transparent;
                border: none;
                color: rgba(255, 255, 255, 0.6);
                cursor: pointer;
                font-size: 14px;
                transition: color 0.2s;
            }
            .bh-btn-toggle:hover {
                color: #ffffff;
            }
            .bh-content {
                padding: 16px;
                max-height: 450px;
                overflow-y: auto;
            }
            #bubi-helper-gui.collapsed .bh-content {
                display: none;
            }
            .bh-section {
                margin-bottom: 16px;
                background: rgba(255, 255, 255, 0.03);
                padding: 12px;
                border-radius: 10px;
                border: 1px solid rgba(255, 255, 255, 0.05);
            }
            .bh-section-title {
                font-size: 12px;
                font-weight: 600;
                color: #ff5277;
                margin-bottom: 10px;
                letter-spacing: 0.5px;
                text-transform: uppercase;
            }
            .bh-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
                font-size: 13px;
            }
            .bh-row label {
                color: rgba(255, 255, 255, 0.85);
            }
            .bh-input-group {
                margin-bottom: 8px;
                display: flex;
                flex-direction: column;
            }
            .bh-input-group label {
                font-size: 11px;
                color: rgba(255, 255, 255, 0.6);
                margin-bottom: 4px;
            }
            .bh-input-group input {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 6px;
                padding: 6px 10px;
                color: #ffffff;
                font-size: 13px;
                transition: all 0.2s;
            }
            .bh-input-group input:focus {
                border-color: #ff5277;
                background: rgba(255, 255, 255, 0.1);
                outline: none;
            }
            #bh-log-area {
                height: 80px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 6px;
                font-family: monospace;
                font-size: 10px;
                padding: 6px;
                overflow-y: auto;
                color: #a3ffb4;
                white-space: pre-wrap;
            }
            .bh-btn-save {
                width: 100%;
                background: linear-gradient(135deg, #ff5277 0%, #ff758c 100%);
                color: #ffffff;
                border: none;
                border-radius: 10px;
                padding: 10px;
                font-weight: 600;
                cursor: pointer;
                box-shadow: 0 4px 15px rgba(255, 82, 119, 0.3);
                transition: all 0.2s;
            }
            .bh-btn-save:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 20px rgba(255, 82, 119, 0.4);
            }
            .bh-header:active {
                cursor: grabbing;
            }
        `;

        document.body.appendChild(panel);
        document.body.appendChild(style);

        const btnToggle = panel.querySelector('.bh-btn-toggle');
        btnToggle.addEventListener('click', () => {
            isCollapsed = !isCollapsed;
            if (isCollapsed) {
                panel.classList.add('collapsed');
                btnToggle.innerText = '＋';
            } else {
                panel.classList.remove('collapsed');
                btnToggle.innerText = '—';
            }
        });

        const btnSave = panel.querySelector('.bh-btn-save');
        btnSave.addEventListener('click', () => {
            DB.settings.autoWelcome = panel.querySelector('#bh-welcome').checked;
            DB.settings.autoAttendance = panel.querySelector('#bh-attendance').checked;
            DB.settings.enableCommands = panel.querySelector('#bh-commands').checked;
            DB.settings.cooldownSeconds = parseInt(panel.querySelector('#bh-cooldown').value) || 3;
            DB.settings.welcomeMsgNormal = panel.querySelector('#bh-msg-normal').value;
            DB.settings.welcomeMsgHot = panel.querySelector('#bh-msg-hot').value;
            DB.settings.welcomeMsgVIP = panel.querySelector('#bh-msg-vip').value;
            DB.settings.minGift = parseInt(panel.querySelector('#bh-min-gift').value) || 300;

            saveDB();
            logStatus('[설정] 모든 설정이 성공적으로 저장 및 적용되었습니다.');
            btnSave.innerText = '적용 완료! ✓';
            setTimeout(() => { btnSave.innerText = '설정 저장 및 적용'; }, 1500);
        });

        makeDraggable(panel);
    }

    function logStatus(text) {
        const logArea = document.getElementById('bh-log-area');
        if (!logArea) return;
        const now = new Date();
        const timeStr = now.toTimeString().slice(0, 8);
        logArea.textContent += `[${timeStr}] ${text}\n`;
        logArea.scrollTop = logArea.scrollHeight;
    }

    function makeDraggable(el) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const header = el.querySelector('.bh-header');
        if (header) {
            header.onmousedown = dragMouseDown;
        } else {
            el.onmousedown = dragMouseDown;
        }

        function dragMouseDown(e) {
            e = e || window.event;
            if (e.target.classList.contains('bh-btn-toggle')) return;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            el.style.top = (el.offsetTop - pos2) + "px";
            el.style.left = (el.offsetLeft - pos1) + "px";
            el.style.right = 'auto';
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    function initBubiHelper() {
        if (window.location.href === 'about:blank' || window.location.origin === 'null') return;
        
        loadDB();
        initTodayChecked();
        
        setTimeout(() => {
            startChatObserver();
            startEffectObserver();
        }, 3000);
        
        setTimeout(createGUI, 2000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initBubiHelper);
    } else {
        initBubiHelper();
    }

})();
