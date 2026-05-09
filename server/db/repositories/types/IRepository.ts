// server/db/repositories/types/IRepository.ts
// Generic repository interface — tüm repository class'ları bu interface'i uygular.

/**
 * Temel CRUD operasyonlarını tanımlayan generic repository contract.
 * T: Entity tipi
 * ID: Birincil anahtar tipi (varsayılan: string)
 */
export interface IRepository<T, ID = string> {
  findById(id: ID): Promise<T | null>;
  findAll(query?: Partial<T>): Promise<T[]>;
  create(data: Partial<T>): Promise<T>;
  update(id: ID, fields: Partial<T>): Promise<unknown>;
  delete(id: ID): Promise<unknown>;
}
