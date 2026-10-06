import * as fs from "fs";
import * as path from "path";
import { Ftl } from "./ftl";

// 演示：3 块 x 2 页，逻辑页数 = (3-1)*2-1 = 3（LPN 0..2）
// 反复覆盖同几个逻辑页，触发至少两次回收。
const file = path.join(__dirname, "..", "..", "data", "demo.db");
fs.rmSync(file, { force: true });
fs.rmSync(file + "-wal", { force: true });
fs.rmSync(file + "-shm", { force: true });

const ftl = Ftl.open(file, { blocks: 3, pagesPerBlock: 2 });

function showLayout(tag: string) {
  const { spare, pages } = ftl.layout();
  console.log(`\n== ${tag} ==  备用块: ${spare}`);
  for (const p of pages) {
    console.log(`  块${p.block} 页${p.page}: ${p.state}${p.lpn !== null ? ` LPN=${p.lpn} 数据=${JSON.stringify(p.data)}` : ""}`);
  }
}

showLayout("初始");
const seq: Array<[number, string]> = [
  [0, "a1"], [1, "b1"], [2, "c1"],
  [0, "a2"], [1, "b2"], // 触发第 1 次回收
  [0, "a3"], [1, "b3"], // 触发第 2 次回收
];
for (const [lpn, data] of seq) {
  const r = ftl.write(lpn, data);
  console.log(`\n写 LPN=${lpn} <- ${data}: 映射 ${r.mappingBefore} -> ${r.mappingAfter}` +
    (r.invalidated ? `, 旧页失效 ${r.invalidated}` : "") +
    (r.gc ? `, GC: 受害块=${r.gc.victimBlock} 搬迁=${r.gc.migrated.length}页 擦除块=${r.gc.erasedBlock} 新备用块=${r.gc.newSpare}` : ""));
  if (r.gc) showLayout("GC 后");
}
showLayout("最终");
for (const lpn of [0, 1, 2]) {
  const r = ftl.read(lpn);
  console.log(`读 LPN=${lpn}: ${r.data} (位于 ${r.at})`);
}
console.log("\n统计:", JSON.stringify(ftl.report(), null, 2));
ftl.close();
