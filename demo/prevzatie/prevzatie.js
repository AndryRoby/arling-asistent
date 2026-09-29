// Kód aj Bearer zostávajú v pamäti tejto stránky, nikdy v URL ani v logu.
const API = 'https://arling-asistent.arling.workers.dev';
const el = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
el('domena').value = query.get('domain') || '';
el('feed').value = query.get('feed') || '';
let udaje = null, token = '', generacia = 0;
const chyba = {
  domain_taken: 'Účet sa nepodarilo prevziať. Použite e-mail na doméne obchodu alebo pôvodný verejný kontakt. Ak problém trvá, napíšte na podpora@arling.sk.',
  bad_code: 'Kód nesedí. Skontrolujte ho v e-maile.',
  no_code: 'Kód už neplatí. Pošlite si nový kód.',
  rate_limited: 'Príliš veľa pokusov. Skúste to neskôr.',
  feed_other_domain: 'Feed musí byť na doméne Vášho obchodu.',
  validation_failed: 'Skontrolujte doménu, e-mail a úplnú adresu feedu.'
};
async function api(cesta, body, bearer = '') {
  const r = await fetch(API + cesta, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await r.json();
  if (!r.ok) throw new Error(chyba[data.error] || 'Operácia sa nepodarila. Skúste ju znova alebo napíšte na podpora@arling.sk.');
  return data;
}
el('zmenit').addEventListener('click', () => {
  generacia += 1; token = ''; udaje = null;
  el('polia').disabled = false; el('overenie').hidden = true;
  el('zmenit').hidden = true; el('kod').value = ''; el('sprava').textContent = '';
  el('hotovo').hidden = true; el('vlozenie').hidden = true; el('prevziat').disabled = false; el('email').focus();
});
el('udaje').addEventListener('submit', async (e) => {
  e.preventDefault();
  const gen = ++generacia;
  udaje = { domain: el('domena').value.trim(), feed_url: el('feed').value.trim(), email: el('email').value.trim().toLowerCase(), lang: 'sk', zdroj: 'formular', prevziat: true };
  token = ''; el('polia').disabled = true;
  try {
    await api('/v1/ucet/kod', { email: udaje.email, jazyk: 'sk' });
    if (gen !== generacia) return;
    el('overenie').hidden = false; el('zmenit').hidden = false;
    el('kod').value = ''; el('kod').focus();
    el('sprava').textContent = 'Kód sme poslali na ' + udaje.email + '.';
  } catch (err) {
    if (gen !== generacia) return;
    el('polia').disabled = false; el('sprava').textContent = err.message;
  }
});
el('overenie').addEventListener('submit', async (e) => {
  e.preventDefault();
  const gen = generacia, vstup = { ...udaje };
  el('prevziat').disabled = true;
  try {
    if (!token) {
      const overenie = await api('/v1/ucet/over', { email: vstup.email, kod: el('kod').value.trim() });
      if (gen !== generacia) return;
      token = overenie.token;
    }
    const tenant = await api('/v1/tenants', vstup, token);
    if (gen !== generacia) return;
    if (!tenant.prevzate || !tenant.existing) throw new Error('Prevzatie nie je potvrdené. Napíšte na podpora@arling.sk.');
    el('sprava').textContent = 'Účet je prevzatý. Overujeme načítanie aktuálnych produktov.';
    for (let i = 0; i < 30; i += 1) {
      const stav = await api('/v1/tenants/' + encodeURIComponent(tenant.id) + '/status');
      if (gen !== generacia) return;
      if (stav.status === 'ready' && stav.feed_pripojeny && stav.product_count > 0) {
        el('ucet').href = 'https://arling.sk/asistent/tenant/?t=' + encodeURIComponent(tenant.id);
        el('hotovo').hidden = false; el('overenie').hidden = true;
        el('vlozenie').hidden = false;
        el('snippet').value = '<script src="' + API + '/widget.js" data-tenant="' + encodeURIComponent(tenant.id) + '" data-lang="auto" defer></script>';
        el('sprava').textContent = 'Účet je prevzatý a produkty sú načítané.';
        return;
      }
      if (stav.status === 'error') break;
      await new Promise((r) => setTimeout(r, 2000));
      if (gen !== generacia) return;
    }
    el('sprava').textContent = 'Účet je prevzatý, načítanie produktov zatiaľ nie je potvrdené. Skúste pripojenie znova tým istým tlačidlom alebo napíšte na podpora@arling.sk.';
  } catch (err) {
    if (gen === generacia) el('sprava').textContent = err.message;
  } finally {
    if (gen === generacia) el('prevziat').disabled = false;
  }
});
