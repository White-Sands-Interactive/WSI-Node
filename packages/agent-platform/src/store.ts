import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type PlatformKeyRecord = {
  key: string;
  name: string;
  createdAt: string;
  /** Cumulative prompt + completion tokens billed to this key. */
  tokenUsage: number;
};

type StoreFile = {
  keys: PlatformKeyRecord[];
};

export class PlatformStore {
  private readonly filePath: string;
  private data: StoreFile = { keys: [] };
  private loaded = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "platform.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as StoreFile;
      if (!Array.isArray(this.data.keys)) this.data.keys = [];
    } catch {
      this.data = { keys: [] };
      await this.flush();
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  async createKey(name: string): Promise<PlatformKeyRecord> {
    await this.load();
    const record: PlatformKeyRecord = {
      key: `pk_${randomBytes(24).toString("hex")}`,
      name,
      createdAt: new Date().toISOString(),
      tokenUsage: 0,
    };
    this.data.keys.push(record);
    await this.flush();
    return record;
  }

  async findKey(key: string): Promise<PlatformKeyRecord | null> {
    await this.load();
    return this.data.keys.find((k) => k.key === key) ?? null;
  }

  async addTokenUsage(key: string, tokens: number): Promise<void> {
    await this.load();
    const record = this.data.keys.find((k) => k.key === key);
    if (!record) return;
    record.tokenUsage += Math.max(0, Math.floor(tokens));
    await this.flush();
  }

  async listKeys(): Promise<PlatformKeyRecord[]> {
    await this.load();
    return [...this.data.keys];
  }
}
