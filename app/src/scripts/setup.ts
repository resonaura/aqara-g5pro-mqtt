import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
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
    "camera-ips": { type: "string" },
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
    const { default: inquirer } = await import("inquirer");
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
  const appkey = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi";

  const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

  function aqaraSign(opts: { nonce: string; time: string; token?: string; body?: string }): string {
    let pre = `Appid=${appid}&Nonce=${opts.nonce}&Time=${opts.time}`;
    if (opts.token) pre += `&Token=${opts.token}`;
    if (opts.body) pre += `&${opts.body}`;
    pre += `&${appkey}`;
    return md5(pre);
  }

  const phoneId = uuidv4().toUpperCase();
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    lang: "en",
    "app-version": "6.1.6",
    "sys-type": "1",
    "sys-version": "14",
    "phone-model": "NodeSetup",
    phoneid: phoneId,
    appid,
  };

  console.log(`🌐 Authenticating with Aqara (${area})`);

  const encryptedPassword = encryptPassword(password);

  const loginBody = JSON.stringify({
    account: username,
    encryptType: 2,
    password: encryptedPassword,
  });
  const loginTime = Date.now().toString();
  const loginNonce = crypto.randomBytes(16).toString("hex").toUpperCase();

  try {
    const resp = await axios.post(`${server}/app/v1.0/lumi/user/login`, loginBody, {
      headers: {
        ...baseHeaders,
        Time: loginTime,
        Nonce: loginNonce,
        Sign: aqaraSign({
          nonce: loginNonce,
          time: loginTime,
          body: loginBody,
        }),
      },
      timeout: 15000,
    });

    console.log(`📥 HTTP status:    ${resp.status} ${resp.statusText}`);

    if (resp.data.code !== 0) {
      const code = Number.isFinite(Number(resp.data.code)) ? Number(resp.data.code) : "unknown";
      console.error(`\n❌ Login failed (code=${code})`);
      process.exit(1);
    }

    const token = resp.data.result.token;
    const userId = resp.data.result.userId;
    console.log(`\n✅ Login success`);

    // Get device list
    console.log("\n📋 Fetching device list...");
    const devTime = Date.now().toString();
    const devNonce = crypto.randomBytes(16).toString("hex").toUpperCase();
    const deviceResp = await axios.get(`${server}/app/v1.0/lumi/app/position/device/query`, {
      headers: {
        ...baseHeaders,
        Token: token,
        Time: devTime,
        Nonce: devNonce,
        Sign: aqaraSign({ nonce: devNonce, time: devTime, token }),
      },
      timeout: 15000,
    });

    const deviceCode = Number.isFinite(Number(deviceResp.data.code))
      ? Number(deviceResp.data.code)
      : "unknown";
    console.log(`📥 Devices response (code=${deviceCode})`);

    const allDevices: any[] = deviceResp.data.result?.devices || [];
    console.log(`   Total devices in account: ${allDevices.length}`);

    const devices = allDevices.filter((d: any) => d.model?.startsWith("lumi.camera"));

    if (!devices.length) {
      console.error("❌ No cameras found for this account");
      process.exit(1);
    }

    console.log(`\n✅ Found ${devices.length} camera(s)`);

    // Build .env
    let envContent = `NODE_ENV=production
AQUARA_URL=${server}
APPID=${appid}
TOKEN=${token}
USER_ID=${userId}
PHONE_ID=${phoneId}
AQARA_USER=${username}
AQARA_PASS=${password}
MQTT_URL=${mqttUrl}
MQTT_USER=${mqttUser}
MQTT_PASS=${mqttPass}
POLL_INTERVAL=${argv["poll-interval"]}
LOG_LEVEL=${argv["log-level"]}
`;
    if (argv["camera-ips"]) {
      envContent += `CAMERA_IPS=${argv["camera-ips"]}\n`;
    }

    const envPath = path.join(process.cwd(), ".env");
    fs.writeFileSync(envPath, envContent, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    console.log("✅ .env generated successfully");
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const code = /^[A-Z_]{1,40}$/.test(err.code ?? "") ? err.code : "unknown";
      console.error(`\n❌ Authentication request failed (code=${code})`);
      console.error(`   Status:  ${err.response?.status}`);
    } else {
      console.error("\n❌ Setup failed");
    }
    process.exit(1);
  }
}

main();
