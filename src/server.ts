import * as http from "http";
import * as path from "path";
import { Ftl, FtlError } from "./ftl";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const disks = new Map<string, Ftl>();

function getDisk(name: string): Ftl {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new FtlError("INVALID_NAME", "盘名须为 1..32 位字母数字-_");
  let d = disks.get(name);
  if (!d) {
    d = Ftl.open(path.join(DATA_DIR, `${name}.db`));
    disks.set(name, d);
  }
  return d;
}

function send(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  if (s.length > 64 * 1024) throw new FtlError("PAYLOAD_TOO_LARGE", "请求体过大");
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const b = req.method === "POST" ? await body(req) : {};
    // /disks/:name/...
    if (parts[0] === "disks" && parts.length >= 2) {
      const name = parts[1];
      const sub = parts[2];
      if (req.method === "POST" && !sub) {
        const ftl = Ftl.open(path.join(DATA_DIR, `${name}.db`), {
          blocks: Number(b.blocks), pagesPerBlock: Number(b.pagesPerBlock),
          maxDataLen: b.maxDataLen, maxLogRecords: b.maxLogRecords,
        });
        const r = ftl.report(); ftl.close();
        return send(res, 201, r);
      }
      const ftl = getDisk(name);
      if (req.method === "POST" && sub === "write") return send(res, 200, ftl.write(b.lpn, b.data));
      if (req.method === "POST" && sub === "unmap") return send(res, 200, ftl.unmap(b.lpn));
      if (req.method === "GET" && sub === "read") return send(res, 200, ftl.read(Number(url.searchParams.get("lpn"))));
      if (req.method === "GET" && sub === "layout") return send(res, 200, ftl.layout());
      if (req.method === "GET" && sub === "report") return send(res, 200, ftl.report());
      if (req.method === "GET" && sub === "logs") return send(res, 200, ftl.getLog(Number(parts[3])));
    }
    send(res, 404, { error: "NOT_FOUND", message: "未知路由" });
  } catch (e: any) {
    if (e instanceof FtlError) return send(res, 400, { error: e.code, message: e.message });
    send(res, 500, { error: "INTERNAL", message: String(e?.message ?? e) });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 0;
server.listen(port, () => {
  const addr = server.address();
  console.log(`FTL API 已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
});
