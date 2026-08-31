import { login, getCameras, api } from "../../aqara.js";
import { config } from "dotenv";

config();

async function main() {
  if (process.env.AQARA_USER && process.env.AQARA_PASS) {
    await login(process.env.AQARA_USER, process.env.AQARA_PASS);
  }
  const cams = await getCameras();
  for (const c of cams) {
    const infoResp = await api.get("/app/v1.0/lumi/devex/camera/p2p/info", {
      params: { did: c.did },
    });
    const info = infoResp.data.result;
    console.log(`📷 Camera: "${c.deviceName}"`);
    console.log(`   did:     ${c.did}`);
    console.log(`   model:   ${c.model}`);
    console.log(`   p2pId:   ${info?.p2pId}`);
    console.log(`   initStr: ${info?.initStringApp}`);
    console.log(`   devPub:  ${info?.devP2pPublicKey}\n`);
  }
}

main().catch(console.error);
