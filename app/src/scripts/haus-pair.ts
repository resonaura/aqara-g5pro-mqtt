import "dotenv/config";
const port = Number(process.env.HTTP_PORT || 8580);
const response = await fetch(`http://127.0.0.1:${port}/api/haus/v2/pairing`, {
  method: "POST",
  headers: { "X-Haus-Client": "1" },
  signal: AbortSignal.timeout(5000),
});
if (!response.ok) throw Error("Haus pairing is unavailable. Start the camera bridge first.");
const result = (await response.json()) as { code: string; expiresAt: number };
process.stdout.write(JSON.stringify(result) + "\n");
