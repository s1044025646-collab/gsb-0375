import * as path from "path";
import { Ftl, FtlError } from "./ftl";

const DATA_DIR = path.join(__dirname, "..", "..", "data");

function usage(): never {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
  create <名称> <块数> <每块页数>   创建模拟盘
  write  <名称> <lpn> <数据>        写逻辑页
  read   <名称> <lpn>               读逻辑页
  unmap  <名称> <lpn>               取消映射
  layout <名称>                     查看物理布局
  log    <名称> <id>                查询某次操作/回收记录
  report <名称>                     导出统计报告`);
  process.exit(1);
}

function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (!cmd || !name) usage();
  const file = path.join(DATA_DIR, `${name}.db`);
  try {
    if (cmd === "create") {
      const [blocks, ppb] = rest.map(Number);
      const ftl = Ftl.open(file, { blocks, pagesPerBlock: ppb });
      console.log(`已创建 ${file}: 块数=${ftl.blocks} 每块页数=${ftl.pagesPerBlock} 逻辑页数=${ftl.logicalPages}`);
      ftl.close();
      return;
    }
    const ftl = Ftl.open(file);
    const out = (x: any) => console.log(JSON.stringify(x, null, 2));
    switch (cmd) {
      case "write": out(ftl.write(Number(rest[0]), rest[1])); break;
      case "read": out(ftl.read(Number(rest[0]))); break;
      case "unmap": out(ftl.unmap(Number(rest[0]))); break;
      case "layout": out(ftl.layout()); break;
      case "log": out(ftl.getLog(Number(rest[0]))); break;
      case "report": out(ftl.report()); break;
      default: ftl.close(); usage();
    }
    ftl.close();
  } catch (e) {
    if (e instanceof FtlError) {
      console.error(JSON.stringify({ error: e.code, message: e.message }));
      process.exit(2);
    }
    throw e;
  }
}
main();
