# Node.jsの公式イメージをベースにする
FROM node:latest

# アプリケーションのソースコードをコンテナ内にコピーする
WORKDIR /app
COPY filter.ts package.json package-lock.json tsconfig.json /app/

# アプリケーションの依存関係をインストールする
RUN npm install --production

# アプリケーションをコンパイルする
RUN npx tsc

# リスナーポートの設定
EXPOSE 8081

# アプリケーションを実行するコマンドを指定する
CMD ["node", "filter.js"]
