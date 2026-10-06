import path from "node:path";
import { Ftl } from "./ftl";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, opts };
}

function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

const HELP = `用法: node dist/src/cli.js <命令> [参数] [--db 数据文件路径]
命令:
  create --blocks N --pages P     创建模拟盘（块数>=3，每块页数>=2）
  write <lpn> <data>              写逻辑页
  read <lpn>                      读逻辑页
  unmap <lpn>                     取消映射（幂等）
  layout                          查看物理布局
  op <id>                         查询某次操作/回收过程
  report                          导出统计报告
  demo                            运行回收演示（反复覆盖触发至少两次回收）
`;

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const dbPath = opts.db ?? path.join("data", "ftl.db");
  if (!cmd || cmd === "help") {
    console.log(HELP);
    return;
  }
  const ftl = new Ftl(dbPath);
  try {
    switch (cmd) {
      case "create":
        print(ftl.create({ blocks: Number(opts.blocks), pagesPerBlock: Number(opts.pages) }));
        break;
      case "write":
        print(ftl.write(Number(positional[1]), positional[2] ?? ""));
        break;
      case "read":
        print(ftl.read(Number(positional[1])));
        break;
      case "unmap":
        print(ftl.unmap(Number(positional[1])));
        break;
      case "layout":
        print(ftl.layout());
        break;
      case "op":
        print(ftl.getOp(Number(positional[1])));
        break;
      case "report":
        print(ftl.report());
        break;
      case "demo":
        runDemo(ftl);
        break;
      default:
        console.error(`未知命令: ${cmd}\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    ftl.close();
  }
}

/** 演示：4 块 x 2 页，逻辑容量 5 页，反复覆盖同几个逻辑页，触发至少两次回收。 */
function runDemo(ftl: Ftl) {
  if (!ftl.created) {
    console.log("创建演示盘: 4 块 x 2 页，逻辑页容量 5");
    print(ftl.create({ blocks: 4, pagesPerBlock: 2 }));
  }
  const script: [number, string][] = [
    [0, "A1"], [1, "B1"], [2, "C1"], [3, "D1"], [4, "E1"], // 顺序写满
    [0, "A2"], [1, "B2"], // 覆盖 -> 触发第 1 次回收
    [2, "C2"], [3, "D2"], // 覆盖 -> 触发第 2 次回收
    [0, "A3"],
  ];
  for (const [lpn, data] of script) {
    const r = ftl.write(lpn, data);
    const gc = r.gc ? ` [GC: 受害块 ${r.gc.victimBlock} -> 擦除, 搬迁 ${r.gc.movedPages.length} 页, 新备用块 ${r.gc.newSpareBlock}]` : "";
    console.log(`write lpn=${lpn} "${data}" -> ${r.writeAt}，旧页失效: ${r.invalidatedOldPage ?? "无"}${gc}`);
  }
  ftl.unmap(4);
  console.log("unmap lpn=4，再次 unmap（幂等）:");
  print(ftl.unmap(4));
  for (const lpn of [0, 1, 2, 3]) {
    const r = ftl.read(lpn);
    console.log(`read lpn=${lpn} -> "${r.data}" @ ${r.at}`);
  }
  try {
    ftl.read(4);
  } catch (e: any) {
    console.log(`read lpn=4 -> ${e.code}: ${e.message}`);
  }
  console.log("最终报告:");
  print(ftl.report());
  const problems = ftl.checkInvariants();
  console.log(problems.length === 0 ? "不变量检查通过" : `不变量问题: ${problems.join("; ")}`);
}

main();
