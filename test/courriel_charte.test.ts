// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : test/courriel_charte.test.ts   (FICHIER NEUF — lot J)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courrielDeConnexion, courrielDeRappel } from '../src/courriel.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ✉️ LOT J (07/09/2026) — LA CHARTE DES COURRIELS, ET CE QUI LA GARDE
 * ═══════════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ CE FICHIER NE JUGE PAS UN GOÛT, IL GARDE DEUX PROPRIÉTÉS QUI NE SE
 * VOIENT PAS : ① le cyan de la marque (`#10CEF2`) ne descend JAMAIS sur le
 * fond clair — il y mesure **1,38:1**, c'est-à-dire illisible, et « ça a l'air
 * joli » est exactement l'erreur qu'on fait devant un écran calibré ;
 * ② la mise en page reste en `<table>`, sans `flex` ni variables CSS, parce
 * qu'aucun client mail ne garantit le reste.
 *
 * 🔴 ET LE MODE DE PANNE EST LE MÊME DANS LES DEUX CAS : ça marche chez celui
 * qui écrit le code (son navigateur sait tout faire), et ça casse chez le
 * destinataire, sans qu'aucune erreur ne remonte. Un courriel n'a pas de
 * console.
 *
 * ⛔ CE QUE CE BANC NE PROUVE PAS, ET IL FAUT LE DIRE : le rendu réel dans
 * Outlook, Gmail ou Apple Mail. Il vérifie que les contraintes CONNUES de ces
 * clients sont respectées — pas qu'elles suffisent.
 */

const messages = () => [
  ['connexion', courrielDeConnexion('a@b.test', 'https://veveprice.com/entrer?j=x', 15, true)],
  ['rappel', courrielDeRappel('a@b.test', 5, '2026-09-12T00:00:00Z', 'https://veveprice.com/compte/')],
] as const;

test('le cyan de la marque ne touche jamais le fond clair', () => {
  for (const [nom, m] of messages()) {
    // ⭐ ON COUPE LÀ OÙ LE FOND CHANGE, ET LA COUPE EST MESURÉE SUR LE DOCUMENT,
    //   pas supposée : le corps clair commence au premier `background:#F4F4F2`
    //   qui suit l'en-tête sombre. Chercher « #10CEF2 » dans tout le HTML
    //   aurait interdit le cyan y compris là où il est correct — un contrôle
    //   qui refuse l'état sain se fait désarmer au premier lot pressé.
    const iEntete = m.html.indexOf('#1A1A1A;padding');
    assert.ok(iEntete > 0, `${nom} : en-tête sombre introuvable — ce banc ne mesurerait rien`);
    const finEntete = m.html.indexOf('</tr></table></td></tr>', iEntete);
    assert.ok(finEntete > iEntete, `${nom} : fin de l'en-tête introuvable`);
    const corps = m.html.slice(finEntete);
    assert.equal(corps.includes('#10CEF2'), false,
      `${nom} : le cyan #10CEF2 est servi sur le corps clair — 1,38:1, illisible`);
    // ⛔ CONTRE-ÉPREUVE : il DOIT être présent dans l'en-tête, sinon ce contrôle
    //    serait vert sur un message qui aurait perdu la marque.
    assert.ok(m.html.slice(0, finEntete).includes('#10CEF2'),
      `${nom} : plus de cyan du tout — la pastille de marque a disparu`);
  }
});

test('les liens et le bouton emploient la couleur lisible sur clair', () => {
  for (const [nom, m] of messages()) {
    assert.ok(m.html.includes('#0B798F'), `${nom} : la couleur de lien lisible est absente`);
    // ⛔ L'ANCIENNE CHARTE NE DOIT PAS REVENIR PAR UN COPIER-COLLER.
    assert.equal(m.html.includes('#c9a227'), false, `${nom} : le bouton or est revenu`);
    assert.equal(m.html.includes('#14161b'), false, `${nom} : le fond anthracite est revenu`);
  }
});

test('la mise en page tient sans flex, sans variable CSS, sans police distante', () => {
  for (const [nom, m] of messages()) {
    assert.ok((m.html.match(/<table/g) || []).length >= 3,
      `${nom} : moins de trois tables — la mise en page ne tiendra pas dans Outlook`);
    assert.equal(/display:\s*flex/.test(m.html), false, `${nom} : un \`flex\` s'est glissé dans un courriel`);
    assert.equal(/var\(--/.test(m.html), false, `${nom} : une variable CSS — aucun client mail ne la garantit`);
    assert.equal(/@font-face|fonts\.googleapis/.test(m.html), false, `${nom} : une police distante`);
    // ⛔ AUCUNE IMAGE : une image distante est bloquée par défaut chez la
    //    moitié des clients, et le mot-marque doit rester lisible sans elle.
    assert.equal(/<img/.test(m.html), false, `${nom} : une image — le mot-marque doit être du texte`);
  }
});

test('le pied légal est dans les deux messages, et il est le même', () => {
  const [[, a], [, b]] = messages();
  for (const m of [a, b]) {
    assert.ok(m.html.includes('Aucun wallet'), 'le pied légal manque');
    assert.ok(m.html.includes('Non affilié à VeVe / ECOMI'), 'la mention de non-affiliation manque');
  }
  // ⭐ IDENTIQUE, ET PAS SEULEMENT PRÉSENT : deux pieds qui divergent, c'est
  //   deux promesses juridiques différentes envoyées par le même expéditeur.
  const pied = (h: string) => (h.match(/Aucun wallet[\s\S]*?<\/p>/) || [''])[0];
  assert.equal(pied(a.html), pied(b.html), 'les deux pieds légaux ont divergé');
});

test('aucun montant, aucun chiffre de marché ne voyage dans un courriel', () => {
  // 🔴 UN COURRIEL EST RELU DES SEMAINES PLUS TARD (maquette v5, page 16) : un
  //    montant y devient faux tout seul, et le site aurait alors DEUX horloges.
  //    ⚠️ Le rappel porte légitimement une date et un nombre de jours — on
  //    cherche donc une UNITÉ de marché, pas un chiffre.
  for (const [nom, m] of messages()) {
    assert.equal(/\bgems\b|\bOMI\b|\$\s?\d/.test(m.html), false,
      `${nom} : une unité de marché apparaît dans un courriel`);
  }
});
