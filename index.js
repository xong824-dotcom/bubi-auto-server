const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BUBEE_ID = process.env.BUBEE_ID;
const BUBEE_PW = process.env.BUBEE_PW;
const BUBEE_ROOM_ID = process.env.BUBEE_ROOM_ID || '115654';

if (!BUBEE_ROOM_ID) {
    console.error("❌ 에러: BUBEE_ROOM_ID 환경 변수가 설정되지 않았습니다.");
    process.exit(1);
}

async function run() {
    console.log("🚀 Bubeelive Auto Helper Bot 기동 중...");
    
    // Railway 및 Linux 환경 최적화 브라우저 실행 옵션
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1280,720'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    // 활성 페이지 포인터 (팝업창이 열릴 경우를 대비해 동적으로 변환)
    let activePage = page;

    // 브라우저의 console.log를 서버 콘솔로 출력
    page.on('console', msg => {
        console.log(`[Browser Console] ${msg.text()}`);
    });

    page.on('error', err => {
        console.error(`[Page Error] ${err.message}`);
    });

    page.on('pageerror', pageerr => {
        console.error(`[Page Uncaught Exception] ${pageerr.message}`);
    });

    // 새 탭/팝업창(window.open) 감지 및 연동 핸들러
    browser.on('targetcreated', async target => {
        if (target.type() === 'page') {
            try {
                const newPage = await target.page();
                console.log(`💡 [Popup Info] 새 팝업/탭 감지됨: ${newPage.url()}`);
                activePage = newPage;
                
                newPage.on('console', msg => {
                    console.log(`[Popup Console] ${msg.text()}`);
                });
                
                newPage.on('error', err => {
                    console.error(`[Popup Page Error] ${err.message}`);
                });
            } catch (e) {
                console.log(`[Popup Warning] 팝업창 연동 실패: ${e.message}`);
            }
        }
    });

    try {
        const BUBEE_COOKIES = process.env.BUBEE_COOKIES;
        let loginSkipped = false;

        // 쿠키 정보가 등록되어 있다면 쿠키 주입 로그인 시도 (캡차/로그인 모달 우회용)
        if (BUBEE_COOKIES) {
            console.log("🍪 쿠키 데이터를 감지했습니다. 쿠키 주입 로그인을 시도합니다...");
            try {
                // 쿠키 설정에 도메인을 맞추기 위해 메인 도메인을 먼저 로드
                await page.goto('https://www.bubeelive.com/', { waitUntil: 'domcontentloaded' });
                
                const cookies = JSON.parse(BUBEE_COOKIES);
                await page.setCookie(...cookies);
                console.log("✅ 쿠키 주입 성공! 일반 로그인 절차를 생략하고 바로 방송 페이지로 진입합니다.");
                loginSkipped = true;
            } catch (e) {
                console.error(`❌ 쿠키 주입 실패: ${e.message}. 일반 ID 로그인 절차를 진행합니다.`);
            }
        }

        if (!loginSkipped) {
            if (!BUBEE_ID || !BUBEE_PW) {
                console.error("❌ 에러: 일반 로그인용 BUBEE_ID 와 BUBEE_PW 환경 변수가 설정되지 않았습니다.");
                await browser.close();
                process.exit(1);
            }

            // 1. 로그인 페이지 또는 메인 페이지 접속
            console.log("🔑 로그인 페이지로 이동 중...");
            await page.goto('https://www.bubeelive.com/login', { waitUntil: 'networkidle2' });

            // 페이지가 완전히 로딩되도록 대기
            await new Promise(r => setTimeout(r, 2000));

            // 모든 프레임에서 비밀번호 입력란이 있는지 검색하는 헬퍼 함수 (오직 화면에 보이는 활성 입력란만 스캔)
            let pwInput = null;
            let idInput = null;
            let targetFrame = page;

            const scanPasswordInput = async () => {
                const frames = activePage.frames();
                for (const frame of frames) {
                    try {
                        const inputs = await frame.$$('input');
                        for (const input of inputs) {
                            // 가시성 검사 (display: none이거나 크기가 0인 숨겨진 input 제외)
                            const visible = await frame.evaluate(el => {
                                const style = window.getComputedStyle(el);
                                return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
                            }, input);
                            
                            if (!visible) continue;

                            const type = (await frame.evaluate(el => el.getAttribute('type'), input) || '').toLowerCase();
                            if (type === 'password') {
                                pwInput = input;
                                targetFrame = frame;
                                return true;
                            }
                        }
                    } catch (e) {}
                }
                return false;
            };

            // 초기 스캔
            await scanPasswordInput();
            
            // 비밀번호 입력창이 감지되지 않은 경우 (로그인 모달이 안 열렸거나 로그인 수단 선택 화면 상태)
            if (!pwInput) {
                console.log("💡 비밀번호 입력창이 발견되지 않았습니다. 로그인 모달 열기 또는 로그인 방식 선택을 시작합니다...");
                
                // 1단계: 먼저 로그인 모달 열기 시도 (로그인 버튼 클릭)
                const loginSelectors = [
                    '.btn-login',
                    '#login-btn',
                    'button.login',
                    'a.login',
                    '[data-testid="login-button"]'
                ];
                
                let clicked = false;
                for (const selector of loginSelectors) {
                    try {
                        const btn = await page.$(selector);
                        if (btn) {
                            console.log(`🔘 로그인 버튼 발견 (${selector}), 클릭합니다.`);
                            await btn.click();
                            clicked = true;
                            break;
                        }
                    } catch (e) {}
                }
                
                if (!clicked) {
                    // 엘리먼트 텍스트 매칭으로 '로그인' 버튼 탐색
                    const elements = await page.$$('button, a, div, span, p');
                    for (const el of elements) {
                        try {
                            const text = (await page.evaluate(el => el.innerText, el) || '').trim();
                            if (text === '로그인' || text.includes('로그인')) {
                                console.log("🔘 텍스트 매칭으로 로그인 버튼 발견, 클릭합니다.");
                                await el.click();
                                clicked = true;
                                break;
                            }
                        } catch (e) {}
                    }
                }
                
                // 모달이 뜰 때까지 2초 대기
                await new Promise(r => setTimeout(r, 2000));

                // 2단계: 로그인 수단 선택 화면(ID, 계정 추가하기 등)이 떴는지 확인 후 진입 시도
                await scanPasswordInput();
                
                if (!pwInput) {
                    console.log("💡 로그인 방식 선택 화면이 감지되었습니다. 'ID' 로그인 진입을 시도합니다...");
                    
                    let idSelectorClicked = false;
                    const elements = await page.$$('button, a, div, span, p');
                    
                    // 디버깅용: 발견된 엘리먼트 텍스트 출력
                    console.log(`[Selector Debug] 총 ${elements.length}개의 엘리먼트를 스캔합니다.`);
                    for (const el of elements) {
                        try {
                            const text = (await page.evaluate(el => el.innerText, el) || '').trim();
                            if (text && text.length < 50) {
                                console.log(`  - 발견된 텍스트: "${text.replace(/\n/g, ' ')}"`);
                            }
                        } catch (e) {}
                    }

                    // ID 로그인 관련 키워드 매칭 및 클릭
                    for (const el of elements) {
                        try {
                            const text = (await page.evaluate(el => el.innerText, el) || '').trim();
                            const textLower = text.toLowerCase();
                            
                            // 구글, 카카오, 네이버 등의 소셜 로그인 수단은 오매칭 방지를 위해 제외
                            if (
                                textLower.includes('google') || 
                                textLower.includes('kakao') || 
                                textLower.includes('naver') || 
                                textLower.includes('구글') || 
                                textLower.includes('카카오') || 
                                textLower.includes('네이버')
                            ) {
                                continue;
                            }
                            
                            if (
                                textLower === 'id' || 
                                textLower.replace(/\s/g, '') === 'id' ||
                                textLower.startsWith('id\n') ||
                                textLower.startsWith('id ') ||
                                text.includes('계정 추가하기') || 
                                text.includes('계정추가하기') || 
                                text.includes('아이디') || 
                                text.includes('일반 로그인')
                            ) {
                                console.log(`🔘 로그인 방식 선택 클릭 매칭 성공: "${text.replace(/\n/g, ' ')}"`);
                                await el.click();
                                idSelectorClicked = true;
                                break;
                            }
                        } catch (e) {}
                    }
                    
                    if (idSelectorClicked) {
                        console.log("⏳ ID 로그인 화면으로 전환 대기 중 (팝업창 생성 가능성 대기)...");
                        await new Promise(r => setTimeout(r, 3000));
                        await scanPasswordInput(); // 입력창 다시 감지
                    }
                }
            }

            // 클릭 후 최종 프레임 재스캔 (아이프레임 또는 팝업창 최종 감지)
            if (!pwInput) {
                await scanPasswordInput();
            }

            // 아이디 필드 식별 (비밀번호 필드가 발견된 동일한 프레임에서 보이는 텍스트 입력창 탐색)
            if (pwInput) {
                const inputs = await targetFrame.$$('input');
                for (const input of inputs) {
                    // 가시성 검사
                    const visible = await targetFrame.evaluate(el => {
                        const style = window.getComputedStyle(el);
                        return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
                    }, input);
                    
                    if (!visible) continue;

                    const type = (await targetFrame.evaluate(el => el.getAttribute('type'), input) || '').toLowerCase();
                    const placeholder = (await targetFrame.evaluate(el => el.getAttribute('placeholder'), input) || '');
                    if (type === 'text' || type === 'email' || type === 'tel' || type === 'number' || type === '') {
                        if (!placeholder.includes('비밀번호') && !placeholder.includes('password') && !placeholder.includes('패스워드')) {
                            idInput = input;
                            break;
                        }
                    }
                }
                
                // 가시성이 보장되는 첫 번째 입력필드를 아이디로 최종 매핑 (대체재)
                if (!idInput) {
                    for (const input of inputs) {
                        const visible = await targetFrame.evaluate(el => {
                            const style = window.getComputedStyle(el);
                            return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
                        }, input);
                        if (visible) {
                            idInput = input;
                            break;
                        }
                    }
                }
            }

            if (idInput && pwInput) {
                console.log(`📝 로그인 정보 입력 중... (대상 프레임: ${targetFrame.url()})`);
                
                // click() 실패 시 focus() 처리로 예외 복구
                try {
                    await idInput.click({ clickCount: 3 });
                } catch (e) {
                    console.log("⚠️ idInput 클릭 실패, 포커스로 대체 진행합니다.");
                    await idInput.focus();
                }
                await idInput.type(BUBEE_ID);
                
                try {
                    await pwInput.click({ clickCount: 3 });
                } catch (e) {
                    console.log("⚠️ pwInput 클릭 실패, 포커스로 대체 진행합니다.");
                    await pwInput.focus();
                }
                await pwInput.type(BUBEE_PW);
            } else {
                throw new Error(`로그인 입력 필드를 식별할 수 없습니다. (비밀번호 감지: ${pwInput ? 'O' : 'X'}, 아이디 감지: ${idInput ? 'O' : 'X'})`);
            }

            // 로그인 시도 (엔터 키 입력)
            console.log("🔘 로그인 시도...");
            await activePage.keyboard.press('Enter');

            // 1.5초 대기 후 서브밋 버튼이 별도로 있는 경우 클릭 시도 (보조)
            await new Promise(r => setTimeout(r, 1500));
            try {
                // 표준 CSS 선택자 조합 사용 (비표준 :has-text 선택자는 제외하여 구문 오류 방지)
                const submitBtn = await targetFrame.$('button[type="submit"], button.btn-submit, .btn-login-submit, .btn-submit');
                if (submitBtn) {
                    console.log("🔘 로그인 전송 버튼 클릭 (CSS)...");
                    await submitBtn.click();
                } else {
                    // 텍스트 매칭으로 전송 버튼 클릭 시도
                    const btns = await targetFrame.$$('button, a, div[role="button"]');
                    for (const btn of btns) {
                        const text = (await targetFrame.evaluate(el => el.innerText, btn) || '').trim();
                        if (text === '로그인' || text.includes('로그인')) {
                            console.log(`🔘 로그인 전송 버튼 클릭 (텍스트 매칭: "${text}")...`);
                            await btn.click();
                            break;
                        }
                    }
                }
            } catch (e) {
                console.log(`⚠️ 로그인 버튼 클릭 보조 기능 건너뜀 (이미 전송되었거나 화면이 전환됨): ${e.message}`);
            }

            // 로그인 완료 후 페이지 이동 대기
            // SPA 환경에서는 주소 이동이 발생하지 않으므로 단순 대기(4초) 후 바로 방송국 페이지로 이동하여 세션을 인계받음
            console.log("⏳ 로그인 처리 및 세션 저장 대기 중 (4초)...");
            await new Promise(r => setTimeout(r, 4000));
        }

        console.log("✅ 로그인 완료!");

        // 방 번호 리스트 추출 (콤마로 구분된 여러 방 지원)
        const roomIds = BUBEE_ROOM_ID.split(',').map(id => id.trim()).filter(id => id);
        console.log(`📺 모니터링할 방송국 리스트: ${roomIds.join(', ')}`);

        // 유저스크립트 로드
        const userscriptPath = path.join(__dirname, 'userscript.js');
        const userscriptContent = fs.readFileSync(userscriptPath, 'utf8');

        // 각 방의 페이지(탭) 객체 상태를 저장할 맵
        const roomStatus = {};

        // 각 방별로 새 탭을 열어 동시에 모니터링 시작
        for (let i = 0; i < roomIds.length; i++) {
            const roomId = roomIds[i];
            const targetUrl = `https://www.bubeelive.com/lives/play/${roomId}`;
            
            // 첫 번째 방은 로그인한 기존 page(탭)를 재사용하고, 추가 방들은 새 탭을 개설
            const roomPage = (i === 0) ? page : await browser.newPage();
            await roomPage.setViewport({ width: 1280, height: 720 });
            
            // 각 탭별 독립적인 콘솔 로깅 연동
            roomPage.on('console', msg => console.log(`[Room ${roomId} Console] ${msg.text()}`));
            roomPage.on('error', err => console.error(`[Room ${roomId} Error] ${err.message}`));
            roomPage.on('pageerror', pageerr => console.error(`[Room ${roomId} Uncaught Exception] ${pageerr.message}`));

            // 페이지가 로드되기 전에 유저스크립트를 자동 주입 (Tampermonkey처럼 작동)
            await roomPage.evaluateOnNewDocument(userscriptContent);

            console.log(`📺 [Room ${roomId}] 방송 접속 시도 중: ${targetUrl}`);
            await roomPage.goto(targetUrl, { waitUntil: 'networkidle2' });
            console.log(`✨ [Room ${roomId}] 접속 완료 및 모니터링 시작!`);

            roomStatus[roomId] = { page: roomPage, url: targetUrl, isOffline: false };
        }

        // [추가 기능] 방종 감지 및 방송 시작 자동 재입장 (1분 간격 폴링)
        setInterval(async () => {
            for (const roomId of roomIds) {
                const room = roomStatus[roomId];
                if (!room) continue;

                try {
                    if (!room.isOffline) {
                        // 1. 현재 방송 중인 경우 -> 방송이 종료(방종)되었는지 체크
                        const isEnded = await room.page.evaluate(() => {
                            const text = document.body.innerText || '';
                            // 플랫폼에 따라 다를 수 있으나, 일반적으로 출력되는 텍스트를 기반으로 감지
                            return text.includes('방송이 종료') || 
                                   text.includes('방송 종료') ||
                                   text.includes('오프라인 상태입니다') ||
                                   text.includes('종료된 방송');
                        });

                        if (isEnded) {
                            console.log(`\n💤 [Room ${roomId}] 방종(방송 종료) 감지됨! 방에서 퇴장하여 대기 모드로 전환합니다.`);
                            room.isOffline = true;
                            // 빈 페이지(about:blank)로 이동하여 채팅방에서 완전히 빠져나오고 시스템 리소스 확보
                            await room.page.goto('about:blank');
                        }
                    } else {
                        // 2. 대기 모드(방종 상태)인 경우 -> 방송이 다시 켜졌는지 찔러보기
                        console.log(`⏳ [Room ${roomId}] 방송 재시작 여부를 확인합니다...`);
                        await room.page.goto(room.url, { waitUntil: 'domcontentloaded' });
                        
                        // 화면이 대략적으로 로드되어 텍스트가 표시될 때까지 3초 대기
                        await new Promise(r => setTimeout(r, 3000));
                        
                        const stillEnded = await room.page.evaluate(() => {
                            const text = document.body.innerText || '';
                            return text.includes('방송이 종료') || 
                                   text.includes('방송 종료') ||
                                   text.includes('오프라인 상태입니다') ||
                                   text.includes('종료된 방송');
                        });

                        if (stillEnded) {
                            // 아직도 방종 상태이면 다시 리소스 확보를 위해 퇴장
                            await room.page.goto('about:blank');
                        } else {
                            // 다시 방송이 시작됨!
                            console.log(`🎉 [Room ${roomId}] 방송이 다시 시작되었습니다! 봇이 자동으로 채팅방에 재입장했습니다!`);
                            room.isOffline = false;
                        }
                    }
                } catch (err) {
                    console.error(`[Room ${roomId} 모니터링 오류] ${err.message}`);
                }
            }
        }, 60 * 1000); // 1분 주기 (60000ms)

        // 브라우저 인스턴스 유지
        await new Promise(() => {});

    } catch (err) {
        console.error("❌ 실행 중 치명적인 오류가 발생했습니다:", err);
        await browser.close();
        process.exit(1);
    }
}

// 예외 처리
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

run();
