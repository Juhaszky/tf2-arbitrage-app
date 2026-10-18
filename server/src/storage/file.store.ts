import { promises as fs } from 'fs';
import path from 'path';

/** Egyszerű JSON-fájl tároló. Az írás atomi: ideiglenes fájlba ír, majd átnevezi. */
export class FileStore {
  constructor(private dir: string) {}

  async read<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async write(name: string, data: unknown): Promise<void> {
    const target = this.file(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  private file(name: string) {
    return path.join(this.dir, name);
  }
}

/** Az SKU-ban lévő ';' és egyéb karakterek miatt kódolt fájlnév. */
export const historyFile = (sku: string) => `history/${encodeURIComponent(sku)}.json`;
