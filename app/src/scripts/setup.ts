import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import axios from "axios";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import yargs from "yargs";

const AREAS: Record<string, { server: string; appid: string }> = {
  CN: {
    server: "https://aiot-rpc.aqara.cn",
    appid: "444c476ef7135e53330f46e7",
  },
  EU: {
    server: "https://rpc-ger.aqara.com",
    appid: "444c476ef7135e53330f46e7",
  },
  US: {
    server: "https://aiot-rpc-usa.aqara.com",
    appid: "444c476ef7135e53330f46e7",
  },
  RU: { server: "https://rpc-ru.aqara.com", appid: "444c476ef7135e53330f46e7" },
  KR: { server: "https://rpc-kr.aqara.com", appid: "444c476ef7135e53330f46e7" },
  JP: { server: "https://rpc-kr.aqara.com", appid: "444c476ef7135e53330f46e7" },
  AU: { server: "https://rpc-au.aqara.com", appid: "444c476ef7135e53330f46e7" },
  OTHER: {
    server: "https://aiot-rpc-usa.aqara.com",
    appid: "444c476ef7135e53330f46e7",
  },
};

const PUBKEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCG46slB57013JJs4Vvj5cVyMpR
9b+B2F+YJU6qhBEYbiEmIdWpFPpOuBikDs2FcPS19MiWq1IrmxJtkICGurqImRUt
4lP688IWlEmqHfSxSRf2+aH0cH8VWZ2OaZn5DWSIHIPBF2kxM71q8stmoYiV0oZs
rZzBHsMuBwA4LQdxBwIDAQAB
-----END PUBLIC KEY-----`;

function encryptPassword(password: string): string {
  const md5 = crypto.createHash("md5").update(password).digest("hex");
  console.log(`   MD5 hash:     ${md5}`);
  const pub = crypto.createPublicKey(PUBKEY);
  const encrypted = crypto.publicEncrypt(
    { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(md5),
  );
  return encrypted.toString("base64");
}

interface SetupAnswers {
  username: string;
  password: string;
  area: keyof typeof AREAS;
  mqttUrl: string;
  mqttUser: string;
  mqttPass: string;
}

async function main() {
  const argv = await yargs(process.argv.slice(2)).option({
    auto: { type: "boolean", default: false },
    username: { type: "string" },
    password: { type: "string" },
    area: { type: "string" },
    "mqtt-url": { type: "string" },
    "mqtt-user": { type: "string" },
    "mqtt-pass": { type: "string" },
    "poll-interval": { type: "number", default: 1 },
    "log-level": { type: "string", default: "info" },
  }).argv;

  let answers: SetupAnswers;

  if (argv.auto) {
    // 🚀 Non-interactive mode (for Home Assistant add-on)
    if (!argv.username || !argv.password || !argv.area || !argv["mqtt-url"]) {
      console.error("❌ Missing required arguments for --auto mode");
      process.exit(1);
    }

    answers = {
      username: argv.username,
      password: argv.password,
      area: argv.area as keyof typeof AREAS,
      mqttUrl: argv["mqtt-url"],
      mqttUser: argv["mqtt-user"] || "",
      mqttPass: argv["mqtt-pass"] || "",
    };
  } else {
    // 🖐 Interactive mode
    answers = await inquirer.prompt([
      { name: "username", message: "Aqara Username (email):", type: "input" },
      {
        name: "password",
        message: "Aqara Password:",
        type: "password",
        mask: "*",
      },
      {
        name: "area",
        message: "Region:",
        type: "list",
        choices: Object.keys(AREAS),
        default: "US",
      },
      {
        name: "mqttUrl",
        message: "MQTT URL:",
        default: "mqtt://127.0.0.1:1883",
      },
      {
        name: "mqttUser",
        message: "MQTT Username (leave empty if none):",
        default: "",
      },
      {
        name: "mqttPass",
        message: "MQTT Password (leave empty if none):",
        default: "",
      },
    ]);
  }

  const { username, password, area, mqttUrl, mqttUser, mqttPass } = answers;
  const { server, appid } = AREAS[area];

  const phoneId = uuidv4().toUpperCase();
  const time = Date.now().toString();
  const nonce = uuidv4().replace(/-/g, "").substring(0, 16);
  const headers = {
    "User-Agent": "AqaraSetup/1.0.0",
    "App-Version": "3.0.0",
    "Sys-Type": "1",
    Lang: "en",
    "Phone-Model": "NodeSetup",
    PhoneId: phoneId,
    Time: time,
    Nonce: nonce,
  };

  console.log("\n🌐 Login request details:");
  console.log(`   Server:       ${server}`);
  console.log(`   Area:         ${area}`);
  console.log(`   AppID:        ${appid}`);
  console.log(`   Username:     ${username}`);
  console.log(`   PhoneId:      ${phoneId}`);

  const encryptedPassword = encryptPassword(password);
  console.log(
    `   Encrypted pw: ${encryptedPassword.substring(0, 20)}... (len=${encryptedPassword.length})`,
  );

  const requestHeaders = { ...headers, Appid: appid };
  console.log(`   Request headers: ${JSON.stringify(requestHeaders, null, 2)}`);

  const loginBody = {
    account: username,
    encryptType: 2,
    password: encryptedPassword,
  };
  console.log(
    `📤 Request body: ${JSON.stringify({ ...loginBody, password: loginBody.password.substring(0, 20) + "..." }, null, 2)}`,
  );
  console.log(`   Full URL: ${server}/app/v1.0/lumi/user/login\n`);

  try {
    const resp = await axios.post(
      `${server}/app/v1.0/lumi/user/login`,
      loginBody,
      {
        headers: requestHeaders,
        timeout: 15000,
      },
    );

    console.log(`📥 HTTP status:    ${resp.status} ${resp.statusText}`);
    console.log(
      `📥 Response headers: ${JSON.stringify(resp.headers, null, 2)}`,
    );
    console.log(`📥 Response body:  ${JSON.stringify(resp.data, null, 2)}`);

    if (resp.data.code !== 0) {
      console.error(
        `\n❌ Login failed (code=${resp.data.code}): ${resp.data.message}`,
      );
      console.error(
        `   Full error response: ${JSON.stringify(resp.data, null, 2)}`,
      );
      process.exit(1);
    }

    const token = resp.data.result.token;
    console.log(`\n✅ Login success`);
    console.log(`   Token: ${token.substring(0, 10)}... (len=${token.length})`);

    // Get device list
    console.log("\n📋 Fetching device list...");
    const deviceResp = await axios.get(
      `${server}/app/v1.0/lumi/app/position/device/query`,
      { headers: { ...headers, Token: token, Appid: appid }, timeout: 15000 },
    );

    console.log(
      `📥 Devices response (code=${deviceResp.data.code}): ${JSON.stringify(deviceResp.data, null, 2)}`,
    );

    const allDevices: any[] = deviceResp.data.result?.devices || [];
    console.log(`   Total devices in account: ${allDevices.length}`);
    allDevices.forEach((d: any) =>
      console.log(`     • ${d.deviceName} | model=${d.model} | did=${d.did}`),
    );

    const devices = allDevices.filter((d: any) =>
      d.model?.startsWith("lumi.camera"),
    );

    if (!devices.length) {
      console.error("❌ No cameras found for this account");
      process.exit(1);
    }

    console.log(`\n✅ Found ${devices.length} camera(s):`);
    devices.forEach((d: any) => console.log(`  - ${d.deviceName} (${d.did})`));

    // Build .env
    const envContent = `NODE_ENV=production
AQUARA_URL=${server}
APPID=${appid}
TOKEN=${token}
MQTT_URL=${mqttUrl}
MQTT_USER=${mqttUser}
MQTT_PASS=${mqttPass}
POLL_INTERVAL=${argv["poll-interval"]}
LOG_LEVEL=${argv["log-level"]}
`;

    fs.writeFileSync(path.join(process.cwd(), ".env"), envContent, "utf-8");
    console.log("✅ .env generated successfully");
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      console.error(`\n❌ HTTP Error: ${err.message}`);
      console.error(`   Code:    ${err.code}`);
      console.error(`   Status:  ${err.response?.status}`);
      console.error(`   URL:     ${err.config?.url}`);
      console.error(
        `   Request headers: ${JSON.stringify(err.config?.headers, null, 2)}`,
      );
      console.error(`   Request body:    ${err.config?.data}`);
      console.error(
        `   Response body:   ${JSON.stringify(err.response?.data, null, 2)}`,
      );
    } else {
      console.error(`\n❌ Error: ${err.message}`);
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
