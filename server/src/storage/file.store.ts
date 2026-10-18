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

  /** A nagy, csak gépi olvasásra szánt fájlokat (`pretty: false`) tömören menti. */
  async write(name: string, data: unknown, pretty = true): Promise<void> {
    const target = this.file(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8');
    await fs.rename(tmp, target);
  }

  /** Egy almappa fájljainak neve (üres, ha a mappa nem létezik). */
  async list(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(this.file(dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    await fs.rm(this.file(name), { force: true });
  }

  private file(name: string) {
    return path.join(this.dir, name);
  }
}

/** Az SKU-ban lévő ';' és egyéb karakterek miatt kódolt fájlnév. */
export const historyFile = (sku: string) => `history/${encodeURIComponent(sku)}.json`;
