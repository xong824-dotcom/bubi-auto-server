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

    try {
        // 1. 로그인 페이지 접속
        console.log("🔑 로그인 페이지로 이동 중...");
        await page.goto('https://www.bubeelive.com/login', { waitUntil: 'networkidle2' });

        // 페이지 내의 input 태그가 나타날 때까지 대기
        await page.waitForSelector('input', { timeout: 30000 });
        
        const inputs = await page.$$('input');
        console.log(`[Input Info] 페이지에서 총 ${inputs.length}개의 input 요소를 감지했습니다.`);
        
        let idInput = null;
        let pwInput = null;

        // 감지된 input 필드들을 돌며 아이디와 비밀번호 필드 식별
        for (const input of inputs) {
            const type = (await page.evaluate(el => el.getAttribute('type'), input) || '').toLowerCase();
            const placeholder = (await page.evaluate(el => el.getAttribute('placeholder'), input) || '');
            console.log(`[Input Debug] Input 요소 발견: type="${type}", placeholder="${placeholder}"`);
            
            if (type === 'password') {
                pwInput = input;
            } else if (type === 'text' || type === 'email' || type === 'tel' || type === 'number' || type === '') {
                // placeholder에 비밀번호/패스워드 관련 키워드가 없으면 아이디 필드로 선택
                if (!placeholder.includes('비밀번호') && !placeholder.includes('password') && !placeholder.includes('패스워드')) {
                    idInput = input;
                }
            }
        }

        // 명시적으로 찾지 못한 경우 순서대로 매핑 (1번째: ID, 2번째: PW)
        if (!idInput && inputs.length > 0) idInput = inputs[0];
        if (!pwInput && inputs.length > 1) pwInput = inputs[1];

        if (idInput && pwInput) {
            console.log("📝 로그인 정보 입력 중...");
            
            // 기존 텍스트가 있을 수 있으므로 선택하여 삭제 후 입력
            await idInput.click({ clickCount: 3 });
            await idInput.type(BUBEE_ID);
            
            await pwInput.click({ clickCount: 3 });
            await pwInput.type(BUBEE_PW);
        } else {
            throw new Error(`로그인 입력 필드를 식별할 수 없습니다. (검색된 input 개수: ${inputs.length})`);
        }

        // 로그인 시도 (엔터 입력)
        console.log("🔘 로그인 시도...");
        await page.keyboard.press('Enter');

        // 로그인 완료 후 페이지 이동 대기
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
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
