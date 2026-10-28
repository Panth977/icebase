import { api } from './api';

export interface Overview {
  name: string;
  env: string;
  environments: string[];
  projectId: string | null;
  modes: Record<string, string>;
  health: { ok: boolean; services: string[]; documents: number } | null;
  counts: { collections: number; paths: number; files: number; endpoints: number };
  rules: Record<string, string>;
  hosting: { public: string; site: string | null } | null;
  customAuth: { email: string | null; phone: string | null; google: boolean } | null;
  secrets: { name: string; set: boolean }[];
  problems: string[];
}

export const app = $state({
  overview: null as Overview | null,
  error: '' as string,
});

export async function load() {
  app.error = '';
  try {
    app.overview = await api<Overview>('overview');
  } catch (e) {
    app.overview = null;
    app.error = (e as Error).message;
  }
}
