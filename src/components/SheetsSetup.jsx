/**
 * components/SheetsSetup.jsx
 * ---------------------------------------------------------------------------
 * Pemasang sinkronisasi Google Sheets, lengkap dengan kodenya.
 *
 * Seluruh pemasangan dapat diselesaikan dari layar ini: hasilkan token, salin
 * kode, tempel di Apps Script, deploy, lalu tempel URL-nya kembali. Tidak ada
 * langkah yang mengharuskan pengguna membuka repositori atau mencari berkas.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useLocale } from '../context/AppProviders.jsx';
import { buildAppsScript, generateToken, copyText } from '../core/sync/appsScript.js';

export function SheetsSetup({ token, onTokenChange }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(null);

  const code = useMemo(() => buildAppsScript(token), [token]);

  const salin = useCallback(async () => {
    const r = await copyText(code);
    setCopied(r.ok ? 'ok' : 'gagal');
    setTimeout(() => setCopied(null), 2500);
  }, [code]);

  return (
    <section className="gt-export-group">
      <h4>{t('setup.title')}</h4>
      <p className="gt-export-count">{t('setup.intro')}</p>

      <ol className="gt-setup-steps">
        <li>{t('setup.step1')}</li>
        <li>{t('setup.step2')}</li>
        <li>
          {t('setup.step3')}
          <div className="gt-setup-deploy">
            <code>Execute as</code> → <b>Me</b><br />
            <code>Who has access</code> → <b>Anyone</b>
          </div>
          <span className="gt-hint">{t('setup.step3Warn')}</span>
        </li>
        <li>{t('setup.step4')}</li>
      </ol>

      <label className="gt-field">
        {t('setup.token')}
        <div className="gt-row gt-token-row">
          <input value={token ?? ''} spellCheck={false}
            placeholder={t('setup.tokenPlaceholder')}
            onChange={(e) => onTokenChange(e.target.value.trim())} />
          <button type="button" onClick={() => onTokenChange(generateToken())}>
            {t('setup.generate')}
          </button>
        </div>
      </label>
      <p className="gt-hint">{t('setup.tokenNote')}</p>

      <button type="button" className="gt-btn-primary" onClick={salin}>
        {copied === 'ok' ? t('setup.copied')
          : copied === 'gagal' ? t('setup.copyFailed')
          : t('setup.copy')}
      </button>

      <button type="button" onClick={() => setOpen((v) => !v)}>
        {open ? t('setup.hideCode') : t('setup.showCode')}
      </button>

      {open && (
        <pre className="gt-code gt-script"><code>{code}</code></pre>
      )}

      <p className="gt-hint gt-export-warn">{t('setup.securityNote')}</p>
    </section>
  );
}
