// One UDP socket, several STUN servers: same mapped port everywhere => endpoint-independent mapping (EIM).
// 用来验证「本机直连走 Clash 后是 EIM、容器内是 symmetric NAT」的判断。不依赖仓库代码、不需要密钥。
// 用法: node host/deploy/tailcat-native/tools/stun-eim.mjs stun.l.google.com:19302 <derper>:<port> ...
import dgram from "node:dgram"; import crypto from "node:crypto"; import dns from "node:dns/promises"; import zlib from "node:zlib";
// Tailscale derper only answers requests carrying SOFTWARE + FINGERPRINT attributes.
function request(tid) { const sw = Buffer.from("tailnode"), a = Buffer.alloc(12); a.writeUInt16BE(0x8022, 0); a.writeUInt16BE(8, 2); sw.copy(a, 4);
  const h = Buffer.alloc(20); h.writeUInt16BE(1, 0); h.writeUInt16BE(a.length + 8, 2); h.writeUInt32BE(0x2112a442, 4); tid.copy(h, 8);
  const m = Buffer.concat([h, a]), f = Buffer.alloc(8); f.writeUInt16BE(0x8028, 0); f.writeUInt16BE(4, 2); f.writeUInt32BE((zlib.crc32(m) ^ 0x5354554e) >>> 0, 4); return Buffer.concat([m, f]); }
const servers = process.argv.slice(2); const sock = dgram.createSocket("udp4"); const got = {};
sock.on("message", m => { const id = m.subarray(8, 20).toString("hex"); for (let i = 20; i + 4 <= m.length;) {
  const t = m.readUInt16BE(i), l = m.readUInt16BE(i + 2);
  if (t === 0x20 || t === 0x01) { const x = t === 0x20; const port = m.readUInt16BE(i + 6) ^ (x ? 0x2112 : 0);
    const ip = [0,1,2,3].map(k => m[i + 8 + k] ^ (x ? [0x21,0x12,0xa4,0x42][k] : 0)).join("."); got[id] ??= `${ip}:${port}`; }
  i += 4 + l + ((4 - l % 4) % 4); } });
sock.bind(Number(process.env.LOCAL_PORT || 0), async () => {
  console.log("local udp port", sock.address().port); const ids = [];
  for (const s of servers) { const [h, p] = s.split(":"); let ip; try { ip = (await dns.lookup(h, { family: 4 })).address; } catch { ids.push([s, null]); continue; }
    for (let n = 0; n < 2; n++) { const tid = crypto.randomBytes(12), b = request(tid);
      ids.push([`${s} (${ip})`, tid.toString("hex")]); sock.send(b, Number(p), ip); await new Promise(r => setTimeout(r, 250)); } }
  setTimeout(() => { const ports = new Set(); for (const [s, id] of ids) { const v = id && got[id]; if (v) ports.add(v); console.log(s.padEnd(45), "->", v ?? "timeout"); }
    console.log(ports.size === 1 ? "RESULT: EIM (single mapping " + [...ports][0] + ")" : ports.size ? "RESULT: mapping varies -> " + [...ports].join(", ") : "RESULT: no replies"); sock.close(); }, 2500); });
