#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const serverEntry = path.join(__dirname, '../server/dist/index.js');
const clientIndex = path.join(__dirname, '../client/dist/index.html');

if (fs.existsSync(serverEntry) && fs.existsSync(clientIndex)) {
  process.exit(0);
}

console.error(`
❌  Production build eksik.

Şunları çalıştır:
  npm install
  cd server && npm install && cd ..
  npm run build

Geliştirme için:
  npm run dev
`);
process.exit(1);
