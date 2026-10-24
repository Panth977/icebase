// The only setup file in the frontend. Switch environments with one string; app code never changes.
import { initializeApp } from 'icebase/app';
import { getAuth } from 'icebase/auth';
import { getFirestore } from 'icebase/firestore';
import { getFunctions } from 'icebase/functions';
import { getStorage } from 'icebase/storage';
import config from '../../icebase.config';

const env = (globalThis as { ICEBASE_ENV?: 'local' | 'prod' }).ICEBASE_ENV ?? 'local';

export const app = initializeApp(config, env); // 'local' | 'prod' — a typo is a compile error
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);
