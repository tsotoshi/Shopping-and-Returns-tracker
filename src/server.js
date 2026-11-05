import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const db = openDb();
createApp(db).listen(port, () => {
  console.log(`Shopping & Returns Tracker running at http://localhost:${port}`);
});
