// Смотрим полный объект устройства E1 — есть ли там P2P UID
import { login, api } from "../aqara.js";
const did = process.env.DID!;
await login(process.env.AQARA_USER!, process.env.AQARA_PASS!);
const r = await api.get("/app/v1.0/lumi/app/position/device/query");
const dev = (r.data?.result?.devices ?? []).find((d: any) => d.did === did);
console.log(JSON.stringify(dev, null, 2));
