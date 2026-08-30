/**
 * hooks/useSheetSync.js
 * ---------------------------------------------------------------------------
 * Menjembatani antrean sinkron ke keadaan React.
 *
 * Pengiriman dipicu tiga hal: sampel baru disimpan, jaringan pulih, dan
 * permintaan manual. Tidak ada polling berkala — di lapangan, permintaan
 * jaringan yang berulang tanpa hasil hanya menguras baterai.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  SYNC, loadConfig, saveConfig, loadQueue, enqueue, dequeue,
  toRow, sendBatch, testConnection, chunkQueue,
} from '../core/sync/sheets.js';

export function useSheetSync({ onSent } = {}) {
  const [config, setConfig] = useState(loadConfig);
  const [queue, setQueue] = useState(loadQueue);
  const [status, setStatus] = useState(SYNC.OFF);
  const [lastError, setLastError] = useState(null);
  const [lastOk, setLastOk] = useState(null);
  const running = useRef(false);

  useEffect(() => {
    if (!config.enabled || !config.url) setStatus(SYNC.OFF);
    else setStatus(queue.length ? SYNC.QUEUED : SYNC.IDLE);
  }, [config.enabled, config.url, queue.length]);

  const update = useCallback((patch) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveConfig(next);
      return next;
    });
  }, []);

  /** Kirim seluruh antrean. Aman dipanggil berulang: dijaga agar tidak tumpang tindih. */
  const flush = useCallback(async () => {
    if (running.current) return;
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.url) return;

    const pending = loadQueue();
    if (!pending.length) { setStatus(SYNC.IDLE); return; }

    running.current = true;
    setStatus(SYNC.SENDING);
    setLastError(null);

    try {
      const rows = pending.map((s) => toRow(s, { includePhotos: cfg.sendPhotos }));
      for (const group of chunkQueue(rows)) {
        await sendBatch(cfg, group);
        // Dibuang dari antrean per kelompok, bukan di akhir. Bila kelompok
        // berikutnya gagal, yang sudah terkirim tidak dikirim ulang.
        const ids = group.map((r) => r.id);
        setQueue((q) => dequeue(q, ids));
        onSent?.(ids);
      }
      setStatus(SYNC.IDLE);
      setLastOk(new Date().toISOString());
    } catch (e) {
      setLastError(e.message);
      setStatus(SYNC.ERROR);
    } finally {
      running.current = false;
      setQueue(loadQueue());
    }
  }, [onSent]);

  /** Masukkan sampel ke antrean lalu coba kirim. */
  const push = useCallback((sample) => {
    setQueue((q) => enqueue(q, sample));
    // Ditunda satu putaran supaya penyimpanan status selesai lebih dahulu.
    setTimeout(flush, 0);
  }, [flush]);

  // Kirim ulang ketika jaringan pulih. Inilah pemicu yang paling sering
  // menyelamatkan data di lapangan.
  useEffect(() => {
    const onOnline = () => flush();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flush]);

  const test = useCallback(async () => {
    setLastError(null);
    try {
      const r = await testConnection(loadConfig());
      setLastOk(new Date().toISOString());
      return { ok: true, info: r };
    } catch (e) {
      setLastError(e.message);
      return { ok: false, error: e.message };
    }
  }, []);

  return {
    config, update, status, queue, pending: queue.length,
    lastError, lastOk, push, flush, test,
  };
}
