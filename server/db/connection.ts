import db from './loader';

type CollectionLike<T extends object> = {
  find(query?: object, opts?: object): { toArray(): Promise<T[]> };
  findOne(query?: object): Promise<T | null>;
  updateOne(filter: object, update: object, opts?: object): Promise<unknown>;
  deleteOne(filter: object): Promise<unknown>;
  createIndex(index: object, opts?: object): Promise<unknown>;
};

export function getDb() {
  return {
    collection<T extends object = Record<string, unknown>>(name: string): CollectionLike<T> {
      const collection = (db as unknown as Record<string, unknown>)[name];
      const c = collection as { find?: (q?: object) => Promise<T[]> | T[]; findOne?: (q?: object) => Promise<T | null>; update?: (q: object, u: object) => Promise<unknown>; remove?: (q: object) => Promise<unknown> } | undefined;
      return {
        find(query?: object) {
          return { async toArray() { return c?.find ? await c.find(query) : []; } };
        },
        async findOne(query?: object) { return c?.findOne ? await c.findOne(query) : null; },
        async updateOne(filter: object, update: object) { return c?.update ? await c.update(filter, update) : undefined; },
        async deleteOne(filter: object) { return c?.remove ? await c.remove(filter) : undefined; },
        async createIndex() { return undefined; },
      };
    },
  };
}
