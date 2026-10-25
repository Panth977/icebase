// Every export is a deployed function — same file deploys to Cloud Functions (mode firebase) or runs on the IceBase server.
import { onRequest, onSchedule } from '@panth977/icebase-server/functions';

export { onOrderCreated, cancelOrder, lowStock, getProduct, orderSummary } from './orders';

export const api = onRequest(async (req) => new Response(JSON.stringify({ ok: true, path: new URL(req.url).pathname }), { headers: { 'content-type': 'application/json' } }));

export const nightlyReport = onSchedule('0 2 * * *', async () => {
  console.log('nightly report');
});
