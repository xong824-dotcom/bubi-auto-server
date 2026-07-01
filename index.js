const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BUBEE_ID = process.env.BUBEE_ID;
const BUBEE_PW = process.env.BUBEE_PW;
const BUBEE_ROOM_ID = process.env.BUBEE_ROOM_ID || '115654';

if (!BUBEE_ID || !BUBEE_PW) {
    console.error("❌ 에러: BUBEE_ID 와 BUBEE_PW 환경 변수가 설정되지 않았습니다. .env 파일을 확인해 주세요.");
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
        // 1. 로그인 페이지 또는 메인 페이지 접속
        console.log("🔑 로그인 페이지로 이동 중...");
        await page.goto('https://www.bubeelive.com/login', { waitUntil: 'networkidle2' });

        // 페이지가 완전히 로딩되도록 대기
        await new Promise(r => setTimeout(r, 2000));

        // 모든 프레임에서 비밀번호 입력란이 있는지 검색하는 헬퍼 함수
        let pwInput = null;
        let idInput = null;
        let targetFrame = page;

        const scanPasswordInput = async () => {
            const frames = activePage.frames();
            for (const frame of frames) {
                try {
                    const inputs = await frame.$$('input');
                    for (const input of inputs) {
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

        // 아이디 필드 식별 (비밀번호 필드가 발견된 동일한 프레임에서 탐색)
        if (pwInput) {
            const inputs = await targetFrame.$$('input');
            for (const input of inputs) {
                const type = (await targetFrame.evaluate(el => el.getAttribute('type'), input) || '').toLowerCase();
                const placeholder = (await targetFrame.evaluate(el => el.getAttribute('placeholder'), input) || '');
                if (type === 'text' || type === 'email' || type === 'tel' || type === 'number' || type === '') {
                    if (!placeholder.includes('비밀번호') && !placeholder.includes('password') && !placeholder.includes('패스워드')) {
                        idInput = input;
                        break;
                    }
                }
            }
            if (!idInput && inputs.length > 0) idInput = inputs[0];
        }

        if (idInput && pwInput) {
            console.log(`📝 로그인 정보 입력 중... (대상 프레임: ${targetFrame.url()})`);
            
            // 기존 텍스트 제거하고 입력
            await idInput.click({ clickCount: 3 });
            await idInput.type(BUBEE_ID);
            
            await pwInput.click({ clickCount: 3 });
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
            const submitBtn = await targetFrame.$('button[type="submit"], button.btn-submit, .btn-login-submit, button:has-text("로그인")');
            if (submitBtn) {
                console.log("🔘 로그인 전송 버튼 클릭...");
                await submitBtn.click();
            }
        } catch (e) {
            console.log(`⚠️ 로그인 버튼 클릭 보조 기능 건너뜀 (이미 전송되었거나 화면이 전환됨): ${e.message}`);
        }

        // 로그인 완료 후 페이지 이동 대기
        if (activePage !== page) {
            console.log("⏳ 팝업창에서 로그인 처리 중... 메인 창의 리다이렉트 대기...");
            await new Promise(r => setTimeout(r, 5000));
            // 메인 페이지가 로그인된 상태로 동기화될 때까지 대기
        } else {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        }
        console.log("✅ 로그인 완료!");

        // 2. 라이브 방송 페이지로 이동
        const targetUrl = `https://www.bubeelive.com/lives/play/${BUBEE_ROOM_ID}`;
        console.log(`📺 방송국 이동: ${targetUrl}`);

        // 유저스크립트 로드
        const userscriptPath = path.join(__dirname, 'userscript.js');
        const userscriptContent = fs.readFileSync(userscriptPath, 'utf8');

        // 페이지가 로드되기 전에 유저스크립트를 자동 주입 (Tampermonkey처럼 작동)
        await page.evaluateOnNewDocument(userscriptContent);

        // 방송 페이지 접속
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });
        console.log("✨ 유저스크립트 로드 완료 및 모니터링 중...");

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
