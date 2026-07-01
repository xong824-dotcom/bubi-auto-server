FROM node:20-slim

# Puppeteer/Chromium 실행에 필요한 의존성 패키지 및 Chrome 브라우저 설치
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer가 별도의 Chromium을 다운로드하지 않고 설치된 Chrome을 사용하도록 환경 설정
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./

# package-lock.json이 없을 때도 빌드가 되도록 npm install 사용
RUN npm install --omit=dev

COPY . .

CMD [ "npm", "start" ]
