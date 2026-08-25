// Подготовка P2P-сессии для E1: p2p/info + X25519 + p2p/sign
import axios from "axios";
import crypto from "crypto";

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const APPID = "444c476ef7135e53330f46e7";
const APPKEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi";
const BASE = "https://aiot-rpc-usa.aqara.com";
const did = process.env.DID!;

function signedHeaders(body: string, token: string) {
  const time = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex").toUpperCase();
  let pre = `Appid=${APPID}&Nonce=${nonce}&Time=${time}`;
  if (token) pre += `&Token=${token}`;
  if (body) pre += `&${body}`;
  pre += `&${APPKEY}`;
  return {
    lang: "en", "app-version": "6.1.6", "sys-type": "1", "sys-version": "14",
    "phone-model": "Pixel 7", appid: APPID,
    nonce, time, sign: md5(pre), ...(token ? { token } : {}),
    "content-type": "application/json",
  };
}

async function post(path: string, obj: any, token: string) {
  const body = JSON.stringify(obj);
  const r = await axios.post(BASE + path, body, { headers: signedHeaders(body, token), timeout: 15000 });
  return r.data;
}
async function get(path: string, params: any, token: string) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  const time = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex").toUpperCase();
  const pre = `Appid=${APPID}&Nonce=${nonce}&Time=${time}&Token=${token}&${qs}&${APPKEY}`;
  const r = await axios.get(`${BASE}${path}?${qs}`, {
    headers: { ...signedHeaders("", token), nonce, time, sign: md5(pre), token },
    timeout: 15000,
  });
  return r.data;
}

// login
const PUBKEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCG46slB57013JJs4Vvj5cVyMpR
9b+B2F+YJU6qhBEYbiEmIdWpFPpOuBikDs2FcPS19MiWq1IrmxJtkICGurqImRUt
4lP688IWlEmqHfSxSRf2+aH0cH8VWZ2OaZn5DWSIHIPBF2kxM71q8stmoYiV0oZs
rZzBHsMuBwA4LQdxBwIDAQAB
-----END PUBLIC KEY-----`;
const md5pw = md5(process.env.AQARA_PASS!);
const encPw = crypto.publicEncrypt({ key: crypto.createPublicKey(PUBKEY), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(md5pw)).toString("base64");
const loginBody = JSON.stringify({ account: process.env.AQARA_USER!, encryptType: 2, password: encPw });
const lr = await axios.post(BASE + "/app/v1.0/lumi/user/login", loginBody, { headers: signedHeaders(loginBody, ""), timeout: 15000 });
if (lr.data.code !== 0) { console.error("login failed"); process.exit(1); }
const token = lr.data.result.token;

// p2p/info
const infoRaw = await get("/app/v1.0/lumi/devex/camera/p2p/info", { did }, token);
console.error("info:", JSON.stringify(infoRaw).slice(0, 400));
const info = infoRaw.result;
const initString = info.initStringApp.split(":")[0];
const ppcsKey = info.initStringApp.split(":")[1];

// X25519 keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
// raw 32 байта публичного ключа X25519
const appPub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64").toString("hex");

const appPriv = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64").toString("hex");

// p2p/sign
const signRaw = await post("/app/v1.0/lumi/devex/camera/p2p/sign", { devPwd: "", did, p2pAppPublicKey: appPub }, token);
console.error("sign raw:", JSON.stringify(signRaw).slice(0, 300));
const signRes = signRaw.result;
console.log("sign result:", JSON.stringify(signRes));

console.log(JSON.stringify({
  did, p2pId: info.p2pId, ppcsKey, initString,
  devPub: info.devP2pPublicKey,
  appPub, appPriv,
  appSign: signRes?.sign, signTime: signRes?.time,
}, null, 2));
