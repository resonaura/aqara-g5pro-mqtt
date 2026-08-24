// Получение TOKEN через email/password и проверка списка устройств.
// Использование: AQARA_USER=... AQARA_PASS=... npm run login
import { login, getDevices } from "../aqara.js";

const user = process.env.AQARA_USER;
const pass = process.env.AQARA_PASS;
if (!user || !pass) {
  console.error("Usage: AQARA_USER=<email> AQARA_PASS=<password> npm run login");
  process.exit(1);
}

await login(user, pass);
console.log("✅ Login OK");
const res = await getDevices();
const devices = res.result?.devices ?? [];
console.log(`📱 Devices: ${devices.length}`);
devices.forEach((d) => console.log(`  - ${d.deviceName} (${d.model}) did=${d.did}`));
