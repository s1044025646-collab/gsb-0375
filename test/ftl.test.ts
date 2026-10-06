import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Ftl, FtlError } from "../src/ftl";

function tmpdb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ftl-")), "t.db");
}

/** 独立核对：映射与有效页一一对应、备用块全空白、容量与计数守恒 */
function checkInvariants(ftl: Ftl) {
  const { spare, pages } = ftl.layout();
  const valid = pages.filter((p) => p.state === "valid");
  const seenLpn = new Set<number>();
  for (const p of valid) {
    assert.ok(!seenLpn.has(p.lpn!), `LPN ${p.lpn} 有多个有效页`);
    seenLpn.add(p.lpn!);
    assert.equal(ftl.read(p.lpn!).at, `${p.block}:${p.page}`);
  }
  for (const p of pages) {
    if (p.block === spare) assert.equal(p.state, "blank", "备用块必须全空白");
  }
  assert.equal(pages.length, ftl.blocks * ftl.pagesPerBlock, "页总数守恒");
  assert.ok(valid.length <= ftl.logicalPages, "有效页数不超过逻辑容量");
  const r = ftl.report();
  assert.equal(r.eraseCounts.reduce((s: number, e: any) => s + e.count, 0) >= 0, true);
  if (r.logicalWrites > 0) {
    assert.ok(r.physicalPrograms >= r.logicalWrites, "物理编程 >= 逻辑写入");
    assert.equal(r.physicalPrograms - r.logicalWrites, r.migratedPages, "搬迁计入物理编程");
  }
}

test("顺序写满允许的逻辑范围，再写一个触发回收", () => {
  const ftl = Ftl.open(tmpdb(), { blocks: 3, pagesPerBlock: 2 });
  assert.equal(ftl.logicalPages, 3); // (3-1)*2-1
  const dict = new Map<number, string>();
  for (let lpn = 0; lpn < 3; lpn++) {
    ftl.write(lpn, `v${lpn}`);
    dict.set(lpn, `v${lpn}`);
  }
  checkInvariants(ftl);
  // 普通区 (3-1)*2=4 页，已写 3 页，还剩 1 空白页，不触发回收
  let r = ftl.write(0, "w0");
  dict.set(0, "w0");
  assert.equal(r.gc, null);
  assert.equal(r.invalidated, "1:0"); // LPN0 旧页失效
  // 普通区空白页耗尽，下一次写触发回收
  r = ftl.write(1, "w1");
  dict.set(1, "w1");
  assert.ok(r.gc, "应触发回收");
  assert.equal(r.gc!.erasedBlock, r.gc!.newSpare);
  for (const [lpn, want] of dict) assert.equal(ftl.read(lpn).data, want);
  checkInvariants(ftl);
  ftl.close();
});

test("频繁改写同几个逻辑页，触发至少两次回收，备用块角色轮换", () => {
  const ftl = Ftl.open(tmpdb(), { blocks: 3, pagesPerBlock: 2 });
  const dict = new Map<number, string>();
  const spares: number[] = [ftl.layout().spare];
  let gcCount = 0;
  for (let i = 0; i < 20; i++) {
    const lpn = i % 3;
    const r = ftl.write(lpn, `d${i}`);
    dict.set(lpn, `d${i}`);
    if (r.gc) {
      gcCount++;
      assert.equal(r.gc!.oldSpare, spares[spares.length - 1]);
      spares.push(r.gc!.newSpare);
      // 搬迁目标必须是旧备用块，且按物理页顺序
      r.gc!.migrated.forEach((m, idx) => {
        assert.equal(m.to, `${r.gc!.oldSpare}:${idx}`);
      });
    }
    checkInvariants(ftl);
  }
  assert.ok(gcCount >= 2, `至少两次回收，实际 ${gcCount}`);
  for (const [lpn, want] of dict) assert.equal(ftl.read(lpn).data, want);
  // 旧值不可读：物理布局中旧版本均为失效
  const { pages } = ftl.layout();
  const invalid = pages.filter((p) => p.state === "invalid");
  assert.ok(invalid.length > 0);
  ftl.close();
});

test("取消映射：读不存在、重复取消幂等、取消后重写", () => {
  const ftl = Ftl.open(tmpdb(), { blocks: 3, pagesPerBlock: 2 });
  ftl.write(0, "x");
  const r1 = ftl.unmap(0);
  assert.equal(r1.mappingBefore, "1:0");
  assert.equal(r1.mappingAfter, null);
  assert.throws(() => ftl.read(0), (e: FtlError) => e.code === "NOT_FOUND");
  const r2 = ftl.unmap(0); // 幂等
  assert.equal(r2.mappingBefore, null);
  assert.ok(r2.note);
  const before = ftl.report();
  ftl.unmap(0);
  const after = ftl.report();
  assert.equal(after.physicalPrograms, before.physicalPrograms, "取消映射不计数据写入");
  ftl.write(0, "y"); // 取消后重写
  assert.equal(ftl.read(0).data, "y");
  checkInvariants(ftl);
  ftl.close();
});

test("受害块平局按块编号最小选择", () => {
  // 4 块 x 2 页，逻辑页 (4-1)*2-1 = 5
  const ftl = Ftl.open(tmpdb(), { blocks: 4, pagesPerBlock: 2 });
  // 写满 5 个逻辑页：普通区 6 页用 5 页
  for (let lpn = 0; lpn < 5; lpn++) ftl.write(lpn, `v${lpn}`);
  // 覆盖 LPN0（在块1）与 LPN2（在块2），各制造 1 个失效页
  ftl.write(0, "a"); // 用掉最后空白页
  const r = ftl.write(2, "b"); // 触发回收
  assert.ok(r.gc);
  // 块1 与块2 各有 1 个失效页（块1: LPN0 旧页；块2: LPN2 旧页），平局选块1
  assert.equal(r.gc!.victimBlock, 1);
  checkInvariants(ftl);
  ftl.close();
});

test("非法地址与非法数据报错且不留半份映射", () => {
  const ftl = Ftl.open(tmpdb(), { blocks: 3, pagesPerBlock: 2 });
  ftl.write(0, "ok");
  const before = ftl.layout();
  for (const bad of [-1, 3, 100, 1.5, NaN, "x" as any]) {
    assert.throws(() => ftl.write(bad, "d"), (e: FtlError) => e.code === "INVALID_LPN");
    assert.throws(() => ftl.read(bad), (e: FtlError) => e.code === "INVALID_LPN");
    assert.throws(() => ftl.unmap(bad), (e: FtlError) => e.code === "INVALID_LPN");
  }
  assert.throws(() => ftl.write(1, ""), (e: FtlError) => e.code === "INVALID_DATA");
  assert.throws(() => ftl.write(1, "x".repeat(65)), (e: FtlError) => e.code === "INVALID_DATA");
  assert.throws(() => ftl.write(1, 42 as any), (e: FtlError) => e.code === "INVALID_DATA");
  assert.deepEqual(ftl.layout(), before, "失败后状态不变");
  ftl.close();
});

test("手算短序列：搬迁与擦除次数", () => {
  // 3 块 x 2 页，备用块=0，普通块 1、2
  const ftl = Ftl.open(tmpdb(), { blocks: 3, pagesPerBlock: 2 });
  ftl.write(0, "a"); // -> 1:0
  ftl.write(1, "b"); // -> 1:1
  ftl.write(2, "c"); // -> 2:0
  ftl.write(0, "a2"); // -> 2:1，1:0 失效
  // 普通区满，写 LPN1 触发回收：
  // 块1 有 1 失效页(1:0)，块2 有 0 失效页 -> 受害块=1
  // 块1 有效页：1:1 (LPN1=b) -> 搬到备用块 0 的页 0
  const r = ftl.write(1, "b2");
  assert.ok(r.gc);
  assert.equal(r.gc!.victimBlock, 1);
  assert.equal(r.gc!.victimInvalidPages, 1);
  assert.deepEqual(r.gc!.migrated, [{ lpn: 1, from: "1:1", to: "0:0", data: "b" }]);
  assert.equal(r.gc!.erasedBlock, 1);
  assert.equal(r.gc!.newSpare, 1);
  assert.equal(r.gc!.oldSpare, 0);
  // 本次写入落在原备用块 0 的页 1
  assert.equal(r.writeAt, "0:1");
  const rep = ftl.report();
  assert.equal(rep.logicalWrites, 5);
  assert.equal(rep.physicalPrograms, 6); // 5 次写入 + 1 页搬迁
  assert.equal(rep.migratedPages, 1);
  assert.equal(rep.eraseCounts.find((e: any) => e.block === 1).count, 1);
  assert.equal(rep.eraseCounts.find((e: any) => e.block === 0).count, 0);
  assert.equal(rep.writeAmplification, 6 / 5);
  // 再触发一次回收验证擦除计数。
  // 此时块0: 0:0 失效(搬迁后被覆写)、0:1 有效(b2)；块2: 2:0 有效(c)、2:1 有效(a2)。
  // 普通区无空白页，块0 有 1 个失效页 -> 受害块=0，搬迁 LPN1 到备用块1 页0。
  const r2 = ftl.write(2, "c2");
  assert.ok(r2.gc);
  assert.equal(r2.gc!.victimBlock, 0);
  assert.deepEqual(r2.gc!.migrated, [{ lpn: 1, from: "0:1", to: "1:0", data: "b2" }]);
  assert.equal(r2.writeAt, "1:1");
  const rep2 = ftl.report();
  assert.equal(rep2.eraseCounts.find((e: any) => e.block === 0).count, 1);
  assert.equal(rep2.eraseCounts.find((e: any) => e.block === 2).count, 0);
  assert.equal(rep2.migratedPages, 2);
  assert.equal(ftl.read(0).data, "a2");
  assert.equal(ftl.read(1).data, "b2");
  assert.equal(ftl.read(2).data, "c2");
  checkInvariants(ftl);
  ftl.close();
});

test("写放大无数据状态", () => {
  const ftl = Ftl.open(tmpdb(), { blocks: 3, pagesPerBlock: 2 });
  const r = ftl.report();
  assert.equal(r.writeAmplification, null);
  assert.ok(r.writeAmplificationNote);
  ftl.close();
});

test("重启后映射与数据一致，日志可复现", () => {
  const file = tmpdb();
  let ftl = Ftl.open(file, { blocks: 3, pagesPerBlock: 2 });
  const dict = new Map<number, string>();
  for (let i = 0; i < 12; i++) {
    const lpn = i % 3;
    ftl.write(lpn, `v${i}`);
    dict.set(lpn, `v${i}`);
  }
  const repBefore = ftl.report();
  const wr = ftl.write(0, "final");
  const logId = wr.logId;
  dict.set(0, "final");
  ftl.close();
  // 重新打开
  ftl = Ftl.open(file);
  for (const [lpn, want] of dict) assert.equal(ftl.read(lpn).data, want);
  const repAfter = ftl.report();
  assert.equal(repAfter.logicalWrites, repBefore.logicalWrites + 1);
  const migrated = wr.gc ? wr.gc.migrated.length : 0;
  assert.equal(repAfter.physicalPrograms, repBefore.physicalPrograms + 1 + migrated);
  const log = ftl.getLog(logId);
  assert.equal(log.op, "write");
  assert.equal(log.lpn, 0);
  checkInvariants(ftl);
  ftl.close();
});

test("独立逻辑字典核对随机操作序列", () => {
  const ftl = Ftl.open(tmpdb(), { blocks: 4, pagesPerBlock: 3 });
  const dict = new Map<number, string>();
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 200; i++) {
    const lpn = Math.floor(rnd() * ftl.logicalPages);
    if (rnd() < 0.25) {
      ftl.unmap(lpn);
      dict.delete(lpn);
    } else {
      const data = `d${i}`;
      ftl.write(lpn, data);
      dict.set(lpn, data);
    }
    checkInvariants(ftl);
  }
  for (let lpn = 0; lpn < ftl.logicalPages; lpn++) {
    if (dict.has(lpn)) assert.equal(ftl.read(lpn).data, dict.get(lpn));
    else assert.throws(() => ftl.read(lpn), (e: FtlError) => e.code === "NOT_FOUND");
  }
  ftl.close();
});

test("配置校验", () => {
  assert.throws(() => Ftl.open(tmpdb(), { blocks: 2, pagesPerBlock: 2 }), (e: FtlError) => e.code === "INVALID_CONFIG");
  assert.throws(() => Ftl.open(tmpdb(), { blocks: 3, pagesPerBlock: 1 }), (e: FtlError) => e.code === "INVALID_CONFIG");
  assert.throws(() => Ftl.open(tmpdb()), (e: FtlError) => e.code === "NOT_INITIALIZED");
});
