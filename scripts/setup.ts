import { copyFileSync, existsSync } from 'node:fs';
if (!existsSync('.env')) { copyFileSync('.env.example', '.env'); console.log('Created .env. Add your credentials locally; do not post them in chat.'); }
else console.log('.env already exists; keeping all settings.');
console.log('Next: npm run tools:install, npm run doctor, npm run register, npm run spotify:login, npm run build, npm start.');
