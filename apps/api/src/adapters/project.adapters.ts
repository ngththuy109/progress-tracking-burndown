import {
  deleteProject,
  findProject,
  findProjectConnection,
  listMembers,
  listProjects,
  removeMember,
  updateProjectJira,
  upsertMember,
  upsertProject,
  type PrismaClient,
  type ProjectConnectionRow,
  type ProjectMemberRow,
  type ProjectRow,
  type UpdateProjectJiraArgs,
  type UpsertProjectArgs,
} from '@app/db';
import type { ProjectDirectory } from './project-scope.js';

/**
 * Cổng ĐỌC/GHI gốc tenant `project` — dùng cho `/api/admin/projects` và `/api/me`.
 *
 * `connection()` trả CẢ token đã mã hóa (`jiraTokenEnc`) — chỉ tầng route admin
 * dùng để test kết nối; TUYỆT ĐỐI không đưa row này vào response API.
 */
export interface ProjectStore {
  list(): Promise<readonly ProjectRow[]>;
  find(projectKey: string): Promise<ProjectRow | null>;
  upsert(row: UpsertProjectArgs): Promise<void>;
  /** Trả `false` nếu project không tồn tại (route đổi thành 404). */
  updateJira(projectKey: string, args: UpdateProjectJiraArgs): Promise<boolean>;
  remove(projectKey: string): Promise<boolean>;
  /** Row kết nối Jira đầy đủ (token MÃ HÓA) — cho "Test connection". */
  connection(projectKey: string): Promise<ProjectConnectionRow | null>;
}

export function createProjectStore(prisma: PrismaClient): ProjectStore {
  return {
    list: () => listProjects(prisma),
    find: (projectKey) => findProject(prisma, projectKey),
    upsert: (row) => upsertProject(prisma, row),
    updateJira: (projectKey, args) => updateProjectJira(prisma, projectKey, args),
    remove: (projectKey) => deleteProject(prisma, projectKey),
    connection: (projectKey) => findProjectConnection(prisma, projectKey),
  };
}

/**
 * Cổng tra tồn tại cho guard `requireProject` — một truy vấn khoá chính mỗi
 * request có `:projectKey`. Tách khỏi `ProjectStore` để test-fakes chỉ cần giả
 * đúng một hàm.
 */
export function createProjectDirectory(prisma: PrismaClient): ProjectDirectory {
  return {
    async exists(projectKey) {
      const row = await prisma.project.findUnique({
        where: { projectKey },
        select: { projectKey: true },
      });
      return row !== null;
    },
  };
}

/** Cổng thành viên dự án — `/api/admin/projects/:projectKey/members`. */
export interface ProjectMemberStore {
  list(projectKey: string): Promise<readonly ProjectMemberRow[]>;
  upsert(args: {
    projectKey: string;
    userId: string;
    role: 'PM' | 'VIEWER';
    addedBy: string;
  }): Promise<void>;
  remove(projectKey: string, userId: string): Promise<boolean>;
}

export function createProjectMemberStore(prisma: PrismaClient): ProjectMemberStore {
  return {
    list: (projectKey) => listMembers(prisma, projectKey),
    upsert: (args) => upsertMember(prisma, args),
    remove: (projectKey, userId) => removeMember(prisma, projectKey, userId),
  };
}
