export type PageState = "blank" | "valid" | "invalid";

export interface FtlOptions {
  blocks: number;
  pagesPerBlock: number;
  maxDataLen?: number;
  maxLogRecords?: number;
}

export interface PageInfo {
  block: number;
  page: number;
  state: PageState;
  lpn: number | null;
  data: string | null;
}

export interface GcReport {
  victimBlock: number;
  victimInvalidPages: number;
  migrated: Array<{ lpn: number; from: string; to: string; data: string }>;
  erasedBlock: number;
  oldSpare: number;
  newSpare: number;
}

export interface OpReport {
  op: string;
  logId: number;
  lpn?: number;
  mappingBefore: string | null;
  mappingAfter: string | null;
  writeAt?: string;
  invalidated?: string | null;
  gc: GcReport | null;
  data?: string | null;
  note?: string;
}

export class FtlError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const LIMITS = {
  minBlocks: 3,
  maxBlocks: 64,
  minPagesPerBlock: 2,
  maxPagesPerBlock: 64,
  maxDataLen: 256,
  maxLogRecords: 10000,
};

export class Ftl {
  private db: any;
  readonly blocks: number;
  readonly pagesPerBlock: number;
  readonly maxDataLen: number;
  readonly maxLogRecords: number;
  readonly logicalPages: number;

  static open(path: string, opts?: FtlOptions): Ftl {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL;");
    return new Ftl(db, opts);
  }

  constructor(db: any, opts?: FtlOptions) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pages (
        block INTEGER NOT NULL, page INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('blank','valid','invalid')),
        lpn INTEGER, data TEXT,
        PRIMARY KEY (block, page)
      );
      CREATE TABLE IF NOT EXISTS mapping (lpn INTEGER PRIMARY KEY, block INTEGER NOT NULL, page INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS erase_counts (block INTEGER PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL, detail TEXT NOT NULL
      );
    `);
    const existing = db.prepare("SELECT value FROM meta WHERE key='config'").get();
    if (existing) {
      const cfg = JSON.parse(existing.value);
      this.blocks = cfg.blocks;
      this.pagesPerBlock = cfg.pagesPerBlock;
      this.maxDataLen = cfg.maxDataLen;
      this.maxLogRecords = cfg.maxLogRecords;
      if (opts && (opts.blocks !== this.blocks || opts.pagesPerBlock !== this.pagesPerBlock)) {
        throw new FtlError("CONFIG_MISMATCH", "已有模拟盘配置与新参数不一致");
      }
    } else {
      if (!opts) throw new FtlError("NOT_INITIALIZED", "模拟盘不存在，请先创建");
      this.blocks = opts.blocks;
      this.pagesPerBlock = opts.pagesPerBlock;
      this.maxDataLen = opts.maxDataLen ?? 64;
      this.maxLogRecords = opts.maxLogRecords ?? 10000;
      this.validateConfig();
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO meta VALUES ('config', ?)").run(JSON.stringify({
          blocks: this.blocks, pagesPerBlock: this.pagesPerBlock,
          maxDataLen: this.maxDataLen, maxLogRecords: this.maxLogRecords,
        }));
        db.prepare("INSERT INTO meta VALUES ('spare', '0')").run();
        const ins = db.prepare("INSERT INTO pages VALUES (?, ?, 'blank', NULL, NULL)");
        for (let b = 0; b < this.blocks; b++)
          for (let p = 0; p < this.pagesPerBlock; p++) ins.run(b, p);
        for (const k of ["logical_writes", "physical_programs", "migrated_pages"])
          db.prepare("INSERT INTO stats VALUES (?, 0)").run(k);
        for (let b = 0; b < this.blocks; b++)
          db.prepare("INSERT INTO erase_counts VALUES (?, 0)").run(b);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    this.logicalPages = (this.blocks - 1) * this.pagesPerBlock - 1;
  }

  private validateConfig() {
    const L = LIMITS;
    if (!Number.isInteger(this.blocks) || this.blocks < L.minBlocks || this.blocks > L.maxBlocks)
      throw new FtlError("INVALID_CONFIG", `块数须为 ${L.minBlocks}..${L.maxBlocks} 的整数`);
    if (!Number.isInteger(this.pagesPerBlock) || this.pagesPerBlock < L.minPagesPerBlock || this.pagesPerBlock > L.maxPagesPerBlock)
      throw new FtlError("INVALID_CONFIG", `每块页数须为 ${L.minPagesPerBlock}..${L.maxPagesPerBlock} 的整数`);
    if (this.maxDataLen < 1 || this.maxDataLen > L.maxDataLen)
      throw new FtlError("INVALID_CONFIG", `数据长度上限须为 1..${L.maxDataLen}`);
    if (this.maxLogRecords < 1 || this.maxLogRecords > L.maxLogRecords)
      throw new FtlError("INVALID_CONFIG", `日志条数上限须为 1..${L.maxLogRecords}`);
  }

  private get spare(): number {
    return Number(this.db.prepare("SELECT value FROM meta WHERE key='spare'").get().value);
  }
  private setSpare(b: number) {
    this.db.prepare("UPDATE meta SET value=? WHERE key='spare'").run(String(b));
  }
  private bump(key: string, n = 1) {
    this.db.prepare("UPDATE stats SET value = value + ? WHERE key=?").run(n, key);
  }
  private stat(key: string): number {
    return this.db.prepare("SELECT value FROM stats WHERE key=?").get(key).value;
  }

  private validateLpn(lpn: any): number {
    if (!Number.isInteger(lpn) || lpn < 0 || lpn >= this.logicalPages)
      throw new FtlError("INVALID_LPN", `逻辑页号须为 0..${this.logicalPages - 1} 的整数，收到 ${lpn}`);
    return lpn;
  }

  private getMapping(lpn: number): { block: number; page: number } | null {
    return this.db.prepare("SELECT block, page FROM mapping WHERE lpn=?").get(lpn) ?? null;
  }

  /** 普通块中空白页的确定选择顺序：块号升序、页号升序。 */
  private nextBlankPage(): { block: number; page: number } | null {
    return this.db.prepare(
      "SELECT block, page FROM pages WHERE state='blank' AND block != ? ORDER BY block, page LIMIT 1"
    ).get(this.spare) ?? null;
  }

  private blankCountNormal(): number {
    return this.db.prepare(
      "SELECT COUNT(*) c FROM pages WHERE state='blank' AND block != ?"
    ).get(this.spare).c;
  }

  /** 垃圾回收：选失效页最多的非备用块（至少一页失效），平局取块号最小者。 */
  private gc(): GcReport {
    const victim = this.db.prepare(`
      SELECT block,
        SUM(CASE WHEN state='invalid' THEN 1 ELSE 0 END) AS invalids
      FROM pages WHERE block != ?
      GROUP BY block HAVING invalids >= 1
      ORDER BY invalids DESC, block ASC LIMIT 1
    `).get(this.spare);
    if (!victim) throw new FtlError("OUT_OF_SPACE", "普通区域无空白页且无含失效页的块可回收");
    const oldSpare = this.spare;
    const validPages = this.db.prepare(
      "SELECT page, lpn, data FROM pages WHERE block=? AND state='valid' ORDER BY page"
    ).all(victim.block);
    const migrated: GcReport["migrated"] = [];
    let nextPage = 0;
    for (const vp of validPages) {
      // 备用块必为全空白，按页序写入
      this.db.prepare("UPDATE pages SET state='valid', lpn=?, data=? WHERE block=? AND page=?")
        .run(vp.lpn, vp.data, oldSpare, nextPage);
      this.db.prepare("UPDATE mapping SET block=?, page=? WHERE lpn=?").run(oldSpare, nextPage, vp.lpn);
      migrated.push({
        lpn: vp.lpn,
        from: `${victim.block}:${vp.page}`,
        to: `${oldSpare}:${nextPage}`,
        data: vp.data,
      });
      nextPage++;
    }
    if (migrated.length > 0) {
      this.bump("physical_programs", migrated.length);
      this.bump("migrated_pages", migrated.length);
    }
    // 整块擦除受害块
    this.db.prepare("UPDATE pages SET state='blank', lpn=NULL, data=NULL WHERE block=?").run(victim.block);
    this.db.prepare("UPDATE erase_counts SET count = count + 1 WHERE block=?").run(victim.block);
    this.setSpare(victim.block);
    return {
      victimBlock: victim.block,
      victimInvalidPages: victim.invalids,
      migrated,
      erasedBlock: victim.block,
      oldSpare,
      newSpare: victim.block,
    };
  }

  private log(op: string, detail: object): number {
    const r = this.db.prepare("INSERT INTO logs (op, detail) VALUES (?, ?)").run(op, JSON.stringify(detail));
    // 限制日志条数：删除最旧的多余记录
    this.db.prepare(
      "DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)"
    ).run(this.maxLogRecords);
    return Number(r.lastInsertRowid);
  }

  private checkInvariants() {
    // 每个映射指向唯一有效页；每个有效页恰有一条映射；备用块全空白
    const bad1 = this.db.prepare(`
      SELECT COUNT(*) c FROM mapping m
      WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.block=m.block AND p.page=m.page AND p.state='valid' AND p.lpn=m.lpn)
    `).get().c;
    const bad2 = this.db.prepare(`
      SELECT COUNT(*) c FROM pages p WHERE p.state='valid'
      AND NOT EXISTS (SELECT 1 FROM mapping m WHERE m.lpn=p.lpn AND m.block=p.block AND m.page=p.page)
    `).get().c;
    const bad3 = this.db.prepare(
      "SELECT COUNT(*) c FROM pages WHERE block=? AND state != 'blank'"
    ).get(this.spare).c;
    if (bad1 || bad2 || bad3) throw new FtlError("INVARIANT_FAILED", `内部不变量失败: ${bad1},${bad2},${bad3}`);
  }

  write(lpn: any, data: any): OpReport {
    this.validateLpn(lpn);
    if (typeof data !== "string" || data.length === 0 || data.length > this.maxDataLen)
      throw new FtlError("INVALID_DATA", `数据须为 1..${this.maxDataLen} 字符的字符串`);
    this.db.exec("BEGIN");
    try {
      const before = this.getMapping(lpn);
      let gcReport: GcReport | null = null;
      if (this.blankCountNormal() === 0) gcReport = this.gc();
      const target = this.nextBlankPage();
      if (!target) throw new FtlError("OUT_OF_SPACE", "回收后仍无空白页");
      let invalidated: string | null = null;
      // 回收可能已搬迁本逻辑页，须使用回收后的最新映射来失效旧页
      const current = gcReport ? this.getMapping(lpn) : before;
      if (current) {
        this.db.prepare("UPDATE pages SET state='invalid' WHERE block=? AND page=?").run(current.block, current.page);
        invalidated = `${current.block}:${current.page}`;
      }
      this.db.prepare("UPDATE pages SET state='valid', lpn=?, data=? WHERE block=? AND page=?")
        .run(lpn, data, target.block, target.page);
      this.db.prepare("INSERT INTO mapping (lpn, block, page) VALUES (?,?,?) ON CONFLICT(lpn) DO UPDATE SET block=excluded.block, page=excluded.page")
        .run(lpn, target.block, target.page);
      this.bump("logical_writes");
      this.bump("physical_programs");
      this.checkInvariants();
      const report: OpReport = {
        op: "write", logId: 0, lpn,
        mappingBefore: before ? `${before.block}:${before.page}` : null,
        mappingAfter: `${target.block}:${target.page}`,
        writeAt: `${target.block}:${target.page}`,
        invalidated, gc: gcReport,
      };
      report.logId = this.log("write", report);
      this.db.exec("COMMIT");
      return report;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  read(lpn: any): { lpn: number; data: string; at: string } {
    this.validateLpn(lpn);
    const m = this.getMapping(lpn);
    if (!m) throw new FtlError("NOT_FOUND", `逻辑页 ${lpn} 未映射`);
    const row = this.db.prepare("SELECT data FROM pages WHERE block=? AND page=?").get(m.block, m.page);
    return { lpn, data: row.data, at: `${m.block}:${m.page}` };
  }

  unmap(lpn: any): OpReport {
    this.validateLpn(lpn);
    this.db.exec("BEGIN");
    try {
      const before = this.getMapping(lpn);
      let note: string | undefined;
      if (before) {
        this.db.prepare("UPDATE pages SET state='invalid' WHERE block=? AND page=?").run(before.block, before.page);
        this.db.prepare("DELETE FROM mapping WHERE lpn=?").run(lpn);
      } else {
        note = "逻辑页未映射，幂等无操作";
      }
      this.checkInvariants();
      const report: OpReport = {
        op: "unmap", logId: 0, lpn,
        mappingBefore: before ? `${before.block}:${before.page}` : null,
        mappingAfter: null,
        invalidated: before ? `${before.block}:${before.page}` : null,
        gc: null, note,
      };
      report.logId = this.log("unmap", report);
      this.db.exec("COMMIT");
      return report;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  layout(): { spare: number; pages: PageInfo[] } {
    return {
      spare: this.spare,
      pages: this.db.prepare("SELECT block, page, state, lpn, data FROM pages ORDER BY block, page").all(),
    };
  }

  getLog(id: number): any {
    const row = this.db.prepare("SELECT id, op, detail FROM logs WHERE id=?").get(id);
    if (!row) throw new FtlError("NOT_FOUND", `日志 ${id} 不存在`);
    return { id: row.id, op: row.op, ...JSON.parse(row.detail) };
  }

  report() {
    const lw = this.stat("logical_writes");
    const pp = this.stat("physical_programs");
    return {
      config: {
        blocks: this.blocks, pagesPerBlock: this.pagesPerBlock,
        logicalPages: this.logicalPages, spareBlock: this.spare,
        maxDataLen: this.maxDataLen, maxLogRecords: this.maxLogRecords,
      },
      logicalWrites: lw,
      physicalPrograms: pp,
      migratedPages: this.stat("migrated_pages"),
      writeAmplification: lw === 0 ? null : pp / lw,
      writeAmplificationNote: lw === 0 ? "无数据（尚无逻辑写入）" : undefined,
      eraseCounts: this.db.prepare("SELECT block, count FROM erase_counts ORDER BY block").all(),
    };
  }

  close() { this.db.close(); }
}
