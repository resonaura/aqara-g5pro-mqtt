// Fetch TOKEN via email/password and verify device list.
// Usage: AQARA_USER=... AQARA_PASS=... pnpm run login
import "dotenv/config";
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
