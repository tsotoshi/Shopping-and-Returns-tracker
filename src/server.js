import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
// Safe default: only this computer can open the app. If you set
// APP_PASSWORD, it also listens on your Wi-Fi so your phone can use it.
const host = process.env.HOST || (process.env.APP_PASSWORD ? '0.0.0.0' : '127.0.0.1');
const db = openDb();
createApp(db).listen(port, host, () => {
  console.log(`Shopping & Returns Tracker running at http://localhost:${port}`);
  if (host === '0.0.0.0') console.log('Also reachable from other devices on your network (password protected).');
  else console.log('Only reachable from this computer. Set APP_PASSWORD in .env to use it from your phone.');
});
