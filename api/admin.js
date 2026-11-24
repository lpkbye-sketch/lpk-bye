import { randomBytes } from 'node:crypto';
import { authorized, createAdminToken } from '../lib/auth.js';
import { methodNotAllowed, send } from '../lib/http.js';
import { parseJson } from '../lib/sheets.js';
import { dataStore as sheets } from '../lib/store.js';
import { uploadToDrive } from '../lib/drive.js';
import { sendFonnte } from '../lib/fonnte.js';
import { buildAnalyticsReport, createAnalyticsWindow } from '../lib/analytics.js';

const normalizePhone = (value) => String(value || '').replace(/\D/g, '').replace(/^0/, '62');


function normalizeBatch(body, id, fieldsFallback = []) {
  const { batch_name, program_type, description = '', start_date, end_date, quota = 0, training_fee = '', payment_instructions = '', is_active = false, fields = fieldsFallback } = body;
  if (String(batch_name || '').trim().length < 3 || !program_type || !start_date || !end_date || end_date < start_date) {
    throw new Error('Nama program dan periode gelombang harus diisi dengan benar.');
  }
  return {
    id, batch_name: String(batch_name).trim(), program_type: String(program_type).trim(),
    description: String(description).trim(), start_date, end_date, quota: String(Math.max(0, Number(quota) || 0)),
    training_fee: training_fee === '' || training_fee == null ? '' : String(Math.max(0, Number(training_fee) || 0)),
    payment_instructions: String(payment_instructions).trim(), is_active: Boolean(is_active) ? 'true' : 'false',
    fields_json: JSON.stringify(Array.isArray(fields) ? fields : [])
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST' && req.query.action === 'login') {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_TOKEN_SECRET) {
        throw new Error('Konfigurasi admin belum lengkap.');
      }
      if (email !== process.env.ADMIN_EMAIL.toLowerCase() || password !== process.env.ADMIN_PASSWORD) {
        return send(res, 401, { success: false, message: 'Email atau password salah.' });
      }
      return send(res, 200, { success: true, data: { token: createAdminToken(email), admin: { name: 'Administrator LPK BYE', email } } });
    }
    if (!authorized(req)) return send(res, 401, { success: false, message: 'Sesi admin tidak valid atau sudah berakhir.' });

    if (req.method === 'GET' && req.query.action === 'fonnte-status') {
      return send(res, 200, { success: true, data: {
        configured: Boolean(process.env.FONNTE_TOKEN),
        admin_number_configured: Boolean(process.env.FONNTE_ADMIN_NUMBER),
        webhook_configured: Boolean(process.env.FONNTE_WEBHOOK_SECRET)
      } });
    }

    if (req.method === 'GET' && (!req.query.action || req.query.action === 'registrants')) {
      const [registrants, batches, payments] = await Promise.all([
        sheets.listRegistrants(), sheets.listBatches(), sheets.listPayments()
      ]);
      const data = registrants.map(({ portal_token, answers_json, ...item }) => {
        const batch = batches.find((record) => record.id === item.batch_id);
        const rawAnswers = parseJson(answers_json, {});
        const fields = parseJson(batch?.fields_json, []);
        const answers = fields.map((field) => {
          const value = rawAnswers[field.field_name];
          return {
            field_label: field.field_label,
            answer_value: value && typeof value === 'object' ? value.url || value.name || '' : String(value || '')
          };
        });
        const paidTotal = payments.filter((payment) => payment.registrant_id === item.id && payment.status === 'approved')
          .reduce((sum, payment) => sum + Number(payment.amount_approved || 0), 0);
        const trainingFee = Number(batch?.training_fee || 0);
        return {
          ...item,
          participant_feedback: item.feedback,
          answers,
          training_fee: trainingFee,
          paid_total: paidTotal,
          balance_due: Math.max(0, trainingFee - paidTotal)
        };
      }).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return send(res, 200, { success: true, data });
    }
    if (req.method === 'GET' && req.query.action === 'dashboard') {
      const [batches, registrants, payments] = await Promise.all([
        sheets.listBatches(), sheets.listRegistrants(), sheets.listPayments()
      ]);
      const activeBatches = batches.filter((batch) => ['true', '1'].includes(String(batch.is_active).toLowerCase()));
      const approvedPayments = payments.filter((payment) => payment.status === 'approved');
      return send(res, 200, { success: true, data: {
        total_batches: batches.length,
        active_batches: activeBatches.length,
        total_registrants: registrants.length,
        pending_registrants: registrants.filter((item) => item.status === 'pending').length,
        pending_payments: payments.filter((item) => item.status === 'pending').length,
        total_payments_received: approvedPayments.reduce((sum, item) => sum + Number(item.amount_approved || 0), 0),
        pending_admin_notifications: registrants.filter((item) => item.notification_status === 'failed').length
      } });
    }
    if (req.method === 'GET' && req.query.action === 'analytics') {
      const range = createAnalyticsWindow(req.query.days);
      const [events, registrants] = await Promise.all([
        sheets.listAnalyticsEvents(range.query_from, range.query_to),
        sheets.listRegistrants()
      ]);
      return send(res, 200, { success: true, data: buildAnalyticsReport(events, registrants, range) });
    }
    if (req.method === 'GET' && req.query.action === 'batches') {
      const [batches, registrants] = await Promise.all([sheets.listBatches(), sheets.listRegistrants()]);
      return send(res, 200, { success: true, data: batches.map((batch) => ({
        ...batch, is_active: ['true', '1'].includes(String(batch.is_active).toLowerCase()),
        quota: Number(batch.quota || 0), training_fee: batch.training_fee === '' ? null : Number(batch.training_fee),
        fields: parseJson(batch.fields_json, []),
        registrant_count: registrants.filter((item) => item.batch_id === batch.id).length
      })) });
    }
    if (req.method === 'POST' && req.query.action === 'batch') {
      const record = normalizeBatch(req.body || {}, randomBytes(8).toString('hex'));
      await sheets.addBatch(record);
      return send(res, 201, { success: true, message: 'Gelombang berhasil dibuat.' });
    }
    if (req.method === 'PATCH' && req.query.action === 'batch') {
      const current = (await sheets.listBatches()).find((batch) => batch.id === String(req.body?.id || ''));
      if (!current) return send(res, 404, { success: false, message: 'Gelombang tidak ditemukan.' });
      const record = { ...normalizeBatch(req.body || {}, current.id, parseJson(current.fields_json, [])), _row: current._row };
      await sheets.saveBatch(record);
      return send(res, 200, { success: true, message: 'Gelombang berhasil diperbarui.' });
    }
    if (req.method === 'DELETE' && req.query.action === 'batch') {
      const batchId = String(req.query.id || '');
      if (!batchId) return send(res, 422, { success: false, message: 'ID gelombang wajib diisi.' });
      const batches = await sheets.listBatches();
      const batch = batches.find((item) => item.id === batchId);
      if (!batch) return send(res, 404, { success: false, message: 'Gelombang tidak ditemukan.' });
      batch.is_active = 'false';
      await sheets.saveBatch(batch);
      return send(res, 200, { success: true, message: 'Pendaftaran gelombang berhasil ditutup.' });
    }
    if (req.method === 'GET' && req.query.action === 'payments') {
      const [payments, registrants, batches] = await Promise.all([
        sheets.listPayments(), sheets.listRegistrants(), sheets.listBatches()
      ]);
      const statusFilter = req.query.status;
      const filtered = statusFilter ? payments.filter((item) => item.status === statusFilter) : payments;
      const paid = payments.filter((item) => item.status === 'approved');
      const summary = {
        pending_count: payments.filter((item) => item.status === 'pending').length,
        pending_amount: payments.filter((item) => item.status === 'pending').reduce((sum, item) => sum + Number(item.amount_declared || 0), 0),
        total_received: paid.reduce((sum, item) => sum + Number(item.amount_approved || 0), 0)
      };
      return send(res, 200, { success: true, data: filtered.map((item) => {
        const participant = registrants.find((record) => record.id === item.registrant_id);
        const batch = batches.find((record) => record.id === participant?.batch_id);
        const paidTotal = payments.filter((record) => record.registrant_id === item.registrant_id && record.status === 'approved')
          .reduce((sum, record) => sum + Number(record.amount_approved || 0), 0);
        return { ...item, amount_declared: item.amount_declared ? Number(item.amount_declared) : null,
          amount_approved: item.amount_approved ? Number(item.amount_approved) : null,
          participant_status: participant?.status || '', batch_name: participant?.batch_name || '',
          program_type: participant?.program_type || '', training_fee: Number(batch?.training_fee || 0),
          paid_total: paidTotal };
      }).sort((a, b) => b.created_at.localeCompare(a.created_at)), summary });
    }
    if (req.method === 'PATCH' && req.query.action === 'payment') {
      const { id, status, amount, rejection_reason = '' } = req.body || {};
      if (!id || !['approved', 'rejected'].includes(status)) {
        return send(res, 422, { success: false, message: 'Keputusan pembayaran tidak valid.' });
      }
      if (status === 'approved' && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
        return send(res, 422, { success: false, message: 'Nominal pembayaran yang disetujui harus lebih dari 0.' });
      }
      if (status === 'rejected' && !String(rejection_reason).trim()) {
        return send(res, 422, { success: false, message: 'Alasan penolakan wajib diisi.' });
      }
      const payment = (await sheets.listPayments()).find((item) => item.id === String(id));
      if (!payment) return send(res, 404, { success: false, message: 'Pembayaran tidak ditemukan.' });
      if (payment.status !== 'pending') return send(res, 409, { success: false, message: 'Pembayaran ini sudah ditinjau.' });
      payment.status = status;
      payment.amount_approved = status === 'approved' ? String(Number(amount)) : '';
      payment.rejection_reason = status === 'rejected' ? String(rejection_reason).trim() : '';
      payment.reviewed_at = new Date().toISOString();
      let notification = 'not_configured';
      if (process.env.FONNTE_TOKEN) {
        try {
          const text = status === 'approved'
            ? `Pembayaran Rp${new Intl.NumberFormat('id-ID').format(Number(amount))} untuk ${payment.registration_code} telah diverifikasi. Terima kasih.`
            : `Bukti pembayaran ${payment.registration_code} ditolak. Alasan: ${String(rejection_reason).trim()}`;
          await sendFonnte(payment.whatsapp, text);
          notification = 'sent';
        } catch (error) {
          console.error('Fonnte payment review failed:', error.message);
          notification = 'failed';
        }
      }
      payment.notification_status = notification;
      await sheets.savePayment(payment);
      return send(res, 200, { success: true, message: 'Pembayaran berhasil ditinjau.', data: { notification_status: notification } });
    }
    if (req.method === 'GET' && req.query.action === 'content') {
      const content = await sheets.listContent();
      return send(res, 200, { success: true, data: {
        logo_url: content.find((item) => item.type === 'logo')?.image_url || null,
        logo: content.filter((item) => item.type === 'logo'),
        slides: content.filter((item) => item.type === 'slide'),
        gallery: content.filter((item) => item.type === 'gallery'),
        faqs: content.filter((item) => item.type === 'faq').map((item) => ({ ...item, question: item.title, answer: item.caption }))
      } });
    }
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.query.action === 'content') {
      const content = await sheets.listContent();
      if (req.method === 'DELETE') {
        const item = content.find((record) => record.id === String(req.query.id || ''));
        if (!item) return send(res, 404, { success: false, message: 'Konten tidak ditemukan.' });
        item.type = '';
        await sheets.saveContent(item);
        return send(res, 200, { success: true, message: 'Konten berhasil dihapus.' });
      }
      const { id, type, title = '', caption = '', image_url = '', link_url = '', sort_order = 0, is_active = true, extra = '', image_file = null } = req.body || {};
      if (!['logo', 'slide', 'gallery', 'faq'].includes(type)) return send(res, 422, { success: false, message: 'Jenis konten tidak valid.' });
      let finalImageUrl = String(image_url);
      if (image_file?.base64 && image_file?.mimeType && image_file?.name) {
        const uploaded = await uploadToDrive({
          base64: image_file.base64, mimeType: image_file.mimeType,
          fileName: `lpk-bye-${image_file.name}`, publicAccess: true
        });
        finalImageUrl = uploaded.url;
      }
      if (req.method === 'PATCH') {
        const item = content.find((record) => record.id === String(id));
        if (!item) return send(res, 404, { success: false, message: 'Konten tidak ditemukan.' });
        Object.assign(item, { type, title, caption, image_url: finalImageUrl || item.image_url, link_url, sort_order: String(sort_order), is_active: String(Boolean(is_active)), extra });
        await sheets.saveContent(item);
        return send(res, 200, { success: true, message: 'Konten berhasil diperbarui.' });
      }
      if (type === 'logo') {
        const current = content.find((record) => record.type === 'logo');
        if (current) {
          current.image_url = finalImageUrl;
          current.is_active = 'true';
          await sheets.saveContent(current);
          return send(res, 200, { success: true, message: 'Logo berhasil diperbarui.' });
        }
      }
      const record = { id: randomBytes(8).toString('hex'), type, title, caption, image_url: finalImageUrl, link_url,
        sort_order: String(sort_order), is_active: String(Boolean(is_active)), extra };
      await sheets.addContent(record);
      return send(res, 201, { success: true, message: 'Konten berhasil ditambahkan.' });
    }
    if (req.method === 'PATCH' && req.query.action === 'status') {
      const { id, status, feedback = '', notes = '' } = req.body || {};
      if (!id || !['pending', 'verified', 'accepted', 'rejected'].includes(status)) {
        return send(res, 422, { success: false, message: 'Data status pendaftar tidak valid.' });
      }
      if (status === 'rejected' && !String(feedback).trim()) {
        return send(res, 422, { success: false, message: 'Pesan untuk peserta wajib diisi saat menolak pendaftaran.' });
      }
      const registrants = await sheets.listRegistrants();
      const record = registrants.find((item) => item.id === String(id));
      if (!record) return send(res, 404, { success: false, message: 'Pendaftar tidak ditemukan.' });
      record.status = status;
      record.feedback = String(feedback).trim();
      record.notes = String(notes).trim();
      await sheets.saveRegistrant(record);
      const statusText = { pending: 'Menunggu verifikasi', verified: 'Terverifikasi', accepted: 'Diterima', rejected: 'Ditolak' }[status];
      let notification = 'not_configured';
      if (process.env.FONNTE_TOKEN) {
        try {
          await sendFonnte(record.whatsapp, `Halo ${record.full_name}, status pendaftaran ${record.registration_code}: ${statusText}.${record.feedback ? `\nCatatan: ${record.feedback}` : ''}`);
          notification = 'sent';
        } catch (error) {
          console.error('Fonnte status notification failed:', error.message);
          notification = 'failed';
        }
      }
      record.notification_status = notification;
      await sheets.saveRegistrant(record);
      return send(res, 200, { success: true, data: { notification_status: notification } });
    }
    if (req.method === 'POST' && req.query.action === 'notify') {
      const { id, type } = req.body || {};
      if (!id || !['welcome', 'status', 'admin'].includes(type)) {
        return send(res, 422, { success: false, message: 'Jenis notifikasi tidak valid.' });
      }
      if (!process.env.FONNTE_TOKEN) {
        return send(res, 409, { success: false, message: 'Token Fonnte belum dikonfigurasi.' });
      }
      const record = (await sheets.listRegistrants()).find((item) => item.id === String(id));
      if (!record) return send(res, 404, { success: false, message: 'Pendaftar tidak ditemukan.' });
      const portalUrl = `${(process.env.APP_URL || `https://${req.headers.host}`).replace(/\/$/, '')}/peserta/${record.portal_token}`;
      const statusText = { pending: 'Menunggu verifikasi', verified: 'Terverifikasi', accepted: 'Diterima', rejected: 'Ditolak' }[record.status];
      const messages = {
        welcome: `Halo ${record.full_name}, pendaftaran ${record.program_type} - ${record.batch_name} berhasil diterima.\nKode pendaftaran: ${record.registration_code}\nStatus: ${statusText}.\nLihat status: ${portalUrl}`,
        status: `Halo ${record.full_name}, status pendaftaran ${record.registration_code}: ${statusText}.${record.feedback ? `\nCatatan: ${record.feedback}` : ''}`,
        admin: `Pendaftar baru: ${record.full_name} (${record.registration_code}), ${record.batch_name}.`
      };
      const destination = type === 'admin' ? normalizePhone(process.env.FONNTE_ADMIN_NUMBER) : record.whatsapp;
      if (!destination) return send(res, 409, { success: false, message: 'Nomor WhatsApp admin belum dikonfigurasi.' });
      try {
        await sendFonnte(destination, messages[type]);
        record.notification_status = 'sent';
        await sheets.saveRegistrant(record);
        return send(res, 200, { success: true, data: { notification_status: 'sent' } });
      } catch (error) {
        console.error('Fonnte retry notification failed:', error.message);
        record.notification_status = 'failed';
        await sheets.saveRegistrant(record);
        return send(res, 502, { success: false, message: 'Pesan gagal dikirim melalui Fonnte. Periksa token dan status perangkat.' });
      }
    }
    if (req.method === 'POST' && req.query.action === 'payment-notify') {
      const payment = (await sheets.listPayments()).find((item) => item.id === String(req.body?.id || ''));
      if (!payment) return send(res, 404, { success: false, message: 'Pembayaran tidak ditemukan.' });
      if (!process.env.FONNTE_TOKEN) {
        return send(res, 409, { success: false, message: 'Token Fonnte belum dikonfigurasi.' });
      }
      const message = payment.status === 'approved'
        ? `Pembayaran Rp${new Intl.NumberFormat('id-ID').format(Number(payment.amount_approved || 0))} untuk ${payment.registration_code} telah diverifikasi. Terima kasih.`
        : payment.status === 'rejected'
          ? `Bukti pembayaran ${payment.registration_code} ditolak.${payment.rejection_reason ? ` Alasan: ${payment.rejection_reason}` : ''}`
          : `Bukti pembayaran ${payment.registration_code} masih menunggu verifikasi admin.`;
      try {
        await sendFonnte(payment.whatsapp, message);
        payment.notification_status = 'sent';
        await sheets.savePayment(payment);
        return send(res, 200, { success: true, data: { notification_status: 'sent' } });
      } catch (error) {
        console.error('Fonnte payment retry failed:', error.message);
        payment.notification_status = 'failed';
        await sheets.savePayment(payment);
        return send(res, 502, { success: false, message: 'Pesan gagal dikirim melalui Fonnte. Periksa token dan status perangkat.' });
      }
    }
    return methodNotAllowed(res);
  } catch (error) {
    console.error('Admin API error:', error);
    const status = error.message.includes('harus diisi') || error.message.includes('periode') ? 422 : 500;
    const isDriveUpload = req.query.action === 'content'
      && ['POST', 'PATCH'].includes(req.method)
      && Boolean(req.body?.image_file?.base64);
    const message = isDriveUpload || status === 422
      ? error.message
      : 'Permintaan gagal diproses. Periksa konfigurasi layanan.';
    return send(res, status, { success: false, message });
  }
}
