// Start the IceBase emulator for the Dart tests: prints `ready <url>` and runs until killed.
//   node --import tsx tool/emulator.ts test/fixture
import { resolve } from 'node:path';
import { startEmulator } from '@panth977/icebase-cli/emulator';

const root = resolve(process.argv[2] ?? 'test/fixture');
const { default: config } = await import(`${root}/icebase.config.ts`);
const emu = await startEmulator({ config, root, env: 'local', port: Number(process.env.PORT ?? 0), dataDir: ':memory:', log: () => {} });
console.log(`ready ${emu.url}`);
process.on('SIGTERM', () => void emu.close().then(() => process.exit(0)));
