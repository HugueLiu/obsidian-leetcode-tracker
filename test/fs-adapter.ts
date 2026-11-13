import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * DataAdapter 的最小实现，让插件的数据层能在 Node 里跑起来做回归测试。
 * 只实现 store 层真正用到的五个方法。
 */
export class FsAdapter {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "lc-test-"));
  }

  private full(p: string): string {
    return path.join(this.root, p);
  }

  async exists(p: string): Promise<boolean> {
    return fs.existsSync(this.full(p));
  }

  async read(p: string): Promise<string> {
    return fs.readFileSync(this.full(p), "utf8");
  }

  async write(p: string, data: string): Promise<void> {
    const f = this.full(p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data, "utf8");
  }

  async append(p: string, data: string): Promise<void> {
    const f = this.full(p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, data, "utf8");
  }

  async mkdir(p: string): Promise<void> {
    fs.mkdirSync(this.full(p), { recursive: true });
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
