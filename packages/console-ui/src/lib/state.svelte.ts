import { api, session, targets, type Target } from './api';

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
  base: session.base,
  targets: [] as Target[],
  overview: null as Overview | null,
  error: '' as string,
  /** Bumped when the deployment changes: pages reload. */
  epoch: 0,
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

export async function boot() {
  app.targets = await targets();
  await load();
}

export async function switchTo(base: string) {
  session.base = base;
  app.base = base;
  app.overview = null;
  app.epoch++;
  await load();
}

export const deploymentName = () => (app.base ? (app.targets.find((t) => t.url === app.base)?.name ?? app.base) : 'This server');
