// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : test/admin.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';

/**
 * 🔥 LOT 108 — LA PAGE D'EXPLOITATION, JOUÉE PAR HTTP.
 *
 * ⭐⭐⭐ POURQUOI PAR HTTP ET PAS SUR LES FONCTIONS. Le défaut que ce banc
 * doit attraper n'est pas dans `admin.ts` : il est dans le PLACEMENT de la
 * route. `server.ts` porte, à mi-chemin, une ligne
 *     `const compte = …; if (!compte) return … vers(res, '/');`
 * qui avale tout ce qui la suit pour qui n'a pas de compte joueur — et un
 * administrateur n'en a pas. Une route d'admin posée dessous répondrait 302
 * vers l'accueil, sans une erreur, et on conclurait « le lot n'est pas
 * déposé ». Aucun banc sur les fonctions ne peut voir ça.
 * ⭐ C'est le premier banc HTTP de ce dépôt, et c'est ce qui le justifie :
 *   il mesure la CHAÎNE, pas la pièce.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-admin-'));
const JETON = 'jeton-de-banc-3cf1a9';
const W = '0x' + 'ab'.repeat(20);
const EMAIL = 'preda@exemple.net';

let serveur: Server;
let racine = '';

before(async () => {
  const f = join(dossier, 'admin.db');
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT, email TEXT, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);
  CREATE UNIQUE INDEX idx_comptes_wallet ON comptes(wallet) WHERE wallet IS NOT NULL;`);
  db.prepare('INSERT INTO comptes (id, wallet, email, verifie, verifie_le, cree_le) VALUES (?,?,?,?,?,?)')
    .run('juillet', W, EMAIL, 1, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
  db.close();

  process.env.DB_PATH = f;
  process.env.SITE_DEFAUT = 'veveprice';
  process.env.SESSION_SECRET = 'secret-de-banc-0123456789abcdef';
  process.env.ADMIN_TOKEN = JETON;
  process.env.JEUX = 'veveprice=https://veveprice.com';
  process.env.URL_PUBLIQUE = 'https://id.exemple.net';

  const s = await import('../server.ts');
  serveur = s.serveur;
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const a = serveur.address() as { port: number };
  racine = `http://127.0.0.1:${a.port}`;
});

after(async () => {
  await new Promise<void>((r) => serveur.close(() => r()));
  const m = await import('../src/db.ts');
  m.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

/** ⚠️ `redirect: 'manual'` — c'est le CODE qu'on mesure, pas la destination. */
const va = (chemin: string, cookie?: string) =>
  fetch(racine + chemin, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const poste = (chemin: string, corps: string, cookie?: string) =>
  fetch(racine + chemin, {
    method: 'POST', redirect: 'manual', body: corps,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  });

/** Le cookie d'exploitation, obtenu comme un humain : par l'échange. */
async function ouvrirSession(): Promise<string> {
  const r = await va(`/admin?k=${JETON}`);
  const brut = r.headers.getSetCookie().find((c) => c.startsWith('veveid_adm='));
  assert.ok(brut, 'l\'échange doit poser le cookie d\'exploitation');
  return brut.split(';')[0];
}

// ═══════════════════════════════════════════════════════════════════════
// LA PORTE
// ═══════════════════════════════════════════════════════════════════════
test('🔴 sans cookie, /admin est INDISCERNABLE d\'une adresse qui n\'existe pas', async () => {
  const admin = await va('/admin');
  const nimporte = await va('/cette-adresse-nexiste-pas');
  assert.equal(admin.status, nimporte.status,
    'même code que n\'importe quelle adresse inconnue — un 404 ou un 401 annoncerait qu\'il y a quelque chose ici');
  assert.equal(admin.headers.get('location'), nimporte.headers.get('location'));
  const corps = await admin.text();
  assert.ok(!corps.includes('Exploitation'), 'aucun mot de la page ne doit sortir');
});

test('🔴 un mauvais jeton ne se distingue pas non plus', async () => {
  const r = await va('/admin?k=pas-le-bon-jeton');
  const nimporte = await va('/cette-adresse-nexiste-pas');
  assert.equal(r.status, nimporte.status);
  assert.equal(r.headers.getSetCookie().length, 0, 'et surtout : aucun cookie posé');
});

test('⭐ le bon jeton s\'échange contre un cookie, et l\'URL est NETTOYÉE', async () => {
  const r = await va(`/admin?k=${JETON}`);
  assert.equal(r.status, 302, 'la redirection est ce qui sort le secret de la barre d\'adresse');
  assert.equal(r.headers.get('location'), '/admin', 'et elle repointe sur la page, sans le jeton');
  const c = r.headers.getSetCookie().find((x) => x.startsWith('veveid_adm='));
  assert.ok(c);
  assert.match(c!, /HttpOnly/i);
  assert.match(c!, /SameSite=Strict/i, 'le cookie ne doit JAMAIS partir depuis un autre site');
  assert.match(c!, /Path=\/admin/i);
});

test('la page s\'ouvre avec le cookie, et se referme', async () => {
  const cookie = await ouvrirSession();
  const r = await va('/admin', cookie);
  assert.equal(r.status, 200);
  const corps = await r.text();
  assert.ok(corps.includes('Exploitation'));
  assert.ok(corps.includes('veveprice'), 'les comptes sont comptés par site');

  const sortie = await poste('/admin/sortir', '', cookie);
  assert.equal(sortie.status, 302);
  assert.ok(sortie.headers.getSetCookie().some((x) => /veveid_adm=;/.test(x) && /Max-Age=0/.test(x)));
});

// ═══════════════════════════════════════════════════════════════════════
// ⛔ CE QUI NE DOIT JAMAIS SORTIR
// ═══════════════════════════════════════════════════════════════════════
/**
 * ⭐⭐ CE BANC LIT LE HTML RENDU, PAS LES FONCTIONS QUI LE FABRIQUENT. Une
 * règle vérifiée à l'entrée se contourne par un chemin qu'on n'avait pas
 * prévu ; une règle vérifiée sur la SORTIE ne se contourne pas. Même famille
 * que `test:fuite` sur veveprice.
 */
test('⛔ la page ne contient AUCUNE adresse en clair', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await va('/admin', cookie)).text();
  assert.ok(!corps.includes(EMAIL), 'aucune adresse e-mail');
  assert.ok(!corps.includes(W), 'aucun portefeuille');
  assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(corps.replace(/•/g, '')),
    'et aucune adresse d\'aucune sorte, même une qu\'on n\'aurait pas prévue');
});

test('⛔ la recherche ne rend l\'AUTRE identifiant que masqué', async () => {
  const cookie = await ouvrirSession();

  const parWallet = await (await poste('/admin/chercher', `q=${encodeURIComponent(W)}`, cookie)).text();
  assert.ok(parWallet.includes('•'), 'un indice masqué doit apparaître');
  assert.ok(!parWallet.includes(EMAIL), '⛔ jamais l\'adresse entière');
  assert.ok(!parWallet.includes(W), '⛔ ni le terme cherché, qui repartirait dans le HTML');

  const parEmail = await (await poste('/admin/chercher', `q=${encodeURIComponent(EMAIL)}`, cookie)).text();
  assert.ok(parEmail.includes('•'));
  assert.ok(!parEmail.includes(W));
  assert.ok(!parEmail.includes(EMAIL));
});

test('⭐ un terme qui n\'est ni un courriel ni un portefeuille ne cherche RIEN', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await poste('/admin/chercher', 'q=preda', cookie)).text();
  assert.ok(corps.includes('ne ressemble ni'),
    'on le DIT — sinon « rien trouvé » se lit « ce compte n\'existe pas », ce qui est faux');
});

test('une adresse inconnue rend « aucun compte », pas une erreur', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await poste('/admin/chercher', 'q=inconnu%40exemple.net', cookie)).text();
  assert.ok(corps.includes('Aucun compte'));
});

// ═══════════════════════════════════════════════════════════════════════
// LA SONDE PUBLIQUE
// ═══════════════════════════════════════════════════════════════════════
test('⭐ /sante déclare la forme de la base, sans rien révéler', async () => {
  const s = await (await va('/sante')).json() as any;
  assert.equal(s.base.ouverte, true);
  assert.equal(s.base.site_present, true);
  assert.equal(typeof s.base.migrations, 'number');
  // ⛔ Aucun comptage de comptes, aucun nom d'index : la forme n'identifie
  //    personne, la population si.
  assert.deepEqual(Object.keys(s.base).sort(), ['migrations', 'ouverte', 'site_present']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴🔴🔴 LOT 122 — LE SEUL GESTE QUI ÉCRIT
// ═══════════════════════════════════════════════════════════════════════════
/**
 * CE QUE CE BANC GARDE, ET POURQUOI IL COMPTE PLUS QUE SA TAILLE.
 * `accorderAbonnement()` existait depuis des semaines, importée par
 * `server.ts` et appelée par PERSONNE en dehors des tests. Le palier
 * `crevette` se gagne par `abonne_jusqu_a > maintenant` : AUCUN COMPTE AU
 * MONDE ne pouvait donc l'atteindre, et tout ce que veveprice vend était
 * fermé à 100 % des humains comme à 100 % des robots.
 * ⭐⭐⭐ *Une protection qui bloque tout le monde n'est pas stricte, elle est
 * cassée* — et de l'extérieur les deux se ressemblent exactement.
 * ⛔ Le piège qui l'a fait durer : un IMPORT SANS APPEL. Un `grep` trouvait
 *   la fonction dans le fichier des routes, ce qui suffisait à conclure
 *   qu'elle était branchée. *Un import sans appel met la preuve au mauvais
 *   endroit.*
 */
test('🔴 le geste d’abonnement fait passer le palier à crevette', async () => {
  const cookie = await ouvrirSession();
  const av = await import('../src/avoirs.ts');

  assert.equal(av.paliDe(av.lireCompte('juillet')), 'member', 'avant : membre simple');

  const r = await poste('/admin/abonner', 'ref=juillet&jours=30', cookie);
  assert.equal(r.status, 200);
  assert.equal(av.paliDe(av.lireCompte('juillet')), 'crevette', 'après : abonné');

  // ⭐ ET LE CUMUL : un second geste PROLONGE, il ne remet pas à zéro. Sans ce
  //   contrôle, « accorder 30 jours » à quelqu'un qui en a déjà 20 lui en
  //   retirerait 20 — une erreur invisible, qui ne se voit qu'un mois après.
  const fin1 = av.lireCompte('juillet')!.abonne_jusqu_a!;
  await poste('/admin/abonner', 'ref=juillet&jours=30', cookie);
  assert.ok(av.lireCompte('juillet')!.abonne_jusqu_a! > fin1, 'le second geste prolonge');
});

test('⛔ la durée est bornée, et les bornes sont refusées côté serveur', async () => {
  const cookie = await ouvrirSession();
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('juillet')!.abonne_jusqu_a;

  // ⚠️ `min`/`max` dans le HTML est du CONFORT : un POST à la main l'ignore.
  //    La borne qui protège est celle du serveur, et c'est elle qu'on éprouve.
  for (const corps of ['ref=juillet&jours=0', 'ref=juillet&jours=401',
                       'ref=juillet&jours=abc', 'ref=juillet&jours=1.5',
                       'ref=juillet&jours=-30', 'ref=juillet']) {
    const r = await poste('/admin/abonner', corps, cookie);
    assert.equal(r.status, 200, corps);
    assert.equal(av.lireCompte('juillet')!.abonne_jusqu_a, avant,
      `⛔ « ${corps} » ne doit RIEN changer`);
  }
});

test('⛔ une référence inconnue ne crée rien et le dit', async () => {
  const cookie = await ouvrirSession();
  const r = await poste('/admin/abonner', 'ref=personne&jours=30', cookie);
  const corps = await r.text();
  assert.ok(corps.includes('Compte inconnu'), 'le message le dit');
});

/**
 * ⭐⭐⭐ LE TÉMOIN NON DÉSARMÉ, et c'est le contrôle le plus important des
 * quatre : sans lui, les trois précédents prouveraient seulement que le geste
 * marche — jamais qu'il est FERMÉ. Une route qui écrit en base et qu'on
 * atteint sans session d'exploitation, c'est un abonnement gratuit pour qui
 * connaît l'adresse. C'est exactement ce qu'était la « démo » du 01/08.
 */
test('⛔ sans session d’exploitation, le geste n’écrit rien', async () => {
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('juillet')!.abonne_jusqu_a;
  const r = await poste('/admin/abonner', 'ref=juillet&jours=30', '');
  assert.notEqual(r.status, 200, 'la route ne doit pas répondre 200 sans cookie');
  assert.equal(av.lireCompte('juillet')!.abonne_jusqu_a, avant,
    '⛔ la base ne doit PAS avoir bougé');
});

/**
 * ⛔ ET LA RÈGLE QUI A FAIT ÉCHOUER MA PREMIÈRE VERSION : après le geste, la
 * page ne doit toujours contenir AUCUNE identité en clair. Mon formulaire
 * portait l'e-mail dans un champ caché ; il porte désormais une référence
 * opaque. Ce contrôle est ce qui empêche d'y revenir sans s'en apercevoir.
 */
test('⛔ après le geste, toujours aucune adresse en clair', async () => {
  const cookie = await ouvrirSession();
  const r = await poste('/admin/abonner', 'ref=juillet&jours=30', cookie);
  const corps = await r.text();
  assert.ok(!corps.includes(EMAIL), 'aucune adresse e-mail');
  assert.ok(!corps.includes(W), 'aucun portefeuille');
});

/**
 * ⭐ Et le formulaire existe VRAIMENT dans la page de recherche : sans lui,
 * tout ce qui précède mesurerait une route que personne ne peut atteindre —
 * la moitié « qui écrit » d'un circuit dont la moitié « qui appelle »
 * manquerait. C'est la faute que ce lot répare, refaite d'un cran.
 */
test('⭐ la page de recherche PORTE le formulaire d’abonnement', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await poste('/admin/chercher', `q=${encodeURIComponent(W)}`, cookie)).text();
  assert.ok(corps.includes('/admin/abonner'), 'le formulaire est là');
  assert.ok(/name="ref" value="[^"]+"/.test(corps), 'et il porte une référence');
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 LOT 194 (25/08/2026) — LA BASE APPREND À DIRE **LEQUEL**
 * ═══════════════════════════════════════════════════════════════════════════
 * Preda vend trois niveaux depuis `/offre/` (Shrimp 6 $, Lobster 18 $, Whale
 * 36 $/mois). Cette base ne savait dire qu'une DATE : `paliDe()` rendait donc
 * `crevette` pour tout abonné, et deux des trois tarifs étaient invendables —
 * pas par un réglage manquant, mais parce qu'il n'existait aucune case où
 * écrire ce qui avait été acheté.
 *
 * ⭐⭐ CE BANC PART D'UNE BASE **D'AVANT** : le `before()` de ce fichier crée
 * `comptes` sans `site` NI `palier`. Tout ce qui suit s'exécute donc sur une
 * base migrée pour de vrai, pas sur un schéma neuf qui n'existe nulle part.
 */
test('🔴 LOT 194 — la migration ajoute la colonne sur une base d’avant', async () => {
  const { q1 } = await import('../src/db.ts');
  const colonnes = (await import('../src/admin.ts')).forme().colonnes.map((c) => c.nom);
  assert.ok(colonnes.includes('palier'), '⛔ la colonne palier doit exister après migration');
  // ⭐ ET LA LIGNE D'AVANT A ÉTÉ RATTRAPÉE : « juillet » a été abonné par les
  //   tests précédents de ce fichier, donc il porte une date — la migration
  //   n'a PAS pu le voir (elle a tourné au démarrage, avant ces gestes), mais
  //   `accorderAbonnement` a écrit son palier. Les deux chemins mènent au même
  //   état, et c'est ce qu'on vérifie.
  const c = q1<{ palier: string | null }>('SELECT palier FROM comptes WHERE id=?', 'juillet');
  assert.equal(c?.palier, 'crevette', 'un abonnement accordé sans palier reste crevette');
});

test('⭐ LOT 194 — le geste accorde le palier DEMANDÉ, pas crevette par défaut', async () => {
  const cookie = await ouvrirSession();
  const av = await import('../src/avoirs.ts');

  const r = await poste('/admin/abonner', 'ref=juillet&jours=30&palier=whale', cookie);
  assert.equal(r.status, 200);
  assert.equal(av.paliDe(av.lireCompte('juillet')), 'whale', 'le palier demandé est celui qui s’ouvre');
  assert.ok((await r.text()).includes('whale'), 'et le message NOMME ce qui a été accordé');

  // ⛔ Y COMPRIS VERS LE BAS. Un abonnement est ce qu'on vient d'acheter, pas
  //   le meilleur de ce qu'on a acheté un jour. Sans ce contrôle, une
  //   implémentation « on ne redescend jamais » passerait — et le jour où
  //   quelqu'un rétrograde de whale à crevette, il garderait tout.
  await poste('/admin/abonner', 'ref=juillet&jours=30&palier=crevette', cookie);
  assert.equal(av.paliDe(av.lireCompte('juillet')), 'crevette', 'le dernier geste décide, même à la baisse');
});

test('⛔ LOT 194 — un palier qui ne se vend pas est REFUSÉ, pas corrigé', async () => {
  const cookie = await ouvrirSession();
  const av = await import('../src/avoirs.ts');
  const avantD = av.lireCompte('juillet')!.abonne_jusqu_a;
  const avantP = av.lireCompte('juillet')!.palier;

  // ⭐ `member` et `free` sont dans la liste : ce sont de VRAIS paliers du
  //   site, mais ils ne s'ACHÈTENT pas. Les accepter reviendrait à vendre le
  //   gratuit — et à écrire dans `palier` une valeur que `paliDe()` ne saurait
  //   pas relire, donc à fabriquer un abonné fantôme.
  for (const mauvais of ['crevete', 'CREVETTE', 'member', 'free', 'visitor', '', 'whale ']) {
    const r = await poste('/admin/abonner',
      `ref=juillet&jours=30&palier=${encodeURIComponent(mauvais)}`, cookie);
    assert.equal(r.status, 200, mauvais);
    assert.equal(av.lireCompte('juillet')!.abonne_jusqu_a, avantD, `⛔ « ${mauvais} » ne prolonge RIEN`);
    assert.equal(av.lireCompte('juillet')!.palier, avantP, `⛔ « ${mauvais} » n’écrase RIEN`);
  }
  // ⭐ Et le refus se DIT — un geste sans effet ni message est un geste dont on
  //   croit qu'il a marché.
  const corps = await (await poste('/admin/abonner', 'ref=juillet&jours=30&palier=crevete', cookie)).text();
  assert.ok(corps.includes('Palier refusé'), 'le message nomme le refus');
});

test('⛔ LOT 194 — un abonnement EXPIRÉ retombe à member, quel que soit le palier acheté', async () => {
  const { run } = await import('../src/db.ts');
  const av = await import('../src/avoirs.ts');
  // ⚠️ On écrit un état IMPOSSIBLE à atteindre par le geste (date passée +
  //    palier haut) : c'est exactement ce que produira le temps qui passe, et
  //    aucun test qui n'utilise que la route ne peut l'atteindre.
  run("UPDATE comptes SET abonne_jusqu_a='2020-01-01T00:00:00.000Z', palier='whale' WHERE id=?", 'juillet');
  assert.equal(av.paliDe(av.lireCompte('juillet')), 'member',
    '⛔ lire le palier AVANT la date rendrait tout abonnement éternel');
  // ⭐ Mais la colonne GARDE la trace : « il a acheté whale » et « ça ne lui
  //   ouvre plus rien » sont deux faits, et la page d'exploitation a les deux.
  assert.equal(av.lireCompte('juillet')!.palier, 'whale', 'la trace de l’achat survit à l’expiration');
});

test('⛔ LOT 194 — une valeur inconnue EN BASE retombe sur crevette, pas sur elle-même', async () => {
  const { run } = await import('../src/db.ts');
  const av = await import('../src/avoirs.ts');
  const demain = new Date(Date.now() + 86_400_000).toISOString();
  run('UPDATE comptes SET abonne_jusqu_a=?, palier=? WHERE id=?', demain, 'baleine-bleue', 'juillet');
  assert.equal(av.paliDe(av.lireCompte('juillet')), 'crevette',
    '⛔ une base ne dicte pas ce que le code accepte');
  run('UPDATE comptes SET palier=NULL WHERE id=?', 'juillet');
  assert.equal(av.paliDe(av.lireCompte('juillet')), 'crevette',
    '⭐ et le repli protège les abonnements d’avant le lot 194');
});

test('⭐ LOT 194 — le formulaire propose les TROIS paliers, et pas un de plus', async () => {
  const cookie = await ouvrirSession();
  const av = await import('../src/avoirs.ts');
  const corps = await (await poste('/admin/chercher', `q=${encodeURIComponent(W)}`, cookie)).text();
  assert.ok(corps.includes('name="palier"'), 'le sélecteur est là');
  for (const niv of av.PALIERS_VENDUS) {
    assert.ok(corps.includes(`value="${niv}"`), `« ${niv} » est proposé`);
  }
  // ⛔ LE TÉMOIN DANS L'AUTRE SENS : sans lui, un sélecteur qui proposerait
  //    aussi `member` passerait les six lignes ci-dessus.
  const options = (corps.match(/<option value="[^"]*"/g) || []).length;
  assert.equal(options, av.PALIERS_VENDUS.length, `⛔ ${options} option(s) pour ${av.PALIERS_VENDUS.length} paliers vendus`);
  for (const interdit of ['value="member"', 'value="free"', 'value="visitor"']) {
    assert.ok(!corps.includes(interdit), `⛔ ${interdit} ne doit PAS être vendable`);
  }
});

/**
 * 🔬🔴🔴 CE CONTRÔLE EXISTE PARCE QU'UNE INJECTION N'A PAS MORDU.
 *
 * En jugeant ce banc, j'ai débranché `palier` de la recherche (`admin.ts`
 * rendait `null` au lieu de la colonne) : les six contrôles ci-dessus sont
 * restés VERTS. Ils éprouvaient le moteur et la LISTE du sélecteur — jamais la
 * valeur qui remonte jusqu'à l'écran.
 *
 * ⭐⭐⭐ ET LE DÉFAUT QU'ILS LAISSAIENT PASSER EST EXACTEMENT CELUI QUE LE
 * COMMENTAIRE DE `vues.ts` PRÉTEND ÉVITER : sans palier remonté, la page ne
 * dit pas ce que la personne a acheté, ET le sélecteur repart de « crevette ».
 * Le geste courant — reconduire un abonnement — ferait alors REDESCENDRE un
 * whale d'un seul clic, sans un message, sans une erreur.
 * ⇒ *Une injection qui ne mord pas accuse le jeu d'essai, pas le code.*
 */
test('⛔ LOT 194 — la page d’exploitation MONTRE le palier acheté et le pré-sélectionne', async () => {
  const cookie = await ouvrirSession();
  await poste('/admin/abonner', 'ref=juillet&jours=30&palier=whale', cookie);
  const corps = await (await poste('/admin/chercher', `q=${encodeURIComponent(W)}`, cookie)).text();

  // ⭐ LE PALIER EST ÉCRIT DANS LA PAGE, à côté de la date.
  assert.ok(/abonné jusqu[^<]*whale|whale[^<]*<\/strong>/i.test(corps),
    '⛔ la page doit dire LEQUEL, pas seulement « abonné »');
  // ⭐ ET LE SÉLECTEUR PART DE LÀ. C'est la moitié qui protège d'une
  //   rétrogradation par inadvertance, et c'est elle que l'injection visait.
  assert.ok(/<option value="whale" selected/.test(corps),
    '⛔ reconduire doit reconduire, pas redescendre à crevette');
  assert.ok(!/<option value="crevette" selected/.test(corps),
    '⛔ un seul palier pré-sélectionné, et c’est celui qu’on a');
});
