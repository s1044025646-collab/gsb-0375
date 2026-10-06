import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ftl } from "../src/ftl";
import { FtlError } from "../src/errors";

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ftl-")), "test.db");
}

function newDisk(blocks = 4, pages = 2) {
  const ftl = new Ftl(tmpDb());
  ftl.create({ blocks, pagesPerBlock: pages });
  return ftl;
}

test("创建参数校验", () => {
  const ftl = new Ftl(tmpDb());
  assert.throws(() => ftl.create({ blocks: 2, pagesPerBlock: 2 }), /块数/);
  assert.throws(() => ftl.create({ blocks: 3, pagesPerBlock: 1 }), /每块页数/);
  const info = ftl.create({ blocks: 4, pagesPerBlock: 2 });
  assert.equal(info.logicalPages, 5); // (4-1)*2-1
  assert.throws(() => ftl.create({ blocks: 4, pagesPerBlock: 2 }), (e: any) => e.code === "ALREADY_EXISTS");
  ftl.close();
});

test("非法地址与数据长度", () => {
  const ftl = newDisk();
  assert.throws(() => ftl.write(5, "x"), (e: any) => e.code === "LPN_OUT_OF_RANGE");
  assert.throws(() => ftl.write(-1, "x"), (e: any) => e.code === "LPN_OUT_OF_RANGE");
  assert.throws(() => ftl.read(99), (e: any) => e.code === "LPN_OUT_OF_RANGE");
  assert.throws(() => ftl.write(0, "x".repeat(201)), (e: any) => e.code === "DATA_TOO_LONG");
  // 失败操作不留半份状态
  assert.equal(ftl.report().logicalWrites, 0);
  assert.deepEqual(ftl.checkInvariants(), []);
  ftl.close();
});

test("顺序写满允许的逻辑范围，越界拒绝", () => {
  const ftl = newDisk(); // 容量 5
  for (let i = 0; i < 5; i++) ftl.write(i, `v${i}`);
  for (let i = 0; i < 5; i++) assert.equal(ftl.read(i).data, `v${i}`);
  assert.throws(() => ftl.write(5, "x"), (e: any) => e.code === "LPN_OUT_OF_RANGE");
  assert.deepEqual(ftl.checkInvariants(), []);
  ftl.close();
});

test("异地更新：旧值失效，新值可读，映射唯一", () => {
  const ftl = newDisk();
  const w1 = ftl.write(0, "old");
  const w2 = ftl.write(0, "new");
  assert.equal(w1.invalidatedOldPage, null);
  assert.equal(w2.invalidatedOldPage, w1.writeAt);
  assert.equal(ftl.read(0).data, "new");
  const layout = ftl.layout();
  const old = layout.pages.find((p) => `${p.block}:${p.page}` === w1.writeAt)!;
  assert.equal(old.state, "invalid");
  assert.deepEqual(ftl.checkInvariants(), []);
  ftl.close();
});

test("取消映射幂等，取消后可重写", () => {
  const ftl = newDisk();
  ftl.write(1, "a");
  const u1 = ftl.unmap(1);
  assert.equal(u1.alreadyUnmapped, false);
  assert.throws(() => ftl.read(1), (e: any) => e.code === "NOT_FOUND");
  const u2 = ftl.unmap(1);
  assert.equal(u2.alreadyUnmapped, true);
  ftl.write(1, "b");
  assert.equal(ftl.read(1).data, "b");
  assert.deepEqual(ftl.checkInvariants(), []);
  ftl.close();
});

test("手算短序列：搬迁页与擦除次数", () => {
  // 4 块 x 2 页，备用块 3，容量 5。
  const ftl = newDisk();
  ftl.write(0, "a"); // 0:0
  ftl.write(1, "b"); // 0:1
  ftl.write(2, "c"); // 1:0
  ftl.write(0, "a2"); // 1:1，0:0 失效
  ftl.write(3, "d"); // 2:0
  // 现在普通块 0,1,2 只剩 2:1 一页空白
  const w = ftl.write(1, "b2"); // 占用 2:1，0:1 失效 -> 普通区满
  assert.equal(w.gc, null);
  // 下一次写入触发回收：块0 有 2 页失效（0:0、0:1），无有效页
  const g = ftl.write(4, "e");
  assert.ok(g.gc, "应触发回收");
  assert.equal(g.gc!.victimBlock, 0);
  assert.equal(g.gc!.victimInvalidPages, 2);
  assert.equal(g.gc!.movedPages.length, 0); // 块0 没有有效页需要搬迁
  assert.equal(g.gc!.erasedBlock, 0);
  assert.equal(g.gc!.newSpareBlock, 0);
  assert.equal(ftl.read(1).data, "b2");
  assert.equal(ftl.read(4).data, "e");
  const report = ftl.report();
  assert.equal(report.logicalWrites, 7);
  assert.equal(report.physicalPrograms, 7); // 7 次写入 + 0 页搬迁
  assert.equal(report.migratedPages, 0);
  assert.equal(report.blockErases[0], 1);
  assert.equal(report.totalErases, 1);
  assert.deepEqual(ftl.checkInvariants(), []);
  ftl.close();
});

test("受害块平局按块号最小选择", () => {
  const ftl = newDisk(5, 2); // 容量 7，备用块 4
  // 让块 0 和块 1 各有 1 页失效，其余块写满
  ftl.write(0, "x"); // 0:0
  ftl.write(1, "x"); // 0:1
  ftl.write(0, "y"); // 1:0，0:0 失效
  ftl.write(1, "y"); // 1:1，0:1 失效
  ftl.write(2, "x"); // 2:0
  ftl.write(3, "x"); // 2:1
  ftl.write(4, "x"); // 3:0
  ftl.write(5, "x"); // 3:1 -> 普通区满
  const g = ftl.write(6, "x");
  assert.equal(g.gc!.victimBlock, 0); // 块0、块1 平局（各1失效页），取块0
  assert.deepEqual(ftl.checkInvariants(), []);
  ftl.close();
});

test("随机压力：独立逻辑字典核对 + 每步不变量", () => {
  const ftl = newDisk(4, 3); // 容量 8
  const dict = new Map<number, string>();
  let rng = 42;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let step = 0; step < 300; step++) {
    const lpn = Math.floor(rand() * 8);
    const op = rand();
    if (op < 0.6) {
      const data = `d${step}`;
      ftl.write(lpn, data);
      dict.set(lpn, data);
    } else if (op < 0.8) {
      ftl.unmap(lpn);
      dict.delete(lpn);
    } else {
      try {
        assert.equal(ftl.read(lpn).data, dict.get(lpn));
        assert.ok(dict.has(lpn));
      } catch (e: any) {
        assert.equal(e.code, "NOT_FOUND");
        assert.ok(!dict.has(lpn));
      }
    }
    assert.deepEqual(ftl.checkInvariants(), [], `第 ${step} 步不变量失败`);
  }
  // 最终全量核对
  for (let lpn = 0; lpn < 8; lpn++) {
    if (dict.has(lpn)) assert.equal(ftl.read(lpn).data, dict.get(lpn));
    else assert.throws(() => ftl.read(lpn), (e: any) => e.code === "NOT_FOUND");
  }
  const report = ftl.report();
  assert.ok(report.totalErases >= 2, "应触发至少两次回收");
  assert.ok(report.writeAmplification! >= 1);
  ftl.close();
});

test("重启后映射与数据一致", () => {
  const dbPath = tmpDb();
  let ftl = new Ftl(dbPath);
  ftl.create({ blocks: 4, pagesPerBlock: 2 });
  for (let i = 0; i < 6; i++) ftl.write(i % 5, `v${i}`);
  const before = ftl.layout();
  ftl.close();
  ftl = new Ftl(dbPath);
  assert.equal(ftl.read(0).data, "v5");
  assert.deepEqual(ftl.layout(), before);
  assert.deepEqual(ftl.checkInvariants(), []);
  ftl.close();
});

test("无写入时写放大为无数据状态；取消映射不计数据写入", () => {
  const ftl = newDisk();
  const r0 = ftl.report();
  assert.equal(r0.writeAmplification, null);
  assert.match(r0.writeAmplificationNote!, /无数据/);
  ftl.write(0, "a");
  ftl.unmap(0);
  const r1 = ftl.report();
  assert.equal(r1.logicalWrites, 1);
  assert.equal(r1.physicalPrograms, 1);
  ftl.close();
});

test("操作日志可查询回收过程", () => {
  const ftl = newDisk();
  let lastOp = 0;
  for (let i = 0; i < 8; i++) lastOp = ftl.write(i % 5, `v${i}`).opId;
  const op = ftl.getOp(lastOp);
  assert.equal(op.type, "write");
  assert.ok(op.detail.gc, "最后一次写入应含回收记录");
  assert.ok(Array.isArray(op.detail.gc.movedPages));
  assert.throws(() => ftl.getOp(99999), (e: any) => e.code === "NOT_FOUND");
  ftl.close();
});
