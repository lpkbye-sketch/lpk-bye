import { timingSafeEqual } from 'node:crypto';
import { dataStore as sheets } from '../lib/store.js';
import { send } from '../lib/http.js';
import { sendFonnte } from '../lib/fonnte.js';

const normalizePhone = (value) => String(value || '').replace(/\D/g, '').replace(/^0/, '62');
const formatMoney = (value) => new Intl.NumberFormat('id-ID').format(Number(value || 0));

function validKey(provided) {
  const expected = process.env.FONNTE_WEBHOOK_SECRET || '';
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(provided));
  return a.length === b.length && timingSafeEqual(a, b);
}

function portalUrl(req, token) {
  const base = (process.env.APP_URL || `https://${req.headers.host}`).replace(/\/$/, '');
  return `${base}/peserta/${token}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { success: false, message: 'Gunakan POST.' });
  if (!validKey(req.query.key)) return send(res, 401, { success: false, message: 'Webhook key tidak valid.' });
  const sender = normalizePhone(req.body?.sender);
  const message = String(req.body?.message || req.body?.text || '').trim().slice(0, 1000);
  const inboxid = req.body?.inboxid;
  if (!sender || !message) return send(res, 200, { success: true });

  try {
    const [command, ...args] = message.split(/\s+/);
    const action = command.toUpperCase();
    const code = args.join(' ').trim().toUpperCase();
    let reply = 'Perintah tidak dikenali. Ketik MENU untuk melihat bantuan.';
    const registrants = await sheets.listRegistrants();

    if (action === 'MENU') {
      reply = 'LPK BYE\nSTATUS <kode> - cek status pendaftaran\nPEMBAYARAN <kode> - cek cicilan\nPORTAL <kode> - dapatkan tautan portal\nHubungi admin bila perlu bantuan.';
    } else if (['STATUS', 'PEMBAYARAN', 'PORTAL'].includes(action)) {
      if (!code) {
        reply = `Format: ${action} <kode pendaftaran>. Contoh: ${action} BYE-2026-ABC123`;
      } else {
        const registrant = registrants.find((item) =>
          item.registration_code.toUpperCase() === code && normalizePhone(item.whatsapp) === sender);
        if (!registrant) {
          reply = 'Data pendaftaran tidak ditemukan untuk nomor WhatsApp ini. Pastikan nomor dan kode pendaftaran sesuai.';
        } else if (action === 'STATUS') {
          const labels = { pending: 'Menunggu verifikasi', verified: 'Terverifikasi', accepted: 'Diterima', rejected: 'Ditolak' };
          reply = `${registrant.full_name}\nProgram: ${registrant.program_type}\nGelombang: ${registrant.batch_name}\nStatus: ${labels[registrant.status] || registrant.status}${registrant.feedback ? `\nPesan admin: ${registrant.feedback}` : ''}`;
        } else if (action === 'PORTAL') {
          reply = `Portal peserta ${registrant.full_name}:\n${portalUrl(req, registrant.portal_token)}\nTautan ini bersifat pribadi.`;
        } else {
          const [batch, payments] = await Promise.all([sheets.listBatches(), sheets.listPayments()]);
          const training = batch.find((item) => item.id === registrant.batch_id);
          const approved = payments.filter((item) => item.registrant_id === registrant.id && item.status === 'approved');
          const paid = approved.reduce((sum, item) => sum + Number(item.amount_approved || 0), 0);
          const fee = Number(training?.training_fee || 0);
          reply = `Pembayaran ${registrant.registration_code}\nBiaya: Rp${formatMoney(fee)}\nTerverifikasi: Rp${formatMoney(paid)}\nSisa: Rp${formatMoney(Math.max(0, fee - paid))}${training?.payment_instructions && ['verified', 'accepted'].includes(registrant.status) ? `\nInstruksi: ${training.payment_instructions}` : ''}`;
        }
      }
    } else if (action === 'ADMIN' && args[0]?.toUpperCase() === 'RINGKASAN') {
      const allowed = String(process.env.FONNTE_ADMIN_NUMBER || '').split(',').map(normalizePhone).filter(Boolean);
      if (!allowed.includes(sender)) {
        reply = 'Perintah admin tidak diizinkan untuk nomor ini.';
      } else {
        const batches = await sheets.listBatches();
        const pending = registrants.filter((item) => item.status === 'pending').length;
        const active = batches.filter((item) => ['true', '1'].includes(String(item.is_active).toLowerCase())).length;
        reply = `Ringkasan LPK BYE\nTotal pendaftar: ${registrants.length}\nMenunggu verifikasi: ${pending}\nGelombang aktif: ${active}`;
      }
    }
    

    await sendFonnte(sender, reply, inboxid);
    return send(res, 200, { success: true });
  } catch (error) {
    console.error('Fonnte webhook failed:', error);
    return send(res, 500, { success: false, message: 'Webhook gagal diproses.' });
  }
}
