import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import axios from "axios";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

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

// Aqara RSA public key (same as Python version)
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
    Buffer.from(md5)
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
  console.log("\n#### Aqara G5 Pro Setup ####\n");

  const answers = await inquirer.prompt([
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
    { name: "mqttUrl", message: "MQTT URL:", default: "mqtt://127.0.0.1:1883" },
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

  const { username, password, area, mqttUrl, mqttUser, mqttPass } = answers;
  const { server, appid } = AREAS[area];

  const phoneId = uuidv4().toUpperCase();
  const headers = {
    "User-Agent": "AqaraSetup/1.0.0",
    "App-Version": "3.0.0",
    "Sys-Type": "1",
    Lang: "en",
    "Phone-Model": "NodeSetup",
    PhoneId: phoneId,
  };

  try {
    // Login
    const resp = await axios.post(
      `${server}/app/v1.0/lumi/user/login`,
      {
        account: username,
        encryptType: 2,
        password: encryptPassword(password),
      },
      {
        headers: {
          ...headers,
          Appid: appid,
        },
      }
    );

    if (resp.data.code !== 0) {
      console.error("❌ Login failed:", resp.data.message);
      process.exit(1);
    }

    const token = resp.data.result.token;
    console.log("✅ Login success");

    // Get device list
    const deviceResp = await axios.get(
      `${server}/app/v1.0/lumi/app/position/device/query`,
      {
        headers: {
          ...headers,
          Token: token,
          Appid: appid,
        },
      }
    );

    const devices = (deviceResp.data.result?.devices || [])?.filter((d: any) => d.model?.startsWith("lumi.camera"));
    if (!devices.length) {
      console.error("❌ No devices found for this account");
      process.exit(1);
    }

    // Let user pick device
    const deviceChoice = await inquirer.prompt<{ subjectId: string }>([
      {
        name: "subjectId",
        message: "Select your device:",
        type: "list",
        choices: devices.map((d: any) => {
          return {
            name: `${d.deviceName} (${d.model}) — ${d.did}`,
            value: d.did,
          };
        }),
      },
    ]);

    const subjectId = deviceChoice.subjectId;

    // Build .env
    const envContent = `NODE_ENV=production
AQUARA_URL=${server}
APPID=${appid}
TOKEN=${token}
SUBJECT_ID=${subjectId}
MQTT_URL=${mqttUrl}
MQTT_USER=${mqttUser}
MQTT_PASS=${mqttPass}
POLL_INTERVAL=1
LOG_LEVEL=info
`;

    fs.writeFileSync(path.join(process.cwd(), ".env"), envContent, "utf-8");
    console.log("✅ .env generated successfully");
  } catch (err: any) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

main();
