// @panth977/icebase-cli/console — the console as a fetch handler, to host it yourself (a Cloud
// Function for a Firebase project, say): consoleHandler(base, options, isAdmin); or the ready
// `icebaseConsole` function that `icebase deploy` adds when config.console.hosted is set.
export { consoleApi, consoleHandler, firebaseConsoleExtras, type ConsoleOptions } from './index.ts';
export { CONSOLE_BASE, CONSOLE_TOKEN_MIN, consoleTokenEnv, hasConsoleToken, hostedConsoleHandler, icebaseConsole } from './hosted.ts';
