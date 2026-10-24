// The only setup file in the frontend. Switch environments with one string; app code never changes.
import { initializeApp } from '@panth977/icebase/app';
import { getAuth } from '@panth977/icebase/auth';
import { getFirestore } from '@panth977/icebase/firestore';
import { getFunctions } from '@panth977/icebase/functions';
import { getStorage } from '@panth977/icebase/storage';
import config from '../../icebase.config';

const env = (globalThis as { ICEBASE_ENV?: 'local' | 'prod' }).ICEBASE_ENV ?? 'local';

export const app = initializeApp(config, env); // 'local' | 'prod' — a typo is a compile error
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);
