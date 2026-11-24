import { methodNotAllowed, send } from '../lib/http.js';
import { supabaseRpc } from '../lib/supabase.js';
import { syncMirrorRecord } from '../lib/sheets.js';

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
  return req.headers.authorization === `Bearer ${secret}`;
}


export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res);
  if (!isAuthorized(req)) return send(res, 401, { success: false, message: 'Akses sinkronisasi tidak diizinkan.' });
  if (process.env.DATA_STORE !== 'supabase') {
    return send(res, 409, { success: false, message: 'Sinkronisasi Sheets hanya aktif saat DATA_STORE=supabase.' });
  }

  try {
    const jobs = await supabaseRpc('claim_sheet_sync_jobs', { p_limit: 2 });
    let synced = 0;
    let failed = 0;
    for (const job of jobs || []) {
      try {
        await syncMirrorRecord(job.entity, job.operation, job.payload);
        await supabaseRpc('complete_sheet_sync_job', { p_job_id: job.id });
        synced += 1;
      } catch (error) {
        failed += 1;
        console.error('Google Sheets mirror sync failed:', job.entity, error.message);
        try {
          await supabaseRpc('retry_sheet_sync_job', { p_job_id: job.id, p_error: error.message });
        } catch (queueError) {
          console.error('Could not reschedule Google Sheets mirror sync:', queueError.message);
        }
      }
    }
    return send(res, 200, { success: true, data: { claimed: jobs?.length || 0, synced, failed } });
  } catch (error) {
    console.error('Google Sheets mirror worker failed:', error);
    return send(res, 500, { success: false, message: 'Sinkronisasi Sheets gagal dijalankan.' });
  }
}
