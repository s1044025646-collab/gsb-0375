import { DatabaseSync } from "node:sqlite";
import { FtlError } from "./errors";
import { openDb, getMeta, requireMeta, MAX_DATA_LEN, MAX_LOG_RECORDS } from "./db";

export interface DiskConfig {
  blocks: number;
  pagesPerBlock: number;
}

export interface PageRow {
  block: number;
  page: number;
  state: "free" | "valid" | "invalid";
  lpn: number | null;
  data: string | null;
}

export class Ftl {
  readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    this.db = openDb(dbPath);
  }

  close() {
    this.db.close();
  }

  get created(): boolean {
    return getMeta(this.db, "blocks") !== undefined;
  }

  get blocks(): number {
    return Number(requireMeta(this.db, "blocks"));
  }

  get pagesPerBlock(): number {
    return Number(requireMeta(this.db, "pages_per_block"));
  }

  get spareBlock(): number {
    return Number(requireMeta(this.db, "spare_block"));
  }

  get logicalPages(): number {
    return Number(requireMeta(this.db, "logical_pages"));
  }

  create(cfg: DiskConfig) {
    if (this.created) throw new FtlError("ALREADY_EXISTS", "模拟盘已存在，请先删除数据文件");
    if (!Number.isInteger(cfg.blocks) || cfg.blocks < 3)
      throw new FtlError("INVALID_PARAM", "块数必须为 >= 3 的整数");
    if (!Number.isInteger(cfg.pagesPerBlock) || cfg.pagesPerBlock < 2)
      throw new FtlError("INVALID_PARAM", "每块页数必须为 >= 2 的整数");
    const logicalPages = (cfg.blocks - 1) * cfg.pagesPerBlock - 1;
    this.db.exec("BEGIN");
    try {
      const meta = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      meta.run("blocks", String(cfg.blocks));
      meta.run("pages_per_block", String(cfg.pagesPerBlock));
      meta.run("spare_block", String(cfg.blocks - 1));
      meta.run("logical_pages", String(logicalPages));
      const page = this.db.prepare("INSERT INTO pages (block, page, state) VALUES (?, ?, 'free')");
      const erase = this.db.prepare("INSERT INTO block_erases (block, count) VALUES (?, 0)");
      for (let b = 0; b < cfg.blocks; b++) {
        erase.run(b);
        for (let p = 0; p < cfg.pagesPerBlock; p++) page.run(b, p);
      }
      const stat = this.db.prepare("INSERT INTO stats (key, value) VALUES (?, 0)");
      for (const k of ["logical_writes", "physical_programs", "migrated_pages"]) stat.run(k);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { blocks: cfg.blocks, pagesPerBlock: cfg.pagesPerBlock, logicalPages, spareBlock: cfg.blocks - 1 };
  }

  private stat(key: string): number {
    const row = this.db.prepare("SELECT value FROM stats WHERE key = ?").get(key) as { value: number };
    return row.value;
  }

  private bump(key: string, delta = 1) {
    this.db.prepare("UPDATE stats SET value = value + ? WHERE key = ?").run(delta, key);
  }

  private nextOpId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ops").get() as { id: number };
    return row.id;
  }

  private logOp(type: string, detail: unknown): number {
    const id = this.nextOpId();
    this.db.prepare("INSERT INTO ops (id, type, detail) VALUES (?, ?, ?)").run(id, type, JSON.stringify(detail));
    // 限制日志条数：保留最近 MAX_LOG_RECORDS 条
    this.db
      .prepare("DELETE FROM ops WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM ops)")
      .run(MAX_LOG_RECORDS);
    return id;
  }

  private validateLpn(lpn: number) {
    if (!Number.isInteger(lpn)) throw new FtlError("INVALID_PARAM", "逻辑页号必须为整数");
    if (lpn < 0 || lpn >= this.logicalPages)
      throw new FtlError("LPN_OUT_OF_RANGE", `逻辑页号 ${lpn} 越界，有效范围 [0, ${this.logicalPages - 1}]`);
  }

  private getMapping(lpn: number): { block: number; page: number } | undefined {
    return this.db.prepare("SELECT block, page FROM mapping WHERE lpn = ?").get(lpn) as
      | { block: number; page: number }
      | undefined;
  }

  /** 普通区域空白页的确定选择顺序：块号升序（跳过备用块），块内页号升序。 */
  private findFreePage(): { block: number; page: number } | undefined {
    return this.db
      .prepare(
        `SELECT block, page FROM pages
         WHERE state = 'free' AND block != ?
         ORDER BY block ASC, page ASC LIMIT 1`
      )
      .get(this.spareBlock) as { block: number; page: number } | undefined;
  }

  /** 选择受害块：非备用块中失效页最多者，平局取块号最小；必须至少有一页失效。 */
  private pickVictim(): { block: number; invalidCount: number } | undefined {
    return this.db
      .prepare(
        `SELECT block, COUNT(*) AS invalidCount FROM pages
         WHERE state = 'invalid' AND block != ?
         GROUP BY block
         ORDER BY invalidCount DESC, block ASC LIMIT 1`
      )
      .get(this.spareBlock) as { block: number; invalidCount: number } | undefined;
  }

  private gc() {
    const victim = this.pickVictim();
    if (!victim)
      throw new FtlError("NO_VICTIM", "普通区域已满且没有含失效页的块可供回收（内部不变量失败）");
    const spare = this.spareBlock;
    const validPages = this.db
      .prepare("SELECT page, lpn, data FROM pages WHERE block = ? AND state = 'valid' ORDER BY page ASC")
      .all(victim.block) as { page: number; lpn: number; data: string }[];
    const moves: { lpn: number; from: string; to: string }[] = [];
    const updMapping = this.db.prepare("UPDATE mapping SET block = ?, page = ? WHERE lpn = ?");
    const markInvalid = this.db.prepare("UPDATE pages SET state = 'invalid' WHERE block = ? AND page = ?");
    const program = this.db.prepare(
      "UPDATE pages SET state = 'valid', lpn = ?, data = ? WHERE block = ? AND page = ?"
    );
    validPages.forEach((row, i) => {
      markInvalid.run(victim.block, row.page);
      program.run(row.lpn, row.data, spare, i);
      updMapping.run(spare, i, row.lpn);
      moves.push({ lpn: row.lpn, from: `${victim.block}:${row.page}`, to: `${spare}:${i}` });
    });
    this.bump("physical_programs", validPages.length);
    this.bump("migrated_pages", validPages.length);
    // 整块擦除受害块
    this.db
      .prepare("UPDATE pages SET state = 'free', lpn = NULL, data = NULL WHERE block = ?")
      .run(victim.block);
    this.db.prepare("UPDATE block_erases SET count = count + 1 WHERE block = ?").run(victim.block);
    // 角色转换：受害块成为新备用块，原备用块成为普通块
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'spare_block'").run(String(victim.block));
    return {
      victimBlock: victim.block,
      victimInvalidPages: victim.invalidCount,
      oldSpareBlock: spare,
      newSpareBlock: victim.block,
      movedPages: moves,
      erasedBlock: victim.block,
    };
  }

  write(lpn: number, data: string) {
    this.validateLpn(lpn);
    if (typeof data !== "string") throw new FtlError("INVALID_PARAM", "数据必须为字符串");
    if (Buffer.byteLength(data, "utf8") > MAX_DATA_LEN)
      throw new FtlError("DATA_TOO_LONG", `数据长度超过上限 ${MAX_DATA_LEN} 字节`);
    this.db.exec("BEGIN");
    try {
      const mappingBefore = this.getMapping(lpn) ?? null;
      let gcInfo = null;
      let target = this.findFreePage();
      if (!target) {
        gcInfo = this.gc();
        target = this.findFreePage();
        if (!target) throw new FtlError("INTERNAL_INVARIANT", "回收后仍无空白页");
      }
      // 回收可能刚搬迁过该逻辑页，必须在 GC 之后重新读取映射再失效旧页
      const before = this.getMapping(lpn) ?? null;
      let invalidated: string | null = null;
      if (before) {
        this.db
          .prepare("UPDATE pages SET state = 'invalid' WHERE block = ? AND page = ?")
          .run(before.block, before.page);
        invalidated = `${before.block}:${before.page}`;
      }
      this.db
        .prepare("UPDATE pages SET state = 'valid', lpn = ?, data = ? WHERE block = ? AND page = ?")
        .run(lpn, data, target.block, target.page);
      this.db
        .prepare(
          "INSERT INTO mapping (lpn, block, page) VALUES (?, ?, ?) ON CONFLICT(lpn) DO UPDATE SET block = excluded.block, page = excluded.page"
        )
        .run(lpn, target.block, target.page);
      this.bump("logical_writes");
      this.bump("physical_programs");
      const detail = {
        lpn,
        data,
        mappingBefore: mappingBefore ? `${mappingBefore.block}:${mappingBefore.page}` : null,
        mappingAfter: `${target.block}:${target.page}`,
        writeAt: `${target.block}:${target.page}`,
        invalidatedOldPage: invalidated,
        gc: gcInfo,
      };
      const opId = this.logOp("write", detail);
      this.db.exec("COMMIT");
      return { opId, ...detail };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  read(lpn: number) {
    this.validateLpn(lpn);
    const row = this.db
      .prepare(
        `SELECT m.block, m.page, p.data FROM mapping m
         JOIN pages p ON p.block = m.block AND p.page = m.page
         WHERE m.lpn = ? AND p.state = 'valid'`
      )
      .get(lpn) as { block: number; page: number; data: string } | undefined;
    if (!row) throw new FtlError("NOT_FOUND", `逻辑页 ${lpn} 未映射`);
    return { lpn, data: row.data, at: `${row.block}:${row.page}` };
  }

  /** 取消映射：幂等。已取消的页再次取消返回 alreadyUnmapped=true，不产生任何状态变化。 */
  unmap(lpn: number) {
    this.validateLpn(lpn);
    this.db.exec("BEGIN");
    try {
      const before = this.getMapping(lpn) ?? null;
      let invalidated: string | null = null;
      if (before) {
        this.db
          .prepare("UPDATE pages SET state = 'invalid' WHERE block = ? AND page = ?")
          .run(before.block, before.page);
        this.db.prepare("DELETE FROM mapping WHERE lpn = ?").run(lpn);
        invalidated = `${before.block}:${before.page}`;
      }
      const detail = {
        lpn,
        mappingBefore: before ? `${before.block}:${before.page}` : null,
        mappingAfter: null,
        invalidatedOldPage: invalidated,
        alreadyUnmapped: before === null,
      };
      const opId = this.logOp("unmap", detail);
      this.db.exec("COMMIT");
      return { opId, ...detail };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  layout() {
    const pages = this.db
      .prepare("SELECT block, page, state, lpn, data FROM pages ORDER BY block, page")
      .all() as unknown as PageRow[];
    const erases = this.db
      .prepare("SELECT block, count FROM block_erases ORDER BY block")
      .all() as { block: number; count: number }[];
    return {
      blocks: this.blocks,
      pagesPerBlock: this.pagesPerBlock,
      logicalPages: this.logicalPages,
      spareBlock: this.spareBlock,
      pages,
      blockErases: Object.fromEntries(erases.map((r) => [r.block, r.count])),
    };
  }

  getOp(id: number) {
    const row = this.db.prepare("SELECT id, type, detail FROM ops WHERE id = ?").get(id) as
      | { id: number; type: string; detail: string }
      | undefined;
    if (!row) throw new FtlError("NOT_FOUND", `操作记录 ${id} 不存在`);
    return { id: row.id, type: row.type, detail: JSON.parse(row.detail) };
  }

  report() {
    const logicalWrites = this.stat("logical_writes");
    const physicalPrograms = this.stat("physical_programs");
    const migratedPages = this.stat("migrated_pages");
    const erases = this.db
      .prepare("SELECT block, count FROM block_erases ORDER BY block")
      .all() as { block: number; count: number }[];
    return {
      logicalWrites,
      physicalPrograms,
      migratedPages,
      blockErases: Object.fromEntries(erases.map((r) => [r.block, r.count])),
      totalErases: erases.reduce((s, r) => s + r.count, 0),
      writeAmplification:
        logicalWrites === 0 ? null : physicalPrograms / logicalWrites,
      writeAmplificationNote: logicalWrites === 0 ? "无数据：尚未发生逻辑写入" : undefined,
    };
  }

  /** 教学用不变量检查：映射与有效页一一对应、备用块全空白、计数守恒。 */
  checkInvariants(): string[] {
    const problems: string[] = [];
    const validPages = this.db
      .prepare("SELECT block, page, lpn FROM pages WHERE state = 'valid'")
      .all() as { block: number; page: number; lpn: number }[];
    const mappings = this.db
      .prepare("SELECT lpn, block, page FROM mapping")
      .all() as { lpn: number; block: number; page: number }[];
    const validSet = new Set(validPages.map((p) => `${p.lpn}@${p.block}:${p.page}`));
    const mapSet = new Set(mappings.map((m) => `${m.lpn}@${m.block}:${m.page}`));
    for (const v of validSet) if (!mapSet.has(v)) problems.push(`有效页无映射: ${v}`);
    for (const m of mapSet) if (!validSet.has(m)) problems.push(`映射无有效页: ${m}`);
    const sparePages = this.db
      .prepare("SELECT COUNT(*) AS c FROM pages WHERE block = ? AND state != 'free'")
      .get(this.spareBlock) as { c: number };
    if (sparePages.c !== 0) problems.push("备用块不全为空白");
    const lpnCount = this.db.prepare("SELECT COUNT(*) AS c FROM mapping").get() as { c: number };
    if (lpnCount.c > this.logicalPages) problems.push("映射数量超过逻辑容量");
    return problems;
  }
}
