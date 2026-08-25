import { login, queryAttrs } from "../aqara.js";
const did = process.env.DID!;
await login(process.env.AQARA_USER!, process.env.AQARA_PASS!);
const r = await queryAttrs(["rtsp_enable","rtsp_url","rtsp_username","rtsp_password","rtsp_pwd","camera_pwd","device_pwd","pwd"], did);
console.log(JSON.stringify(r.result ?? r, null, 2));
