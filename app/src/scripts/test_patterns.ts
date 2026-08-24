import axios from "axios";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

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

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

async function testCombination(desc: string, signStr: string, headerName: string, extraHeaders: Record<string, string>, bodyObj: any) {
  const appid = "444c476ef7135e53330f46e7";
  const phoneId = uuidv4().toUpperCase();
  const time = Date.now().toString();
  const nonce = uuidv4().replace(/-/g, "").substring(0, 16);

  // Replace placeholders in signStr
  const resolvedSignStr = signStr
    .replace("{appid}", appid)
    .replace("{nonce}", nonce)
    .replace("{time}", time)
    .replace("{phoneId}", phoneId)
    .replace("{body}", JSON.stringify(bodyObj));

  const sign = md5(resolvedSignStr);

  const headers: Record<string, string> = {
    "User-Agent": "AqaraSetup/1.0.0",
    "App-Version": "3.0.0",
    "Sys-Type": "1",
    Lang: "en",
    "Phone-Model": "NodeSetup",
    PhoneId: phoneId,
    Time: time,
    Nonce: nonce,
    Appid: appid,
    [headerName]: sign,
    ...extraHeaders,
  };

  try {
    const res = await axios.post("https://aiot-rpc-usa.aqara.com/app/v1.0/lumi/user/login", bodyObj, {
      headers,
      timeout: 5000,
    });
    console.log(`✅ SUCCESS [${desc}]:`, res.data);
    return true;
  } catch (err: any) {
    const data = err.response?.data || err.message;
    console.log(`❌ [${desc}]:`, typeof data === "object" ? `${data.code}: ${data.msgDetails || data.message}` : data);
    return false;
  }
}

async function run() {
  const username = process.env.AQARA_USER ?? "";
  const password = process.env.AQARA_PASS ?? "";
  const encPass = encryptPassword(password);
  const loginBody = {
    account: username,
    encryptType: 2,
    password: encPass,
  };

  console.log("Testing various sign string constructions...");

  const patterns = [
    // Pattern from getSignHead
    { desc: "Appid=&Nonce=&Time= (body appended)", str: "Appid={appid}&Nonce={nonce}&Time={time}&{body}" },
    { desc: "Appid=&Nonce=&Time= (no body)", str: "Appid={appid}&Nonce={nonce}&Time={time}" },
    { desc: "Appid=&Nonce=&Time=&Token=&{body}", str: "Appid={appid}&Nonce={nonce}&Time={time}&Token=&{body}" },
    { desc: "appid=&nonce=&time=&{body}", str: "appid={appid}&nonce={nonce}&time={time}&{body}" },
    { desc: "appid=&nonce=&time=", str: "appid={appid}&nonce={nonce}&time={time}" },
    { desc: "Appid={appid}&Nonce={nonce}&PhoneId={phoneId}&Time={time}&{body}", str: "Appid={appid}&Nonce={nonce}&PhoneId={phoneId}&Time={time}&{body}" },
    { desc: "Appid={appid}&PhoneId={phoneId}&Time={time}&{body}", str: "Appid={appid}&PhoneId={phoneId}&Time={time}&{body}" },
    { desc: "Appid={appid}&Nonce={nonce}&Time={time}&body={body}", str: "Appid={appid}&Nonce={nonce}&Time={time}&body={body}" },
    { desc: "account={acc}&encryptType=2&password={pw}&Appid=...", str: `account=${username}&encryptType=2&password=${encPass}&Appid={appid}&Nonce={nonce}&Time={time}` },
  ];

  for (const p of patterns) {
    await testCombination(p.desc, p.str, "Sign", {}, loginBody);
    await testCombination(p.desc + " (lower 'sign')", p.str, "sign", {}, loginBody);
  }
}

run();
