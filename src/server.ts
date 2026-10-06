import http from "node:http";
import path from "node:path";
import { Ftl } from "./ftl";
import { FtlError } from "./errors";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, "");
    args[k] = argv[i + 1];
  }
  return args;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new FtlError("INVALID_PARAM", "请求体不是合法 JSON");
  }
}

export function startServer(dbPath: string, port: number) {
  const ftl = new Ftl(dbPath);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const m = req.method ?? "GET";
      const p = url.pathname;
      if (m === "POST" && p === "/disk") {
        const body = await readBody(req);
        return send(201, ftl.create({ blocks: Number(body.blocks), pagesPerBlock: Number(body.pagesPerBlock) }));
      }
      if (m === "POST" && p === "/write") {
        const body = await readBody(req);
        return send(200, ftl.write(Number(body.lpn), String(body.data ?? "")));
      }
      if (m === "POST" && p === "/unmap") {
        const body = await readBody(req);
        return send(200, ftl.unmap(Number(body.lpn)));
      }
      const readMatch = p.match(/^\/read\/(\d+)$/);
      if (m === "GET" && readMatch) return send(200, ftl.read(Number(readMatch[1])));
      if (m === "GET" && p === "/layout") return send(200, ftl.layout());
      const opMatch = p.match(/^\/ops\/(\d+)$/);
      if (m === "GET" && opMatch) return send(200, ftl.getOp(Number(opMatch[1])));
      if (m === "GET" && p === "/report") return send(200, ftl.report());
      if (m === "GET" && p === "/invariants") {
        const problems = ftl.checkInvariants();
        return send(problems.length ? 500 : 200, { ok: problems.length === 0, problems });
      }
      return send(404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof FtlError) return send(400, { error: { code: e.code, message: e.message } });
      return send(500, { error: { code: "INTERNAL_INVARIANT", message: String(e) } });
    }
  });
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db ?? path.join("data", "ftl.db");
  const port = args.port !== undefined ? Number(args.port) : 0; // 0 = 自动选择空闲端口
  startServer(dbPath, port).then(({ port }) => {
    console.log(`FTL 模拟服务已启动: http://127.0.0.1:${port}  数据文件: ${dbPath}`);
  });
}
