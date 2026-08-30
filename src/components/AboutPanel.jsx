/**
 * components/AboutPanel.jsx
 * ---------------------------------------------------------------------------
 * Halaman Tentang: filosofi penamaan dan biodata pengembang.
 *
 * Ditulis dwibahasa lewat tabel string yang sama dengan seluruh aplikasi,
 * bukan teks tertanam, supaya sakelar bahasa tetap berlaku di sini.
 */

import React from 'react';
import { useLocale } from '../context/AppProviders.jsx';

export function AboutPanel() {
  const { t, locale } = useLocale();

  return (
    <div className="gt-about">
      <div className="gt-about-mark">
        <img src="logo.svg" alt="" width="88" height="88" />
        <div>
          <h2>REIS</h2>
          <p>{t('app.subtitle')}</p>
          <p className="gt-about-by">MangGIS.co</p>
        </div>
      </div>

      <section>
        <h3>{t('about.nameTitle')}</h3>
        <p>{t('about.namePara1')}</p>
        <p>{t('about.namePara2')}</p>
        <p>{t('about.namePara3')}</p>
      </section>

      <section>
        <h3>{t('about.devTitle')}</h3>
        <p className="gt-about-name">Garda Asa Muhammad</p>
        <p>{t('about.bio')}</p>
        <p className="gt-about-affil">
          Sains Informasi Geografi · Universitas Pendidikan Indonesia, Bandung
        </p>
      </section>

      <section>
        <h3>{t('about.techTitle')}</h3>
        <ul className="gt-about-list">
          <li>{t('about.tech1')}</li>
          <li>{t('about.tech2')}</li>
          <li>{t('about.tech3')}</li>
          <li>{t('about.tech4')}</li>
        </ul>
      </section>

      <p className="gt-about-foot">
        {t('about.license')}
      </p>
    </div>
  );
}
