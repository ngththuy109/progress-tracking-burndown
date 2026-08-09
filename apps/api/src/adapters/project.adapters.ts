import {
  deleteProject,
  listProjects,
  projectKeySet,
  upsertProject,
  type PrismaClient,
  type ProjectRow,
} from '@app/db';

/** Cổng ĐỌC/GHI danh mục Project — dùng cho `/api/projects` và kiểm PM. */
export interface ProjectStore {
  list(): Promise<readonly ProjectRow[]>;
  /** Tập key đã đăng ký — để kiểm PM chỉ được gán project có thật. */
  keys(): Promise<ReadonlySet<string>>;
  upsert(row: { projectKey: string; displayName: string | null }): Promise<void>;
  remove(projectKey: string): Promise<boolean>;
}

export function createProjectStore(prisma: PrismaClient): ProjectStore {
  return {
    list: () => listProjects(prisma),
    keys: () => projectKeySet(prisma),
    upsert: (row) => upsertProject(prisma, row),
    remove: (projectKey) => deleteProject(prisma, projectKey),
  };
}
