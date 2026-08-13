const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { execSync } = require('child_process');

const chromePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
    console.log('🌐 크롬 브라우저를 엽니다... 부비라이브에 로그인해주세요!');

    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        defaultViewport: null,
    });

    const page = await browser.newPage();
    await page.goto('https://www.ggullive.com/', { waitUntil: 'domcontentloaded', timeout: 0 });

    console.log('⏳ 로그인을 완료하실 때까지 기다립니다...');

    let isLoggedIn = false;
    while (!isLoggedIn) {
        await new Promise(r => setTimeout(r, 2000));
        const cookies = await page.cookies();
        if (cookies.find(c => c.name === 'auth_token')) {
            isLoggedIn = true;
            fs.writeFileSync('cookies.json', JSON.stringify(cookies, null, 2));
            console.log('✅ 로그인 성공! cookies.json 저장 완료!');

            // 자동으로 깃허브에 푸시
            try {
                execSync('git add -f cookies.json && git commit -m "refresh cookies" && git push', {
                    cwd: __dirname, stdio: 'inherit'
                });
                console.log('✅ GitHub 자동 업로드 완료!');
                console.log('✅ 이제 서버에서 git pull && pm2 restart bubi 를 실행해주세요!');
            } catch(e) {
                console.log('⚠️ git push 실패:', e.message);
            }
        }
    }

    await new Promise(r => setTimeout(r, 2000));
    await browser.close();
    process.exit(0);
})();
